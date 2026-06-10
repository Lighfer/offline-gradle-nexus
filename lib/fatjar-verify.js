'use strict';

// fatjar 一致性验证：
// 1) 打开 Spring Boot 风格 fatjar（默认 BOOT-INF/lib/ 下的 *.jar 即运行时依赖）；
//    也支持 shadowJar 这种「内嵌 class 进入根 jar」 的形态，此时回退到从内嵌 pom.properties 推断 GAV；
// 2) 把每个内嵌 jar 的 SHA1 与 GAV 计算出来；
// 3) 与 manifest / bundle/repo 下的 *.jar 做交叉比对：
//    - both-match：jar 名一致 + SHA1 一致；
//    - sha-mismatch：jar 名一致但 SHA1 不一致；
//    - only-in-fatjar：fatjar 中存在但 bundle 中缺失；
//    - only-in-bundle：bundle 中存在但 fatjar 中没有（一般是 testRuntime 依赖、buildscript 等）；

const fs = require('fs');
const path = require('path');
const {
  exists,
  algoHex,
  fileSize,
  safeJsonParse,
  walkFiles
} = require('./util');
const { defaultBundleDir } = require('./bundle');
const { ZipReader } = require('./zip-reader');

const SPRING_BOOT_LIB_PREFIX = 'BOOT-INF/lib/';
const POM_PROPERTIES_PATTERN = /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/;

function parsePomProperties(text) {
  const obj = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#!=][^=]*)=(.*)$/);
    if (!m) continue;
    obj[m[1].trim()] = m[2].trim();
  }
  return obj;
}

// 已知的 Maven 风格 classifier 白名单：只接受这类典型 classifier 推断结果，
// 避免把 "guava-31.1-jre" 这种 *版本号内的标签* 误判成 classifier=jre。
// 真正的 SNAPSHOT、release 修饰词、版本元数据全都留在 version 里。
const KNOWN_CLASSIFIER_SET = new Set([
  'plain', 'sources', 'javadoc', 'tests', 'test-sources', 'all',
  'shaded', 'native', 'jdk8', 'jdk11', 'jdk15', 'jdk17',
  'linux-x86_64', 'linux-aarch_64', 'osx-x86_64', 'osx-aarch_64',
  'windows-x86_64', 'windows-aarch_64'
]);

function parseJarFileNameToGav(fileName) {
  // 从形如 "foo-bar-1.2.3.jar" / "foo-bar-1.2.3-plain.jar" 中尽力还原 artifact + version。
  // 无 group 推断能力，仅做次优。注意：仅在最后一个连字符段命中已知 classifier 时
  // 才认为它是 classifier；否则统统并入 version，避免把 "31.1-jre"、"2.0.0-SNAPSHOT"
  // 之类的版本尾部错切成 classifier。
  const base = String(fileName || '').replace(/\.jar$/i, '');
  const idx = base.search(/-\d/);
  if (idx <= 0) return { artifact: base, version: null, classifier: null };
  const artifact = base.slice(0, idx);
  const rest = base.slice(idx + 1);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash > 0) {
    const tail = rest.slice(lastDash + 1).toLowerCase();
    if (KNOWN_CLASSIFIER_SET.has(tail)) {
      return { artifact, version: rest.slice(0, lastDash), classifier: rest.slice(lastDash + 1) };
    }
  }
  return { artifact, version: rest, classifier: null };
}

/**
 * 已知 (artifact, version) 的情况下，从 fileName 减去前缀以稳定提取 classifier。
 * 用于 bundle 一侧（GAV 已由 Maven 路径推断完毕）：能正确识别 plain / sources / javadoc 等。
 */
function classifierFromFileName(fileName, artifact, version) {
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const stem = name.slice(0, dot);
  const prefix = String(artifact || '') + '-' + String(version || '');
  if (stem === prefix) return null;
  if (stem.startsWith(prefix + '-')) return stem.slice(prefix.length + 1) || null;
  return null;
}

function buildBundleKey(group, artifact, version, classifier) {
  return group + ':' + artifact + ':' + version + (classifier ? ':' + classifier : '');
}

/**
 * 读取单个 fatjar，返回内部 lib jar 清单（含 SHA1、GAV 推断）。
 */
async function readFatjarLibs(fatjarPath, { tryInferGav = true } = {}) {
  const zip = new ZipReader(fatjarPath);
  try {
    const libs = [];
    for (const entry of zip.list()) {
      if (entry.isDirectory) continue;
      if (!entry.fileName.startsWith(SPRING_BOOT_LIB_PREFIX)) continue;
      if (!entry.fileName.toLowerCase().endsWith('.jar')) continue;
      const innerName = entry.fileName.slice(SPRING_BOOT_LIB_PREFIX.length);
      const { hash, size } = await zip.hashEntry(entry, 'sha1');
      const nameGav = parseJarFileNameToGav(innerName);
      const lib = {
        path: entry.fileName,
        fileName: innerName,
        size,
        sha1: hash,
        compressionMethod: entry.compressionMethod,
        gav: { group: null, artifact: nameGav.artifact, version: nameGav.version, classifier: nameGav.classifier }
      };
      if (tryInferGav) {
        // 进一步用内嵌的 pom.properties 提取准确 GAV。
        // 关键：一旦 pom.properties 给出了权威的 (artifact, version)，classifier 必须用
        // `classifierFromFileName(artifact, version)` 重新推导：
        //   - 它会去掉 "<artifact>-<version>" 前缀再判定剩余是否是 classifier；
        //   - 如果文件名 stem == prefix，则 classifier 为 null（不再回退到 nameGav 里那个
        //     朴素切分得到的 classifier，否则会把 "guava-31.1-jre" 这种版本尾部误判成 classifier）。
        try {
          const inferred = await inferGavFromInnerJar(zip, entry);
          if (inferred) {
            const artifact = inferred.artifact || lib.gav.artifact;
            const version = inferred.version || lib.gav.version;
            lib.gav = {
              group: inferred.group || lib.gav.group,
              artifact,
              version,
              classifier: classifierFromFileName(innerName, artifact, version)
            };
          }
        } catch (_) {}
      }
      libs.push(lib);
    }
    return libs;
  } finally {
    zip.close();
  }
}

async function inferGavFromInnerJar(outerZip, libEntry) {
  // 把内嵌 jar 整体读到内存（往往几 MB），再用 ZipReader 解析 pom.properties。
  // Spring Boot 3 默认 STORED 存储 lib，所以这里基本是无压缩拷贝。
  const buf = await outerZip.bufferEntry(libEntry);
  const tmpPath = path.join(require('os').tmpdir(), 'ogn-inner-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.jar');
  fs.writeFileSync(tmpPath, buf);
  try {
    const innerZip = new ZipReader(tmpPath);
    try {
      for (const e of innerZip.list()) {
        if (POM_PROPERTIES_PATTERN.test(e.fileName)) {
          const text = (await innerZip.bufferEntry(e)).toString('utf8');
          const props = parsePomProperties(text);
          if (props.groupId || props.artifactId || props.version) {
            return { group: props.groupId || null, artifact: props.artifactId || null, version: props.version || null };
          }
        }
      }
    } finally {
      innerZip.close();
    }
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
  return null;
}

function indexBundleJars(outputDir) {
  // 把 bundle/repo 下的全部 *.jar 整理成两份索引：
  //   - byKey: group:artifact:version[:classifier] -> entry，命中 fatjar 内 jar 的精确坐标；
  //   - byFileName: fileName -> [entry, ...]，作为 byKey 失败时的回退（罕见的非标准布局）。
  const repoDir = path.join(outputDir, 'repo');
  const byKey = new Map();
  const byFileName = new Map();
  const all = [];
  if (!exists(repoDir)) return { repoDir, byKey, byFileName, all };
  for (const abs of walkFiles(repoDir)) {
    if (!abs.toLowerCase().endsWith('.jar')) continue;
    const rel = path.relative(repoDir, abs).split(path.sep).join('/');
    const parts = rel.split('/');
    // Maven 路径布局 group...../artifact/version/fileName
    if (parts.length < 4) continue;
    const fileName = parts[parts.length - 1];
    const version = parts[parts.length - 2];
    const artifact = parts[parts.length - 3];
    const group = parts.slice(0, parts.length - 3).join('.');
    const classifier = classifierFromFileName(fileName, artifact, version);
    const entry = {
      absPath: abs,
      relativePath: rel,
      group,
      artifact,
      version,
      classifier,
      fileName,
      size: fileSize(abs),
      // SHA1 计算延后到比对时按需做（这样只比对真正匹配到的 jar，避免上千 jar 全部 hash）。
      sha1: null
    };
    const key = buildBundleKey(group, artifact, version, classifier);
    if (!byKey.has(key)) byKey.set(key, entry);
    if (!byFileName.has(fileName)) byFileName.set(fileName, []);
    byFileName.get(fileName).push(entry);
    all.push(entry);
  }
  return { repoDir, byKey, byFileName, all };
}

function indexManifestArtifacts(outputDir) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  if (!exists(manifestPath)) return null;
  const manifest = safeJsonParse(fs.readFileSync(manifestPath, 'utf8'), null);
  if (!manifest) return null;
  return {
    manifestPath,
    manifest,
    byFileName: groupBy(manifest.artifacts || [], a => a.fileName)
  };
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/**
 * 验证 fatjar 与 bundle 一致性。
 */
async function verifyFatjar(body) {
  const fatjarPath = String(body.fatjarPath || '').trim();
  if (!fatjarPath) throw new Error('fatjarPath 不能为空。');
  if (!exists(fatjarPath)) throw new Error('fatjar 文件不存在：' + fatjarPath);

  const workDir = String(body.workDir || '').trim();
  const outputDir = String(body.outputDir || '').trim() || (workDir ? defaultBundleDir(workDir) : '');
  if (!outputDir) throw new Error('未提供 outputDir 也没有 workDir，无法定位本地 bundle 目录。');
  if (!exists(outputDir)) throw new Error('本地 bundle 目录不存在：' + outputDir);

  const fatjarLibs = await readFatjarLibs(fatjarPath, { tryInferGav: body.inferGavFromInnerJar !== false });
  const { repoDir, byKey, byFileName, all: bundleEntries } = indexBundleJars(outputDir);
  const manifestIndex = indexManifestArtifacts(outputDir);

  const matched = [];
  const shaMismatch = [];
  const onlyInFatjar = [];
  const matchedRepoPaths = new Set();

  for (const lib of fatjarLibs) {
    let chosen = null;
    let matchedBy = null;

    // 优先按完整 GAV+classifier 命中：bundle 已保留 classifier 后，这条路径能匹配 -plain.jar 等内嵌 artifact。
    if (lib.gav && lib.gav.group && lib.gav.artifact && lib.gav.version) {
      const key = buildBundleKey(lib.gav.group, lib.gav.artifact, lib.gav.version, lib.gav.classifier);
      if (byKey.has(key)) {
        chosen = byKey.get(key);
        matchedBy = 'gav';
      }
    }
    // 回退：仅在没有完整 GAV 或 byKey 未命中时按 fileName 匹配，沿用旧行为兼容历史 bundle 目录。
    if (!chosen) {
      const candidates = byFileName.get(lib.fileName) || [];
      if (candidates.length) {
        chosen = candidates[0];
        if (lib.gav && lib.gav.group && lib.gav.artifact && lib.gav.version) {
          const better = candidates.find(c =>
            c.group === lib.gav.group &&
            c.artifact === lib.gav.artifact &&
            c.version === lib.gav.version &&
            (c.classifier || null) === (lib.gav.classifier || null)
          );
          if (better) chosen = better;
        }
        matchedBy = 'fileName';
      }
    }

    if (!chosen) {
      onlyInFatjar.push(lib);
      continue;
    }

    if (chosen.sha1 == null) chosen.sha1 = algoHex(chosen.absPath, 'sha1');
    matchedRepoPaths.add(chosen.absPath);
    const bundleGav = { group: chosen.group, artifact: chosen.artifact, version: chosen.version, classifier: chosen.classifier || null };
    if (chosen.sha1 === lib.sha1) {
      matched.push({
        fileName: lib.fileName,
        sha1: lib.sha1,
        size: lib.size,
        fatjarPath: lib.path,
        bundlePath: chosen.relativePath,
        gav: bundleGav,
        matchedBy
      });
    } else {
      shaMismatch.push({
        fileName: lib.fileName,
        fatjarSha1: lib.sha1,
        bundleSha1: chosen.sha1,
        fatjarSize: lib.size,
        bundleSize: chosen.size,
        bundlePath: chosen.relativePath,
        fatjarGav: lib.gav,
        bundleGav,
        matchedBy
      });
    }
  }

  const onlyInBundle = [];
  for (const entry of bundleEntries) {
    if (matchedRepoPaths.has(entry.absPath)) continue;
    onlyInBundle.push({
      fileName: entry.fileName,
      relativePath: entry.relativePath,
      size: entry.size,
      gav: { group: entry.group, artifact: entry.artifact, version: entry.version, classifier: entry.classifier || null }
    });
  }

  return {
    fatjarPath,
    fatjarSize: fileSize(fatjarPath),
    outputDir,
    repoDir,
    manifestPath: manifestIndex ? manifestIndex.manifestPath : null,
    summary: {
      fatjarLibCount: fatjarLibs.length,
      bundleJarCount: bundleEntries.length,
      matched: matched.length,
      shaMismatch: shaMismatch.length,
      onlyInFatjar: onlyInFatjar.length,
      onlyInBundle: onlyInBundle.length,
      consistent: shaMismatch.length === 0 && onlyInFatjar.length === 0
    },
    matched,
    shaMismatch,
    onlyInFatjar,
    onlyInBundle
  };
}

module.exports = {
  verifyFatjar,
  readFatjarLibs,
  indexBundleJars,
  parseJarFileNameToGav
};
