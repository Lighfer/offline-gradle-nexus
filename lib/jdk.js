'use strict';

// JDK 发现：扫描 ~/.jdks、JAVA_HOME 和常见安装目录。
// 排序策略：优先 JDK 17（项目运行时），其次 ≥17 的 JDK 越接近 17 越好，
// 再之是其他可用 JDK；不可识别版本得分最低。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { exists, isWin, uniqueBy, userHome } = require('./util');

function parseJavaVersion(text) {
  const t = String(text || '');
  const m = t.match(/version\s+"([^"]+)"/) || t.match(/openjdk\s+([0-9][^\s]*)/i);
  const raw = m ? m[1] : '';
  let major = null;
  if (/^1\./.test(raw)) major = Number(raw.split('.')[1]);
  else major = Number((raw.match(/^(\d+)/) || [])[1]);
  return { raw, major: Number.isFinite(major) ? major : null };
}

function scoreJdk(jdk) {
  const major = jdk.version && jdk.version.major;
  if (major === 17) return 1000;
  if (major && major > 17) return 500 - (major - 17);
  if (major) return 100 + major;
  return 0;
}

function probeJdk(dir, source) {
  if (!dir) return null;
  const javaExe = path.join(dir, 'bin', isWin() ? 'java.exe' : 'java');
  if (!exists(javaExe)) return null;
  let versionText = '';
  try {
    const out = spawnSync(javaExe, ['-version'], { encoding: 'utf8', timeout: 7000 });
    versionText = (out.stderr || out.stdout || '').trim();
  } catch (_) {}
  const version = parseJavaVersion(versionText);
  return { dir, javaExe, source, version, versionText: versionText.split(/\r?\n/)[0] || '' };
}

function scanJdks() {
  const candidates = [];
  const add = (dir, source) => {
    const j = probeJdk(dir, source);
    if (j) candidates.push(j);
  };

  const home = userHome();
  const jdksDir = path.join(home, '.jdks');
  if (exists(jdksDir)) {
    for (const name of fs.readdirSync(jdksDir)) {
      // 跳过 IntelliJ IDEA 在 ~/.jdks 下存放的 .xxx.intellij 配置文件。
      if (name.startsWith('.')) continue;
      add(path.join(jdksDir, name), '~/.jdks');
    }
  }
  add(process.env.JAVA_HOME, 'JAVA_HOME');
  for (const base of [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Amazon Corretto',
    '/Library/Java/JavaVirtualMachines',
    '/usr/lib/jvm'
  ]) {
    if (!exists(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const p = path.join(base, name);
      add(p, base);
      add(path.join(p, 'Contents', 'Home'), base);
    }
  }
  const uniq = uniqueBy(candidates, x => path.resolve(x.dir).toLowerCase());
  uniq.sort((a, b) => scoreJdk(b) - scoreJdk(a) || String(a.dir).localeCompare(String(b.dir)));
  return uniq;
}

function defaultJdkDir() {
  const jdks = scanJdks();
  return jdks[0] ? jdks[0].dir : '';
}

module.exports = {
  scanJdks,
  defaultJdkDir,
  parseJavaVersion,
  scoreJdk
};
