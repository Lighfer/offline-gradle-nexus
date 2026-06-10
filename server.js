'use strict';

// Offline Gradle Nexus Tool 入口。
// 该文件只负责：
// - 创建 HTTP server；
// - 把请求转给 API 路由或静态资源处理器；
// - 打印启动信息。
// 业务逻辑均拆分到 lib/ 下的模块中，便于维护和单元测试。

const http = require('http');
const path = require('path');
const url = require('url');
const { apiHandler, APP_NAME } = require('./lib/api-router');
const { serveStatic } = require('./lib/static-server');

const PORT = Number(process.env.PORT || 39173);
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname || '';
  if (pathname.startsWith('/api/')) return apiHandler(req, res);
  return serveStatic(req, res, PUBLIC_DIR);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(APP_NAME + ' started: http://127.0.0.1:' + PORT + '/');
  console.log('按 Ctrl+C 退出。');
});
