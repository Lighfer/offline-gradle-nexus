'use strict';

// 本地 bundle 扫描 + Nexus 3 Layout PUT 上传。
// 上传范围限定在 bundle/repo/ 下，即 Maven 坐标文件；wrapper-distribution、local-files 不上传到 Maven 仓库。
//
// v3.4：
// - 失败 item 携带 statusCode/error/bodySnippet/contentType/url/size 与 detail，方便前端展开诊断。
// - 新增 retryFailedOnly 模式：根据上一次上传报告，仅重传其中 status==='failed' 的 item，
//   其余 success/dry-run 状态不动；生成新报告并把原报告的成功项以 'previously-uploaded' 标注合并进来。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  nowIso,
  exists,
  ensureDirSync,
  fileSize,
  toPosix,
  encodePathSegments,
  trimSlash,
  walkFiles,
  safeJsonParse
} = require('./util');
const { putFile, inferContentType } = require('./http-client');
const { defaultBundleDir } = require('./bundle');

function guessRelIsSnapshot(rel) {
  const parts = String(rel).split('/');
  if (parts.length >= 3) return /-SNAPSHOT$/i.test(parts[parts.length - 2]);
  return /SNAPSHOT/i.test(rel);
}

function pickRepository(rel, singleRepo, releaseRepo, snapshotRepo) {
  if (singleRepo) return singleRepo;
  return guessRelIsSnapshot(rel) ? snapshotRepo : releaseRepo;
}

// 把 putFile 返回的原始结果转换为更友好的失败说明（statusCode + 简短 body）。
function describeFailure(r) {
  if (!r) return '未知错误';
  const parts = [];
  if (r.error) parts.push(String(r.error));
  if (r.statusCode) parts.push('HTTP ' + r.statusCode);
  if (r.bodySnippet && String(r.bodySnippet).trim().length > 0) {
    const snippet = String(r.bodySnippet).trim().replace(/\s+/g, ' ').slice(0, 200);
    parts.push(snippet);
  }
  return parts.length > 0 ? parts.join(' | ') : '请求失败但未返回诊断信息';
}

// 单个文件 PUT 上传，把成功/失败结果写到 item 中。
async function performUpload(file, rel, repository, baseUrl, body) {
  const putUrl = baseUrl + '/repository/' + encodeURIComponent(repository) + '/' + encodePathSegments(rel);
  const contentType = inferContentType(file);
  const item = {
    relativePath: rel,
    repository,
    url: putUrl,
    size: exists(file) ? fileSize(file) : 0,
    contentType
  };
  if (!exists(file)) {
    item.status = 'failed';
    item.error = '本地文件缺失：' + file;
    item.detail = item.error;
    return item;
  }
  const r = await putFile(putUrl, file, {
    username: String(body.targetUsername || '').trim(),
    password: String(body.targetPassword || ''),
    rejectUnauthorized: !body.targetTrustAllSsl,
    contentType
  });
  if (r.ok) {
    item.status = 'uploaded';
    item.statusCode = r.statusCode;
  } else {
    item.status = 'failed';
    item.statusCode = r.statusCode;
    item.error = r.error || ('HTTP ' + (r.statusCode || '?'));
    item.bodySnippet = r.bodySnippet || '';
    item.detail = describeFailure(r);
  }
  return item;
}

async function scanBundle(body) {
  const workDir = String(body.workDir || '').trim();
  const outputDir = String(body.outputDir || '').trim() || defaultBundleDir(workDir);
  const repoDir = path.join(outputDir, 'repo');
  const files = exists(repoDir) ? walkFiles(repoDir) : [];
  const manifestPath = path.join(outputDir, 'manifest.json');
  const manifest = exists(manifestPath) ? safeJsonParse(fs.readFileSync(manifestPath, 'utf8'), null) : null;
  const extCounts = {};
  for (const f of files) {
    const k = path.extname(f).toLowerCase() || '(none)';
    extCounts[k] = (extCounts[k] || 0) + 1;
  }
  return {
    outputDir,
    repoDir,
    exists: exists(repoDir),
    fileCount: files.length,
    extCounts,
    manifestPath: exists(manifestPath) ? manifestPath : null,
    manifestSummary: manifest ? (manifest.summary || {
      artifactFiles: (manifest.artifacts || []).length,
      metadataFiles: (manifest.metadata || []).length,
      warnings: (manifest.warnings || []).length,
      errors: (manifest.errors || []).length
    }) : null
  };
}

function buildEmptyReport(outputDir, repoDir, body, mode) {
  return {
    mode,
    startedAt: nowIso(),
    outputDir,
    repoDir,
    dryRun: !!body.dryRunUpload,
    total: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    items: []
  };
}

async function writeReport(outputDir, report) {
  ensureDirSync(path.join(outputDir, 'reports'));
  const reportPath = path.join(outputDir, 'reports', 'upload-report-' + Date.now() + '.json');
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  report.reportPath = reportPath;
  return reportPath;
}

async function uploadFull(body) {
  const workDir = String(body.workDir || '').trim();
  const outputDir = String(body.outputDir || '').trim() || defaultBundleDir(workDir);
  const repoDir = path.join(outputDir, 'repo');
  if (!exists(repoDir)) throw new Error('本地 repo 目录不存在：' + repoDir);
  const baseUrl = trimSlash(String(body.targetBaseUrl || '').trim());
  if (!baseUrl) throw new Error('目标 Nexus Base URL 不能为空，例如 http://nexus:8081');
  const singleRepo = String(body.targetRepository || '').trim();
  const releaseRepo = String(body.releaseRepository || '').trim();
  const snapshotRepo = String(body.snapshotRepository || '').trim();
  if (!singleRepo && (!releaseRepo || !snapshotRepo)) {
    throw new Error('请填写单一目标仓库，或同时填写 releases/snapshots 两个目标仓库。');
  }
  const files = walkFiles(repoDir);
  const report = buildEmptyReport(outputDir, repoDir, body, 'full');
  report.total = files.length;
  for (const file of files) {
    const rel = toPosix(path.relative(repoDir, file));
    const repository = pickRepository(rel, singleRepo, releaseRepo, snapshotRepo);
    if (body.dryRunUpload) {
      report.items.push({
        relativePath: rel,
        repository,
        url: baseUrl + '/repository/' + encodeURIComponent(repository) + '/' + encodePathSegments(rel),
        size: fileSize(file),
        contentType: inferContentType(file),
        status: 'dry-run'
      });
      report.skipped++;
      continue;
    }
    const item = await performUpload(file, rel, repository, baseUrl, body);
    report.items.push(item);
    if (item.status === 'uploaded') report.success++;
    else report.failed++;
  }
  report.finishedAt = nowIso();
  await writeReport(outputDir, report);
  return report;
}

// 仅重试上次报告中 status==='failed' 的 item。
// 其余 status（uploaded / dry-run / previously-uploaded）按原报告复制进新报告，不再发起请求。
async function uploadRetryFailed(body) {
  const retryReportPath = String(body.retryReportPath || '').trim();
  if (!retryReportPath) throw new Error('retryFailedOnly=true 时必须提供 retryReportPath');
  if (!exists(retryReportPath)) throw new Error('上传报告不存在：' + retryReportPath);
  const baseUrl = trimSlash(String(body.targetBaseUrl || '').trim());
  if (!baseUrl) throw new Error('目标 Nexus Base URL 不能为空，例如 http://nexus:8081');

  const original = safeJsonParse(fs.readFileSync(retryReportPath, 'utf8'), null);
  if (!original || !Array.isArray(original.items)) {
    throw new Error('上传报告格式无效：' + retryReportPath);
  }
  const outputDir = String(original.outputDir || '').trim();
  const repoDir = String(original.repoDir || '').trim() || path.join(outputDir, 'repo');
  if (!exists(repoDir)) throw new Error('原报告中的 repo 目录不存在：' + repoDir);

  const failedSet = new Set(
    original.items.filter(it => it && it.status === 'failed').map(it => it.relativePath)
  );

  const report = buildEmptyReport(outputDir, repoDir, body, 'retry');
  report.baseReportPath = retryReportPath;
  report.retryTargets = failedSet.size;

  for (const it of original.items) {
    if (!it || !it.relativePath) continue;
    const rel = it.relativePath;
    if (!failedSet.has(rel)) {
      // 非 failed 项原样落入新报告，标注来源
      const carry = { ...it };
      if (carry.status === 'uploaded' || carry.status === 'previously-uploaded') {
        carry.status = 'previously-uploaded';
        report.success++;
      } else if (carry.status === 'dry-run') {
        report.skipped++;
      } else {
        report.skipped++;
      }
      report.items.push(carry);
      report.total++;
      continue;
    }
    const repository = it.repository;
    const file = path.join(repoDir, rel);
    if (body.dryRunUpload) {
      report.items.push({
        relativePath: rel,
        repository,
        url: it.url,
        size: exists(file) ? fileSize(file) : (it.size || 0),
        contentType: inferContentType(file),
        status: 'dry-run'
      });
      report.total++;
      report.skipped++;
      continue;
    }
    const newItem = await performUpload(file, rel, repository, baseUrl, body);
    newItem.previousAttempt = {
      statusCode: it.statusCode || null,
      error: it.error || null,
      bodySnippet: it.bodySnippet || null
    };
    report.items.push(newItem);
    report.total++;
    if (newItem.status === 'uploaded') report.success++;
    else report.failed++;
  }
  report.finishedAt = nowIso();
  await writeReport(outputDir, report);
  return report;
}

async function uploadBundle(body) {
  if (body && body.retryFailedOnly) return uploadRetryFailed(body);
  return uploadFull(body);
}

module.exports = {
  scanBundle,
  uploadBundle,
  guessRelIsSnapshot
};
