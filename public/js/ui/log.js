'use strict';

// 底部日志抽屉：所有 UI 模块通过 log() 写入；点击 toggle 上拉/下拉。
// 抽屉默认收起，第一次写日志时不强制弹出，避免干扰；用户主动展开后保持打开。

import { $ } from '../dom.js';

let count = 0;

export function setupLogDrawer() {
  const drawer = $('logDrawer');
  const toggle = $('logToggle');
  const clearBtn = $('btnClearLog');
  if (!drawer || !toggle || !clearBtn) return;

  toggle.addEventListener('click', () => {
    const open = drawer.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  clearBtn.addEventListener('click', () => {
    $('log').textContent = '';
    count = 0;
    refreshCount();
  });
}

export function log(msg, obj) {
  const node = $('log');
  if (!node) return;
  const ts = new Date().toLocaleTimeString();
  const line = `[${ts}] ${msg}` + (obj !== undefined ? '\n' + safeStringify(obj) : '') + '\n';
  node.textContent = line + node.textContent;
  count++;
  refreshCount();
}

function safeStringify(obj) {
  try { return JSON.stringify(obj, null, 2); } catch (_) { return String(obj); }
}

function refreshCount() {
  const badge = $('logCount');
  if (badge) badge.textContent = count > 999 ? '999+' : String(count);
}
