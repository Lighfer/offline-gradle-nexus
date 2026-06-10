'use strict';

// 顶部状态条：检查服务、JDK 徽章。
// JDK 扫描结果由 ui/config.js 维护填充；header 只负责切换徽章文案与色彩。

import { $ } from '../dom.js';
import { api } from '../api.js';
import { log } from './log.js';

export function setupHeader() {
  const btn = $('btnHealth');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    try {
      const r = await api('/api/health');
      log('服务检查成功', r);
    } catch (e) {
      log('服务检查失败：' + e.message);
      alert(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

export function setJdkBadge(text, tone) {
  const badge = $('jdkBadge');
  if (!badge) return;
  badge.textContent = text;
  badge.className = 'chip ' + (tone === 'ok' ? 'chip-muted' : 'chip-muted');
  badge.title = text;
}
