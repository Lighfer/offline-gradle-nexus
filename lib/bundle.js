'use strict';

// 一键拉取并整理：把解析得到的 artifact、project 产物、本地文件以及 wrapper distribution 整理成本地 Maven 仓库结构。
//
// 性能策略：
// - resolveProjectOrCached：先查缓存（cacheToken 命中即不再跑 Gradle）；
// - 拷贝文件、生成 POM/.module/.sha1/.md5、元数据下载 都用 pMapWithLimit 受限并行；
// - writeChecksums 内部已切换为单次流式读取算 sha1+md5，避免对同一文件多次完整 I/O。

const fsp = require('fs/promises');
const path = require('path');
const {
  nowIso,
  exists,
  ensureDirSync,
  fileSize,
  sanitizeFilename,
  groupPath,
  parseClassifiedJarFileName,
  walkFiles,
  uniqueBy,
  pMapWithLimit,
  multiHashStreaming,
  isRegularFile
} = require('./util');
const { resolveProjectOrCached, repoUrlsFromResolution } = require('./inspect-resolve');
const {
  generatePomXml,
  generateGradleModuleMetadata,
  fetchOrCopyModuleMetadata,
  parsePomExtraModules,
  collectAncestorProps,
  buildMavenMetadataXml,
  writeChecksums,
  uniqueDeps
} = require('./maven-metadata');
const { exportWrapperDistribution } = require('./wrapper-export');

const APP_NAME = 'offline-gradle-nexus';
const COPY_CONCURRENCY = 8;
const METADATA_CONCURRENCY = 8;

function defaultBundleDir(workDir) {
  return path.join(workDir, '.offline-nexus-bundle');
}

function effectiveProjectGav(info, body) {
  const group = String((info && info.group) || (body && body.fallbackProjectGroup) || '').trim();
  const version = String((info && info.version) || (body && body.fallbackProjectVersion) || '').trim();
  const artifact = String((info && (info.artifact || info.name)) || '').trim();
  return { group, artifact, version };
}

async function copyModuleArtifact(a, outputDir) {
  const c = a.component;
  const baseRel = groupPath(c.group) + '/' + c.module + '/' + c.version;
  const rel = baseRel + '/' + a.fileName;
  const dest = path.join(outputDir, 'repo', ...rel.split('/'));
  ensureDirSync(path.dirname(dest));
  await fsp.copyFile(a.file, dest);
  const hashes = await writeChecksums(dest);
  return {
    kind: 'module-artifact',
    group: c.group, artifact: c.module, version: c.version,
    fileName: a.fileName, relativePath: rel, sourceFile: a.file,
    size: fileSize(dest), sha1: hashes.sha1,
    sourceLabel: a.sourceLabel
  };
}

function projectPomDependencies(projectPath, resolveJson, body) {
  const direct = (resolveJson.projectRuntimeDirectDependencies || {})[projectPath] || [];
  const projectInfos = resolveJson.projectInfos || {};
  const deps = [];
  for (const d of direct) {
    if (!d || d.unresolved || !d.selected) continue;
    if (d.selected.type === 'module') {
      deps.push({ group: d.selected.group, artifact: d.selected.module, version: d.selected.version, scope: 'runtime' });
    } else if (d.selected.type === 'project') {
      const info = projectInfos[d.selected.projectPath] || {};
      const gav = effectiveProjectGav(info, body || {});
      if (gav.group && gav.artifact && gav.version) {
        deps.push({ group: gav.group, artifact: gav.artifact, version: gav.version, scope: 'runtime' });
      }
    }
  }
  return uniqueDeps(deps);
}

/**
 * 在并行拷贝前，按 GAV 分组 project artifact，决定每个 GAV 的 leader（负责 POM/.module/主 jar 回退）。
 * 这样 pMapWithLimit 在并发执行时不会争抢 POM/.module/主 jar 的写入。
 *
 * 返回：Map<originalArtifact, plan>。plan 字段：
 *   - type='unresolved' 时缺失 GAV，走 project-artifacts-unresolved 分支；
 *   - type='resolved' 时携带 gav/classifier/ext/baseRel；
 *   - isLeader：该 artifact 在所属 GAV 内负责生成 POM/.module；
 *   - needsPrimaryFallback：所属 GAV 没有无 classifier 的主 jar，需要把 leader 内容额外复制一份成主 jar（满足 Nexus 消费方按主坐标拉取的场景）。
 */
function planProjectArtifacts(projectArtifacts, projectInfoByPath, body) {
  const meta = new Map();
  const groups = new Map();
  for (const a of projectArtifacts) {
    const info = projectInfoByPath[a.component.projectPath] || {};
    const gav = effectiveProjectGav(info, body);
    if (!gav.group || !gav.artifact || !gav.version) {
      meta.set(a, { type: 'unresolved' });
      continue;
    }
    const { classifier, ext } = parseClassifiedJarFileName(a.fileName || path.basename(a.file), gav);
    const baseRel = groupPath(gav.group) + '/' + gav.artifact + '/' + gav.version;
    const item = { a, gav, classifier, ext: ext || 'jar', baseRel };
    if (!groups.has(baseRel)) groups.set(baseRel, []);
    groups.get(baseRel).push(item);
  }
  for (const arr of groups.values()) {
    const primary = arr.find(x => !x.classifier && x.ext === 'jar');
    const leader = primary || arr[0];
    const needsPrimaryFallback = !primary && leader.ext === 'jar';
    for (const x of arr) {
      meta.set(x.a, {
        type: 'resolved',
        gav: x.gav,
        classifier: x.classifier,
        ext: x.ext,
        baseRel: x.baseRel,
        isLeader: x === leader,
        needsPrimaryFallback: x === leader && needsPrimaryFallback
      });
    }
  }
  return meta;
}

async function copyProjectArtifactUnresolved(a, outputDir, manifest) {
  const destRel = 'project-artifacts-unresolved/' +
    sanitizeFilename(a.component.projectPath || 'project') + '/' +
    sanitizeFilename(a.fileName || path.basename(a.file));
  const dest = path.join(outputDir, destRel);
  ensureDirSync(path.dirname(dest));
  await fsp.copyFile(a.file, dest);
  await writeChecksums(dest);
  manifest.warnings.push({
    type: 'project-gav-missing',
    projectPath: a.component.projectPath,
    file: a.file,
    message: '项目依赖缺少 group/artifact/version，已复制到 project-artifacts-unresolved，不放入 Maven repo，避免上传坐标错误。可在页面配置兜底 group/version 后重试。'
  });
  return [{
    kind: 'project-artifact-unresolved',
    projectPath: a.component.projectPath,
    fileName: a.fileName, relativePath: destRel, sourceFile: a.file
  }];
}

async function copyProjectArtifact(a, plan, resolveJson, outputDir, body, manifest) {
  if (!plan || plan.type === 'unresolved') {
    return copyProjectArtifactUnresolved(a, outputDir, manifest);
  }
  const { gav, classifier, ext, baseRel, isLeader, needsPrimaryFallback } = plan;
  const fileName = gav.artifact + '-' + gav.version + (classifier ? '-' + classifier : '') + '.' + ext;
  const rel = baseRel + '/' + fileName;
  const dest = path.join(outputDir, 'repo', ...rel.split('/'));
  ensureDirSync(path.dirname(dest));
  await fsp.copyFile(a.file, dest);
  const hashes = await writeChecksums(dest);

  const entries = [{
    kind: classifier ? 'project-artifact-classified' : 'project-artifact',
    projectPath: a.component.projectPath,
    group: gav.group, artifact: gav.artifact, version: gav.version,
    classifier: classifier || null,
    fileName, relativePath: rel, sourceFile: a.file,
    size: fileSize(dest), sha1: hashes.sha1,
    sourceLabel: a.sourceLabel
  }];

  // 主 jar 回退：当 GAV 仅有 classifier jar（典型为 Spring Boot 子模块的 -plain.jar）时，
  // 把 leader 内容复制成无 classifier 的主 jar，让 Nexus 消费方按 GAV 拉取也能命中。
  let primaryArtifactFileName = fileName;
  let primaryArtifactDest = dest;
  if (needsPrimaryFallback) {
    primaryArtifactFileName = gav.artifact + '-' + gav.version + '.jar';
    const primaryRel = baseRel + '/' + primaryArtifactFileName;
    primaryArtifactDest = path.join(outputDir, 'repo', ...primaryRel.split('/'));
    if (!exists(primaryArtifactDest)) {
      await fsp.copyFile(a.file, primaryArtifactDest);
      const primaryHashes = await writeChecksums(primaryArtifactDest);
      entries.push({
        kind: 'project-artifact-primary-fallback',
        projectPath: a.component.projectPath,
        group: gav.group, artifact: gav.artifact, version: gav.version,
        classifier: null,
        fileName: primaryArtifactFileName, relativePath: primaryRel, sourceFile: a.file,
        size: fileSize(primaryArtifactDest), sha1: primaryHashes.sha1,
        sourceLabel: a.sourceLabel,
        derivedFrom: classifier
      });
    }
  }

  if (isLeader) {
    const pomFileName = gav.artifact + '-' + gav.version + '.pom';
    const pomFile = path.join(outputDir, 'repo', ...(baseRel + '/' + pomFileName).split('/'));
    if (!exists(pomFile)) {
      const deps = projectPomDependencies(a.component.projectPath, resolveJson, body);
      await fsp.writeFile(pomFile, generatePomXml(gav, deps), 'utf8');
      await writeChecksums(pomFile);
    }
    const moduleFileName = gav.artifact + '-' + gav.version + '.module';
    const moduleFile = path.join(outputDir, 'repo', ...(baseRel + '/' + moduleFileName).split('/'));
    if (!exists(moduleFile)) {
      const moduleJson = await generateGradleModuleMetadata(gav, primaryArtifactFileName, primaryArtifactDest, resolveJson);
      await fsp.writeFile(moduleFile, moduleJson, 'utf8');
      await writeChecksums(moduleFile);
    }
  }

  return entries;
}

async function copyLocalArtifact(a, outputDir) {
  // 先用流式 hash 算出 sha1，再决定目标文件名；后续复制 + 校验文件都用同一份 hash。
  const srcHashes = await multiHashStreaming(a.file, ['sha1']);
  const rel = 'local-files/' + srcHashes.sha1.slice(0, 12) + '-' + sanitizeFilename(a.fileName || path.basename(a.file));
  const dest = path.join(outputDir, rel);
  ensureDirSync(path.dirname(dest));
  await fsp.copyFile(a.file, dest);
  const hashes = await writeChecksums(dest);
  return {
    kind: 'local-file',
    fileName: a.fileName, relativePath: rel, sourceFile: a.file,
    size: fileSize(dest), sha1: hashes.sha1,
    sourceLabel: a.sourceLabel
  };
}

function pomPathForModule(outputDir, m) {
  const rel = groupPath(m.group) + '/' + m.module + '/' + m.version + '/' + m.module + '-' + m.version + '.pom';
  return path.join(outputDir, 'repo', ...rel.split('/'));
}

/**
 * 解析给定的一批 POM，提取其中新出现的 parent / import BOM 坐标（按 knownModuleKeys 去重）。
 * 求值版本占位符时携带父链属性域：fastjson 等大量 POM 的 import BOM 版本（如 ${springsecurity5.version}）
 * 定义在父 POM 的 <properties> 中，仅看本 POM 会漏抓，导致离线构建报 Could not parse POM。
 * - 父链尚未完整落盘且存在未求值占位符的 POM 进入 pending，等下一轮 BFS 父 POM 下载后重扫；
 * - 父链已完整仍无法求值的，立即写 warning（缺口可见、可诊断而非静默丢失）。
 * 返回 { extras, pending }。
 */
async function collectPomDerivedModules(pomFiles, knownModuleKeys, repoDir, manifest) {
  const extras = [];
  const pending = [];
  for (const pomFile of pomFiles) {
    let parsed;
    let ancestor;
    try {
      const text = await fsp.readFile(pomFile, 'utf8');
      ancestor = await collectAncestorProps(text, repoDir);
      parsed = parsePomExtraModules(text, ancestor.props);
    } catch (e) {
      manifest.warnings.push({ type: 'pom-parse-failed', file: pomFile, message: '解析 POM 额外坐标失败：' + e.message });
      continue;
    }
    for (const m of parsed.modules) {
      const key = m.group + ':' + m.module + ':' + m.version;
      if (!knownModuleKeys.has(key)) {
        knownModuleKeys.add(key);
        extras.push(m);
      }
    }
    if (!parsed.unresolved.length) continue;
    if (ancestor.missingParent) {
      pending.push({ pomFile, missingParent: ancestor.missingParent, unresolved: parsed.unresolved });
    } else {
      for (const u of parsed.unresolved) {
        manifest.warnings.push({
          type: 'pom-extra-version-unresolved',
          file: pomFile,
          coordinate: u.group + ':' + u.artifact + ':' + String(u.version || ''),
          reason: u.reason,
          message: 'POM 的 ' + u.reason + ' 版本占位符在完整父链属性域中仍无法求值，已跳过；如该坐标确为构建所需，请确认其属性来源。'
        });
      }
    }
  }
  return { extras, pending };
}

/**
 * 为 repo/ 下每个 group:artifact 生成 GA 级 maven-metadata.xml（含 .sha1/.md5）。
 * 仅以约定的 Maven 布局（repo/<group...>/<artifact>/<version>/<files>）识别版本目录：
 * 任意含 .pom/.jar/.module 的目录视为版本目录，其名即 version、父目录即 artifact、其余路径即 group。
 * 这是动态版本（+）在目标仓库可解析的关键——Nexus 对逐文件 PUT 不会自动重建该文件。
 */
async function writeRepositoryMetadata(outputDir, manifest) {
  const repoDir = path.join(outputDir, 'repo');
  if (!exists(repoDir)) return;
  const gaVersions = new Map();
  for (const file of walkFiles(repoDir)) {
    const lower = file.toLowerCase();
    if (!(lower.endsWith('.pom') || lower.endsWith('.jar') || lower.endsWith('.module'))) continue;
    const versionDir = path.dirname(file);
    const artifactDir = path.dirname(versionDir);
    const groupDir = path.dirname(artifactDir);
    const version = path.basename(versionDir);
    const artifact = path.basename(artifactDir);
    const relGroup = path.relative(repoDir, groupDir);
    if (!relGroup || relGroup.startsWith('..')) continue;
    const group = relGroup.split(path.sep).join('.');
    if (!group || !artifact || !version) continue;
    const key = group + '|' + artifact;
    if (!gaVersions.has(key)) gaVersions.set(key, { group, artifact, versions: new Set() });
    gaVersions.get(key).versions.add(version);
  }
  const entries = [...gaVersions.values()];
  const results = await pMapWithLimit(entries, async (e) => {
    const rel = groupPath(e.group) + '/' + e.artifact + '/maven-metadata.xml';
    const dest = path.join(outputDir, 'repo', ...rel.split('/'));
    const versions = [...e.versions];
    await fsp.writeFile(dest, buildMavenMetadataXml(e.group, e.artifact, versions), 'utf8');
    const hashes = await writeChecksums(dest);
    return {
      kind: 'maven-metadata',
      group: e.group, artifact: e.artifact, versions,
      fileName: 'maven-metadata.xml', relativePath: rel,
      size: fileSize(dest), sha1: hashes.sha1
    };
  }, METADATA_CONCURRENCY);
  for (const r of results) {
    if (r.ok) manifest.metadata.push(r.value);
    else manifest.errors.push({ type: 'write-maven-metadata', item: r.item, message: r.error.message });
  }
}

async function createBundle(body) {
  const workDir = String(body.workDir || '').trim();
  const outputDir = String(body.outputDir || '').trim() || defaultBundleDir(workDir);
  if (body.cleanOutput) await fsp.rm(outputDir, { recursive: true, force: true });
  ensureDirSync(outputDir);
  ensureDirSync(path.join(outputDir, 'repo'));
  ensureDirSync(path.join(outputDir, 'reports'));
  ensureDirSync(path.join(outputDir, 'local-files'));

  const bundleStartedAt = Date.now();
  const resolveJson = await resolveProjectOrCached(body);
  const repos = repoUrlsFromResolution(resolveJson, body);
  const manifest = {
    app: APP_NAME,
    generatedAt: nowIso(),
    workDir,
    outputDir,
    targetProject: body.targetProject || ':',
    configurations: Array.isArray(body.configurations) ? body.configurations : ['runtimeClasspath'],
    repositories: repos.map(r => ({ name: r.name, url: r.url, hasUsername: !!r.username })),
    gradle: {
      version: resolveJson.gradleVersion,
      command: resolveJson.gradleCommand,
      usingWrapper: resolveJson.usingWrapper,
      javaHome: resolveJson.javaHome,
      jdkDir: resolveJson.jdkDir
    },
    artifacts: [],
    metadata: [],
    wrapper: null,
    warnings: [],
    errors: []
  };

  await fsp.writeFile(
    path.join(outputDir, 'reports', 'dependency-tree.json'),
    JSON.stringify(resolveJson, null, 2),
    'utf8'
  );

  const moduleArtifacts = new Map();
  const projectArtifactByFile = new Map();
  const localArtifactByFile = new Map();
  for (const r of resolveJson.results || []) {
    for (const a of r.artifacts || []) {
      if (!a || !a.file || !exists(a.file)) continue;
      // 排除目录型 artifact：compileClasspath 等配置会把项目自身 classes 目录暴露成 variant，
      // 这些条目 file 指向目录（如 build/classes/java/main），既不是可上传的 jar，也无法 copyFile。
      // 直接跳过并在 manifest.warnings 留一条记录，避免后续 EPERM copyfile 错误堆积。
      if (!isRegularFile(a.file)) {
        manifest.warnings.push({
          type: 'artifact-not-regular-file',
          label: r.label,
          file: a.file,
          fileName: a.fileName,
          component: a.component,
          message: '跳过目录型 artifact（多为 compileClasspath 暴露的 classes 目录），不参与 bundle/上传。'
        });
        continue;
      }
      const comp = a.component || {};
      if (comp.type === 'module') {
        const key = comp.group + ':' + comp.module + ':' + comp.version + ':' + a.fileName;
        if (!moduleArtifacts.has(key)) moduleArtifacts.set(key, { ...a, sourceLabel: r.label });
      } else if (comp.type === 'project') {
        // 同一 project artifact 会被 runtimeClasspath / testRuntimeClasspath / annotationProcessor
        // 等多份配置同时暴露，文件路径相同。如果直接并发复制会撞 EBUSY 文件锁，因此按 file 去重。
        if (!projectArtifactByFile.has(a.file)) projectArtifactByFile.set(a.file, { ...a, sourceLabel: r.label });
      } else {
        if (!localArtifactByFile.has(a.file)) localArtifactByFile.set(a.file, { ...a, sourceLabel: r.label });
      }
    }
  }
  const projectArtifacts = [...projectArtifactByFile.values()];
  const localArtifacts = [...localArtifactByFile.values()];

  const moduleResults = await pMapWithLimit(
    [...moduleArtifacts.values()],
    a => copyModuleArtifact(a, outputDir),
    COPY_CONCURRENCY
  );
  for (const r of moduleResults) {
    if (r.ok) manifest.artifacts.push(r.value);
    else manifest.errors.push({ type: 'copy-module-artifact', artifact: r.item, message: r.error.message });
  }

  const projectInfoByPath = resolveJson.projectInfos || {};
  const projectPlans = planProjectArtifacts(projectArtifacts, projectInfoByPath, body);
  const projectResults = await pMapWithLimit(
    projectArtifacts,
    a => copyProjectArtifact(a, projectPlans.get(a), resolveJson, outputDir, body, manifest),
    COPY_CONCURRENCY
  );
  for (const r of projectResults) {
    if (r.ok) {
      for (const entry of r.value || []) manifest.artifacts.push(entry);
    } else {
      manifest.errors.push({ type: 'copy-project-artifact', artifact: r.item, message: r.error.message });
    }
  }

  const localResults = await pMapWithLimit(
    localArtifacts,
    a => copyLocalArtifact(a, outputDir),
    COPY_CONCURRENCY
  );
  for (const r of localResults) {
    if (r.ok) manifest.artifacts.push(r.value);
    else manifest.errors.push({ type: 'copy-local-artifact', artifact: r.item, message: r.error.message });
  }

  const modules = uniqueBy(
    (resolveJson.summary && resolveJson.summary.modules) || [],
    m => m.group + ':' + m.module + ':' + m.version
  );
  const knownModuleKeys = new Set(modules.map(m => m.group + ':' + m.module + ':' + m.version));
  const metaResults = await pMapWithLimit(
    modules,
    m => fetchOrCopyModuleMetadata(m, repos, outputDir, body),
    METADATA_CONCURRENCY
  );
  for (const r of metaResults) {
    if (r.ok) {
      manifest.metadata.push(...r.value.items);
      manifest.warnings.push(...r.value.warnings);
      manifest.errors.push(...r.value.errors);
    } else {
      manifest.errors.push({ type: 'fetch-metadata', module: r.item, message: r.error.message });
    }
  }

  // 递归补齐 POM parent / dependencyManagement import BOM 的完整闭包：
  // 这些坐标常不在 runtimeClasspath 的直接模块集合里，但构建从零解析 POM 时必须可用。
  // BFS：每轮扫描“新落盘的 POM + 父链未完整的 pending POM”，沿 parent/import 边逐层补齐。
  // pending POM 在其父 POM 于后续轮次落盘后重扫求值（import BOM 的版本属性常定义在父 POM），
  // 直到闭包收敛（本轮无新增坐标）；guard 仅防御异常环。
  const repoDir = path.join(outputDir, 'repo');
  const scannedPoms = new Set();
  const pendingPoms = new Map();
  let pomQueue = walkFiles(repoDir).filter(f => f.toLowerCase().endsWith('.pom'));
  for (let guard = 0; guard < 50; guard++) {
    const fresh = pomQueue.filter(f => !scannedPoms.has(f));
    fresh.forEach(f => scannedPoms.add(f));
    const batch = [...fresh, ...pendingPoms.keys()];
    if (!batch.length) break;
    const { extras, pending } = await collectPomDerivedModules(batch, knownModuleKeys, repoDir, manifest);
    for (const f of batch) pendingPoms.delete(f);
    for (const p of pending) pendingPoms.set(p.pomFile, p);
    if (!extras.length) break;
    const extraMetaResults = await pMapWithLimit(
      extras,
      m => fetchOrCopyModuleMetadata(m, repos, outputDir, body),
      METADATA_CONCURRENCY
    );
    const nextPoms = [];
    for (let i = 0; i < extraMetaResults.length; i++) {
      const r = extraMetaResults[i];
      if (r.ok) {
        manifest.metadata.push(...r.value.items);
        manifest.warnings.push(...r.value.warnings);
        manifest.errors.push(...r.value.errors);
        const pomPath = pomPathForModule(outputDir, extras[i]);
        if (exists(pomPath) && !scannedPoms.has(pomPath)) nextPoms.push(pomPath);
      } else {
        manifest.errors.push({ type: 'fetch-metadata-derived', module: r.item, message: r.error.message });
      }
    }
    pomQueue = nextPoms;
  }
  // BFS 收敛后仍因祖先 POM 缺失而无法求值的占位符，统一写入 warnings（缺口可见、可诊断）。
  for (const p of pendingPoms.values()) {
    for (const u of p.unresolved) {
      manifest.warnings.push({
        type: 'pom-extra-version-unresolved',
        file: p.pomFile,
        coordinate: u.group + ':' + u.artifact + ':' + String(u.version || ''),
        reason: u.reason,
        missingParent: p.missingParent,
        message: 'POM 的 ' + u.reason + ' 版本占位符无法求值（祖先 POM ' + p.missingParent + ' 未能获取），已跳过；请确认源仓库中该父 POM 可用。'
      });
    }
  }

  // 生成 GA 级 maven-metadata.xml（动态版本在目标仓库可解析的前提），需在所有 POM/jar 落盘后执行。
  await writeRepositoryMetadata(outputDir, manifest);

  const wrapper = await exportWrapperDistribution(workDir, outputDir, repos, body);
  manifest.wrapper = wrapper.wrapper;
  manifest.warnings.push(...wrapper.warnings);
  manifest.errors.push(...wrapper.errors);

  const elapsedMs = Date.now() - bundleStartedAt;
  // 关键修复：summary 同样写到 manifest.json，scan-bundle 与可视化时才能直接读出。
  manifest.summary = {
    artifactFiles: manifest.artifacts.length,
    metadataFiles: manifest.metadata.length,
    warnings: manifest.warnings.length,
    errors: manifest.errors.length,
    elapsedMs,
    resolveFromCache: !!resolveJson.fromCache
  };

  const manifestPath = path.join(outputDir, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    ok: manifest.errors.length === 0,
    outputDir,
    manifestPath,
    summary: manifest.summary,
    manifest
  };
}

module.exports = {
  createBundle,
  defaultBundleDir
};
