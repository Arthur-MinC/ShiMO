'use strict';

/**
 * ADB 通道封装（FR-01 / FR-02 的底座）
 *
 * 三条硬约束，任何一条放松都会在真机上出问题：
 *
 * 1. 所有子进程输出必须走「字节流 + 显式 UTF-8 解码」。
 *    Windows 下若让管道输出按系统默认代码页（GBK）解码，含中文 / 日文的目录名
 *    会直接乱码，且乱码后无法还原 —— PRD FR-02 验收点、11.3 界面清单均要求
 *    中文日文目录名不乱码。因此这里一律收集 Buffer 再一次性 toString('utf8')。
 *
 * 2. 禁止混用不同模拟器的 adb。adbPath 由调用方显式传入，本模块绝不自行去
 *    PATH 里找 adb —— 真机上已验证：system32 的 client(40) 与模拟器的
 *    server(41) 相遇时会互相 kill server。详见 PRD 7.2 重要约束。
 *
 * 3. 所有长任务必须可取消。取消后已扫描内容不得写入磁盘（PRD FR-03 验收点）。
 *    取消经由 AbortSignal 传入，spawn 原生支持。
 */

const { spawn } = require('node:child_process');
const net = require('node:net');

const DEFAULT_TIMEOUT = 30_000;

/**
 * 直接向已运行的 adb server 查询它的版本号，**不产生任何副作用**。
 *
 * 为什么需要这个：真机实测，用 1.0.31 的 client 去连 1.0.41 的 server，
 * `adb devices` 要 7092 ms —— 因为 client 会先 kill 掉 server 再重启一个新的，
 * 然后重新握手。而用版本匹配的 1.0.41 client 只要 56 ms，差 126 倍。
 *
 * 于是「选哪个 adb」成了本工具最重要的性能决策。选之前得先知道 server 版本，
 * 而 adb 的 smart socket 协议允许直接问 —— 走 5037 端口发 `host:version`，
 * server 回 4 位十六进制版本号，全程不改动任何状态。
 *
 * @returns {Promise<{listening:boolean, version:number|null}>}
 */
function queryAdbServerVersion(port = 5037, timeout = 1200) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let socket;
    try {
      socket = net.connect({ host: '127.0.0.1', port });
    } catch {
      done({ listening: false, version: null });
      return;
    }

    socket.setTimeout(timeout);
    let buf = Buffer.alloc(0);

    const finish = () => {
      try {
        socket.destroy();
      } catch {
        /* 已关闭 */
      }
    };

    socket.on('connect', () => {
      const payload = 'host:version';
      socket.write(`${payload.length.toString(16).padStart(4, '0')}${payload}`);
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 8) return;
      const status = buf.subarray(0, 4).toString('latin1');
      if (status !== 'OKAY') {
        finish();
        done({ listening: true, version: null });
        return;
      }
      const lenHex = buf.subarray(4, 8).toString('latin1');
      const len = Number.parseInt(lenHex, 16);
      if (!Number.isFinite(len) || buf.length < 8 + len) return;
      const versionHex = buf.subarray(8, 8 + len).toString('latin1');
      finish();
      done({ listening: true, version: Number.parseInt(versionHex, 16) });
    });

    socket.on('timeout', () => {
      finish();
      done({ listening: false, version: null });
    });
    socket.on('error', () => {
      finish();
      done({ listening: false, version: null });
    });
  });
}

/** 把 Buffer 数组按 UTF-8 解码。绝不做 GBK 回退 —— 那只会把乱码固化下来。 */
function decodeUtf8(chunks) {
  if (!chunks || chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * adb 会把自身的运维消息混进 stdout —— 不是 stderr。
 * 真机实测（Windows / 雷电 9 / client 与 server 版本不匹配时）：
 *
 *     $ adb devices -l
 *     adb server is out of date.  killing...
 *     * daemon started successfully *
 *     List of devices attached
 *     emulator-5554   device
 *
 * 如果不剥掉，`getprop ro.build.version.release` 会返回
 * "adb server is out of date.  killing...\r\n* daemon started successfully *\r\n9"，
 * `devices` 解析会凭空多出一个名为 "adb" 的假设备。
 * 因此所有 adb 输出在使用前必须过一道噪声剥离。
 */
const ADB_NOISE_PATTERNS = [
  /^\*\s*daemon not running/i,
  /^\*\s*daemon started successfully/i,
  /^\*\s*daemon not running; starting now at tcp:/i,
  /^adb server version .*doesn'?t match this client/i,
  /^adb server is out of date/i,
  /^error: protocol fault/i,
  /^error: device (?:offline|not found)/i,
  /^adb\.exe:\s*$/i,
  /^\* failed to start daemon/i,
  /^cannot connect to daemon/i,
];

function isAdbNoiseLine(line) {
  const t = line.trim();
  if (!t) return false;
  return ADB_NOISE_PATTERNS.some((re) => re.test(t));
}

/** 剥离 adb 自身噪声行，保留真实输出（包括空行结构）。 */
function stripAdbNoise(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter((line) => !isAdbNoiseLine(line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** 剥离噪声行并按行返回，已 trim 且去空。 */
function cleanLines(text) {
  return stripAdbNoise(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `adb devices` 中合法的设备状态。用白名单而不是「非空即有效」——
 *  否则 "adb server is out of date" 会被切成 serial="adb" state="server"。 */
const DEVICE_STATES = new Set([
  'device',
  'offline',
  'unauthorized',
  'bootloader',
  'recovery',
  'sideload',
  'rescue',
  'connecting',
  'authorizing',
  'no',
]);

/** 序列号形态：emulator-5554、127.0.0.1:16384、10.0.2.2:5555、或裸十六进制序列号。 */
const SERIAL_PATTERN = /^(?:emulator-\d+|(?:[\w.-]+):\d+|[0-9A-Za-z]{6,})$/;

/** 判断一行是否为合法的 `adb devices` 设备行，是则返回解析结果。 */
function parseDeviceLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const [serial, state, ...rest] = parts;
  if (!SERIAL_PATTERN.test(serial)) return null;
  if (!DEVICE_STATES.has(state)) return null;
  const props = {};
  for (const token of rest) {
    const eq = token.indexOf(':');
    if (eq > 0) props[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { serial, state, props };
}

/**
 * 执行一次 adb 命令，收集全部输出后返回。
 *
 * @returns {Promise<{ok:boolean, exitCode:number|null, stdout:string, stderr:string,
 *                    reason:string|null, message:string, cancelled:boolean}>}
 */
function runRaw(adbPath, args, options = {}) {
  const timeout = options.timeout === undefined ? DEFAULT_TIMEOUT : options.timeout;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(adbPath, args, {
        windowsHide: true,
        signal: options.signal,
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '',
        reason: 'spawn_failed',
        message: err.message,
        cancelled: false,
      });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let settled = false;
    let timer = null;

    const done = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // 统一剥离 adb 自身噪声，保证上层拿到的每一行都是真实输出；
      // 同时保留 raw 版本，供判断「本次调用是否触发了 server 重启」。
      resolve({
        ...payload,
        stdout: stripAdbNoise(payload.stdout || ''),
        stderr: stripAdbNoise(payload.stderr || ''),
        rawStdout: payload.stdout || '',
        rawStderr: payload.stderr || '',
      });
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 进程可能已退出 */
        }
        done({
          ok: false,
          exitCode: null,
          stdout: decodeUtf8(outChunks),
          stderr: decodeUtf8(errChunks),
          reason: 'timeout',
          message: `adb 命令超时（${timeout} 毫秒）：${args.join(' ')}`,
          cancelled: false,
        });
      }, timeout);
    }

    if (child.stdout) child.stdout.on('data', (c) => outChunks.push(c));
    if (child.stderr) child.stderr.on('data', (c) => errChunks.push(c));

    child.on('error', (err) => {
      const cancelled = err.name === 'AbortError' || err.code === 'ABORT_ERR';
      done({
        ok: false,
        exitCode: null,
        stdout: decodeUtf8(outChunks),
        stderr: decodeUtf8(errChunks),
        reason: cancelled ? 'cancelled' : 'spawn_failed',
        message: cancelled ? '操作已取消' : err.message,
        cancelled,
      });
    });

    child.on('close', (code, signal) => {
      const stdout = decodeUtf8(outChunks);
      const stderr = decodeUtf8(errChunks);
      done({
        ok: code === 0,
        exitCode: code,
        signal: signal || null,
        stdout,
        stderr,
        reason: code === 0 ? null : 'exit_nonzero',
        message: code === 0 ? '' : stderr.trim() || `adb 退出码 ${code}`,
        cancelled: false,
      });
    });
  });
}

/**
 * 流式执行，按行回调。用于 find 这类可能输出数万行的命令 ——
 * 必须边收边解析，否则万级目录下会把整个列表堆在内存里（FR-03 / 7.1）。
 */
function runStream(adbPath, args, handlers = {}) {
  const { onLine, onStderrLine, signal, timeout = 0 } = handlers;

  const child = spawn(adbPath, args, { windowsHide: true, signal });
  const errChunks = [];
  let tail = '';
  let errTail = '';
  let settled = false;
  let timer = null;
  let lineCount = 0;

  const promise = new Promise((resolve) => {
    const done = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        done({ ok: false, reason: 'timeout', message: '操作超时', lineCount, cancelled: false });
      }, timeout);
    }

    child.stdout.on('data', (chunk) => {
      // 先按字节拼接再解码，避免多字节 UTF-8 字符被切在两个 chunk 之间导致乱码
      tail += chunk.toString('utf8');
      let idx = tail.indexOf('\n');
      while (idx !== -1) {
        const line = tail.slice(0, idx).replace(/\r$/, '');
        tail = tail.slice(idx + 1);
        // 流式路径也要挡噪声：server 重启消息会夹在真实输出的第一行之前
        if (line && !isAdbNoiseLine(line)) {
          lineCount += 1;
          if (onLine) onLine(line);
        }
        idx = tail.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      errChunks.push(text);
      if (onStderrLine) {
        errTail += text;
        let idx = errTail.indexOf('\n');
        while (idx !== -1) {
          onStderrLine(errTail.slice(0, idx).replace(/\r$/, ''));
          errTail = errTail.slice(idx + 1);
          idx = errTail.indexOf('\n');
        }
      }
    });

    child.on('error', (err) => {
      const cancelled = err.name === 'AbortError' || err.code === 'ABORT_ERR';
      done({
        ok: false,
        reason: cancelled ? 'cancelled' : 'spawn_failed',
        message: cancelled ? '操作已取消' : err.message,
        stderr: errChunks.join(''),
        lineCount,
        cancelled,
      });
    });

    child.on('close', (code, sig) => {
      if (tail) {
        const line = tail.replace(/\r$/, '');
        tail = '';
        if (line && !isAdbNoiseLine(line)) {
          lineCount += 1;
          if (onLine) onLine(line);
        }
      }
      done({
        ok: code === 0,
        exitCode: code,
        signal: sig || null,
        reason: code === 0 ? null : 'exit_nonzero',
        message: code === 0 ? '' : errChunks.join('').trim() || `adb 退出码 ${code}`,
        stderr: errChunks.join(''),
        lineCount,
        cancelled: false,
      });
    });
  });

  return { promise, kill: () => { try { child.kill(); } catch { /* noop */ } } };
}

/** 设备端路径加单引号，交给设备的 shell 解析。空格与中文都能安全通过。 */
function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * 字节级噪声剥离：仅用于读二进制文件（.moc3 等）。
 *
 * 场景：首次连接时 adb 可能把 server 启动消息写进 stdout，
 * 它会排在文件内容前面，直接把 .moc3 的魔数与版本字节顶掉。
 * 只在头部 1KB 内查找，且只截断到噪声行的行尾，不动后续字节。
 */
const NOISE_BYTE_MARKERS = [
  Buffer.from('* daemon started successfully'),
  Buffer.from('* daemon not running'),
  Buffer.from("doesn't match this client"),
  Buffer.from('adb server is out of date'),
  Buffer.from('error: protocol fault'),
  Buffer.from('* daemon started successfully *'),
];

function stripByteNoise(buffer) {
  if (!buffer || buffer.length === 0) return buffer;
  const headEnd = Math.min(1024, buffer.length);
  let cut = 0;
  for (const marker of NOISE_BYTE_MARKERS) {
    const idx = buffer.subarray(0, headEnd).indexOf(marker);
    if (idx < 0) continue;
    const nl = buffer.indexOf(0x0a, idx);
    if (nl >= 0) {
      const end = nl + 1;
      if (end > cut) cut = end;
    }
  }
  return cut > 0 && cut < buffer.length ? buffer.subarray(cut) : buffer;
}

class AdbClient {
  /**
   * @param {string} adbPath 显式指定的 adb 可执行文件路径（绝不用 PATH 兜底）
   * @param {string|null} serial 目标实例，null 表示未指定
   */
  constructor(adbPath, serial = null) {
    this.adbPath = adbPath;
    this.serial = serial;
  }

  withSerial(serial) {
    return new AdbClient(this.adbPath, serial);
  }

  _args(rest) {
    return this.serial ? ['-s', this.serial, ...rest] : [...rest];
  }

  /** adb 自身版本，用于状态栏显示「当前使用的是哪一个 adb」（PRD 7.2 / R-04）。 */
  async version(options = {}) {
    const r = await runRaw(this.adbPath, ['version'], options);
    const first = (r.stdout || r.stderr).split('\n')[0].trim();
    const m = /version\s+([\d.]+)/i.exec(first);
    const hex = /Version\s+([0-9a-f]+)/i.exec(r.stdout);
    return {
      ok: r.ok,
      version: m ? m[1] : null,
      build: hex ? hex[1] : null,
      raw: first,
      message: r.message,
    };
  }

  /** 启动/复用 adb server。 */
  async startServer(options = {}) {
    return runRaw(this.adbPath, ['start-server'], { timeout: 20_000, ...options });
  }

  /** adb devices -l，解析实例列表。 */
  async devices(options = {}) {
    const r = await runRaw(this.adbPath, ['devices', '-l'], { timeout: 15_000, ...options });
    const devices = [];
    const ignored = [];
    for (const raw of r.stdout.split('\n')) {
      const line = raw.trim();
      if (!line || /^List of devices/i.test(line) || line.startsWith('*')) continue;
      const parsed = parseDeviceLine(line);
      if (parsed) devices.push(parsed);
      else ignored.push(line);
    }

    // 本次调用是否触发了 server 重启 / 版本冲突。
    // 这是选 adb 的关键依据：会 kill server 的那个 client 会让用户其他
    // 正在使用 adb 的工具一起断线（PRD 7.2 重要约束）。
    const combined = `${r.rawStdout}\n${r.rawStderr}`;
    const serverKilled = /killing\.\.\.|is out of date|doesn'?t match this client/i.test(combined);
    const serverStarted = /daemon not running|daemon started successfully/i.test(combined);
    const mismatch = /doesn'?t match this client/i.exec(combined);

    return {
      ok: r.ok,
      devices,
      ignored,
      serverKilled,
      serverStarted,
      versionMismatch: mismatch ? mismatch[0] : null,
      raw: r.stdout,
      message: r.message,
    };
  }

  /** 设备端执行 shell 命令。cmd 可为字符串（经设备 shell）或数组（不经 shell）。 */
  async shell(cmd, options = {}) {
    const rest = Array.isArray(cmd) ? ['shell', ...cmd] : ['shell', cmd];
    return runRaw(this.adbPath, this._args(rest), options);
  }

  async getProp(name, options = {}) {
    const r = await this.shell(`getprop ${name}`, { timeout: 10_000, ...options });
    return r.stdout.trim();
  }

  /** 当前 shell 用户身份。用于判断是否需要 adb root（PRD FR-01 / E-05）。 */
  async whoami(options = {}) {
    const r = await this.shell('id', { timeout: 10_000, ...options });
    const text = (r.stdout || '').trim();
    const uid = /uid=(\d+)/.exec(text);
    return {
      raw: text,
      userId: uid ? Number(uid[1]) : null,
      isRoot: uid ? Number(uid[1]) === 0 : false,
    };
  }

  /** 尝试提权。失败不是错误 —— 很多模拟器默认就是 root，SELinux 仍会限制部分路径。 */
  async root(options = {}) {
    const r = await runRaw(this.adbPath, this._args(['root']), { timeout: 20_000, ...options });
    const text = `${r.stdout}\n${r.stderr}`;
    return {
      ok: r.ok,
      granted: /already running as root|cannot run as root/i.test(text) ? /already running/i.test(text) : true,
      restricted: /cannot run as root/i.test(text),
      message: text.trim(),
    };
  }

  async remount(options = {}) {
    return runRaw(this.adbPath, this._args(['remount']), { timeout: 20_000, ...options });
  }

  /**
   * 读取远端文件为 Buffer。
   *
   * 用 `exec-out` 而非 `shell`：exec-out 不经过设备端 pty，不做 CRLF 转换 ——
   * 读 `.moc3` 时必须如此，否则文件头字节会被改写，版本号直接读错。
   * 外层再套一层字节级噪声剥离，兜住 server 首次启动时的消息混入。
   */
  async catBuffer(remotePath, options = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(this.adbPath, this._args(['exec-out', `cat ${shellQuote(remotePath)}`]), {
          windowsHide: true,
          signal: options.signal,
        });
      } catch (err) {
        resolve({ ok: false, buffer: Buffer.alloc(0), message: err.message, cancelled: false });
        return;
      }
      const chunks = [];
      const errChunks = [];
      let settled = false;
      const timer = options.timeout
        ? setTimeout(() => {
            try {
              child.kill();
            } catch {
              /* 已退出 */
            }
          }, options.timeout)
        : null;

      const done = (payload) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(
          payload.buffer
            ? { ...payload, buffer: stripByteNoise(payload.buffer) }
            : payload
        );
      };

      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', (c) => errChunks.push(c));
      child.on('error', (err) => {
        const cancelled = err.name === 'AbortError' || err.code === 'ABORT_ERR';
        done({ ok: false, buffer: Buffer.alloc(0), message: err.message, cancelled });
      });
      child.on('close', (code) => {
        const buffer = Buffer.concat(chunks);
        done({
          ok: code === 0 && buffer.length > 0,
          buffer,
          stderr: stripAdbNoise(decodeUtf8(errChunks)),
          message: code === 0 ? '' : stripAdbNoise(decodeUtf8(errChunks)).trim() || `读取失败（退出码 ${code}）`,
          cancelled: false,
        });
      });
    });
  }

  async catText(remotePath, options = {}) {
    const r = await this.catBuffer(remotePath, options);
    return { ...r, text: r.buffer.toString('utf8') };
  }

  /** 读文件头若干字节，用于容器格式判断与 .moc3 版本检测。 */
  async headBytes(remotePath, count = 64, options = {}) {
    const r = await runRaw(
      this.adbPath,
      this._args(['exec-out', `head -c ${count} ${shellQuote(remotePath)}`]),
      { timeout: 15_000, ...options }
    );
    return { ok: r.ok, buffer: Buffer.from(r.stdout, 'latin1'), message: r.message };
  }

  /**
   * 批量读取文件体积。
   * 真机实测 `stat -c '%s %n' f1 f2 ...` 可一次接受多个路径，
   * 比每文件一次 adb 往返快一个数量级。分块是为了避开 shell 命令行长度上限。
   */
  async statMany(remotePaths, options = {}) {
    const sizes = new Map();
    if (remotePaths.length === 0) return sizes;

    const CHUNK = 60; // 60 × 平均路径 70 字符 ≈ 4.2 KB，稳妥低于命令行上限
    for (let i = 0; i < remotePaths.length; i += CHUNK) {
      if (options.signal && options.signal.aborted) break;
      const slice = remotePaths.slice(i, i + CHUNK);
      const r = await this.shell(
        `stat -c '%s %n' ${slice.map(shellQuote).join(' ')} 2>/dev/null`,
        { timeout: 30_000, ...options }
      );
      for (const line of cleanLines(r.stdout)) {
        const sp = line.indexOf(' ');
        if (sp <= 0) continue;
        const size = Number(line.slice(0, sp));
        const p = line.slice(sp + 1).trim();
        if (Number.isFinite(size) && p) sizes.set(p, size);
      }
      // 没拿到的补 null，让调用方能区分「不存在」与「未查询」
      for (const p of slice) if (!sizes.has(p)) sizes.set(p, null);
    }
    return sizes;
  }

  /**
   * 统计目标根下的文件总数。
   *
   * 这是给遍历阶段一个**真实**的进度分母，而不是靠渐近曲线猜。
   * 真机实测：27,895 个文件的完整 `find | wc -l` 只要 0.76 秒，
   * 用这点开销换取精确百分比与准确的剩余时间，完全值得。
   */
  async countFiles(roots, options = {}) {
    if (!roots || roots.length === 0) return { ok: false, count: null, message: '未指定扫描范围' };
    const quoted = roots.map(shellQuote).join(' ');
    const r = await this.shell(`find ${quoted} -type f 2>/dev/null | wc -l`, {
      timeout: 120_000,
      ...options,
    });
    const first = cleanLines(r.stdout)[0];
    const n = Number(first);
    return {
      ok: Number.isFinite(n),
      count: Number.isFinite(n) ? n : null,
      message: Number.isFinite(n) ? '' : r.message || '无法统计文件数量',
    };
  }

  /** 仅判断远端路径是否存在。 */
  async exists(remotePath, options = {}) {
    const r = await this.shell(`[ -e ${shellQuote(remotePath)} ] && echo yes || echo no`, {
      timeout: 10_000,
      ...options,
    });
    return r.stdout.trim() === 'yes';
  }

  /** 列出远端目录内的文件名（不含 . 与 ..）。 */
  async listDir(remotePath, options = {}) {
    const r = await this.shell(`ls -1 ${shellQuote(remotePath)} 2>/dev/null`, {
      timeout: 15_000,
      ...options,
    });
    return { ok: r.ok, entries: cleanLines(r.stdout), message: r.message };
  }

  /**
   * 预热：确保 adb server 已启动。
   * 首次连接时 server 的启动消息会混进 stdout（真机已复现），
   * 先跑一次廉价命令把它挤出去，后续读文件与流式遍历就干净了。
   */
  async warmUp(options = {}) {
    const r = await runRaw(this.adbPath, ['start-server'], { timeout: 20_000, ...options });
    return { ok: r.ok, message: r.message };
  }

  /**
   * 流式遍历远端目录树。一次 find 让设备端完成遍历，
   * 避免每目录一次 round-trip（万级文件下差两个数量级）。
   */
  findStream(roots, handlers = {}) {
    const quoted = roots.map(shellQuote).join(' ');
    const cmd = `find ${quoted} -type f 2>/dev/null`;
    return runStream(this.adbPath, this._args(['shell', cmd]), handlers);
  }

  /** 递归列出目录（含目录本身），用于容器识别阶段定位 .obb / .zip / .unity3d。 */
  listFilesStream(roots, handlers = {}) {
    const quoted = roots.map(shellQuote).join(' ');
    const cmd = `find ${quoted} \\( -type f -o -type d \\) 2>/dev/null`;
    return runStream(this.adbPath, this._args(['shell', cmd]), handlers);
  }

  /** 拉取单个文件到本地。 */
  pull(remotePath, localPath, options = {}) {
    return runRaw(this.adbPath, this._args(['pull', remotePath, localPath]), {
      timeout: 0,
      ...options,
    });
  }

  /** 拉取整个目录（保持内部相对结构）。 */
  pullDir(remoteDir, localDir, options = {}) {
    return runRaw(this.adbPath, this._args(['pull', remoteDir, localDir]), {
      timeout: 0,
      ...options,
    });
  }

  /** 已安装应用清单，供「从已安装应用中选择」入口使用（FR-02）。 */
  async listPackages(options = {}) {
    const r = await this.shell('pm list packages', { timeout: 30_000, ...options });
    return cleanLines(r.stdout)
      .filter((l) => l.startsWith('package:'))
      .map((l) => l.slice('package:'.length))
      .sort();
  }

  /** 应用 APK 路径，辅助用户定位安装目录（FR-02）。 */
  async packagePath(pkg, options = {}) {
    const r = await this.shell(`pm path ${shellQuote(pkg)}`, { timeout: 15_000, ...options });
    return cleanLines(r.stdout)
      .filter((l) => l.startsWith('package:'))
      .map((l) => l.slice('package:'.length));
  }
}

module.exports = {
  AdbClient,
  runRaw,
  runStream,
  queryAdbServerVersion,
  decodeUtf8,
  stripAdbNoise,
  cleanLines,
  isAdbNoiseLine,
  parseDeviceLine,
  stripByteNoise,
  DEVICE_STATES,
  SERIAL_PATTERN,
  shellQuote,
  DEFAULT_TIMEOUT,
};
