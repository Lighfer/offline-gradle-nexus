'use strict';

// 前端入口：初始化各 UI 模块，绑定分析/下载按钮，维护 step tabs 切换。

import { $, $$, escapeHtml, formatSeconds } from './dom.js';
import { api } from './api.js';
import { setState, state } from './state.js';
import { startTimer } from './progress.js';
import { setupHeader } from './ui/header.js';
import { setupConfigPanel, bodyBase } from './ui/config.js';
import { setupInspect, renderRepos } from './ui/inspect.js';
import { setupTreeView, renderResolve } from './ui/tree.js';
import { setupVerify } from './ui/verify.js';
import { setupUpload } from './ui/upload.js';
import { setupLogDrawer, log } from './ui/log.js';

function main() {
  setupHeader();
  setupLogDrawer();
  setupConfigPanel();
  setupInspect();
  setupTreeView();
  setupVerify();
  setupUpload();
  setupStepTabs();
  setupAnalyzeActions();
}

function setupStepTabs() {
  const tabs = $$('.step-tab');
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      for (const t of tabs) {
        const active = t.dataset.tab === target;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', String(active));
      }
      for (const panel of $$('.step-panel')) {
        panel.classList.toggle('hidden', panel.id !== 'tab-' + target);
      }
    });
  }
}

function setupAnalyzeActions() {
  const resolveBtn = $('btnResolve');
  const downloadBtn = $('btnDownload');
  if (resolveBtn) resolveBtn.addEventListener('click', runResolve);
  if (downloadBtn) downloadBtn.addEventListener('click', runDownload);
}

function resolveBody() {
  const main = $('mainConfiguration').value;
  const configs = [main];
  if ($('includeTestRuntime').checked && !configs.includes('testRuntimeClasspath')) configs.push('testRuntimeClasspath');
  if ($('includeAnnotationProcessor').checked) {
    if (!configs.includes('annotationProcessor')) configs.push('annotationProcessor');
    if (!configs.includes('testAnnotationProcessor')) configs.push('testAnnotationProcessor');
  }
  return {
    ...bodyBase(),
    targetProject: $('targetProject').value || ':',
    configurations: configs,
    includeBuildscript: $('includeBuildscript').checked,
    includePlugins: $('includePlugins').checked,
    includeSpringBootBundled: $('includeSpringBootBundled') ? $('includeSpringBootBundled').checked : true,
    fallbackProjectGroup: $('fallbackProjectGroup').value.trim(),
    fallbackProjectVersion: $('fallbackProjectVersion').value.trim()
  };
}

function downloadBody() {
  const cacheToken = state.resolve && state.resolve.cacheToken ? state.resolve.cacheToken : '';
  return {
    ...resolveBody(),
    cleanOutput: $('cleanOutput').checked,
    cacheToken
  };
}

async function runResolve() {
  const btn = $('btnResolve');
  const timer = startTimer(btn, '分析依赖树', ['启动 Gradle', '解析 ResolutionResult', '收集 artifacts']);
  try {
    const r = await api('/api/resolve', resolveBody());
    setState('resolve', r);
    renderResolve(r);
    renderRepos(r.repositories || []);
    renderResolveSummary(r);
    log(`依赖分析完成（${formatSeconds(r.elapsedMs)}）`, r.summary);
  } catch (e) {
    log('依赖分析失败：' + e.message);
    alert(e.message);
  } finally {
    timer.stop();
  }
}

async function runDownload() {
  const btn = $('btnDownload');
  const timer = startTimer(btn, '一键拉取并整理', [
    '解析依赖（或命中缓存）',
    '拷贝 module artifact',
    '拷贝 project artifact',
    '生成 POM / .module',
    '下载 metadata',
    'Wrapper distribution'
  ]);
  try {
    const r = await api('/api/download', downloadBody());
    renderDownloadSummary(r);
    log(`一键拉取完成（${formatSeconds(r.summary && r.summary.elapsedMs)}）`, r.summary);
  } catch (e) {
    log('一键拉取失败：' + e.message);
    alert(e.message);
  } finally {
    timer.stop();
  }
}

function renderResolveSummary(r) {
  const node = $('resolveSummary');
  if (!node) return;
  const s = r.summary || {};
  node.hidden = false;
  node.innerHTML = `
    <span class="info-pill"><strong>模块依赖</strong> ${s.moduleCount || 0}</span>
    <span class="info-pill"><strong>Project 依赖</strong> ${s.projectCount || 0}</span>
    <span class="info-pill"><strong>Artifact 文件</strong> ${s.artifactCount || 0}</span>
    <span class="info-pill ${(s.failureCount || 0) ? 'err' : 'ok'}"><strong>失败</strong> ${s.failureCount || 0}</span>
    <span class="info-pill"><strong>用时</strong> ${escapeHtml(formatSeconds(r.elapsedMs))}</span>
    ${r.cacheToken ? `<span class="info-pill"><span class="badge badge-soft">cacheToken</span> <code>${escapeHtml(r.cacheToken)}</code></span>` : ''}
  `;
}

function renderDownloadSummary(r) {
  const node = $('resolveSummary');
  if (!node) return;
  const s = r.summary || {};
  const fromCache = s.resolveFromCache ? '<span class="badge badge-primary">复用缓存</span>' : '';
  node.hidden = false;
  node.innerHTML = `
    <span class="info-pill"><strong>导出目录</strong> <code>${escapeHtml(r.outputDir || '')}</code> ${fromCache}</span>
    <span class="info-pill"><strong>Artifact</strong> ${s.artifactFiles || 0}</span>
    <span class="info-pill"><strong>Metadata</strong> ${s.metadataFiles || 0}</span>
    <span class="info-pill ${(s.warnings || 0) ? 'warn' : ''}"><strong>Warnings</strong> ${s.warnings || 0}</span>
    <span class="info-pill ${(s.errors || 0) ? 'err' : 'ok'}"><strong>Errors</strong> ${s.errors || 0}</span>
    <span class="info-pill"><strong>用时</strong> ${escapeHtml(formatSeconds(s.elapsedMs))}</span>
    ${r.manifestPath ? `<span class="info-pill"><strong>Manifest</strong> <code>${escapeHtml(r.manifestPath)}</code></span>` : ''}
  `;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
