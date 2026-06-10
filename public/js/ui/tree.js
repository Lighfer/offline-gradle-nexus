'use strict';

// 依赖树视图：根据 /api/resolve 返回的 results 列表生成「子标签 + 树 + 详情」三件套。
//
// 关键修复点：
// 1. 按 (ownerProject, configuration) 分 tab；不再把多个 result 强行合并在同一棵树上。
// 2. 目标模块的 runtimeClasspath/testRuntimeClasspath/AP/testAP 永远在最前；buildscript/pluginMarkers 单独列。
// 3. 当目标模块所选 tab 被 skipped 或 graphFailure 时，直接给出错误提示，不再静默 fallback 到其它 result。
// 4. 节点支持折叠/搜索/选中；选中后右侧详情显示 GAV、selectionReason、repositoryName 与对应 artifact 文件路径。

import { $, escapeHtml, debounce } from '../dom.js';
import { state } from '../state.js';

// 目标模块自身配置的偏好顺序：保证 runtimeClasspath 永远是首位 tab。
const TARGET_CFG_ORDER = [
  'runtimeClasspath',
  'compileClasspath',
  'testRuntimeClasspath',
  'testCompileClasspath',
  'annotationProcessor',
  'testAnnotationProcessor'
];

// 模块级状态：当前激活 tab、搜索词、所选节点。
const view = {
  resolve: null,
  targetProject: ':',
  tabs: [],
  activeTabId: null,
  searchTerm: ''
};

export function setupTreeView() {
  const search = $('treeSearch');
  const expand = $('btnTreeExpand');
  const collapse = $('btnTreeCollapse');
  if (search) search.addEventListener('input', debounce(() => {
    view.searchTerm = search.value || '';
    applySearch();
  }, 120));
  if (expand) expand.addEventListener('click', () => toggleAll(true));
  if (collapse) collapse.addEventListener('click', () => toggleAll(false));
}

/** 主入口：刷新依赖树视图。由 main.js 在 /api/resolve 响应后调用。 */
export function renderResolve(resolve) {
  view.resolve = resolve || null;
  view.targetProject = (resolve && resolve.targetProject) || ':';
  view.tabs = buildTabs((resolve && resolve.results) || [], view.targetProject);
  view.activeTabId = view.tabs.length ? view.tabs[0].id : null;
  view.searchTerm = '';
  const search = $('treeSearch');
  if (search) search.value = '';
  renderTabs();
  renderActive();
}

/** 把 results 列表分组成稳定的 tab 序列。 */
function buildTabs(results, targetProject) {
  const targetCfgs = [];
  const buildscripts = [];
  const markers = [];
  const others = [];
  for (const r of results) {
    if (!r) continue;
    if (r.label === '__gradlePluginMarkers') markers.push(r);
    else if (/buildscriptClasspath$/.test(String(r.label || ''))) buildscripts.push(r);
    else if (String(r.ownerProject || '') === targetProject) targetCfgs.push(r);
    else others.push(r);
  }
  targetCfgs.sort((a, b) => {
    const ia = TARGET_CFG_ORDER.indexOf(String(a.configuration || ''));
    const ib = TARGET_CFG_ORDER.indexOf(String(b.configuration || ''));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
      || String(a.configuration || '').localeCompare(String(b.configuration || ''));
  });
  buildscripts.sort((a, b) => String(a.ownerProject || '').localeCompare(String(b.ownerProject || '')));

  const tabs = [];
  for (const r of targetCfgs) tabs.push({
    id: r.label || `target:${r.configuration}`,
    name: r.configuration || '(未知配置)',
    cat: 'target',
    tone: r.skipped ? 'warn' : (r.graphFailure ? 'danger' : 'primary'),
    result: r
  });
  for (const r of buildscripts) tabs.push({
    id: r.label || `bs:${r.ownerProject}`,
    name: `${r.ownerProject || ':'} · buildscript`,
    cat: 'buildscript',
    tone: r.skipped ? 'warn' : 'muted',
    result: r
  });
  for (const r of markers) tabs.push({
    id: r.label || 'pluginMarkers',
    name: 'pluginMarkers',
    cat: 'markers',
    tone: 'muted',
    result: r
  });
  for (const r of others) tabs.push({
    id: r.label || `other:${r.ownerProject}:${r.configuration}`,
    name: `${r.ownerProject || ''} · ${r.configuration || ''}`.trim(),
    cat: 'other',
    tone: 'muted',
    result: r
  });
  return tabs;
}

function renderTabs() {
  const wrap = $('treeResultTabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (!view.tabs.length) return;
  for (const t of view.tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'result-tab' + (t.id === view.activeTabId ? ' active' : '');
    if (t.tone === 'warn') btn.classList.add('warn');
    if (t.tone === 'danger') btn.classList.add('danger');
    const count = (t.result.components || []).length;
    const status = t.result.skipped ? '<span class="badge badge-warning">skipped</span>'
      : (t.result.graphFailure ? '<span class="badge badge-danger">error</span>' : '');
    btn.innerHTML = `<span>${escapeHtml(t.name)}</span><span class="badge badge-soft">${count}</span>${status}`;
    btn.addEventListener('click', () => {
      view.activeTabId = t.id;
      renderTabs();
      renderActive();
    });
    wrap.appendChild(btn);
  }
}

function renderActive() {
  const container = $('treeContainer');
  const detail = $('treeDetail');
  if (!container || !detail) return;
  detail.innerHTML = '<p class="empty muted">单击左侧节点查看详细信息。</p>';
  if (!view.tabs.length || !view.activeTabId) {
    container.innerHTML = '<p class="empty muted">点击「分析依赖树」后展示。</p>';
    return;
  }
  const tab = view.tabs.find(t => t.id === view.activeTabId);
  if (!tab) return;
  const r = tab.result;

  // 关键：目标模块所选 tab 失败时不再 fallback；明确告知用户原因，让其切换其它 tab 排查。
  if (r.skipped) {
    container.innerHTML = `<div class="tree-error">
      <h4>该 configuration 被跳过</h4>
      <p>${escapeHtml(r.reason || 'Configuration not found')}</p>
      <p class="muted small">可能原因：模块未应用 Java/Spring Boot 插件、该 configuration 被 lazy 创建或被 Gradle 显式禁用。请切换其它 tab 查看，或在该模块的 build.gradle 中确认 plugins 与 sourceSets 配置。</p>
    </div>`;
    return;
  }
  if (r.graphFailure) {
    container.innerHTML = `<div class="tree-error">
      <h4>解析依赖图时出错</h4>
      <p>${escapeHtml(r.graphFailure)}</p>
    </div>`;
    return;
  }
  if (!r.root || !(r.components || []).length) {
    container.innerHTML = `<div class="tree-error">
      <h4>无依赖图</h4>
      <p class="muted small">该 configuration 解析成功但没有任何组件，通常意味着 configuration 为空或仅含自身。</p>
    </div>`;
    return;
  }

  const components = new Map((r.components || []).map(c => [c.id, c]));
  const byFrom = new Map();
  for (const e of r.edges || []) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e);
  }

  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'tree-children';
  root.style.paddingLeft = '0';
  root.style.borderLeft = '0';
  root.style.marginLeft = '0';
  renderNode(root, r.root, components, byFrom, new Set(), 0, true);
  container.appendChild(root);

  if ((r.unresolved || []).length) {
    const box = document.createElement('div');
    box.className = 'tree-error';
    box.innerHTML = `<h4>未解析依赖（${r.unresolved.length}）</h4>` +
      `<pre style="margin:0;white-space:pre-wrap;font-family:inherit;font-size:12px">${escapeHtml(JSON.stringify(r.unresolved, null, 2))}</pre>`;
    container.appendChild(box);
  }
  applySearch();
}

function renderNode(parent, id, components, byFrom, seen, depth, isRoot) {
  const c = components.get(id) || { id, displayName: id, type: 'unknown' };
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.dataset.id = id;

  const children = byFrom.get(id) || [];
  // 防御性深度上限（沿用旧实现的 80 层），同时防止环依赖二次展开。
  const hasChildren = children.length > 0 && !seen.has(id) && depth < 80;

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.nodeId = id;

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle' + (hasChildren ? '' : ' empty');
  toggle.textContent = hasChildren ? '▾' : '';
  row.appendChild(toggle);

  const icon = document.createElement('span');
  icon.className = 'tree-icon ' + (c.type === 'module' ? 'module' : (c.type === 'project' ? 'project' : ''));
  icon.textContent = c.type === 'module' ? '●' : (c.type === 'project' ? '◆' : '◌');
  row.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = labelComponent(c);
  row.appendChild(label);

  if (isRoot) appendTag(row, 'root', '');
  if (c.selectionReason && c.selectionReason !== 'requested' && c.selectionReason !== 'root') {
    appendTag(row, c.selectionReason, classifyReason(c.selectionReason));
  }

  row.addEventListener('click', () => selectNode(id));
  node.appendChild(row);

  if (hasChildren) {
    const childWrap = document.createElement('div');
    childWrap.className = 'tree-children';
    seen.add(id);
    for (const e of children.slice().sort((a, b) => String(a.to).localeCompare(String(b.to)))) {
      renderNode(childWrap, e.to, components, byFrom, new Set(seen), depth + 1, false);
    }
    node.appendChild(childWrap);
    toggle.addEventListener('click', ev => {
      ev.stopPropagation();
      const hidden = childWrap.classList.toggle('hidden');
      toggle.textContent = hidden ? '▸' : '▾';
    });
  }

  parent.appendChild(node);
}

function appendTag(row, text, cls) {
  const span = document.createElement('span');
  span.className = 'tree-tag' + (cls ? ' ' + cls : '');
  span.textContent = text;
  row.appendChild(span);
}

function classifyReason(reason) {
  const s = String(reason || '').toLowerCase();
  if (s.includes('conflict')) return 'conflict';
  if (s.includes('forced')) return 'forced';
  if (s.includes('constraint')) return 'constraint';
  return '';
}

function labelComponent(c) {
  if (!c) return '';
  if (c.type === 'module') return `${c.group}:${c.module}:${c.version}`;
  if (c.type === 'project') return `project ${c.projectPath || ':'}`;
  return c.displayName || c.id || '(未知)';
}

function selectNode(id) {
  const container = $('treeContainer');
  if (!container) return;
  for (const r of container.querySelectorAll('.tree-row.selected')) r.classList.remove('selected');
  const target = container.querySelector(`.tree-row[data-node-id="${cssEscape(id)}"]`);
  if (target) target.classList.add('selected');

  const tab = view.tabs.find(t => t.id === view.activeTabId);
  if (!tab) return;
  const c = (tab.result.components || []).find(x => x.id === id) || { id };
  const artifacts = (tab.result.artifacts || []).filter(a => a.component && a.component.id === id);
  renderDetail(c, artifacts);
}

function renderDetail(c, artifacts) {
  const detail = $('treeDetail');
  if (!detail) return;
  const rows = [];
  rows.push(['Type', c.type || '?']);
  if (c.type === 'module') {
    rows.push(['Group', c.group || '']);
    rows.push(['Artifact', c.module || '']);
    rows.push(['Version', c.version || '']);
  } else if (c.type === 'project') {
    rows.push(['Project Path', c.projectPath || '']);
  }
  if (c.displayName) rows.push(['Display', c.displayName]);
  if (c.selectionReason) rows.push(['Selection', c.selectionReason]);
  if (c.repositoryName) rows.push(['Repository', c.repositoryName]);
  if (c.id) rows.push(['Component ID', c.id]);

  let artifactBlock = '';
  if (artifacts.length) {
    const items = artifacts.map(a => `
      <div class="detail-row">
        <div class="detail-key">File</div>
        <div class="detail-val">${escapeHtml(a.fileName || '')}<br><span class="muted small">${escapeHtml(a.file || '')}</span></div>
      </div>
      ${a.variant ? `<div class="detail-row"><div class="detail-key">Variant</div><div class="detail-val">${escapeHtml(a.variant)}</div></div>` : ''}
    `).join('');
    artifactBlock = `<h4 style="margin-top:14px">Artifacts (${artifacts.length})</h4>${items}`;
  }

  detail.innerHTML = '<h4>节点详情</h4>' + rows.map(([k, v]) => `
    <div class="detail-row"><div class="detail-key">${escapeHtml(k)}</div><div class="detail-val">${escapeHtml(v)}</div></div>
  `).join('') + artifactBlock;
}

function applySearch() {
  const term = String(view.searchTerm || '').toLowerCase().trim();
  const container = $('treeContainer');
  if (!container) return;
  const rows = container.querySelectorAll('.tree-row');
  if (!term) {
    for (const r of rows) r.classList.remove('match', 'dimmed');
    return;
  }
  const matchedNodes = [];
  for (const row of rows) {
    const lbl = row.querySelector('.tree-label');
    const text = lbl ? lbl.textContent.toLowerCase() : '';
    if (text.includes(term)) {
      row.classList.add('match');
      row.classList.remove('dimmed');
      matchedNodes.push(row.parentElement);
    } else {
      row.classList.remove('match');
      row.classList.add('dimmed');
    }
  }
  // 展开命中节点的所有祖先链，确保用户能看到匹配项。
  for (const node of matchedNodes) {
    let p = node.parentElement;
    while (p && p.classList && p.classList.contains('tree-children')) {
      p.classList.remove('hidden');
      const parentNode = p.parentElement;
      if (parentNode && parentNode.classList && parentNode.classList.contains('tree-node')) {
        const t = parentNode.querySelector(':scope > .tree-row > .tree-toggle');
        if (t && !t.classList.contains('empty')) t.textContent = '▾';
      }
      p = p.parentElement && p.parentElement.parentElement;
    }
  }
}

function toggleAll(expand) {
  const container = $('treeContainer');
  if (!container) return;
  for (const wrap of container.querySelectorAll('.tree-children')) {
    if (wrap === container.firstElementChild) continue; // 顶层 wrapper 不参与
    if (expand) wrap.classList.remove('hidden'); else wrap.classList.add('hidden');
  }
  for (const t of container.querySelectorAll('.tree-toggle')) {
    if (t.classList.contains('empty')) continue;
    t.textContent = expand ? '▾' : '▸';
  }
}

/** CSS.escape 兼容回退：旧浏览器或 Worker 中可能缺失。 */
function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(s));
  return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => '\\' + ch);
}

// 暴露状态以便调试与单测；不依赖此对象的外部代码不会读它。
export const __viewForTest = view;
