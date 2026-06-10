'use strict';

// 零依赖的最小 ZIP 读取器，专门服务于 fatjar 校验场景。
// 只支持读取 central directory 与单个条目的 stored/deflate 数据，足以遍历 Spring Boot fatjar
// 的 BOOT-INF/lib/*.jar 与 META-INF/* 内容。

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD64_SIGNATURE = 0x06064b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

const ZIP64_EXTRA_FIELD_ID = 0x0001;

function readUInt16LE(buf, off) { return buf.readUInt16LE(off); }
function readUInt32LE(buf, off) { return buf.readUInt32LE(off); }
function readBigUInt64LE(buf, off) { return Number(buf.readBigUInt64LE(off)); }

function findEocd(fd, fileSize) {
  // EOCD 末端 22 字节固定头 + 最长 65535 字节注释，所以最多回扫 22 + 65535 字节。
  const maxScan = Math.min(fileSize, 22 + 0xFFFF);
  const start = fileSize - maxScan;
  const buf = Buffer.alloc(maxScan);
  fs.readSync(fd, buf, 0, maxScan, start);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      return { absoluteOffset: start + i, buf, offsetInBuf: i };
    }
  }
  throw new Error('未找到 ZIP EOCD，文件可能不是 ZIP/JAR 格式。');
}

function readEocd(fd, fileSize) {
  const { absoluteOffset, buf, offsetInBuf } = findEocd(fd, fileSize);
  const eocdView = buf.subarray(offsetInBuf, offsetInBuf + 22);
  let totalEntries = readUInt16LE(eocdView, 10);
  let centralDirSize = readUInt32LE(eocdView, 12);
  let centralDirOffset = readUInt32LE(eocdView, 16);
  const needZip64 = totalEntries === 0xFFFF || centralDirSize === 0xFFFFFFFF || centralDirOffset === 0xFFFFFFFF;
  if (needZip64) {
    // 回去找 ZIP64 EOCD locator，再读 ZIP64 EOCD。
    const locOffset = absoluteOffset - 20;
    if (locOffset >= 0) {
      const locBuf = Buffer.alloc(20);
      fs.readSync(fd, locBuf, 0, 20, locOffset);
      if (readUInt32LE(locBuf, 0) === EOCD64_LOCATOR_SIGNATURE) {
        const zip64EocdOffset = readBigUInt64LE(locBuf, 8);
        const zip64Buf = Buffer.alloc(56);
        fs.readSync(fd, zip64Buf, 0, 56, zip64EocdOffset);
        if (readUInt32LE(zip64Buf, 0) === EOCD64_SIGNATURE) {
          totalEntries = readBigUInt64LE(zip64Buf, 32);
          centralDirSize = readBigUInt64LE(zip64Buf, 40);
          centralDirOffset = readBigUInt64LE(zip64Buf, 48);
        }
      }
    }
  }
  return { totalEntries, centralDirSize, centralDirOffset };
}

function parseZip64ExtraField(buf, expectFlags) {
  // expectFlags：哪些字段在头里是 0xFFFFFFFF / 0xFFFF，需要从 ZIP64 extra 中读
  const out = {};
  let pos = 0;
  if (expectFlags.uncompressedSize) { out.uncompressedSize = readBigUInt64LE(buf, pos); pos += 8; }
  if (expectFlags.compressedSize) { out.compressedSize = readBigUInt64LE(buf, pos); pos += 8; }
  if (expectFlags.localHeaderOffset) { out.localHeaderOffset = readBigUInt64LE(buf, pos); pos += 8; }
  return out;
}

function findZip64Extra(extraBuf) {
  let pos = 0;
  while (pos + 4 <= extraBuf.length) {
    const id = readUInt16LE(extraBuf, pos);
    const size = readUInt16LE(extraBuf, pos + 2);
    if (id === ZIP64_EXTRA_FIELD_ID) return extraBuf.subarray(pos + 4, pos + 4 + size);
    pos += 4 + size;
  }
  return null;
}

function readCentralDirectory(fd, eocd) {
  const buf = Buffer.alloc(eocd.centralDirSize);
  fs.readSync(fd, buf, 0, eocd.centralDirSize, eocd.centralDirOffset);
  const entries = [];
  let pos = 0;
  while (pos + 46 <= buf.length) {
    if (readUInt32LE(buf, pos) !== CENTRAL_DIR_SIGNATURE) break;
    const generalPurpose = readUInt16LE(buf, pos + 8);
    const compressionMethod = readUInt16LE(buf, pos + 10);
    let compressedSize = readUInt32LE(buf, pos + 20);
    let uncompressedSize = readUInt32LE(buf, pos + 24);
    const fileNameLen = readUInt16LE(buf, pos + 28);
    const extraLen = readUInt16LE(buf, pos + 30);
    const commentLen = readUInt16LE(buf, pos + 32);
    let localHeaderOffset = readUInt32LE(buf, pos + 42);
    const fileNameStart = pos + 46;
    const extraStart = fileNameStart + fileNameLen;
    const commentStart = extraStart + extraLen;
    const isUtf8 = (generalPurpose & 0x0800) !== 0;
    const fileName = buf.toString(isUtf8 ? 'utf8' : 'binary', fileNameStart, fileNameStart + fileNameLen);
    const extraBuf = buf.subarray(extraStart, extraStart + extraLen);
    const expectFlags = {
      uncompressedSize: uncompressedSize === 0xFFFFFFFF,
      compressedSize: compressedSize === 0xFFFFFFFF,
      localHeaderOffset: localHeaderOffset === 0xFFFFFFFF
    };
    if (expectFlags.uncompressedSize || expectFlags.compressedSize || expectFlags.localHeaderOffset) {
      const zip64Field = findZip64Extra(extraBuf);
      if (zip64Field) {
        const z = parseZip64ExtraField(zip64Field, expectFlags);
        if (z.uncompressedSize != null) uncompressedSize = z.uncompressedSize;
        if (z.compressedSize != null) compressedSize = z.compressedSize;
        if (z.localHeaderOffset != null) localHeaderOffset = z.localHeaderOffset;
      }
    }
    entries.push({
      fileName,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: fileName.endsWith('/')
    });
    pos = commentStart + commentLen;
  }
  return entries;
}

function resolveDataOffset(fd, entry) {
  // local file header 长度 30 字节固定 + fileNameLen + extraLen，需要再回去读一次精确的 extraLen。
  const headerBuf = Buffer.alloc(30);
  fs.readSync(fd, headerBuf, 0, 30, entry.localHeaderOffset);
  if (readUInt32LE(headerBuf, 0) !== LOCAL_FILE_SIGNATURE) {
    throw new Error('Local file header 签名不匹配：' + entry.fileName);
  }
  const fileNameLen = readUInt16LE(headerBuf, 26);
  const extraLen = readUInt16LE(headerBuf, 28);
  return entry.localHeaderOffset + 30 + fileNameLen + extraLen;
}

/**
 * 流式遍历单个 ZIP 条目的解压数据，逐块回调，避免一次性占用大量内存。
 */
function streamEntry(fd, entry, onChunk) {
  return new Promise((resolve, reject) => {
    if (entry.isDirectory) return resolve();
    let dataOffset;
    try { dataOffset = resolveDataOffset(fd, entry); } catch (e) { return reject(e); }
    const compressedSize = entry.compressedSize;
    const readStream = fs.createReadStream(null, {
      fd,
      start: dataOffset,
      end: dataOffset + compressedSize - 1,
      autoClose: false
    });
    let pipeline = readStream;
    if (entry.compressionMethod === 8) {
      // DEFLATE 没有 zlib header；DEFLATE-raw 使用 inflateRaw。
      pipeline = readStream.pipe(zlib.createInflateRaw());
    } else if (entry.compressionMethod !== 0) {
      readStream.destroy();
      return reject(new Error('暂不支持的 ZIP 压缩方法：' + entry.compressionMethod + ' (' + entry.fileName + ')'));
    }
    pipeline.on('data', chunk => onChunk(chunk));
    pipeline.on('end', () => resolve());
    pipeline.on('error', err => reject(err));
    readStream.on('error', err => reject(err));
  });
}

/**
 * 计算单条目的 SHA1（与 size）。
 */
async function entryHash(fd, entry, algo = 'sha1') {
  const h = crypto.createHash(algo);
  let size = 0;
  await streamEntry(fd, entry, chunk => { h.update(chunk); size += chunk.length; });
  return { hash: h.digest('hex'), size };
}

/**
 * 把单条目解压为 Buffer（仅适合小文件如 classpath.idx、MANIFEST.MF、pom.properties）。
 */
async function entryBuffer(fd, entry) {
  const chunks = [];
  await streamEntry(fd, entry, chunk => chunks.push(chunk));
  return Buffer.concat(chunks);
}

class ZipReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(this.fd);
    const eocd = readEocd(this.fd, stats.size);
    this.entries = readCentralDirectory(this.fd, eocd);
  }
  list() { return this.entries; }
  close() { try { fs.closeSync(this.fd); } catch (_) {} }
  hashEntry(entry, algo) { return entryHash(this.fd, entry, algo); }
  bufferEntry(entry) { return entryBuffer(this.fd, entry); }
}

module.exports = {
  ZipReader
};
