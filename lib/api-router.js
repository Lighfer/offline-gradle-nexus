'use strict';

// HTTP API 路由。所有处理函数从各业务模块中聚合而来，保持本文件只负责分发与编解码。

const url = require('url');
const { nowIso, safeJsonParse } = require('./util');
const { scanJdks, defaultJdkDir } = require('./jdk');
const { inspectProject, resolveProject } = require('./inspect-resolve');
const { createBundle } = require('./bundle');
const { scanBundle, uploadBundle } = require('./bundle-upload');
const { verifyFatjar } = require('./fatjar-verify');

const APP_NAME = 'offline-gradle-nexus';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 50 * 1024 * 1024) reject(new Error('Request body too large'));
    });
    req.on('end', () => resolve(data ? safeJsonParse(data, {}) : {}));
    req.on('error', reject);
  });
}

const ROUTES = [
  { method: 'GET', path: '/api/health', handler: async () => ({ ok: true, app: APP_NAME, now: nowIso() }) },
  { method: 'GET', path: '/api/jdks', handler: async () => ({ jdks: scanJdks(), defaultJdkDir: defaultJdkDir() }) },
  { method: 'POST', path: '/api/inspect', handler: async (body) => inspectProject(body) },
  { method: 'POST', path: '/api/resolve', handler: async (body) => resolveProject(body) },
  { method: 'POST', path: '/api/download', handler: async (body) => createBundle(body) },
  { method: 'POST', path: '/api/scan-bundle', handler: async (body) => scanBundle(body) },
  { method: 'POST', path: '/api/upload', handler: async (body) => uploadBundle(body) },
  { method: 'POST', path: '/api/verify-fatjar', handler: async (body) => verifyFatjar(body) }
];

async function apiHandler(req, res) {
  const parsed = url.parse(req.url, true);
  const route = ROUTES.find(r => r.method === req.method && r.path === parsed.pathname);
  if (!route) return sendText(res, 404, 'Not found');
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const result = await route.handler(body);
    return sendJson(res, 200, result);
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message, stack: e.stack });
  }
}

module.exports = {
  apiHandler,
  APP_NAME
};
