'use strict';

// 前端全局状态，被各 UI 模块共享读取。
// 这里只放结构化数据，不放 DOM 节点；DOM 由对应的 ui/* 模块管理。

export const state = {
  jdks: null,         // /api/jdks 响应
  inspect: null,      // /api/inspect 响应
  resolve: null,      // /api/resolve 响应（也被 download 复用）
  bundleScan: null,   // /api/scan-bundle 响应
  verify: null,       // /api/verify-fatjar 响应
  upload: null        // /api/upload 响应
};

export function setState(key, value) {
  state[key] = value;
}
