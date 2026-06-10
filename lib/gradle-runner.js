'use strict';

// Gradle 执行器：负责拼装 init script、调用 gradlew/系统 gradle、捕获 stdout 中的 JSON 输出。
// 仓库覆盖、凭据传递通过环境变量交给 init script 自己处理，保持 Node 与 Groovy 的解耦。
//
// 性能关键约束：默认启用 Gradle daemon。--no-daemon 会让每次调用都重启 JVM，单次 inspect/resolve
// 在 8.x 上常常超过 1 分钟；启用 daemon 后第二次起 5~10 秒内即可完成。
// daemon 由 Gradle 自己负责生命周期与 idle 自动停止，本工具不强行 --stop，避免影响用户其它会话。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { JSON_START, JSON_END } = require('./gradle-init-scripts');
const { exists, isWin } = require('./util');

function gradleCommand(workDir) {
  const bat = path.join(workDir, isWin() ? 'gradlew.bat' : 'gradlew');
  if (exists(bat)) return { command: bat, usingWrapper: true };
  return { command: 'gradle', usingWrapper: false };
}

function writeTempFile(prefix, suffix, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const file = path.join(dir, prefix + suffix);
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

function buildPerfArgs(body) {
  // 默认 daemon + parallel + 简化日志；用户可在页面通过参数关闭。
  const args = [];
  const useDaemon = body && body.useDaemon === false ? false : true;
  args.push(useDaemon ? '--daemon' : '--no-daemon');
  args.push('--console=plain');
  if (body && body.gradleQuiet) args.push('-q');
  if (!(body && body.parallel === false)) args.push('--parallel');
  if (!(body && body.buildCache === false)) args.push('--build-cache');
  // 关闭 configuration cache：本工具的 init script 注册了 task，且 doLast 闭包内部读取 ENV 是
  // configuration-cache 不友好的形式，强制关闭避免命中缓存却返回旧 JSON。
  args.push('--no-configuration-cache');
  return args;
}

function normalizeRepoSpecs(body) {
  const text = String((body && (body.sourceRepos || body.sourceRepoUrls)) || '').trim();
  const username = String((body && body.sourceUsername) || '').trim();
  const password = String((body && body.sourcePassword) || '');
  const allowInsecureProtocol = !!(body && body.allowInsecureProtocol);
  const urls = text ? text.split(/[\r\n,;]+/).map(x => x.trim()).filter(Boolean) : [];
  return urls.map((u, i) => {
    const lower = u.toLowerCase();
    const isHttp = lower.startsWith('http://') || lower.startsWith('https://');
    return {
      name: 'ogn-source-' + (i + 1),
      url: u,
      isHttp,
      // 认证只允许注入到 http/https 仓库。file:// 或本地路径一旦带 credentials，Gradle 会报：
      // Authentication scheme 'all'(Authentication) is not supported by protocol 'file'。
      username: isHttp ? username : '',
      password: isHttp ? password : '',
      allowInsecureProtocol: isHttp && allowInsecureProtocol
    };
  });
}

function makeGradleEnv(body, jdkDir, extraEnv = {}) {
  const repoSpecs = normalizeRepoSpecs(body || {});
  const env = { ...process.env };
  if (jdkDir) {
    env.JAVA_HOME = jdkDir;
    env.PATH = path.join(jdkDir, 'bin') + path.delimiter + (env.PATH || '');
  }
  // 「额外源仓库」：仅在 inspect/resolve 阶段叠加到用户工程已有仓库前部，不覆盖原仓库。
  // 旧字段 OGN_REPO_OVERRIDE_JSON 保留写一份以兼容尚未升级的 init 脚本调用方。
  env.OGN_EXTRA_REPOS_JSON = repoSpecs.length ? JSON.stringify(repoSpecs) : '';
  env.OGN_REPO_OVERRIDE_JSON = env.OGN_EXTRA_REPOS_JSON;
  env.OGN_SOURCE_USERNAME = String((body && body.sourceUsername) || '');
  env.OGN_SOURCE_PASSWORD = String((body && body.sourcePassword) || '');
  env.OGN_ALLOW_INSECURE = (body && body.allowInsecureProtocol) ? 'true' : 'false';
  env.OGN_TRUST_ALL_SSL = (body && body.trustAllSsl) ? 'true' : 'false';
  // 默认填充空用户名，避免项目脚本里 credentials.username 为 null 时 Gradle 直接抛出 "Username must not be null"。
  // 如果仓库真正需要认证，仍然需要在页面填写源仓库账号密码，否则会得到正常的 401/403。
  env.OGN_FILL_EMPTY_CREDENTIALS = (body && body.fillEmptyCredentials === false) ? 'false' : 'true';
  if (body && body.gradleUserHome) env.GRADLE_USER_HOME = String(body.gradleUserHome);
  Object.assign(env, extraEnv || {});
  return env;
}

function extractJsonFromGradle(stdout) {
  const s = String(stdout || '');
  // 用 lastIndexOf 取最后一对标记，避免被项目脚本里其他 println 输出干扰。
  const start = s.lastIndexOf(JSON_START);
  const end = s.lastIndexOf(JSON_END);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Gradle 输出中没有找到 JSON 标记。输出片段：\n' + s.slice(-3000));
  }
  const json = s.slice(start + JSON_START.length, end).trim();
  return JSON.parse(json);
}

/**
 * 执行 Gradle 任务。
 * @param {Object} opts
 * @param {string} opts.workDir Gradle 工程目录
 * @param {string} opts.jdkDir 指定 JDK
 * @param {Object} opts.body 页面参数（仓库/凭据/SSL）
 * @param {string} opts.initScript 注入的 init script Groovy 内容
 * @param {string} opts.taskName 任务名（例如 __ognInspect）
 * @param {string[]} [opts.extraArgs] 额外参数
 * @param {Object} [opts.envExtra] 额外环境变量
 * @param {number} [opts.timeoutMs] 超时
 */
async function runGradle({ workDir, jdkDir, body = {}, initScript, taskName, extraArgs = [], envExtra = {}, timeoutMs = 10 * 60 * 1000 }) {
  if (!workDir || !exists(workDir)) throw new Error('工作目录不存在：' + workDir);
  const { command, usingWrapper } = gradleCommand(workDir);
  const tmp = writeTempFile('ogn-init', '.gradle', initScript);
  const args = [...buildPerfArgs(body), '-I', tmp.file];
  if (jdkDir) args.push('-Dorg.gradle.java.home=' + jdkDir);
  args.push(...extraArgs, taskName);
  const env = makeGradleEnv(body, jdkDir, envExtra);
  const startedAt = Date.now();

  const cleanupTmp = () => {
    try { fs.rmSync(tmp.dir, { recursive: true, force: true }); } catch (_) {}
  };

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workDir,
      env,
      shell: isWin(),
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      cleanupTmp();
      reject(new Error('Gradle 执行超时：' + taskName + '，已运行 ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's。'));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      cleanupTmp();
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      cleanupTmp();
      const elapsedMs = Date.now() - startedAt;
      if (code !== 0) {
        const tail = (stdout + '\n' + stderr).slice(-12000);
        const msg = 'Gradle 执行失败，退出码 ' + code + '，耗时 ' + (elapsedMs / 1000).toFixed(1) + 's。命令：' + command + ' ' + args.join(' ') + '\n\n' + tail;
        reject(new Error(msg));
      } else {
        resolve({ stdout, stderr, command, args, usingWrapper, elapsedMs });
      }
    });
  });
}

module.exports = {
  gradleCommand,
  normalizeRepoSpecs,
  makeGradleEnv,
  extractJsonFromGradle,
  runGradle
};
