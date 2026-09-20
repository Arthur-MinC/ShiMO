'use strict';

/**
 * 模拟器实例发现（FR-01）。
 *
 * 设计要点，逐条对应 PRD：
 *
 * - 「无需用户输入任何路径」→ 枚举盘符 + 常见安装根，按目录名特征匹配已知模拟器。
 * - 「按文件名模糊匹配递归查找其自带 adb，禁止硬编码单一文件名」→
 *   ADB_FILENAME_HINTS 是一组候选 + 一条正则，覆盖 adb.exe / HD-adb.exe /
 *   adb_server.exe / nox_adb.exe / MuMuAdb.exe 等实际存在过的名字。
 * - 「多开端口无固定规律，不得依赖端口推算」→ 端口只作为展示信息与探测线索，
 *   实例身份一律以 `adb devices` 的实际返回为准，绝不用端口反推有几个实例。
 * - 「未运行的模拟器应出现在列表中并标注状态」→ 只发现安装目录但没探测到实例的，
 *   作为 uninstalled/running:false 条目返回，点击时给启动引导而非报错。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { AdbClient, queryAdbServerVersion } = require('./adb');

/**
 * 已知模拟器画像。
 * dirPatterns 匹配「目录名」，不匹配完整路径 —— 因为同一家的目录层级深浅不一
 * （MuMu 是 Program Files\Netease\MuMuPlayer-12.0，雷电往往是盘根\LDPlayer9）。
 */
const KNOWN_EMULATORS = [
  {
    id: 'mumu',
    name: 'MuMu 模拟器',
    vendor: '网易',
    processNames: [
      'MuMuPlayer.exe',
      'MuMuVMMHeadless.exe',
      'MuMuVMMSVC.exe',
      'MuMuPlayer-12.0.exe',
      'NemuPlayer.exe',
      'NemuHeadless.exe',
      'NemuVMMHeadless.exe',
    ],
    dirPatterns: [/^MuMuPlayer/i, /^MuMu\b/i, /^MuMu$/i, /^Nemu/i, /^MuMuPlayer-\d/i],
    adbNames: ['adb.exe', 'MuMuAdb.exe', 'adb_server.exe', 'HD-adb.exe'],
    knownPorts: [16384, 7555],
    portNote: '默认 16384；多开端口无固定递增规律，需以 adb devices 实际返回为准',
  },
  {
    id: 'ldplayer',
    name: '雷电模拟器',
    vendor: '上海禾念',
    processNames: ['dnplayer.exe', 'LdVBoxHeadless.exe', 'ldconsole.exe', 'Ld9BoxHeadless.exe'],
    dirPatterns: [/^LDPlayer/i, /^dnplayer/i, /^LdVBox/i, /雷电/],
    adbNames: ['adb.exe', 'ldadb.exe', 'adb_server.exe'],
    knownPorts: [5555, 5557, 5559],
    portNote: '自 5555 起逐个 +2 递增',
  },
  {
    id: 'nox',
    name: '夜神模拟器',
    vendor: 'BigNox',
    processNames: ['Nox.exe', 'NoxVMHandle.exe', 'NoxVMSVC.exe'],
    dirPatterns: [/^Nox/i, /^BigNox/i],
    adbNames: ['nox_adb.exe', 'adb.exe', 'adb_server.exe'],
    knownPorts: [62001, 62025],
    portNote: '默认 62001；多开自 62025 起递增',
  },
  {
    id: 'memu',
    name: '逍遥模拟器',
    vendor: 'Microvirt',
    processNames: ['MEmu.exe', 'MEmuHeadless.exe', 'MEmuConsole.exe'],
    dirPatterns: [/^MEmu/i, /^Microvirt/i, /逍遥/],
    adbNames: ['adb.exe', 'MEmuAdb.exe'],
    knownPorts: [21503],
    portNote: '默认 21503',
  },
  {
    id: 'bluestacks',
    name: 'BlueStacks',
    vendor: 'BlueStack Systems',
    processNames: ['HD-Player.exe', 'BlueStacks.exe', 'BstkVMM.exe', 'BlueStacksNxt.exe', 'HD-Agent.exe'],
    dirPatterns: [/^BlueStacks/i, /^HD-Player/i],
    adbNames: ['HD-adb.exe', 'adb.exe', 'BlueStacksAdb.exe'],
    knownPorts: [5555, 5565, 5575],
    portNote: '默认 5555；多开端口无固定递增规律，需以 adb devices 实际返回为准',
  },
];

/** adb 可执行文件名匹配（FR-01 明确要求模糊匹配，不得硬编码单一文件名）。 */
const ADB_FILENAME_REGEX = /^(?:[a-z0-9_-]*[-_])?adb(?:[-_]?server)?\.exe$/i;
const ADB_FILENAME_HINTS = ['adb.exe', 'HD-adb.exe', 'adb_server.exe', 'nox_adb.exe', 'MuMuAdb.exe', 'ldadb.exe'];

/** 扫描时要跳过的目录名：体积大且不可能住着模拟器。 */
const SKIP_DIRS = new Set([
  'windows',
  'windowsapps',
  'windows nt',
  'common files',
  'node_modules',
  'modifiablewindowsapps',
  'assembly',
  'driverstore',
  '$recycle.bin',
  'system volume information',
  'installer',
  'winsxs',
  'reference assemblies',
  'dotnet',
  'microsoft office',
  'microsoft sql server',
  'msbuild',
]);

function existsSyncSafe(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** 枚举本机存在的盘符根。 */
function listDriveRoots() {
  const roots = [];
  for (let c = 65; c <= 90; c += 1) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (existsSyncSafe(drive)) roots.push(drive);
  }
  return roots;
}

/** 常见安装根目录集合。 */
function candidateRoots() {
  const roots = [];
  for (const drive of listDriveRoots()) {
    roots.push(path.join(drive, 'Program Files'));
    roots.push(path.join(drive, 'Program Files (x86)'));
    roots.push(path.join(drive, 'Games'));
    roots.push(drive);
  }
  for (const key of ['LOCALAPPDATA', 'APPDATA', 'ProgramData', 'USERPROFILE']) {
    if (process.env[key]) roots.push(process.env[key]);
  }
  return [...new Set(roots)].filter(existsSyncSafe);
}

/** 读取当前进程列表（仅名字，快速路径）。进程名均为 ASCII，解码方式不影响匹配。 */
function listProcesses() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, names: new Set(), paths: new Map(), message: err.message });
        return;
      }
      const names = new Set();
      for (const line of String(stdout).split('\n')) {
        const m = /^"([^"]+)"/.exec(line.trim());
        if (m) names.add(m[1]);
      }
      resolve({ ok: true, names, paths: new Map(), message: '' });
    });
  });
}

/**
 * 读取进程名 + 可执行文件完整路径。
 *
 * 这是发现模拟器安装位置**最可靠**的线索。真机验证得到的教训：
 * 雷电模拟器装在 `E:\software\LDPlayer9`，既不在 Program Files 下，
 * 也不在盘根第一层 —— 任何基于固定目录清单的扫描都会漏掉它。
 * 而正在运行的进程一定知道自己在哪，顺着 ExecutablePath 反推是零成本且必然命中的。
 *
 * 性能注意：全量 `Get-Process` 后 JSON 序列化 171 个进程要 3.2 秒，
 * 直接吃掉 PRD 给冷启动的全部预算。改成只按已知模拟器的进程名过滤查询，
 * 实测降到数百毫秒；进程名过滤在 PowerShell 侧完成，回传量也小了。
 */
function listProcessesWithPath() {
  return new Promise((resolve) => {
    const names = [
      ...new Set(
        KNOWN_EMULATORS.flatMap((em) => em.processNames.map((n) => n.replace(/\.exe$/i, '')))
      ),
    ];
    const nameList = names.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
    const script =
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
      `Get-Process -Name ${nameList} -ErrorAction SilentlyContinue | ` +
      'Where-Object { $_.Path } | Select-Object ProcessName,Path | ConvertTo-Json -Compress -Depth 2';

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, entries: [], message: err.message });
          return;
        }
        try {
          const text = String(stdout).trim();
          if (!text) {
            resolve({ ok: true, entries: [], message: '' });
            return;
          }
          const parsed = JSON.parse(text);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          const entries = list
            .filter((p) => p && p.Path)
            .map((p) => ({ name: String(p.ProcessName || ''), path: String(p.Path) }));
          resolve({ ok: true, entries, message: '' });
        } catch (parseErr) {
          resolve({ ok: false, entries: [], message: `进程路径解析失败：${parseErr.message}` });
        }
      }
    );
  });
}

/**
 * 从可执行文件路径反推模拟器安装目录。
 * exe 可能在 bin / shell 这类子目录里，因此向上回溯若干层，
 * 取最靠近根的那个「目录名匹配已知模拟器特征」的目录。
 */
function installationDirFromExe(exePath, emulatorId) {
  const profile = KNOWN_EMULATORS.find((e) => e.id === emulatorId);
  if (!profile) return null;
  let dir = path.dirname(exePath);
  let best = null;
  for (let i = 0; i < 5; i += 1) {
    const base = path.basename(dir);
    if (profile.dirPatterns.some((re) => re.test(base))) best = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return best;
}

/** 在给定目录下递归查找模拟器自带 adb 可执行文件。 */
async function findBundledAdb(rootDir, extraNames = [], maxDepth = 4) {
  const results = [];
  const seen = new Set();

  const visit = async (dir, depth) => {
    if (depth > maxDepth || results.length >= 6) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const isCandidate =
          ADB_FILENAME_REGEX.test(entry.name) ||
          extraNames.some((n) => n.toLowerCase() === entry.name.toLowerCase()) ||
          ADB_FILENAME_HINTS.some((n) => n.toLowerCase() === entry.name.toLowerCase());
        if (isCandidate && !seen.has(full.toLowerCase())) {
          seen.add(full.toLowerCase());
          results.push(full);
        }
      } else if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (SKIP_DIRS.has(lower)) continue;
        // 优先下钻名字里带 adb / shell / tools / bin 的目录，其余顺带看看
        subdirs.push({ full, priority: /adb|shell|tools|bin|platform/.test(lower) ? 0 : 1 });
      }
    }
    subdirs.sort((a, b) => a.priority - b.priority);
    for (const s of subdirs) {
      if (results.length >= 6) break;
      await visit(s.full, depth + 1);
    }
  };

  await visit(rootDir, 1);
  // 根目录下的 adb.exe 最可能是该模拟器自带的那个，排前面
  results.sort((a, b) => path.dirname(a).length - path.dirname(b).length);
  return results;
}

/**
 * 按目录名特征扫描安装位置。
 *
 * 深度策略：盘根也下钻 2 层。
 * 原因来自真机教训：雷电模拟器装在 `E:\software\LDPlayer9`，
 * 只下钻 1 层会停在 `E:\software` 而完全漏掉它。
 * 盘根下的目录数量有限，加 SKIP_DIRS 过滤后可接受。
 */
async function scanInstallationsFixed(options = {}) {
  const { signal } = options;
  const maxDepth = options.maxDepth === undefined ? 3 : options.maxDepth;
  const roots = options.roots || candidateRoots();
  const found = [];
  const seenDirs = new Set();

  const visit = async (dir, depth, limit) => {
    if (depth > limit) return;
    if (signal && signal.aborted) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const nextLevel = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lower = entry.name.toLowerCase();
      if (SKIP_DIRS.has(lower)) continue;
      const full = path.join(dir, entry.name);
      const matched = KNOWN_EMULATORS.find((em) => em.dirPatterns.some((re) => re.test(entry.name)));
      if (matched) {
        const key = full.toLowerCase();
        if (!seenDirs.has(key)) {
          seenDirs.add(key);
          found.push({ emulatorId: matched.id, dir: full, discoveredBy: 'directory-scan' });
        }
      } else {
        nextLevel.push(full);
      }
    }
    for (const d of nextLevel) {
      if (signal && signal.aborted) return;
      await visit(d, depth + 1, limit);
    }
  };

  for (const root of roots) {
    if (signal && signal.aborted) break;
    const isDriveRoot = /^[A-Za-z]:\\?$/.test(root);
    await visit(root, 1, isDriveRoot ? 2 : maxDepth);
  }

  return found;
}

/** 从 `adb devices` 的序列号推断可能的模拟器归属（仅用于展示，不用于计数）。 */
function guessEmulatorBySerial(serial) {
  const portMatch = /^(?:127\.0\.0\.1:)?(\d+)$/.exec(serial);
  const port = portMatch ? Number(portMatch[1]) : null;
  if (port !== null) {
    for (const em of KNOWN_EMULATORS) {
      if (em.knownPorts.includes(port)) return { emulatorId: em.id, port, certainty: 'known_port' };
    }
  }
  if (/^emulator-\d+$/.test(serial)) {
    const idx = Number(serial.slice('emulator-'.length));
    return { emulatorId: 'ldplayer', port: 5554 + (idx - 1) * 2, certainty: 'emulator_serial' };
  }
  return { emulatorId: null, port, certainty: 'unknown' };
}

/**
 * 解析 `getprop` 的完整输出。格式固定为 `[key]: [value]`。
 * 一次拉全量属性，比逐个 getprop 少掉 N 次进程启动。
 */
function parseGetprop(text) {
  const map = {};
  for (const line of String(text).split('\n')) {
    const m = /^\[([^\]]+)\]:\s*\[([\s\S]*)\]$/.exec(line.trim());
    if (m) map[m[1]] = m[2];
  }
  return map;
}

/**
 * 读取实例详情：Android 版本、ABI、root 状态。
 *
 * 性能：真机实测「5 次并行 getprop」要 637 ms（每次都是一个新的 adb 进程），
 * 改成「一次 getprop 拉全量 + 一次 id」两个并行调用后降到 ~100 ms。
 * 单个实例不可用时返回空值而不是抛错 —— 一个实例读不到不该让整个发现流程失败。
 */
async function probeInstance(client, options = {}) {
  const safe = async (fn, fallback) => {
    try {
      return await fn();
    } catch {
      return fallback;
    }
  };

  const [propResult, idResult] = await Promise.all([
    safe(() => client.shell('getprop', { timeout: 15_000, ...options }), null),
    safe(() => client.shell('id', { timeout: 10_000, ...options }), null),
  ]);

  const props = propResult ? parseGetprop(propResult.stdout) : {};
  const release = props['ro.build.version.release'] || '';
  const sdk = props['ro.build.version.sdk'] || '';
  const abi = props['ro.product.cpu.abi'] || '';
  const model = props['ro.product.model'] || '';
  const identityText = idResult ? idResult.stdout.trim() : '';
  const uid = /uid=(\d+)/.exec(identityText);
  const isRoot = uid ? Number(uid[1]) === 0 : false;

  return {
    androidVersion: release ? `Android ${release}` : '未知版本',
    androidRelease: release,
    sdkLevel: sdk ? Number(sdk) : null,
    abi,
    model,
    shellUser: identityText,
    isRoot,
    // 「已 root 但 adb 未提权」是常见状态，需要给 adb root 引导（FR-01 验收点）
    needsAdbRoot: Boolean(uid) && !isRoot,
  };
}

/** 路径级排除：这些目录名里带模拟器关键字，但绝不可能是安装目录。 */
const PATH_SKIP_PATTERNS = [
  /\\crashrpt\\/i,
  /unsentcrashreports/i,
  /\\crashdumps\\/i,
  /\\wer\\/i,
  /\\temp\\/i,
  /\\logs?\\/i,
  /\\cache\\/i,
  /共享文件夹/,
  /shared folder/i,
];

/**
 * 判定一个目录是不是真的模拟器安装目录。
 *
 * 判据是**实质性的**：目录（限深度 2）内必须存在该模拟器的可执行文件，
 * 或存在任意 adb 可执行文件。
 *
 * 真机教训：只按目录名匹配会把
 * `AppData\Local\CrashRpt\UnsentCrashReports\MuMu App Player_2.3.15`、
 * `Documents\MuMu共享文件夹` 全都当成 MuMu 安装目录 —— 一次扫出 10 个假安装。
 */
async function isRealInstallation(dir, profile) {
  const stack = [{ d: dir, depth: 0 }];
  while (stack.length > 0) {
    const { d, depth } = stack.pop();
    if (depth > 2) continue;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        const n = entry.name.toLowerCase();
        if (profile && profile.processNames.some((p) => p.toLowerCase() === n)) return true;
        if (ADB_FILENAME_REGEX.test(entry.name)) return true;
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name.toLowerCase()) && depth < 2) {
        stack.push({ d: path.join(d, entry.name), depth: depth + 1 });
      }
    }
  }
  return false;
}

/** adb 版本号转可比较数值。用于「优先选版本最高的 client」。 */
function parseAdbVersion(text) {
  if (!text) return 0;
  const parts = String(text)
    .split('.')
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 0) return 0;
  return parts.reduce((acc, p, i) => acc + p * 1000 ** (3 - i), 0);
}

/**
 * 从 adb client 版本串里取出**协议版本号**。
 *
 * adb 的报错 `doesn't match this client (40)` 与 `adb version` 输出的
 * `1.0.40` 末段完全对应，server 侧的 `host:version` 回的也是同一个数。
 * 所以 `1.0.41` → 41，可直接和 server 版本比对。
 */
function protocolVersionOf(versionText) {
  const m = /\.(\d+)$/.exec(String(versionText || ''));
  return m ? Number(m[1]) : null;
}

/**
 * 主入口：发现本机全部模拟器与实例。
 *
 * 性能设计（PRD 7.1 要求冷启动到实例列表可见 ≤ 3 秒）：
 *   - `skipDirectoryScan: true` 时只走「进程 → 安装目录 → adb → devices」快路径，
 *     首屏立即可用；目录扫描（补充未启动的模拟器）由调用方在后台补跑。
 *   - 实例一旦拿到就停止探测其余 adb，避免每个 client 都把 server 重启一遍。
 *
 * @returns {Promise<{instances:Array, installations:Array, rejected:Array, adbReports:Array,
 *                    runningProcessNames:Array, chosenAdb:object|null, warnings:Array}>}
 */
async function discoverEmulators(options = {}) {
  const { signal } = options;
  const warnings = [];
  const skipDirectoryScan = options.skipDirectoryScan === true;

  // 1) 进程查询与目录扫描并行 —— 两者互不依赖，串起来是 500+670ms，并行只要 700ms。
  //    同时向已运行的 adb server 问一句它的版本，零副作用，用于稍后挑 client。
  const [procResult, procPathResult, scanned, serverInfo] = await Promise.all([
    listProcesses(),
    listProcessesWithPath(),
    skipDirectoryScan
      ? Promise.resolve([])
      : scanInstallationsFixed({ signal, maxDepth: options.maxDepth }),
    queryAdbServerVersion(),
  ]);

  const runningIds = new Set();
  const runningProcessNames = [];
  const fromProcessDirs = [];

  const procEntries =
    procPathResult.ok && procPathResult.entries.length
      ? procPathResult.entries
      : [...procResult.names].map((n) => ({ name: n.replace(/\.exe$/i, ''), path: '' }));

  for (const entry of procEntries) {
    const exeName = entry.path ? path.basename(entry.path) : `${entry.name}.exe`;
    for (const em of KNOWN_EMULATORS) {
      const hit = em.processNames.find(
        (n) => n.toLowerCase() === exeName.toLowerCase() || n.toLowerCase() === `${entry.name}.exe`.toLowerCase()
      );
      if (!hit) continue;
      runningIds.add(em.id);
      if (!runningProcessNames.includes(exeName)) runningProcessNames.push(exeName);
      if (entry.path) {
        const dir = installationDirFromExe(entry.path, em.id);
        if (dir && !fromProcessDirs.some((d) => d.dir.toLowerCase() === dir.toLowerCase())) {
          fromProcessDirs.push({ emulatorId: em.id, dir, discoveredBy: 'process-path' });
        }
      }
    }
  }

  // 2) 安装目录：进程路径优先（必然命中），目录扫描兜底（覆盖未启动的模拟器）
  const installationsRaw = [...fromProcessDirs];
  for (const item of scanned) {
    if (!installationsRaw.some((d) => d.dir.toLowerCase() === item.dir.toLowerCase())) {
      installationsRaw.push(item);
    }
  }

  // 3) 有效性校验 + 查找自带 adb
  const installations = [];
  const rejected = [];
  for (const item of installationsRaw) {
    if (signal && signal.aborted) break;
    const lower = item.dir.toLowerCase();
    const profile = KNOWN_EMULATORS.find((e) => e.id === item.emulatorId);

    if (PATH_SKIP_PATTERNS.some((re) => re.test(item.dir))) {
      rejected.push({ dir: item.dir, reason: '路径特征表明这不是安装目录' });
      continue;
    }

    const valid = await isRealInstallation(item.dir, profile);
    // 进程路径推出的目录即使暂时读不到内容也保留 —— 实例确实在跑
    if (!valid && item.discoveredBy !== 'process-path') {
      rejected.push({ dir: item.dir, reason: '目录内未找到模拟器可执行文件或 adb' });
      continue;
    }

    const adbFiles = await findBundledAdb(item.dir, profile ? profile.adbNames : []);
    installations.push({
      emulatorId: item.emulatorId,
      emulatorName: profile ? profile.name : item.emulatorId,
      vendor: profile ? profile.vendor : '',
      dir: item.dir,
      discoveredBy: item.discoveredBy,
      adbFiles,
      adbPath: adbFiles[0] || null,
      running: runningIds.has(item.emulatorId),
      knownPorts: profile ? profile.knownPorts : [],
      portNote: profile ? profile.portNote : '',
      hasBundledAdb: adbFiles.length > 0,
    });
  }

  // 4) adb 候选：并行取版本，按版本降序排列。
  //    版本高的 client 兼容性最好；若恰好与运行中的 server 同版本，
  //    就不会触发 kill server（真机上 1.0.41 对 1.0.31 的差别就在这）。
  const candidateMap = new Map();
  for (const inst of installations) {
    for (const adbPath of inst.adbFiles) {
      const key = adbPath.toLowerCase();
      if (!candidateMap.has(key)) {
        candidateMap.set(key, { adbPath, emulatorId: inst.emulatorId, source: 'bundled', from: inst.dir });
      }
    }
  }
  if (options.fallbackAdbPath && existsSyncSafe(options.fallbackAdbPath)) {
    const key = options.fallbackAdbPath.toLowerCase();
    if (!candidateMap.has(key)) {
      candidateMap.set(key, { adbPath: options.fallbackAdbPath, emulatorId: null, source: 'fallback', from: '' });
    }
  }

  const candidates = [...candidateMap.values()];
  const withVersion = await Promise.all(
    candidates.map(async (cand) => {
      const client = new AdbClient(cand.adbPath);
      const ver = await client.version({ timeout: 8_000, signal });
      return {
        ...cand,
        versionInfo: ver,
        parsedVersion: parseAdbVersion(ver.version),
        protocolVersion: protocolVersionOf(ver.version),
      };
    })
  );

  // 排序依据（真机实测得出，见 adb.js 中 queryAdbServerVersion 的注释）：
  // 与运行中的 server **协议版本相同**的 client 不会触发 kill+重启，
  // 实测 56 ms；版本不同的那个要 7092 ms —— 差 126 倍。
  // 所以先按「是否匹配 server」分组，组内再按版本降序（高版本兼容性更好）。
  const serverVersion = serverInfo && serverInfo.listening ? serverInfo.version : null;
  for (const c of withVersion) {
    c.serverVersion = serverVersion;
    c.matchesServer = serverVersion !== null && c.protocolVersion === serverVersion;
  }
  withVersion.sort((a, b) => {
    if (a.matchesServer !== b.matchesServer) return a.matchesServer ? -1 : 1;
    return b.parsedVersion - a.parsedVersion;
  });

  if (serverVersion !== null) {
    const match = withVersion.find((c) => c.matchesServer);
    if (!match && withVersion.length > 0) {
      warnings.push({
        code: 'NO_MATCHING_ADB',
        message:
          `本机正在运行的 ADB 服务为协议版本 ${serverVersion}，但没有找到与之匹配的 adb 客户端。` +
          `连接时服务会被重启一次，首次连接会慢一些。`,
      });
    }
  }

  // 5) 串行探测实例。拿到实例即停 —— 每多试一个 adb 就可能多 kill 一次 server。
  const instances = [];
  const seenSerials = new Set();
  const adbReports = [];
  const pendingDetails = [];
  let chosenAdb = null;

  const collectDevices = (dev, cand) => {
    for (const d of dev.devices) {
      if (seenSerials.has(d.serial)) continue;
      seenSerials.add(d.serial);

      // 归属判定：**不能**用「哪个 adb 找到的」来断定实例属于哪家模拟器。
      // adb client 是通用的，真机上就出现过用 MuMu 自带的 adb 连到了雷电的实例。
      // 可靠顺序：① 该 adb 所属模拟器确实在运行 → 归它；
      //           ② 按序列号形态推断（emulator-N / 已知端口）；③ 记「归属未知」。
      const ownerRunning = Boolean(cand.emulatorId) && runningIds.has(cand.emulatorId);
      const guess = guessEmulatorBySerial(d.serial);
      let emulatorId;
      let confidence;
      if (ownerRunning) {
        emulatorId = cand.emulatorId;
        confidence = 'process';
      } else if (guess.emulatorId && guess.certainty !== 'unknown') {
        emulatorId = guess.emulatorId;
        confidence = 'serial';
      } else {
        emulatorId = cand.emulatorId || null;
        confidence = 'unknown';
      }
      const profile = KNOWN_EMULATORS.find((e) => e.id === emulatorId);

      const base = {
        id: d.serial,
        serial: d.serial,
        name: profile ? `${profile.name} · ${d.serial}` : `模拟器实例 · ${d.serial}`,
        emulatorId,
        emulatorName: profile ? profile.name : '归属未知',
        emulatorConfidence: confidence,
        // 该实例是通过哪个 adb 发现的（与归属是两回事，状态栏要显示这个）
        discoveredViaAdb: cand.adbPath,
        adbPath: cand.adbPath,
        adbSource: cand.source,
        adbVersion: cand.versionInfo ? cand.versionInfo.version : null,
        adbAddress: d.serial.includes(':') ? d.serial : null,
      };
      pendingDetails.push({ base, serial: d.serial, state: d.state, props: d.props, cand });
    }
  };

  for (const cand of withVersion) {
    if (signal && signal.aborted) break;
    const client = new AdbClient(cand.adbPath);
    const dev = await client.devices({ signal });
    adbReports.push({
      adbPath: cand.adbPath,
      emulatorId: cand.emulatorId,
      source: cand.source,
      from: cand.from,
      version: cand.versionInfo ? cand.versionInfo.version : null,
      parsedVersion: cand.parsedVersion,
      ok: dev.ok,
      deviceCount: dev.devices.length,
      serverKilled: dev.serverKilled,
      serverStarted: dev.serverStarted,
      versionMismatch: dev.versionMismatch,
      ignoredLines: dev.ignored,
      message: dev.message,
    });

    if (dev.devices.length > 0) {
      collectDevices(dev, cand);
      if (!chosenAdb) chosenAdb = adbReports[adbReports.length - 1];
      // 已有可用 adb，默认不再试其余候选（选项可强制全量探测）
      if (!options.probeAllAdb) break;
    }
  }

  // 6) 补齐实例详情
  for (const item of pendingDetails) {
    if (signal && signal.aborted) break;
    if (item.state !== 'device') {
      instances.push({
        ...item.base,
        running: false,
        state: item.state,
        stateLabel:
          item.state === 'offline'
            ? '已离线'
            : item.state === 'unauthorized'
              ? '未授权'
              : `状态异常（${item.state}）`,
        androidVersion: '',
        isRoot: false,
        needsAdbRoot: false,
        host: item.props && item.props.usb ? item.props.usb : '',
      });
      continue;
    }
    const client = new AdbClient(item.cand.adbPath, item.serial);
    const detail = await probeInstance(client, { signal });
    instances.push({
      ...item.base,
      running: true,
      state: 'device',
      stateLabel: '运行中',
      ...detail,
    });
  }

  // 7) 装了但没在跑的模拟器也要出现在列表里（FR-01 验收点）
  for (const inst of installations) {
    const hasInstance = instances.some((i) => i.emulatorId === inst.emulatorId);
    if (hasInstance) continue;
    instances.push({
      id: `offline:${inst.emulatorId}:${inst.dir}`,
      serial: null,
      name: inst.emulatorName,
      emulatorId: inst.emulatorId,
      emulatorName: inst.emulatorName,
      adbPath: inst.adbPath,
      adbSource: 'bundled',
      adbVersion: null,
      running: false,
      state: 'not_running',
      stateLabel: '未运行',
      adbAddress: inst.knownPorts.length ? `127.0.0.1:${inst.knownPorts[0]}` : null,
      androidVersion: '',
      isRoot: false,
      needsAdbRoot: false,
      installDir: inst.dir,
      knownPorts: inst.knownPorts,
      portNote: inst.portNote,
      hasBundledAdb: inst.hasBundledAdb,
    });
  }

  if (instances.length === 0) {
    warnings.push({
      code: 'NO_EMULATOR_FOUND',
      message:
        '未发现任何模拟器实例。请确认模拟器软件已安装；若已安装但未启动，请启动模拟器并确认已开启 ADB 调试后重试。',
    });
  }

  // 被判定为无效的目录也要如实报告，便于排查「为什么没列出我的模拟器」
  if (rejected.length > 0) {
    warnings.push({
      code: 'INSTALL_DIRS_REJECTED',
      message: `有 ${rejected.length} 个目录名疑似模拟器目录，但没有找到模拟器程序或 adb，已忽略。`,
      detail: rejected,
    });
  }

  // 没有任何自带 adb 可用时提示，并给出回退说明
  if (adbReports.length > 0 && adbReports.every((r) => r.deviceCount === 0)) {
    warnings.push({
      code: 'NO_DEVICE_FROM_ANY_ADB',
      message: '已找到模拟器的 adb，但没有探测到可用实例。请确认模拟器已启动且 ADB 调试已开启。',
    });
  }

  // 版本不匹配会导致 server 反复重启，如实告知（PRD R-04）
  const mismatched = adbReports.find((r) => r.versionMismatch);
  if (mismatched) {
    warnings.push({
      code: 'ADB_VERSION_MISMATCH',
      message: `当前使用的 ADB 与已运行的 ADB 服务版本不一致（${mismatched.versionMismatch}），服务被重新启动过一次。若连接不稳定，请关闭其他正在使用 ADB 的工具后重试。`,
    });
  }

  return {
    instances,
    installations,
    rejected,
    adbCandidates: withVersion.map((c) => ({
      adbPath: c.adbPath,
      emulatorId: c.emulatorId,
      version: c.versionInfo ? c.versionInfo.version : null,
      protocolVersion: c.protocolVersion,
      matchesServer: c.matchesServer,
    })),
    adbReports,
    serverVersion,
    runningProcessNames,
    processes: [...runningIds],
    chosenAdb,
    warnings,
  };
}

/**
 * 实例的身份键。
 *
 * **一律用 `id`，不要用 `serial`。** 未运行的实例没有 serial —— 它压根没连上
 * adb，字段就是 `null`（见下方构造未运行实例的那段）。而 `null === null` 为真，
 * 于是所有未运行实例在「用 serial 认实例」的代码里会互相相等：
 *
 *   - `list.some(i => i.serial === null)` 恒为真 → 「上次选的还在」判断被击穿，
 *     自动选中运行中实例的逻辑被跳过；
 *   - `list.find(i => i.serial === null)` 会返回**第一个未运行实例** → 界面上
 *     把一个没在跑的实例渲染成当前选中项。
 *
 * 两个问题都真实发生过：本机雷电在运行、MuMu 没运行，界面却显示选中了 MuMu
 * 并提示「该实例当前未运行，请先启动」—— 让用户去启动一个本来就在运行的模拟器。
 *
 * `id` 是有值的：运行中实例用 serial，未运行实例用 `offline:<厂商>:<安装目录>`，
 * 两者都唯一。
 */
function instanceKey(inst) {
  return inst && inst.id ? inst.id : null;
}

/**
 * 按 id 定位实例；只有调用方明确给 serial 时才退回用 serial 找。
 *
 * 优先 id 的理由同上：serial 在未运行实例上是 null，用它找会命中错误的实例
 * （多个未运行实例更是必然找错）。
 */
function findInstance(instances, { id, serial } = {}) {
  const list = instances || [];
  if (id) return list.find((i) => i.id === id) || null;
  if (serial) return list.find((i) => i.serial === serial) || null;
  return null;
}

/**
 * 挑出默认要连接的实例。
 *
 * 只在**运行中且 adb 可达**（`running && state === 'device'`）的实例里挑：
 * 装了但没在跑的实例要出现在列表里（FR-01 验收点），但不该被自动选中 ——
 * 自动选中一个连不上的实例，用户一进来看到的是一屏无法操作的界面，
 * 还得自己意识到「原来要换一个」。宁可什么都不选，让界面提示去启动模拟器。
 *
 * 延续上次选择的唯一条件：那个实例**现在仍然可连接**。上次选的是谁用 id 认。
 */
function selectDefaultInstance(instances, previousId) {
  const list = instances || [];
  const connectable = (i) => Boolean(i && i.running && i.state === 'device');

  const previous = previousId ? list.find((i) => i.id === previousId) : null;
  if (connectable(previous)) return previous;
  return list.find(connectable) || null;
}

module.exports = {
  KNOWN_EMULATORS,
  ADB_FILENAME_REGEX,
  ADB_FILENAME_HINTS,
  SKIP_DIRS,
  PATH_SKIP_PATTERNS,
  listDriveRoots,
  candidateRoots,
  listProcesses,
  listProcessesWithPath,
  installationDirFromExe,
  isRealInstallation,
  parseAdbVersion,
  protocolVersionOf,
  parseGetprop,
  findBundledAdb,
  scanInstallationsFixed,
  guessEmulatorBySerial,
  probeInstance,
  discoverEmulators,
  instanceKey,
  findInstance,
  selectDefaultInstance,
};
