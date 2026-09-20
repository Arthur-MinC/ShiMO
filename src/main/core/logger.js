'use strict';

/**
 * 主进程日志。
 *
 * 为什么必须落盘：Windows 上 Electron 是 GUI 子系统的可执行文件，
 * 主进程的 stdout 不附着到控制台 —— `console.log` 在终端里一个字都看不到，
 * `ELECTRON_ENABLE_LOGGING=1` 也只能拿到 Chromium 自己的输出。
 * 出了启动期错误时，用户看到的只是「窗口没出来」，没有任何线索。
 * 所以任何值得排查的事都写进日志文件，出问题让用户把日志发过来。
 *
 * 设计约束：
 *   - 任何一步失败都不能让主进程崩掉（初始化失败就退化成空操作）；
 *   - 同步写，量小；崩溃前的最后几行必须已经落盘。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_LINE = 4000;

let logFile = null;
let ready = false;
let failureReason = null;

/** 默认放 userData/logs，可用 SHIMO_LOG_DIR 覆盖（开发时指向仓库便于查看）。 */
function resolveDir(explicitDir) {
  if (explicitDir) return explicitDir;
  if (process.env.SHIMO_LOG_DIR) return process.env.SHIMO_LOG_DIR;
  try {
    // 延迟 require，避免核心模块在单测里被 electron 拖住
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'logs');
  } catch {
    /* 非 Electron 环境（单元测试）走到这里 */
  }
  return path.join(process.cwd(), 'logs');
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function serialize(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, scope, message, extra) {
  const text = String(message === undefined || message === null ? '' : message);
  const line = `${stamp()} [${level}] [${scope}] ${text}${extra === undefined ? '' : ` ${serialize(extra)}`}`;

  // 终端里能看到就顺手输出一份（CI / 管道场景仍然有效）
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    /* stdout 不可用，忽略 */
  }

  if (!ready) return;
  try {
    fs.appendFileSync(logFile, `${line.slice(0, MAX_LINE)}\n`, 'utf8');
  } catch {
    /* 磁盘满 / 被占用：静默降级，日志本身不该成为故障源 */
  }
}

function init(options = {}) {
  if (ready) return { ok: true, file: logFile };
  try {
    const dir = resolveDir(options.dir);
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, `shimo-${fileStamp()}.log`);
    fs.appendFileSync(
      logFile,
      `\n${'-'.repeat(72)}\n${stamp()} [info] [boot] 日志会话开始 · pid=${process.pid} · Electron ${process.versions.electron || '—'} · Node ${process.versions.node}\n`,
      'utf8'
    );
    ready = true;
    return { ok: true, file: logFile };
  } catch (err) {
    failureReason = err.message;
    return { ok: false, message: err.message };
  }
}

/** 挂上进程级兜底：主进程任何未捕获异常都要留下痕迹，否则只剩「窗口没出来」。 */
function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    write('fatal', 'process', '未捕获异常', err);
  });
  process.on('unhandledRejection', (reason) => {
    write('fatal', 'process', '未处理的 Promise 拒绝', reason);
  });
}

function scoped(scope) {
  return {
    info: (msg, extra) => write('info', scope, msg, extra),
    warn: (msg, extra) => write('warn', scope, msg, extra),
    error: (msg, extra) => write('error', scope, msg, extra),
    debug: (msg, extra) => {
      if (process.env.SHIMO_LOG_DEBUG) write('debug', scope, msg, extra);
    },
  };
}

module.exports = {
  init,
  installCrashHandlers,
  scope: scoped,
  info: (msg, extra) => write('info', 'app', msg, extra),
  warn: (msg, extra) => write('warn', 'app', msg, extra),
  error: (msg, extra) => write('error', 'app', msg, extra),
  get file() {
    return logFile;
  },
  get reason() {
    return failureReason;
  },
};
