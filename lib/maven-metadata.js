'use strict';

// Maven 坐标对应的 POM / Gradle .module 文件生成与获取逻辑。
// 来源优先级：本地 Gradle 缓存 -> 源仓库下载。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  exists,
  ensureDirSync,
  algoHex,
  fileSize,
  groupPath,
  encodePathSegments,
  isFileUrl,
  trimSlash,
  fileUrlToLocalPath,
  userHome,
  isSnapshotVersion,
  uniqueBy,
  multiHashStreaming
} = require('./util');
const { httpRequestBuffer } = require('./http-client');

function xmlEscape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function generatePomXml(gav, deps) {
  const depXml = (deps || []).map(d =>
    `    <dependency>\n` +
    `      <groupId>${xmlEscape(d.group)}</groupId>\n` +
    `      <artifactId>${xmlEscape(d.artifact)}</artifactId>\n` +
    `      <version>${xmlEscape(d.version)}</version>\n` +
    `      <scope>${xmlEscape(d.scope || 'runtime')}</scope>\n` +
    `    </dependency>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${xmlEscape(gav.group)}</groupId>
  <artifactId>${xmlEscape(gav.artifact)}</artifactId>
  <version>${xmlEscape(gav.version)}</version>
  <packaging>jar</packaging>
${depXml ? '  <dependencies>\n' + depXml + '\n  </dependencies>\n' : ''}</project>
`;
}

async function generateGradleModuleMetadata(gav, artifactFileName, artifactFile, resolveJson) {
  // 用单次流式读取算齐 4 种摘要，避免对 jar 做 4 次完整 I/O。
  const size = fileSize(artifactFile);
  const hashes = await multiHashStreaming(artifactFile, ['sha512', 'sha256', 'sha1', 'md5']);
  const meta = {
    formatVersion: '1.1',
    component: {
      group: gav.group,
      module: gav.artifact,
      version: gav.version,
      attributes: { 'org.gradle.status': isSnapshotVersion(gav.version) ? 'integration' : 'release' }
    },
    createdBy: { gradle: { version: String(resolveJson.gradleVersion || '') } },
    variants: [{
      name: 'runtimeElements',
      attributes: {
        'org.gradle.category': 'library',
        'org.gradle.dependency.bundling': 'external',
        'org.gradle.libraryelements': 'jar',
        'org.gradle.usage': 'java-runtime'
      },
      files: [{
        name: artifactFileName,
        url: artifactFileName,
        size,
        sha512: hashes.sha512,
        sha256: hashes.sha256,
        sha1: hashes.sha1,
        md5: hashes.md5
      }]
    }]
  };
  return JSON.stringify(meta, null, 2) + '\n';
}

function findGradleCachedMetadata(gradleUserHome, module, filename) {
  const home = gradleUserHome || process.env.GRADLE_USER_HOME || path.join(userHome(), '.gradle');
  const base = path.join(home, 'caches', 'modules-2', 'files-2.1', module.group, module.module, module.version);
  if (!exists(base)) return null;
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === filename) return p;
    }
  }
  return null;
}

async function downloadFromRepos(repos, rel, dest, body) {
  if (!repos || repos.length === 0) return { ok: false, message: '没有可用源仓库 URL。可在页面手动填写源 Nexus 仓库地址。' };
  const tried = [];
  for (const repo of repos) {
    const base = trimSlash(repo.url || '');
    if (!base) continue;
    if (isFileUrl(base)) {
      try {
        const fileBase = fileUrlToLocalPath(base);
        if (!fileBase) {
          tried.push(base + ' (无法解析为本地路径)');
          continue;
        }
        const src = path.join(fileBase, ...rel.split('/'));
        tried.push(src);
        if (exists(src)) {
          await fsp.copyFile(src, dest);
          return { ok: true, url: src };
        }
      } catch (e) { tried.push(base + ' => ' + e.message); }
      continue;
    }
    const requestUrl = base + '/' + encodePathSegments(rel);
    tried.push(requestUrl);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await httpRequestBuffer('GET', requestUrl, {
        username: repo.username || body.sourceUsername,
        password: repo.password || body.sourcePassword,
        rejectUnauthorized: !body.trustAllSsl,
        timeoutMs: 120000
      });
      if (!r.error && r.statusCode >= 200 && r.statusCode < 300) {
        await fsp.writeFile(dest, r.body);
        return { ok: true, url: requestUrl };
      }
      if (r.statusCode === 404) break;
    }
  }
  return { ok: false, message: '未找到：' + rel + '；尝试过：' + tried.slice(0, 8).join(' | ') };
}

async function writeChecksums(filePath) {
  // 单次流式读取计算 sha1 + md5，并发写两个校验文件；比之前两次 readFileSync 快得多。
  const hashes = await multiHashStreaming(filePath, ['sha1', 'md5']);
  await Promise.all([
    fsp.writeFile(filePath + '.sha1', hashes.sha1 + '\n', 'utf8'),
    fsp.writeFile(filePath + '.md5', hashes.md5 + '\n', 'utf8')
  ]);
  return hashes;
}

async function fetchOrCopyModuleMetadata(module, repos, outputDir, body) {
  const result = { items: [], warnings: [], errors: [] };
  const baseRel = groupPath(module.group) + '/' + module.module + '/' + module.version;
  for (const ext of ['pom', 'module']) {
    const filename = module.module + '-' + module.version + '.' + ext;
    const rel = baseRel + '/' + filename;
    const dest = path.join(outputDir, 'repo', ...rel.split('/'));
    if (exists(dest)) continue;
    ensureDirSync(path.dirname(dest));
    let copied = false;
    const cached = findGradleCachedMetadata(body.gradleUserHome, module, filename);
    if (cached) {
      await fsp.copyFile(cached, dest);
      copied = true;
      result.items.push({
        kind: 'metadata-cache',
        group: module.group, artifact: module.module, version: module.version,
        fileName: filename, relativePath: rel, sourceFile: cached
      });
    } else {
      const dl = await downloadFromRepos(repos, rel, dest, body);
      if (dl.ok) {
        copied = true;
        result.items.push({
          kind: 'metadata-download',
          group: module.group, artifact: module.module, version: module.version,
          fileName: filename, relativePath: rel, sourceUrl: dl.url
        });
      } else if (ext === 'module') {
        result.warnings.push({
          type: 'module-metadata-missing',
          module, fileName: filename,
          message: dl.message || '未找到 .module 元数据，很多 Maven 依赖本身没有该文件。'
        });
      } else {
        result.errors.push({
          type: 'pom-missing',
          module, fileName: filename,
          message: dl.message || '未能从 Gradle 缓存或源仓库取得 POM。'
        });
      }
    }
    if (copied) await writeChecksums(dest);
  }
  return result;
}

function readPomTag(block, tag) {
  const m = String(block || '').match(new RegExp('<' + tag + '>\\s*([^<]+)\\s*</' + tag + '>', 'i'));
  return m ? String(m[1] || '').trim() : '';
}

function parsePomProperties(text) {
  const props = {};
  const blocks = String(text || '').match(/<properties\b[\s\S]*?<\/properties>/ig) || [];
  for (const b of blocks) {
    const body = String(b).replace(/^[\s\S]*?<properties[^>]*>/i, '').replace(/<\/properties>[\s\S]*$/i, '');
    const pairs = body.match(/<([A-Za-z0-9_.-]+)>\s*([^<]+)\s*<\/\1>/g) || [];
    for (const p of pairs) {
      const m = p.match(/<([A-Za-z0-9_.-]+)>\s*([^<]+)\s*<\/\1>/);
      if (!m) continue;
      const key = String(m[1] || '').trim();
      const val = String(m[2] || '').trim();
      if (key) props[key] = val;
    }
  }
  return props;
}

function resolvePomValue(raw, props) {
  let v = String(raw || '').trim();
  if (!v) return '';
  for (let i = 0; i < 8; i++) {
    const m = v.match(/^\$\{([^}]+)\}$/);
    if (!m) break;
    const key = String(m[1] || '').trim();
    if (!key || !Object.prototype.hasOwnProperty.call(props || {}, key)) break;
    v = String(props[key] || '').trim();
  }
  return v;
}

function isConcreteVersion(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  // `${springBootVersion}` 这类属性占位符无法在离线镜像阶段安全求值，这里先跳过，避免写入错误坐标。
  if (s.includes('${')) return false;
  return true;
}

/**
 * 解析 POM 自身坐标（groupId / artifactId / version）与 parent 坐标。
 * Maven 继承规则：缺省 groupId/version 时继承自 parent。
 * 读取时先剥离 <parent> 块并截到 dependencyManagement/dependencies/build 等大节点之前，
 * 避免把 parent 或依赖里的坐标误当成工程自身坐标。
 */
function readProjectGav(text) {
  const parentMatch = String(text || '').match(/<parent\b[\s\S]*?<\/parent>/i);
  const parent = parentMatch ? {
    group: readPomTag(parentMatch[0], 'groupId'),
    artifact: readPomTag(parentMatch[0], 'artifactId'),
    version: readPomTag(parentMatch[0], 'version')
  } : null;
  let header = parentMatch ? String(text).replace(parentMatch[0], '') : String(text || '');
  const cut = header.search(/<(dependencyManagement|dependencies|build|profiles|modules|properties|reporting|distributionManagement)\b/i);
  if (cut >= 0) header = header.slice(0, cut);
  const ownGroup = readPomTag(header, 'groupId') || (parent && parent.group) || '';
  const ownArtifact = readPomTag(header, 'artifactId') || '';
  const ownVersion = readPomTag(header, 'version') || (parent && parent.version) || '';
  return { ownGroup, ownArtifact, ownVersion, parent };
}

/**
 * 汇总该 POM 的可用属性：Maven 内置属性（project.version 等保留字优先级最高）+ 工程 <properties>。
 * 这样 ${project.version} / ${project.parent.version} / ${revision} 等占位符都能被求值。
 */
function buildPomPropertyScope(text) {
  const ownProps = parsePomProperties(text);
  const { ownGroup, ownArtifact, ownVersion, parent } = readProjectGav(text);
  const builtins = {
    'project.version': ownVersion, 'pom.version': ownVersion,
    'project.groupId': ownGroup, 'pom.groupId': ownGroup,
    'project.artifactId': ownArtifact, 'pom.artifactId': ownArtifact
  };
  if (parent) {
    builtins['project.parent.version'] = parent.version;
    builtins['parent.version'] = parent.version;
    builtins['project.parent.groupId'] = parent.group;
    builtins['parent.groupId'] = parent.group;
  }
  return { props: { ...ownProps, ...builtins }, parent };
}

/**
 * 从 POM 文本中提取“为了继续解析该 POM 可能还需要的额外坐标”：
 * - parent POM
 * - dependencyManagement 里的 import BOM（type=pom + scope=import）
 * 返回 { modules, unresolved }：
 * - modules：版本已求值为具体值的坐标，进入后续递归补齐；
 * - unresolved：占位符无法求值（如属性定义在更上层 parent）的 parent/import，交由调用方写入 warnings 以便诊断。
 */
function parsePomExtraModules(pomText) {
  const text = String(pomText || '');
  const { props, parent } = buildPomPropertyScope(text);
  const out = [];
  const unresolved = [];

  if (parent && parent.group && parent.artifact) {
    const v = resolvePomValue(parent.version, props);
    if (isConcreteVersion(v)) out.push({ group: parent.group, module: parent.artifact, version: v, reason: 'pom-parent' });
    else unresolved.push({ group: parent.group, artifact: parent.artifact, version: parent.version, reason: 'pom-parent' });
  }

  const dmBlocks = text.match(/<dependencyManagement\b[\s\S]*?<\/dependencyManagement>/ig) || [];
  for (const dm of dmBlocks) {
    const deps = String(dm).match(/<dependency\b[\s\S]*?<\/dependency>/ig) || [];
    for (const dep of deps) {
      const g = readPomTag(dep, 'groupId');
      const a = readPomTag(dep, 'artifactId');
      const rawV = readPomTag(dep, 'version');
      const v = resolvePomValue(rawV, props);
      const type = (readPomTag(dep, 'type') || 'jar').toLowerCase();
      const scope = (readPomTag(dep, 'scope') || '').toLowerCase();
      if (type !== 'pom' || scope !== 'import' || !g || !a) continue;
      if (isConcreteVersion(v)) out.push({ group: g, module: a, version: v, reason: 'dependencyManagement-import' });
      else unresolved.push({ group: g, artifact: a, version: rawV, reason: 'dependencyManagement-import' });
    }
  }

  return {
    modules: uniqueBy(out, m => m.group + ':' + m.module + ':' + m.version),
    unresolved: uniqueBy(unresolved, m => m.group + ':' + m.artifact + ':' + m.version + ':' + m.reason)
  };
}

// 生成 Maven lastUpdated 时间戳（UTC，yyyyMMddHHmmss）。
function mavenTimestamp(date) {
  const d = date || new Date();
  const p = n => String(n).padStart(2, '0');
  return String(d.getUTCFullYear()) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

/**
 * Maven 版本比较（近似实现）：按 . _ - + 切段，数字段按数值比较，
 * 末尾多出的限定段（snapshot / rc / alpha 等非数字）视为预发布，排在同前缀正式版之前。
 * 仅用于在 maven-metadata.xml 中排序与挑选 latest/release，bundle 内同一坐标通常只有 1 个版本。
 */
function compareMavenVersions(a, b) {
  const tok = s => String(s || '').toLowerCase().split(/[._\-+]/).filter(x => x.length);
  const ta = tok(a);
  const tb = tok(b);
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return /^\d+$/.test(y) ? -1 : 1;
    if (y === undefined) return /^\d+$/.test(x) ? 1 : -1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
    else if (nx) return 1;
    else if (ny) return -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 生成 GA 级 maven-metadata.xml：列出 bundle 内该 group:artifact 实际存在的版本。
 * 这是动态版本（+ / latest.release / 区间）能在目标仓库被解析的前提；
 * Nexus 对逐文件 PUT 不会自动重建该文件，故必须由本工具显式生成并上传。
 */
function buildMavenMetadataXml(group, artifact, versions) {
  const list = (versions || []).filter(Boolean).slice().sort(compareMavenVersions);
  const releases = list.filter(v => !isSnapshotVersion(v));
  const latest = list.length ? list[list.length - 1] : '';
  const release = releases.length ? releases[releases.length - 1] : '';
  const versionsXml = list.map(v => '      <version>' + xmlEscape(v) + '</version>').join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata modelVersion="1.1.0">
  <groupId>${xmlEscape(group)}</groupId>
  <artifactId>${xmlEscape(artifact)}</artifactId>
  <versioning>
    <latest>${xmlEscape(latest)}</latest>
${release ? '    <release>' + xmlEscape(release) + '</release>\n' : ''}    <versions>
${versionsXml}
    </versions>
    <lastUpdated>${mavenTimestamp()}</lastUpdated>
  </versioning>
</metadata>
`;
}

module.exports = {
  generatePomXml,
  generateGradleModuleMetadata,
  fetchOrCopyModuleMetadata,
  parsePomExtraModules,
  buildMavenMetadataXml,
  compareMavenVersions,
  writeChecksums,
  downloadFromRepos,
  uniqueDeps: arr => uniqueBy(arr, d => d.group + ':' + d.artifact + ':' + d.version + ':' + d.scope)
};
