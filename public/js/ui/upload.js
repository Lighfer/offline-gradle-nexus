'use strict';

// 上传 Nexus 视图：扫描本地 bundle、生成上传计划/实际上传，并表格化展示结果。
// v3.4：失败行可展开查看 statusCode/Content-Type/响应体；支持「仅重试失败项」复用上次报告。

import { $, escapeHtml, formatBytes, debounce, copyToClipboard } from '../dom.js';
import { api } from '../api.js';
import { setState } from '../state.js';
import { startTimer } from '../progress.js';
import { log } from './log.js';
import { bodyBase } from './config.js';

const uploadView = {
  scan: null,
  upload: null,
  search: '',
  expanded: new Set()
};

export function setupUpload() {
  const scanBtn = $('btnScanBundle');
  const upBtn = $('btnUpload');
  const retryBtn = $('btnRetryFailed');
  if (scanBtn) scanBtn.addEventListener('click', runScan);
  if (upBtn) upBtn.addEventListener('click', runUpload);
  if (retryBtn) retryBtn.addEventListener('click', runRetryFailed);
  refreshRetryButton();
}

function refreshRetryButton() {
  const btn = $('btnRetryFailed');
  const hint = $('retryHint');
  if (!btn) return;
  const r = uploadView.upload;
  const failed = r ? Number(r.failed || 0) : 0;
  const reportPath = r ? r.reportPath : null;
  const enable = !!reportPath && failed > 0;
  btn.disabled = !enable;
  if (hint) {
    if (!r) hint.textContent = '';
    else if (failed > 0 && reportPath) hint.textContent = `可对 ${failed} 个失败项发起重试，无需重新扫描或全量重传`;
    else if (failed === 0 && r.total != null) hint.textContent = '当前没有失败项可以重试';
    else hint.textContent = '';
  }
}

function uploadCommonBody() {
  return {
    ...bodyBase(),
    targetBaseUrl: $('targetBaseUrl').value.trim(),
    targetRepository: $('targetRepository').value.trim(),
    releaseRepository: $('releaseRepository').value.trim(),
    snapshotRepository: $('snapshotRepository').value.trim(),
    targetUsername: $('targetUsername').value.trim(),
    targetPassword: $('targetPassword').value,
    targetTrustAllSsl: $('targetTrustAllSsl').checked
  };
}

async function runScan() {
  const btn = $('btnScanBundle');
  const timer = startTimer(btn, '扫描本地导出目录');
  try {
    const r = await api('/api/scan-bundle', bodyBase());
    setState('bundleScan', r);
    uploadView.scan = r;
    renderScanSummary(r);
    log('扫描本地导出目录完成', r);
  } catch (e) {
    log('扫描本地导出目录失败：' + e.message);
    alert(e.message);
  } finally {
    timer.stop();
  }
}

async function runUpload() {
  const btn = $('btnUpload');
  const dryRun = $('dryRunUpload').checked;
  const stages = dryRun ? ['生成上传计划'] : ['连接 Nexus', '上传 Maven Layout', '汇总报告'];
  const timer = startTimer(btn, dryRun ? '生成上传计划' : '上传中', stages);
  try {
    const body = { ...uploadCommonBody(), dryRunUpload: dryRun };
    const r = await api('/api/upload', body);
    setState('upload', r);
    uploadView.upload = r;
    uploadView.search = '';
    uploadView.expanded.clear();
    renderUploadSummary(r);
    renderUploadTable();
    refreshRetryButton();
    logUploadResult(dryRun ? '上传计划生成完成' : '上传完成', r);
  } catch (e) {
    log('上传失败：' + e.message);
    alert(e.message);
  } finally {
    timer.stop();
  }
}

async function runRetryFailed() {
  const prev = uploadView.upload;
  if (!prev || !prev.reportPath) {
    alert('当前没有可用的上传报告，无法重试');
    return;
  }
  if (!Number(prev.failed || 0)) {
    alert('当前报告里没有失败项');
    return;
  }
  const btn = $('btnRetryFailed');
  const dryRun = $('dryRunUpload').checked;
  const timer = startTimer(btn, dryRun ? '生成重试计划' : '重试失败项', ['加载上次报告', '重新 PUT', '汇总']);
  try {
    const body = {
      ...uploadCommonBody(),
      dryRunUpload: dryRun,
      retryFailedOnly: true,
      retryReportPath: prev.reportPath
    };
    const r = await api('/api/upload', body);
    setState('upload', r);
    uploadView.upload = r;
    uploadView.search = '';
    uploadView.expanded.clear();
    renderUploadSummary(r);
    renderUploadTable();
    refreshRetryButton();
    logUploadResult(dryRun ? '重试计划生成完成' : '重试失败项完成', r);
  } catch (e) {
    log('重试失败项时出错：' + e.message);
    alert(e.message);
  } finally {
    timer.stop();
  }
}

function logUploadResult(prefix, r) {
  const failedList = (r.items || [])
    .filter(it => it && it.status === 'failed')
    .slice(0, 20)
    .map(it => ({
      path: it.relativePath,
      statusCode: it.statusCode || null,
      detail: it.detail || it.error || '',
      url: it.url
    }));
  log(prefix, {
    mode: r.mode || 'full',
    total: r.total,
    success: r.success,
    failed: r.failed,
    skipped: r.skipped,
    reportPath: r.reportPath,
    baseReportPath: r.baseReportPath || null,
    failedSamples: failedList
  });
}

function renderScanSummary(r) {
  const node = $('bundleSummary');
  if (!node) return;
  node.hidden = false;
  const exts = Object.entries(r.extCounts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="badge badge-soft">${escapeHtml(k)} · ${v}</span>`)
    .join(' ');
  const ms = r.manifestSummary || {};
  node.innerHTML = `
    <span class="info-pill"><strong>导出目录</strong> <code>${escapeHtml(r.outputDir || '')}</code></span>
    <span class="info-pill"><strong>repo 文件数</strong> ${r.fileCount || 0}</span>
    ${ms.artifactFiles != null ? `<span class="info-pill"><strong>Artifact</strong> ${ms.artifactFiles}</span>` : ''}
    ${ms.metadataFiles != null ? `<span class="info-pill"><strong>Metadata</strong> ${ms.metadataFiles}</span>` : ''}
    ${ms.errors != null ? `<span class="info-pill ${ms.errors ? 'err' : ''}"><strong>Errors</strong> ${ms.errors}</span>` : ''}
    <span class="info-pill">${exts || '<span class="muted">无文件</span>'}</span>
  `;
}

function renderUploadSummary(r) {
  const node = $('uploadSummary');
  if (!node) return;
  node.hidden = false;
  const modeBadge = r.mode === 'retry'
    ? '<span class="badge badge-primary">重试模式</span>'
    : '<span class="badge badge-soft">全量模式</span>';
  node.innerHTML = `
    <span class="info-pill">${modeBadge}</span>
    <span class="info-pill"><strong>总数</strong> ${r.total || 0}</span>
    <span class="info-pill"><strong class="ok">成功</strong> ${r.success || 0}</span>
    <span class="info-pill"><strong class="err">失败</strong> ${r.failed || 0}</span>
    <span class="info-pill"><strong>Dry-run / 跳过</strong> ${r.skipped || 0}</span>
    ${r.reportPath ? `<span class="info-pill"><strong>报告</strong> <code>${escapeHtml(r.reportPath)}</code> <button class="copy-btn" data-copy="${escapeHtml(r.reportPath)}">复制</button></span>` : ''}
    ${r.baseReportPath ? `<span class="info-pill"><strong>基于</strong> <code>${escapeHtml(r.baseReportPath)}</code></span>` : ''}
  `;
  for (const btn of node.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async () => {
      const ok = await copyToClipboard(btn.dataset.copy || '');
      btn.textContent = ok ? '已复制' : '失败';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    });
  }
}

function renderUploadTable() {
  const wrap = $('uploadTable');
  if (!wrap) return;
  const r = uploadView.upload;
  if (!r) {
    wrap.innerHTML = '<p class="empty muted">扫描或上传后会展示完整列表。</p>';
    return;
  }
  const items = r.items || [];
  const term = uploadView.search.toLowerCase().trim();
  const filtered = term ? items.filter(it => searchUpload(it, term)) : items;
  const failedCount = items.filter(it => it.status === 'failed').length;
  wrap.innerHTML = `
    <div class="toolbar-table">
      <input id="uploadSearch" type="search" placeholder="按 path / repository / status / 错误关键字过滤" value="${escapeHtml(uploadView.search)}" />
      <span class="muted small">显示 ${filtered.length} / ${items.length}</span>
      ${failedCount > 0 ? `<button id="btnFilterFailed" class="btn btn-mini btn-ghost" type="button">只看失败 (${failedCount})</button>` : ''}
      ${failedCount > 0 ? `<button id="btnExpandAllFailed" class="btn btn-mini btn-ghost" type="button">展开全部失败详情</button>` : ''}
    </div>
    ${tableUpload(filtered)}
  `;
  bindTableInteractions(items);
}

function bindTableInteractions(allItems) {
  const search = $('uploadSearch');
  if (search) search.addEventListener('input', debounce(() => {
    uploadView.search = search.value || '';
    renderUploadTable();
    const again = $('uploadSearch');
    if (again) {
      again.focus();
      const v = again.value;
      again.setSelectionRange(v.length, v.length);
    }
  }, 200));
  const onlyFailed = $('btnFilterFailed');
  if (onlyFailed) onlyFailed.addEventListener('click', () => {
    uploadView.search = 'failed';
    renderUploadTable();
  });
  const expandAll = $('btnExpandAllFailed');
  if (expandAll) expandAll.addEventListener('click', () => {
    for (const it of allItems) {
      if (it.status === 'failed') uploadView.expanded.add(it.relativePath);
    }
    renderUploadTable();
  });
  const wrap = $('uploadTable');
  if (!wrap) return;
  for (const btn of wrap.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async ev => {
      ev.stopPropagation();
      const ok = await copyToClipboard(btn.dataset.copy || '');
      btn.textContent = ok ? '已复制' : '失败';
      setTimeout(() => { btn.textContent = '复制'; }, 1200);
    });
  }
  for (const btn of wrap.querySelectorAll('.row-toggle')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (!key) return;
      if (uploadView.expanded.has(key)) uploadView.expanded.delete(key);
      else uploadView.expanded.add(key);
      renderUploadTable();
    });
  }
}

function searchUpload(it, term) {
  return [it.relativePath, it.repository, it.status, it.error, it.detail, it.bodySnippet, it.url, it.contentType]
    .filter(Boolean)
    .some(s => String(s).toLowerCase().includes(term));
}

function tableUpload(rows) {
  if (!rows.length) return '<p class="empty muted">没有数据。</p>';
  const body = rows.map(it => renderUploadRow(it)).join('');
  return `<table class="data-table">
    <thead><tr>
      <th style="width: 30px"></th>
      <th>relativePath</th>
      <th>repository</th>
      <th>size</th>
      <th>status</th>
      <th>错误 / URL</th>
    </tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderUploadRow(it) {
  const pill = statusPill(it.status);
  const url = it.url || '';
  const key = it.relativePath || url;
  const expanded = uploadView.expanded.has(key);
  const failed = it.status === 'failed';
  const toggleBtn = failed
    ? `<button class="row-toggle" type="button" aria-expanded="${expanded}" data-key="${escapeHtml(key)}" title="展开/收起失败详情">${expanded ? '−' : '+'}</button>`
    : '';
  const errCell = failed
    ? `<span class="truncate" title="${escapeHtml(it.detail || it.error || '')}">${escapeHtml(it.detail || it.error || '')}</span>`
    : `<span class="muted truncate" title="${escapeHtml(url)}">${escapeHtml(url)}</span>`;
  const main = `<tr>
    <td class="col-narrow">${toggleBtn}</td>
    <td><span class="truncate" title="${escapeHtml(it.relativePath)}">${escapeHtml(it.relativePath)}</span></td>
    <td class="col-narrow">${escapeHtml(it.repository || '-')}</td>
    <td class="col-num">${escapeHtml(formatBytes(it.size))}</td>
    <td class="col-status">${pill}${it.statusCode ? ` <span class="muted small">${it.statusCode}</span>` : ''}</td>
    <td>${errCell}<button class="copy-btn" data-copy="${escapeHtml(url)}">复制 URL</button></td>
  </tr>`;
  if (!failed || !expanded) return main;
  return main + `<tr class="detail-row"><td colspan="6">${renderFailureDetail(it)}</td></tr>`;
}

function renderFailureDetail(it) {
  const prev = it.previousAttempt;
  const rows = [];
  rows.push(['HTTP 状态', it.statusCode != null ? String(it.statusCode) : '(无响应)']);
  if (it.error) rows.push(['错误信息', it.error]);
  if (it.contentType) rows.push(['Content-Type', it.contentType]);
  if (it.size != null) rows.push(['大小', formatBytes(it.size)]);
  rows.push(['PUT URL', it.url || '']);
  if (it.repository) rows.push(['仓库', it.repository]);
  if (prev) {
    rows.push(['上次尝试', `HTTP ${prev.statusCode || '?'} | ${prev.error || prev.bodySnippet || ''}`]);
  }
  const html = rows
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd><code>${escapeHtml(String(v))}</code></dd>`)
    .join('');
  const body = it.bodySnippet
    ? `<dt>响应正文</dt><dd><pre>${escapeHtml(String(it.bodySnippet))}</pre></dd>`
    : '';
  return `<dl class="upload-detail">${html}${body}</dl>`;
}

function statusPill(status) {
  const s = String(status || '');
  if (s === 'uploaded') return '<span class="status-pill uploaded">uploaded</span>';
  if (s === 'previously-uploaded') return '<span class="status-pill previously">previously</span>';
  if (s === 'failed') return '<span class="status-pill failed">failed</span>';
  if (s === 'dry-run') return '<span class="status-pill dryrun">dry-run</span>';
  return `<span class="status-pill dryrun">${escapeHtml(s)}</span>`;
}
