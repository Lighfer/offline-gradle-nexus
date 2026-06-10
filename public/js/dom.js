'use strict';

// 极简 DOM/格式化工具，仅服务前端各 UI 模块。
// 不依赖任何第三方库，统一处理 ID 选择、HTML 转义、字节/秒数格式化等。

export const $ = id => document.getElementById(id);
export const $$ = sel => document.querySelectorAll(sel);

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
    else if (k === 'on') for (const [ek, eh] of Object.entries(v)) node.addEventListener(ek, eh);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function formatSeconds(ms) {
  if (ms == null) return '';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(2) + 's';
  return Math.floor(s / 60) + 'm' + (s % 60).toFixed(1) + 's';
}

export function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  const n = Number(bytes);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
    return true;
  } catch (_) {
    // 旧浏览器或非安全上下文回退方案：临时 textarea + execCommand。
    const ta = document.createElement('textarea');
    ta.value = String(text || '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* noop */ }
    document.body.removeChild(ta);
    return ok;
  }
}

/** 受控 debounce，给搜索框等使用。 */
export function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}
