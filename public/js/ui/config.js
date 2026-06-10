'use strict';

// 基础配置 + 源仓库覆盖配置面板。
// 仅负责读写表单值与 JDK 扫描；与具体业务（inspect/resolve/download）解耦。

import { $, escapeHtml } from '../dom.js';
import { api } from '../api.js';
import { setState } from '../state.js';
import { startTimer } from '../progress.js';
import { log } from './log.js';
import { setJdkBadge } from './header.js';

/** 把表单基础字段汇总成 POST body 的公共部分。 */
export function bodyBase() {
  return {
    workDir: $('workDir').value.trim(),
    jdkDir: $('jdkDir').value.trim(),
    gradleUserHome: $('gradleUserHome').value.trim(),
    outputDir: $('outputDir').value.trim(),
    sourceRepos: $('sourceRepos').value.trim(),
    sourceUsername: $('sourceUsername').value.trim(),
    sourcePassword: $('sourcePassword').value,
    allowInsecureProtocol: $('allowInsecureProtocol').checked,
    trustAllSsl: $('trustAllSsl').checked
  };
}

export function setupConfigPanel() {
  const btn = $('btnScanJdks');
  if (!btn) return;
  btn.addEventListener('click', () => scanJdks(true));
  // 启动时自动扫描 JDK，减少首次配置成本；不强制覆盖用户已有 jdkDir。
  scanJdks(false);
}

async function scanJdks(byUser) {
  const btn = $('btnScanJdks');
  const stop = startTimer(btn, '扫描 JDK').stop;
  try {
    const r = await api('/api/jdks');
    setState('jdks', r);
    if (!$('jdkDir').value && r.defaultJdkDir) $('jdkDir').value = r.defaultJdkDir;
    renderJdkList(r);
    refreshJdkBadge(r);
    if (byUser) log('JDK 扫描完成', r);
  } catch (e) {
    log('JDK 扫描失败：' + e.message);
    if (byUser) alert(e.message);
  } finally {
    stop && stop();
  }
}

function renderJdkList(r) {
  const node = $('jdkList');
  if (!node) return;
  const list = (r && r.jdks) || [];
  if (!list.length) {
    node.innerHTML = '<span class="muted small">未在 ~/.jdks 下发现可用 JDK，可手动指定 JDK 目录。</span>';
    return;
  }
  node.innerHTML = list.map(j => {
    const major = (j.version && j.version.major) || '?';
    return `<span class="badge badge-soft" title="${escapeHtml(j.dir)}">Java ${escapeHtml(major)} · ${escapeHtml(short(j.dir))}</span>`;
  }).join(' ');
}

function refreshJdkBadge(r) {
  const list = (r && r.jdks) || [];
  if (!list.length) { setJdkBadge('JDK：未发现', 'warn'); return; }
  const def = (r && r.defaultJdkDir) || list[0].dir;
  const matched = list.find(j => j.dir === def) || list[0];
  const major = (matched.version && matched.version.major) || '?';
  setJdkBadge(`JDK ${major} · ${short(matched.dir)}`, 'ok');
}

function short(dir) {
  if (!dir) return '';
  const s = String(dir);
  if (s.length <= 36) return s;
  return s.slice(0, 12) + '…' + s.slice(-22);
}
