'use strict';

// Gradle 工程识别：触发 /api/inspect、填充模块下拉、显示工程信息条与仓库表格。

import { $, escapeHtml, formatSeconds, copyToClipboard } from '../dom.js';
import { api } from '../api.js';
import { setState } from '../state.js';
import { startTimer } from '../progress.js';
import { log } from './log.js';
import { bodyBase } from './config.js';

export function setupInspect() {
  const btn = $('btnInspect');
  if (!btn) return;
  btn.addEventListener('click', runInspect);
}

async function runInspect() {
  const btn = $('btnInspect');
  const timer = startTimer(btn, '识别 Gradle 工程', ['启动 Gradle', '加载多模块', '汇总信息']);
  try {
    const r = await api('/api/inspect', bodyBase());
    setState('inspect', r);
    fillProjects(r.projects || []);
    renderInspectInfo(r);
    renderRepos(r.repositories || []);
    log(`Gradle 工程识别完成（${formatSeconds(r.elapsedMs)}）`, {
      projects: (r.projects || []).length,
      repositories: (r.repositories || []).length,
      pluginRequests: (r.pluginRequests || []).length,
      wrapper: r.wrapper && r.wrapper.distributionUrl
    });
  } catch (e) {
    log('Gradle 工程识别失败：' + e.message);
    alert(e.message);
  } finally {
    timer.stop();
  }
}

function fillProjects(projects) {
  const sel = $('targetProject');
  if (!sel) return;
  sel.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.path;
    const gav = `${p.group || '?'}:${p.artifact || p.name}:${p.version || '?'}`;
    opt.textContent = `${p.path}  (${gav})`;
    sel.appendChild(opt);
  }
}

function renderInspectInfo(r) {
  const info = $('inspectInfo');
  if (!info) return;
  const projects = (r.projects || []).length;
  const wrapper = r.wrapper && r.wrapper.distributionUrl;
  info.classList.add('toolbar-info-active');
  info.innerHTML = [
    `<span class="info-pill"><strong>Gradle</strong> ${escapeHtml(r.gradleVersion || '')}</span>`,
    `<span class="info-pill"><strong>JDK</strong> ${escapeHtml(r.javaHome || '')}</span>`,
    `<span class="info-pill"><strong>模块</strong> ${projects}</span>`,
    `<span class="info-pill"><strong>Wrapper</strong> ${r.usingWrapper ? '是' : '否'}</span>`,
    `<span class="info-pill"><strong>用时</strong> ${escapeHtml(formatSeconds(r.elapsedMs))}</span>`,
    wrapper ? `<span class="info-pill"><strong>Distribution</strong> <code>${escapeHtml(wrapper)}</code></span>` : ''
  ].join(' ');
}

export function renderRepos(repos) {
  const wrap = $('repoTable');
  const count = $('repoCount');
  if (!wrap) return;
  const cleaned = (repos || []).filter(r => r && r.url);
  if (count) count.textContent = String(cleaned.length);
  if (!cleaned.length) {
    wrap.innerHTML = '<p class="empty muted">尚未识别仓库。</p>';
    return;
  }
  // 表格化展示仓库列表，比 pre+JSON 直观；URL 单元格附带复制按钮。
  const rows = cleaned.map((r, i) => {
    const scope = r.scope || '-';
    const project = r.project || '-';
    const name = r.name || '-';
    const url = r.url;
    const cred = r.hasCredentials === true ? '<span class="badge badge-warning">有凭据</span>'
      : r.hasCredentials === false ? '<span class="badge badge-soft">无凭据</span>'
      : '<span class="badge badge-soft">未探测</span>';
    return `<tr data-i="${i}">
      <td class="col-narrow">${escapeHtml(scope)}</td>
      <td class="col-narrow">${escapeHtml(project)}</td>
      <td>${escapeHtml(name)}</td>
      <td><span class="truncate" title="${escapeHtml(url)}">${escapeHtml(url)}</span></td>
      <td class="col-narrow">${cred} <button class="copy-btn" data-copy="${escapeHtml(url)}">复制</button></td>
    </tr>`;
  }).join('');
  wrap.innerHTML = `<table class="data-table">
    <thead><tr><th>Scope</th><th>Project</th><th>Name</th><th>URL</th><th>凭据</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  for (const btn of wrap.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async ev => {
      ev.stopPropagation();
      const ok = await copyToClipboard(btn.dataset.copy || '');
      btn.textContent = ok ? '已复制' : '失败';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    });
  }
}
