'use strict';

// Gradle wrapper distribution 导出：识别 wrapper.properties.distributionUrl，
// 拷贝/下载到 bundle/wrapper-distribution/ 下，并补齐校验文件。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  exists,
  ensureDirSync,
  algoHex,
  fileSize,
  sanitizeFilename,
  isFileUrl,
  isProbablyHttpUrl,
  fileUrlToLocalPath
} = require('./util');
const { httpDownloadToFile } = require('./http-client');
const { writeChecksums } = require('./maven-metadata');

function parseWrapperProperties(workDir) {
  const file = path.join(workDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!exists(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const obj = { file };
  for (const line of lines) {
    const m = line.match(/^\s*([^#!][^=]*)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].trim().replace(/\\:/g, ':');
    obj[k] = v;
  }
  return obj;
}

async function exportWrapperDistribution(workDir, outputDir, repos, body) {
  const result = { wrapper: null, warnings: [], errors: [] };
  const props = parseWrapperProperties(workDir);
  if (!props || !props.distributionUrl) {
    result.warnings.push({
      type: 'wrapper-missing',
      message: '未找到 gradle/wrapper/gradle-wrapper.properties 或 distributionUrl。'
    });
    return result;
  }
  const distUrl = props.distributionUrl;
  const fileName = sanitizeFilename(path.basename(distUrl.split('?')[0]) || 'gradle-wrapper-distribution.zip');
  const destRel = 'wrapper-distribution/' + fileName;
  const dest = path.join(outputDir, destRel);
  ensureDirSync(path.dirname(dest));

  // 已存在时也补齐 size/sha1，避免 manifest 信息缺失。
  if (exists(dest)) {
    result.wrapper = {
      distributionUrl: distUrl,
      relativePath: destRel,
      existing: true,
      size: fileSize(dest),
      sha1: algoHex(dest, 'sha1')
    };
    return result;
  }

  try {
    if (isFileUrl(distUrl)) {
      const src = fileUrlToLocalPath(distUrl);
      if (!src) {
        result.warnings.push({ type: 'wrapper-file-url-invalid', distributionUrl: distUrl });
        return result;
      }
      await fsp.copyFile(src, dest);
      await writeChecksums(dest);
      result.wrapper = {
        distributionUrl: distUrl, relativePath: destRel, sourceFile: src,
        size: fileSize(dest), sha1: algoHex(dest, 'sha1')
      };
      return result;
    }
    if (isProbablyHttpUrl(distUrl)) {
      // 关键修复：wrapper distribution 可能 100MB+，必须流式落盘，不能整体 buffer。
      const r = await httpDownloadToFile(distUrl, dest, {
        username: body.sourceUsername,
        password: body.sourcePassword,
        rejectUnauthorized: !body.trustAllSsl,
        timeoutMs: 10 * 60 * 1000
      });
      if (!r.error && r.statusCode >= 200 && r.statusCode < 300) {
        await writeChecksums(dest);
        result.wrapper = {
          distributionUrl: distUrl, relativePath: destRel,
          size: fileSize(dest), sha1: algoHex(dest, 'sha1')
        };
      } else {
        result.warnings.push({
          type: 'wrapper-download-failed',
          distributionUrl: distUrl,
          message: r.error || ('HTTP ' + r.statusCode)
        });
      }
    } else {
      result.warnings.push({
        type: 'wrapper-unsupported-scheme',
        distributionUrl: distUrl,
        message: '不识别的 wrapper distributionUrl 协议，仅支持 file:// 与 http(s)://。'
      });
    }
  } catch (e) {
    result.warnings.push({ type: 'wrapper-download-failed', distributionUrl: distUrl, message: e.message });
  }
  return result;
}

module.exports = {
  parseWrapperProperties,
  exportWrapperDistribution
};
