'use strict';

// fatjar 一致性验证视图：摘要卡 → 结论横条 → 4 个结果 tab → 表格。
// 每个 tab 是独立的列、独立的搜索框；点击行展开行内详情；不再用大块 <pre>+JSON dump。

import { $, escapeHtml, formatBytes, debounce, copyToClipboard } from '../dom.js';
import { api } from '../api.js';
import { setState, state } from '../state.js';
import { startTimer } from '../progress.js';
import { log } from './log.js';
import { bodyBase } from './config.js';

// 4 个结果分类：onlyInFatjar 优先级最高（用户必须关注）。
const VERIFY_TABS = [
  { id: 'onlyInFatjar', name: '仅在 fatjar', tone: 'danger', description: 'fatjar 内嵌 jar 在 bundle 中找不到匹配；这些必须修复，否则下游构建会缺包。' },
  { id: 'shaMismatch', name: 'SHA1 不一致', tone: 'warn', description: 'fileName/坐标对得上但内容不同。多见于源仓库版本漂移、或本地缓存被替换。' },
  { id: 'matched', name: '完全匹配', tone: 'success', description: 'fileName + SHA1 全部一致，bundle 已覆盖该 jar。' },
  { id: 'onlyInBundle', name: '仅在 bundle', tone: 'muted', description: '一般是 testRuntime/buildscript/AP/plugin marker 等不会进入 fatjar 的依赖。' }
];

const verifyView = {
  result: null,
  activeTabId: 'onlyInFatjar',
  search: ''
};

export function setupVerify() {
  const btn = $('btnVerifyFatjar');
  if (!btn) return;
  btn.addEventListener('click', runVerify);
}

async function runVerify() {
  const btn = $('btnVerifyFatjar');
  const timer = startTimer(btn, '开始验证', ['打开 fatjar', '计算 SHA1', '索引 bundle', '比对']);
  try {
    const body = {
      ...bodyBase(),
      fatjarPath: $('fatjarPath').value.trim(),
      inferGavFromInnerJar: $('inferGavFromInnerJar').checked
    };
    const r = await api('/api/verify-fatjar', body);
    setState('verify', r);
    verifyView.result = r;
    // 默认聚焦最重要的 tab；若 onlyInFatjar 为 0 且其它有内容，自动落到 shaMismatch / matched。
    const s = r.summary || {};
    verifyView.activeTabId = s.onlyInFatjar > 0 ? 'onlyInFatjar'
      : s.shaMismatch > 0 ? 'shaMismatch'
      : s.matched > 0 ? 'matched' : 'onlyInBundle';
    verifyView.search = '';
    renderSummary();
    renderTabs();
    renderActive();
    log('fatjar 一致性验证完成', s);
  } catch (e) {
    log('fatjar 一致性验证失败：' + e.message);
    alert(e.message);
  } finally {
    timer.stop();
  }
}

function renderSummary() {
  const cards = $('verifySummaryCards');
  const verdict = $('verifyVerdict');
  const r = verifyView.result;
  if (!r || !cards || !verdict) return;
  const s = r.summary || {};
  cards.hidden = false;
  cards.innerHTML = `
    ${card('Matched', s.matched || 0, 'ok', `bundle 已覆盖 ${s.matched || 0} 个内嵌 jar`)}
    ${card('SHA1 不一致', s.shaMismatch || 0, (s.shaMismatch || 0) > 0 ? 'warn' : 'ok', '内容差异')}
    ${card('仅在 fatjar', s.onlyInFatjar || 0, (s.onlyInFatjar || 0) > 0 ? 'err' : 'ok', '必须关注')}
    ${card('仅在 bundle', s.onlyInBundle || 0, '', 'testRuntime/AP/buildscript 等')}
  `;
  verdict.hidden = false;
  if (s.consistent) {
    verdict.className = 'verdict-strip ok';
    verdict.innerHTML = `<span>结论：一致</span><span class="muted small">fatjar 内嵌 ${s.fatjarLibCount || 0} 个 jar 已被 bundle 完整覆盖。</span>`;
  } else {
    verdict.className = 'verdict-strip err';
    verdict.innerHTML = `<span>结论：不一致</span><span class="muted small">fatjar ${s.fatjarLibCount || 0} 个；bundle ${s.bundleJarCount || 0} 个；缺失 ${s.onlyInFatjar || 0}，SHA1 不一致 ${s.shaMismatch || 0}。</span>`;
  }
}

function card(label, value, tone, hint) {
  const cls = tone ? ' ' + tone : '';
  return `<div class="summary-card${cls}">
    <span class="label">${escapeHtml(label)}</span>
    <span class="value">${escapeHtml(value)}</span>
    <span class="muted small">${escapeHtml(hint || '')}</span>
  </div>`;
}

function renderTabs() {
  const wrap = $('verifyResultTabs');
  if (!wrap) return;
  const r = verifyView.result;
  wrap.innerHTML = '';
  if (!r) return;
  for (const t of VERIFY_TABS) {
    const arr = r[t.id] || [];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'result-tab' + (t.id === verifyView.activeTabId ? ' active' : '') + (t.tone ? ' ' + t.tone : '');
    btn.innerHTML = `<span>${escapeHtml(t.name)}</span><span class="badge ${countBadge(t, arr.length)}">${arr.length}</span>`;
    btn.addEventListener('click', () => {
      verifyView.activeTabId = t.id;
      verifyView.search = '';
      renderTabs();
      renderActive();
    });
    wrap.appendChild(btn);
  }
}

function countBadge(t, n) {
  if (t.id === 'matched') return n > 0 ? 'badge-success' : 'badge-soft';
  if (t.id === 'shaMismatch') return n > 0 ? 'badge-warning' : 'badge-soft';
  if (t.id === 'onlyInFatjar') return n > 0 ? 'badge-danger' : 'badge-soft';
  return 'badge-soft';
}

function renderActive() {
  const body = $('verifyResultBody');
  const r = verifyView.result;
  if (!body) return;
  if (!r) {
    body.innerHTML = '<p class="empty muted">填写 fatjar 路径后点击「开始验证」。</p>';
    return;
  }
  const tab = VERIFY_TABS.find(t => t.id === verifyView.activeTabId) || VERIFY_TABS[0];
  const all = r[tab.id] || [];
  const term = verifyView.search.toLowerCase().trim();
  const filtered = term ? all.filter(x => matchSearch(x, term, tab.id)) : all;

  body.innerHTML = `
    <div class="muted small" style="margin:6px 2px 10px">${escapeHtml(tab.description)}</div>
    <div class="table-wrap">
      <div class="toolbar-table">
        <input id="verifySearch" type="search" placeholder="按 fileName / GAV / 路径过滤" value="${escapeHtml(verifyView.search)}" />
        <span class="muted small">显示 ${filtered.length} / ${all.length}</span>
      </div>
      ${renderTable(tab.id, filtered)}
    </div>
  `;
  const search = $('verifySearch');
  if (search) search.addEventListener('input', debounce(() => {
    verifyView.search = search.value || '';
    renderActive();
    // 重新 render 后输入光标会丢失，再次定位输入框。
    const again = $('verifySearch');
    if (again) {
      again.focus();
      const v = again.value;
      again.setSelectionRange(v.length, v.length);
    }
  }, 200));
  bindRowExpansion(body);
  bindCopyButtons(body);
}

function matchSearch(x, term, tabId) {
  const fields = [];
  fields.push(x.fileName || '');
  fields.push(x.bundlePath || '');
  fields.push(x.fatjarPath || '');
  fields.push(x.relativePath || '');
  const gavs = [x.gav, x.fatjarGav, x.bundleGav].filter(Boolean);
  for (const g of gavs) fields.push(`${g.group || ''}:${g.artifact || ''}:${g.version || ''}${g.classifier ? ':' + g.classifier : ''}`);
  return fields.some(s => String(s).toLowerCase().includes(term));
}

function renderTable(tabId, rows) {
  if (!rows.length) return '<p class="empty muted">没有数据。</p>';
  if (tabId === 'matched') return tableMatched(rows);
  if (tabId === 'shaMismatch') return tableSha(rows);
  if (tabId === 'onlyInFatjar') return tableOnlyInFatjar(rows);
  if (tabId === 'onlyInBundle') return tableOnlyInBundle(rows);
  return '<p class="empty muted">未知分类。</p>';
}

function gavText(g) {
  if (!g) return '';
  const cls = g.classifier ? `:${g.classifier}` : '';
  return `${g.group || '-'}:${g.artifact || '-'}:${g.version || '-'}${cls}`;
}

function tableMatched(rows) {
  const body = rows.map((x, i) => `
    <tr data-i="${i}">
      <td><span class="truncate" title="${escapeHtml(x.fileName)}">${escapeHtml(x.fileName)}</span></td>
      <td>${escapeHtml(gavText(x.gav))}</td>
      <td class="col-narrow">${escapeHtml((x.sha1 || '').slice(0, 12))}…</td>
      <td class="col-num">${escapeHtml(formatBytes(x.size))}</td>
      <td><span class="truncate" title="${escapeHtml(x.bundlePath || '')}">${escapeHtml(x.bundlePath || '')}</span></td>
    </tr>
    <tr class="detail-row hidden" data-detail="${i}"><td colspan="5">${rowDetailMatched(x)}</td></tr>
  `).join('');
  return `<table class="data-table">
    <thead><tr><th>fileName</th><th>GAV</th><th>SHA1</th><th>size</th><th>bundle 路径</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function rowDetailMatched(x) {
  return `
    <div class="detail-row"><div class="detail-key">fatjar 路径</div><div class="detail-val">${escapeHtml(x.fatjarPath || '')} <button class="copy-btn" data-copy="${escapeHtml(x.fatjarPath || '')}">复制</button></div></div>
    <div class="detail-row"><div class="detail-key">bundle 路径</div><div class="detail-val">${escapeHtml(x.bundlePath || '')} <button class="copy-btn" data-copy="${escapeHtml(x.bundlePath || '')}">复制</button></div></div>
    <div class="detail-row"><div class="detail-key">SHA1</div><div class="detail-val">${escapeHtml(x.sha1 || '')}</div></div>
    <div class="detail-row"><div class="detail-key">匹配方式</div><div class="detail-val">${escapeHtml(x.matchedBy || 'gav')}</div></div>
  `;
}

function tableSha(rows) {
  const body = rows.map((x, i) => `
    <tr data-i="${i}">
      <td><span class="truncate" title="${escapeHtml(x.fileName)}">${escapeHtml(x.fileName)}</span></td>
      <td>${escapeHtml(gavText(x.bundleGav))}</td>
      <td class="col-narrow"><span class="badge badge-warning">不一致</span></td>
      <td class="col-num">${escapeHtml(formatBytes(x.fatjarSize))} / ${escapeHtml(formatBytes(x.bundleSize))}</td>
      <td><span class="truncate" title="${escapeHtml(x.bundlePath || '')}">${escapeHtml(x.bundlePath || '')}</span></td>
    </tr>
    <tr class="detail-row hidden" data-detail="${i}"><td colspan="5">${rowDetailSha(x)}</td></tr>
  `).join('');
  return `<table class="data-table">
    <thead><tr><th>fileName</th><th>bundle GAV</th><th>状态</th><th>fatjar / bundle size</th><th>bundle 路径</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function rowDetailSha(x) {
  return `
    <div class="detail-row"><div class="detail-key">fatjar SHA1</div><div class="detail-val">${escapeHtml(x.fatjarSha1 || '')}</div></div>
    <div class="detail-row"><div class="detail-key">bundle SHA1</div><div class="detail-val">${escapeHtml(x.bundleSha1 || '')}</div></div>
    <div class="detail-row"><div class="detail-key">fatjar GAV</div><div class="detail-val">${escapeHtml(gavText(x.fatjarGav))}</div></div>
    <div class="detail-row"><div class="detail-key">bundle GAV</div><div class="detail-val">${escapeHtml(gavText(x.bundleGav))}</div></div>
    <div class="detail-row"><div class="detail-key">bundle 路径</div><div class="detail-val">${escapeHtml(x.bundlePath || '')} <button class="copy-btn" data-copy="${escapeHtml(x.bundlePath || '')}">复制</button></div></div>
  `;
}

function tableOnlyInFatjar(rows) {
  const body = rows.map((x, i) => `
    <tr data-i="${i}">
      <td><span class="truncate" title="${escapeHtml(x.fileName)}">${escapeHtml(x.fileName)}</span></td>
      <td>${escapeHtml(gavText(x.gav))}</td>
      <td class="col-narrow">${escapeHtml((x.sha1 || '').slice(0, 12))}…</td>
      <td class="col-num">${escapeHtml(formatBytes(x.size))}</td>
      <td><span class="truncate" title="${escapeHtml(x.path || '')}">${escapeHtml(x.path || '')}</span></td>
    </tr>
    <tr class="detail-row hidden" data-detail="${i}"><td colspan="5">${rowDetailOnlyFat(x)}</td></tr>
  `).join('');
  return `<table class="data-table">
    <thead><tr><th>fileName</th><th>GAV</th><th>SHA1</th><th>size</th><th>fatjar 路径</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function rowDetailOnlyFat(x) {
  return `
    <div class="detail-row"><div class="detail-key">fatjar 路径</div><div class="detail-val">${escapeHtml(x.path || '')} <button class="copy-btn" data-copy="${escapeHtml(x.path || '')}">复制</button></div></div>
    <div class="detail-row"><div class="detail-key">SHA1</div><div class="detail-val">${escapeHtml(x.sha1 || '')}</div></div>
    <div class="detail-row"><div class="detail-key">GAV</div><div class="detail-val">${escapeHtml(gavText(x.gav))}</div></div>
    <div class="detail-row"><div class="detail-key">建议</div><div class="detail-val">在 bundle 中确认是否漏拉；多为 project dependency 的 plain jar 或 buildscript classpath。</div></div>
  `;
}

function tableOnlyInBundle(rows) {
  const body = rows.map((x, i) => `
    <tr data-i="${i}">
      <td><span class="truncate" title="${escapeHtml(x.fileName)}">${escapeHtml(x.fileName)}</span></td>
      <td>${escapeHtml(gavText(x.gav))}</td>
      <td class="col-num">${escapeHtml(formatBytes(x.size))}</td>
      <td><span class="truncate" title="${escapeHtml(x.relativePath || '')}">${escapeHtml(x.relativePath || '')}</span></td>
    </tr>
    <tr class="detail-row hidden" data-detail="${i}"><td colspan="4">${rowDetailOnlyBundle(x)}</td></tr>
  `).join('');
  return `<table class="data-table">
    <thead><tr><th>fileName</th><th>GAV</th><th>size</th><th>bundle 路径</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function rowDetailOnlyBundle(x) {
  return `
    <div class="detail-row"><div class="detail-key">bundle 路径</div><div class="detail-val">${escapeHtml(x.relativePath || '')} <button class="copy-btn" data-copy="${escapeHtml(x.relativePath || '')}">复制</button></div></div>
    <div class="detail-row"><div class="detail-key">GAV</div><div class="detail-val">${escapeHtml(gavText(x.gav))}</div></div>
  `;
}

function bindRowExpansion(scope) {
  const rows = scope.querySelectorAll('tr[data-i]');
  for (const tr of rows) {
    tr.addEventListener('click', ev => {
      if (ev.target && ev.target.classList && ev.target.classList.contains('copy-btn')) return;
      const i = tr.dataset.i;
      const detail = scope.querySelector(`tr.detail-row[data-detail="${i}"]`);
      if (!detail) return;
      const open = !detail.classList.contains('hidden');
      detail.classList.toggle('hidden');
      tr.classList.toggle('expanded', !open);
    });
  }
}

function bindCopyButtons(scope) {
  for (const btn of scope.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async ev => {
      ev.stopPropagation();
      const ok = await copyToClipboard(btn.dataset.copy || '');
      btn.textContent = ok ? '已复制' : '失败';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    });
  }
}
