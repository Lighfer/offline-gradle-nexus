'use strict';

// 统一封装的 HTTP/HTTPS 客户端：支持 Buffer 模式与流式落盘模式。
// Buffer 模式给小响应（POM/.module）用；流式模式用于 wrapper distribution 等大文件下载。

const http = require('http');
const https = require('https');
const fs = require('fs');

function buildAuthHeader(username, password) {
  const u = String(username || '');
  if (!u.length) return null;
  return 'Basic ' + Buffer.from(u + ':' + String(password || '')).toString('base64');
}

function buildRequestOptions(requestUrl, method, options) {
  const u = new URL(requestUrl);
  const headers = { ...(options.headers || {}) };
  const auth = buildAuthHeader(options.username, options.password);
  if (auth) headers.Authorization = auth;
  return {
    lib: u.protocol === 'https:' ? https : http,
    requestOptions: {
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      timeout: options.timeoutMs || 120000
    }
  };
}

/**
 * 把响应整体读到 Buffer，适合小文件、元数据请求。
 * GET 请求支持 30x 重定向；其他方法（PUT 等）不跟随重定向，避免破坏上传语义。
 */
function httpRequestBuffer(method, requestUrl, options = {}, bodyStream = null) {
  const maxRedirects = options.maxRedirects != null ? options.maxRedirects : 5;
  return new Promise((resolve) => {
    const doRequest = (currentUrl, remaining) => {
      const { lib, requestOptions } = buildRequestOptions(currentUrl, method, options);
      const req = lib.request(requestOptions, res => {
        const code = res.statusCode || 0;
        if (method === 'GET' && code >= 300 && code < 400 && res.headers.location && remaining > 0) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          res.resume();
          return doRequest(nextUrl, remaining - 1);
        }
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({ statusCode: code, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', err => resolve({ error: err }));
      if (bodyStream) bodyStream.pipe(req); else req.end();
    };
    doRequest(requestUrl, maxRedirects);
  });
}

/**
 * 流式把响应写到文件，适合大文件（Gradle distribution）。
 * 支持 30x 重定向（services.gradle.org 经常 307 跳转到 downloads.gradle.org）。
 * 返回 { statusCode, error?, redirects? }。
 */
function httpDownloadToFile(requestUrl, destFile, options = {}) {
  const maxRedirects = options.maxRedirects != null ? options.maxRedirects : 5;
  return new Promise((resolve) => {
    const redirects = [];
    const doRequest = (currentUrl, remaining) => {
      const { lib, requestOptions } = buildRequestOptions(currentUrl, 'GET', options);
      const req = lib.request(requestOptions, res => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && remaining > 0) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          redirects.push({ from: currentUrl, to: nextUrl, statusCode: code });
          res.resume();
          return doRequest(nextUrl, remaining - 1);
        }
        if (code < 200 || code >= 300) {
          res.resume();
          return resolve({ statusCode: code, error: 'HTTP ' + code, redirects });
        }
        const out = fs.createWriteStream(destFile);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ statusCode: code, redirects })));
        out.on('error', err => resolve({ statusCode: code, error: err.message, redirects }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', err => resolve({ error: err.message, redirects }));
      req.end();
    };
    doRequest(requestUrl, maxRedirects);
  });
}

function inferContentType(file) {
  // Nexus 3 maven hosted 仓库对 PUT 的 Content-Type 不严格要求，但带上更稳妥。
  const lower = String(file).toLowerCase();
  if (lower.endsWith('.jar')) return 'application/java-archive';
  if (lower.endsWith('.pom') || lower.endsWith('.xml')) return 'application/xml';
  if (lower.endsWith('.module') || lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.sha1') || lower.endsWith('.md5') || lower.endsWith('.sha256') || lower.endsWith('.sha512')) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * PUT 上传单个文件到 Nexus 3 maven hosted。
 */
function putFile(requestUrl, file, options = {}) {
  return new Promise((resolve) => {
    const u = new URL(requestUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
      'content-length': fs.statSync(file).size,
      'content-type': options.contentType || inferContentType(file)
    };
    const auth = buildAuthHeader(options.username, options.password);
    if (auth) headers.Authorization = auth;
    const req = lib.request({
      method: 'PUT',
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      timeout: options.timeoutMs || 180000
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8').slice(0, 1000);
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, statusCode: res.statusCode, bodySnippet: bodyText });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve({ ok: false, error: err.message }));
    fs.createReadStream(file).pipe(req);
  });
}

module.exports = {
  httpRequestBuffer,
  httpDownloadToFile,
  putFile,
  inferContentType
};
