'use strict';

// 通用辅助：基础类型判断、字符串处理、文件与哈希、Maven 路径编码等。
// 该模块刻意保持无外部 IO 依赖以外的副作用，方便被其他模块大量复用。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const urlMod = require('url');

function nowIso() {
  return new Date().toISOString();
}

function userHome() {
  return os.homedir();
}

function isWin() {
  return process.platform === 'win32';
}

function exists(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

function ensureDirSync(p) {
  fs.mkdirSync(p, { recursive: true });
}

function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

function safeJsonParse(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function uniqueBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, x);
  }
  return [...m.values()];
}

function sanitizeFilename(s) {
  return String(s || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}

function isProbablyHttpUrl(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function isFileUrl(s) {
  // 兼容 Java URI toString 输出的单斜杠形式（如 file:/C:/Users/x/.m2/repository/）。
  return /^file:\/{1,3}[^/]/i.test(String(s || '').trim());
}

function trimSlash(s) {
  return String(s || '').replace(/\/+$/, '');
}

function encodePathSegments(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/');
}

function groupPath(group) {
  return String(group || '').replace(/\./g, '/');
}

/**
 * 从 project artifact 的源文件名中解析 classifier 与扩展名。
 * 例如源文件名 "engine-server-0.0.93.1-plain.jar"，gav={artifact:'engine-server', version:'0.0.93.1'}，
 * 应返回 { classifier: 'plain', ext: 'jar' }；
 * 不带 classifier 时返回 { classifier: null, ext: 'jar' }。
 * 当 archivesBaseName 与 gav.artifact 不一致或前缀对不上时不猜测 classifier，仅返回扩展名。
 */
function parseClassifiedJarFileName(srcFileName, gav) {
  const name = String(srcFileName || '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const artifact = String((gav && gav.artifact) || '');
  const version = String((gav && gav.version) || '');
  if (!artifact || !version) return { classifier: null, ext: ext || 'jar' };
  const prefix = artifact + '-' + version;
  if (stem === prefix) return { classifier: null, ext: ext || 'jar' };
  if (stem.startsWith(prefix + '-')) {
    const classifier = stem.slice(prefix.length + 1);
    return { classifier: classifier || null, ext: ext || 'jar' };
  }
  return { classifier: null, ext: ext || 'jar' };
}

function isSnapshotVersion(version) {
  return /-SNAPSHOT$/i.test(String(version || ''));
}

function algoHex(file, algo) {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest('hex');
}

function streamingHash(file, algo) {
  // 大文件用流式 hash，避免一次读到内存。
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 在单次文件读取里同时计算多种算法的哈希值，避免对同一个 jar 重复 I/O。
 * 返回 { algo: hex }。
 */
function multiHashStreaming(file, algos) {
  return new Promise((resolve, reject) => {
    const hashes = {};
    for (const a of algos) hashes[a] = crypto.createHash(a);
    const s = fs.createReadStream(file);
    s.on('data', d => { for (const a of algos) hashes[a].update(d); });
    s.on('error', reject);
    s.on('end', () => {
      const out = {};
      for (const a of algos) out[a] = hashes[a].digest('hex');
      resolve(out);
    });
  });
}

/**
 * 限制并发数的并行 map。保持输入顺序输出。每个 mapper 抛错不会中断整体，
 * 而是把错误对象捕获到 results[i].__error，调用方按需聚合。
 */
async function pMapWithLimit(items, mapper, limit = 8) {
  const arr = items || [];
  const total = arr.length;
  const results = new Array(total);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= total) break;
      try {
        results[i] = { ok: true, value: await mapper(arr[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e, item: arr[i] };
      }
    }
  };
  const workerCount = Math.max(1, Math.min(limit, total));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch (_) { return 0; }
}

function isRegularFile(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function sha1Text(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function fileUrlToLocalPath(fileUrl) {
  // Windows 下 new URL('file:///D:/x').pathname === '/D:/x'，直接拿来当本地路径会出错。
  // 必须用 Node 自带的 fileURLToPath，它会正确处理 Windows 盘符与 URL 编码。
  // 但 Java URI.toString 经常输出 file:/C:/... 单斜杠形式，Node 的 fileURLToPath 会拒绝；
  // 这里先做规范化补到 file:/// 三斜杠。
  const raw = String(fileUrl || '').trim();
  if (!raw) return '';
  let normalized = raw;
  if (/^file:\/[^/]/i.test(normalized)) normalized = normalized.replace(/^file:\//i, 'file:///');
  else if (/^file:\/\/[^/]/i.test(normalized)) normalized = normalized.replace(/^file:\/\//i, 'file:///');
  try { return urlMod.fileURLToPath(normalized); } catch (_) { return ''; }
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
}

module.exports = {
  nowIso,
  userHome,
  isWin,
  exists,
  ensureDirSync,
  toPosix,
  safeJsonParse,
  uniqueBy,
  sanitizeFilename,
  isProbablyHttpUrl,
  isFileUrl,
  trimSlash,
  encodePathSegments,
  groupPath,
  parseClassifiedJarFileName,
  isSnapshotVersion,
  isRegularFile,
  algoHex,
  streamingHash,
  multiHashStreaming,
  pMapWithLimit,
  fileSize,
  sha1Text,
  fileUrlToLocalPath,
  walkFiles
};
