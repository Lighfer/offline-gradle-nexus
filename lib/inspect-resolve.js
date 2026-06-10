'use strict';

// Gradle 工程识别 + 依赖解析的高层封装。
// 调度 init script、整理结果并附加上汇总信息。
//
// 缓存机制：resolveProject 会用 cacheToken 缓存最近一次结果（默认 10 分钟），
// 这样 "一键拉取并整理" 在用户先点 "分析依赖树" 之后能直接复用，
// 避免重复跑一遍 Gradle 解析（重型操作）。

const crypto = require('crypto');
const { runGradle, extractJsonFromGradle, normalizeRepoSpecs } = require('./gradle-runner');
const { INSPECT_INIT, RESOLVE_INIT } = require('./gradle-init-scripts');
const { defaultJdkDir } = require('./jdk');
const { isProbablyHttpUrl, isFileUrl, uniqueBy, trimSlash } = require('./util');

const RESOLVE_CACHE_TTL_MS = 10 * 60 * 1000;
const RESOLVE_CACHE_MAX_ENTRIES = 32;
const resolveCache = new Map();

function pruneResolveCache() {
  const now = Date.now();
  for (const [k, v] of resolveCache) {
    if (now - v.savedAt > RESOLVE_CACHE_TTL_MS) resolveCache.delete(k);
  }
  while (resolveCache.size > RESOLVE_CACHE_MAX_ENTRIES) {
    const oldest = [...resolveCache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)[0];
    if (!oldest) break;
    resolveCache.delete(oldest[0]);
  }
}

function newCacheToken() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * 抽取出 "影响依赖解析结果" 的参数，作为缓存命中的二次校验：
 * 即使 cacheToken 复用了，但只要这些参数变了（targetProject/configurations/源仓库等），
 * 也算 miss，避免 bundle 错把另一组解析数据当成最新结果使用。
 */
function fingerprintResolveBody(body) {
  return JSON.stringify({
    workDir: String((body && body.workDir) || '').trim(),
    jdkDir: String((body && body.jdkDir) || '').trim(),
    gradleUserHome: String((body && body.gradleUserHome) || '').trim(),
    targetProject: String((body && body.targetProject) || ':'),
    configurations: Array.isArray(body && body.configurations) ? [...body.configurations].sort() : null,
    includeBuildscript: body && body.includeBuildscript !== false,
    includePlugins: body && body.includePlugins !== false,
    includeSpringBootBundled: body && body.includeSpringBootBundled !== false,
    includeVersionCatalogImports: body && body.includeVersionCatalogImports !== false,
    includeAllProjectClasspaths: body && body.includeAllProjectClasspaths !== false,
    sourceRepos: String((body && (body.sourceRepos || body.sourceRepoUrls)) || '').trim(),
    sourceUsername: String((body && body.sourceUsername) || '').trim(),
    allowInsecureProtocol: !!(body && body.allowInsecureProtocol),
    trustAllSsl: !!(body && body.trustAllSsl)
  });
}

function getCachedResolve(token, body) {
  if (!token) return null;
  pruneResolveCache();
  const entry = resolveCache.get(String(token));
  if (!entry) return null;
  if (Date.now() - entry.savedAt > RESOLVE_CACHE_TTL_MS) {
    resolveCache.delete(token);
    return null;
  }
  if (body != null && entry.fingerprint !== fingerprintResolveBody(body)) {
    // 参数变了不再算命中。token 仍然保留以备别的请求使用。
    return null;
  }
  return entry.result;
}

function saveResolveCache(result, body) {
  const token = newCacheToken();
  resolveCache.set(token, { result, savedAt: Date.now(), fingerprint: fingerprintResolveBody(body) });
  pruneResolveCache();
  return token;
}

async function inspectProject(body) {
  const workDir = String(body.workDir || '').trim();
  const jdkDir = String(body.jdkDir || '').trim() || defaultJdkDir();
  const r = await runGradle({
    workDir,
    jdkDir,
    body,
    initScript: INSPECT_INIT,
    taskName: '__ognInspect',
    timeoutMs: 8 * 60 * 1000
  });
  const json = extractJsonFromGradle(r.stdout);
  json.gradleCommand = r.command;
  json.usingWrapper = r.usingWrapper;
  json.jdkDir = jdkDir;
  json.elapsedMs = r.elapsedMs;
  return json;
}

async function resolveProject(body) {
  const workDir = String(body.workDir || '').trim();
  const jdkDir = String(body.jdkDir || '').trim() || defaultJdkDir();
  const configurations = Array.isArray(body.configurations) && body.configurations.length
    ? body.configurations
    : ['runtimeClasspath'];
  const extraEnv = {
    OGN_TARGET_PROJECT: String(body.targetProject || ':'),
    OGN_CONFIGURATIONS: configurations.join(','),
    OGN_INCLUDE_BUILDSCRIPT: body.includeBuildscript === false ? 'false' : 'true',
    OGN_INCLUDE_PLUGINS: body.includePlugins === false ? 'false' : 'true',
    OGN_INCLUDE_SPRING_BOOT_BUNDLED: body.includeSpringBootBundled === false ? 'false' : 'true',
    OGN_INCLUDE_VERSION_CATALOG_IMPORTS: body.includeVersionCatalogImports === false ? 'false' : 'true',
    OGN_INCLUDE_ALL_PROJECT_CLASSPATHS: body.includeAllProjectClasspaths === false ? 'false' : 'true'
  };
  const r = await runGradle({
    workDir,
    jdkDir,
    body,
    envExtra: extraEnv,
    initScript: RESOLVE_INIT,
    taskName: '__ognResolve',
    timeoutMs: 20 * 60 * 1000
  });
  const json = extractJsonFromGradle(r.stdout);
  json.gradleCommand = r.command;
  json.usingWrapper = r.usingWrapper;
  json.jdkDir = jdkDir;
  json.elapsedMs = r.elapsedMs;
  json.summary = summarizeResolution(json);
  json.cacheToken = saveResolveCache(json, body);
  return json;
}

/**
 * bundle / 其它 API 复用 resolve 结果时使用：
 * 优先取 cacheToken 命中的缓存（不存在或过期则回退实际跑 Gradle）。
 * fingerprint 不一致时也算 miss，避免参数变更后取到旧解析结果。
 */
async function resolveProjectOrCached(body) {
  const cached = getCachedResolve(body && body.cacheToken, body);
  if (cached) {
    return { ...cached, fromCache: true };
  }
  return resolveProject(body);
}

function summarizeResolution(resolveJson) {
  const modules = new Map();
  const projects = new Set();
  const artifacts = [];
  const failures = [];
  for (const r of resolveJson.results || []) {
    for (const c of r.components || []) {
      if (c.type === 'module') modules.set(c.group + ':' + c.module + ':' + c.version, c);
      if (c.type === 'project') projects.add(c.projectPath);
    }
    for (const a of r.artifacts || []) artifacts.push(a);
    for (const f of r.artifactFailures || []) failures.push({ label: r.label, failure: f });
    for (const u of r.unresolved || []) failures.push({ label: r.label, failure: u.failure || u.requested });
  }
  return {
    moduleCount: modules.size,
    projectCount: projects.size,
    artifactCount: artifacts.length,
    failureCount: failures.length,
    modules: [...modules.values()],
    projects: [...projects],
    failures
  };
}

function repoUrlsFromResolution(resolveJson, body) {
  // 页面填了源仓库覆盖时优先使用覆盖配置（normalizeRepoSpecs 已经做了 file:// 凭据保护）。
  const overrides = normalizeRepoSpecs(body);
  if (overrides.length) return overrides;
  const username = String(body.sourceUsername || '').trim();
  const password = String(body.sourcePassword || '');
  const allowInsecureProtocol = !!body.allowInsecureProtocol;
  const repos = [];
  for (const r of resolveJson.repositories || []) {
    if (!r || !r.url) continue;
    const u = String(r.url).trim();
    const httpLike = isProbablyHttpUrl(u);
    const fileLike = isFileUrl(u);
    if (!httpLike && !fileLike) continue;
    repos.push({
      name: r.name || 'detected',
      url: u,
      // 关键修复：file:// 仓库永远不附带 username/password，避免 Node 端把页面凭据误带进去做 Basic Auth。
      username: httpLike ? username : '',
      password: httpLike ? password : '',
      allowInsecureProtocol: httpLike ? allowInsecureProtocol : false
    });
  }
  return uniqueBy(repos, r => trimSlash(r.url).toLowerCase());
}

module.exports = {
  inspectProject,
  resolveProject,
  resolveProjectOrCached,
  getCachedResolve,
  summarizeResolution,
  repoUrlsFromResolution
};
