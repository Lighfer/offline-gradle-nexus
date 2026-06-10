'use strict';

// 前端 fetch 包装：自动序列化 body、统一抛出错误信息（含服务端 stack）。

export async function api(path, body) {
  const init = { method: body ? 'POST' : 'GET' };
  if (body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  if (!res.ok || json.ok === false) {
    const msg = json && (json.error || json.message) ? (json.error || json.message) : ('HTTP ' + res.status);
    const err = new Error(msg);
    err.detail = json;
    throw err;
  }
  return json;
}
