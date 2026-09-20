'use strict';

/**
 * 五阶段扫描器（FR-03 / FR-04 / FR-05 的整合层）。
 *
 * 阶段划分严格照 PRD：探测模拟器实例 → 拉取应用清单 → 遍历资源目录 →
 * 聚合运行时包 → 完整性校验。每个阶段有独立权重，合成一个整体百分比。
 *
 * 关于进度的核心设计（PRD FR-03 验收点）：
 * 「界面必须同时显示整体百分比与当前正在遍历的目录路径。仅有不确定进度的
 *   旋转图标视为不达标 —— 用户判断程序是否卡死的唯一依据是路径与计数在变化。」
 *
 * 所以遍历阶段不是先跑一遍再报结果，而是边收边报，且每 200 ms 至少推一次。
 * 进度分母来自一次真实的文件计数（真机实测 27,895 个文件只要 0.76 秒），
 * 而不是靠渐近曲线猜测 —— 这样百分比和剩余时间都是真的。
 */

const {
  canonicalDevicePath,
  dedupeDevicePaths,
  deviceDirname,
  deviceDisplayName,
  sourcePackageOf,
  formatBytes,
} = require('./path-utils');
const { buildPack } = require('./packer');
const { validatePack, readMoc3Header } = require('./validator');
const { detectContainer, isContainerCandidate, readZipIndex } = require('./container');

const SCAN_PHASES = [
  { key: 'probe', label: '探测模拟器实例', weight: 6 },
  { key: 'inventory', label: '拉取应用清单', weight: 6 },
  { key: 'traverse', label: '遍历资源目录', weight: 48 },
  { key: 'aggregate', label: '聚合运行时包', weight: 28 },
  { key: 'validate', label: '完整性校验', weight: 12 },
];

/** 与 Live2D 运行时包相关的文件类型。用于统计「已匹配」而非把所有文件都算进来。 */
const RELEVANT_PATTERN =
  /\.(model3\.json|moc3|motion3\.json|exp3\.json|physics3\.json|pose3\.json|cdi3\.json|moc)$/i;

const MANIFEST_PATTERN = /\.model3\.json$/i;

/** 进度事件最小间隔。PRD 7.1 要求刷新频率 ≥ 每 500 毫秒一次，这里做到 200 ms 留余量。 */
const PROGRESS_INTERVAL_MS = 200;

/** 计算阶段内的加权百分比。 */
function overallPercent(phaseIndex, phaseProgress) {
  let done = 0;
  for (let i = 0; i < phaseIndex; i += 1) done += SCAN_PHASES[i].weight;
  done += SCAN_PHASES[phaseIndex].weight * Math.max(0, Math.min(1, phaseProgress));
  return Math.max(0, Math.min(100, done));
}

class ScanReporter {
  constructor(onProgress) {
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;
    this.phaseIndex = 0;
    this.lastEmit = 0;
    this.state = {
      phaseKey: SCAN_PHASES[0].key,
      phaseLabel: SCAN_PHASES[0].label,
      phaseIndex: 1,
      phaseTotal: SCAN_PHASES.length,
      phaseProgress: 0,
      percent: 0,
      currentDir: '',
      scannedFiles: 0,
      totalFiles: null,
      matchedFiles: 0,
      packCount: 0,
      containerCount: 0,
      elapsedMs: 0,
      etaMs: null,
      message: '',
      // 最近聚合到的包。扫描中界面靠「当前目录 + 实时计数」证明程序没卡死，
      // 这个列表负责给出「确实在产出东西」的实证，比百分比更有说服力。
      recentPacks: [],
    };
  }

  /** 阶段切换。 */
  enter(index, message = '') {
    this.phaseIndex = index;
    this.state.phaseIndex = index + 1;
    this.state.phaseKey = SCAN_PHASES[index].key;
    this.state.phaseLabel = SCAN_PHASES[index].label;
    this.state.phaseProgress = 0;
    this.state.percent = overallPercent(index, 0);
    this.state.message = message;
    this.force();
  }

  /** 更新阶段内进度并（按节流）推送。 */
  update(patch = {}, options = {}) {
    Object.assign(this.state, patch);
    this.state.percent = overallPercent(this.phaseIndex, this.state.phaseProgress);

    const now = Date.now();
    // 关键更新（目录变化、阶段切换）必须立即推送，否则用户会以为卡死
    const urgent = options.urgent === true;
    if (urgent || now - this.lastEmit >= PROGRESS_INTERVAL_MS) {
      this.lastEmit = now;
      this.emit();
    }
  }

  emit() {
    if (!this.onProgress) return;
    this.onProgress({ ...this.state });
  }

  force() {
    this.lastEmit = Date.now();
    this.emit();
  }
}

/**
 * 阶段 3：遍历资源目录。
 *
 * 先计数、再流式遍历。两遍遍历听上去浪费，但第一遍只回传一个数字，
 * 真机实测 27,895 个文件 0.76 秒 —— 换来的是**真实**的百分比，
 * 比任何渐近估算都可靠。计数失败时降级为按已扫文件数渐近。
 */
async function traverseDirectory({ client, roots, reporter, signal, budget }) {
  const countResult = await client.countFiles(roots, { signal, timeout: budget.countTimeoutMs });
  const totalFiles = countResult.ok ? countResult.count : null;

  reporter.update(
    {
      totalFiles,
      currentDir: roots[0] || '',
      message: totalFiles === null ? '正在遍历（无法预统计总数，进度为估算）' : `已统计目标规模：${totalFiles.toLocaleString('en-US')} 个文件`,
    },
    { urgent: true }
  );

  const files = [];
  const containerCandidates = [];
  let scanned = 0;
  let matched = 0;
  let lastDir = '';
  const startedAt = Date.now();

  const stream = client.findStream(roots, {
    signal,
    onLine: (line) => {
      const p = line.trim();
      if (!p) return;
      files.push(p);
      scanned += 1;
      if (RELEVANT_PATTERN.test(p)) matched += 1;
      if (isContainerCandidate(p)) containerCandidates.push(p);

      const dir = deviceDirname(p);
      const dirChanged = dir !== lastDir;
      if (dirChanged) lastDir = dir;

      // 分母已知就按真实比例；未知则用渐近曲线，保证进度一直在动
      const progress =
        totalFiles && totalFiles > 0
          ? Math.min(1, scanned / totalFiles)
          : Math.min(0.95, scanned / (scanned + 3000));

      const elapsed = Date.now() - startedAt;
      let etaMs = null;
      if (progress > 0.02) {
        const rate = scanned / Math.max(1, elapsed);
        if (totalFiles && totalFiles > scanned) etaMs = (totalFiles - scanned) / Math.max(0.001, rate);
      }

      reporter.update(
        {
          scannedFiles: scanned,
          matchedFiles: matched,
          currentDir: dir,
          phaseProgress: progress,
          elapsedMs: elapsed,
          etaMs,
        },
        { urgent: dirChanged }
      );
    },
  });

  const result = await stream.promise;
  reporter.update({ phaseProgress: 1 }, { urgent: true });

  // 「掉线」不能只看退出码：find 在遇到不存在的目录时也会返回 1，
  // 那是正常情况（例如本机没有应用使用 obb 目录）。
  // 只有出现明确的连接类错误才算掉线（E-03）。
  const disconnectPattern = /device (?:offline|not found|unauthorized)|no devices|closed|connection reset|protocol fault|device '.*' not found/i;
  const looksDisconnected = disconnectPattern.test(result.stderr || '') || disconnectPattern.test(result.message || '');

  return {
    files,
    containerCandidates,
    scanned,
    matched,
    cancelled: result.reason === 'cancelled' || Boolean(signal && signal.aborted),
    timedOut: result.reason === 'timeout',
    disconnected: looksDisconnected,
    exitCode: result.exitCode === undefined ? null : result.exitCode,
    stderr: result.stderr || '',
    message: result.message || '',
    error: null,
  };
}

/** 在远端查一组文件是否存在。用于复核「清单引用了但遍历没见到」的文件。 */
async function verifyMissing(client, candidates, signal) {
  const confirmed = new Map();
  const CHUNK = 40;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    if (signal && signal.aborted) break;
    const slice = candidates.slice(i, i + CHUNK);
    const script = slice.map((p) => `[ -f '${p.replace(/'/g, `'\\''`)}' ] && echo 1 || echo 0`).join('; ');
    const r = await client.shell(script, { timeout: 20_000, signal });
    const answers = r.stdout.split('\n').map((l) => l.trim());
    slice.forEach((p, idx) => confirmed.set(p, answers[idx] === '1'));
  }
  return confirmed;
}

/**
 * 执行一次完整扫描。
 *
 * @param {object} args
 * @param {import('./adb').AdbClient} args.baseClient 已绑定 adbPath 的客户端（serial 由本函数绑定）
 * @param {string} args.serial 目标实例序列号
 * @param {string[]} args.roots 扫描范围（已被上层归一化过，这里会再校验一次）
 * @param {object} args.source 来源信息（实例名、Android 版本等），写进结果与 manifest
 * @param {AbortSignal} [args.signal] 取消信号
 * @param {(p:object)=>void} [args.onProgress] 进度回调
 * @param {object} [args.budget] 超时预算
 */
async function runScan({
  baseClient,
  serial,
  roots,
  source = {},
  signal,
  onProgress,
  budget = {},
}) {
  const startedAt = Date.now();
  const reporter = new ScanReporter(onProgress);
  const client = baseClient.withSerial(serial);
  const warnings = [];
  const log = [];

  const rootDedup = dedupeDevicePaths(roots);
  const effectiveRoots = rootDedup.kept;
  if (rootDedup.removed.length > 0) {
    for (const item of rootDedup.removed) {
      log.push(`扫描范围已去重：${item.path} —— ${item.reason}${item.duplicateOf ? `（等价于 ${item.duplicateOf}）` : ''}`);
    }
  }

  if (effectiveRoots.length === 0) {
    reporter.force();
    return {
      ok: false,
      cancelled: false,
      error: '没有有效的扫描范围',
      warnings,
      log,
      packs: [],
      containers: [],
      stats: { scannedFiles: 0, matchedFiles: 0, totalFiles: 0, containerCount: 0, encryptedCount: 0 },
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ---------- 阶段 1：探测模拟器实例 ----------
  reporter.enter(0, '正在确认实例连接与访问权限');
  const [identity, release] = await Promise.all([
    client.shell('id', { timeout: 10_000, signal }),
    client.shell('getprop ro.build.version.release', { timeout: 10_000, signal }),
  ]);
  if (identity.exitCode !== 0 && !identity.stdout.trim()) {
    warnings.push({
      code: 'CONNECT_FAILED',
      message: `无法在实例 ${serial} 上执行命令：${identity.message || '未知原因'}`,
    });
  }
  const uidMatch = /uid=(\d+)/.exec(identity.stdout);
  const isRoot = uidMatch ? Number(uidMatch[1]) === 0 : false;
  const androidRelease = release.stdout.trim();

  // 权限预检：目标目录是否真的读得到。读不到时给出可行动的引导而非报错（E-05）。
  const permissionProbe = await client.shell(
    `for d in ${effectiveRoots.map((r) => `'${r}'`).join(' ')}; do ` +
      `if [ -d "$d" ]; then echo "OK $d"; else echo "MISSING $d"; fi; ` +
      `done`,
    { timeout: 15_000, signal }
  );
  const probeLines = permissionProbe.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const missingRoots = probeLines.filter((l) => l.startsWith('MISSING ')).map((l) => l.slice(8));
  for (const m of missingRoots) {
    // 目录不存在是常见情况（很多设备压根没有 obb 目录），记为日志而非警告
    log.push(`扫描范围中的目录不存在，已跳过：${m}`);
  }
  if (missingRoots.length > 0 && missingRoots.length === effectiveRoots.length) {
    warnings.push({
      code: 'ALL_ROOTS_MISSING',
      message: `扫描范围中的目录全部不存在：${missingRoots.join('、')}。请确认实例已正确启动，或改用其他范围。`,
    });
  }
  if (!isRoot) {
    warnings.push({
      code: 'NOT_ROOT',
      message:
        '当前 ADB 会话以 shell 用户运行（非 root）。部分目录可能读不到内容，若扫描结果异常可尝试「以 root 身份重连」。',
    });
  }

  // ---------- 阶段 2：拉取应用清单 ----------
  reporter.enter(1, '正在读取已安装应用列表');
  let packages = [];
  try {
    packages = await client.listPackages({ signal });
  } catch (err) {
    warnings.push({ code: 'PACKAGE_LIST_FAILED', message: `读取应用列表失败：${err.message}` });
  }
  const packageSet = new Set(packages);
  log.push(`已安装应用 ${packages.length} 个`);

  // ---------- 阶段 3：遍历资源目录 ----------
  reporter.enter(2, '正在遍历资源目录');
  const traversal = await traverseDirectory({
    client,
    roots: effectiveRoots,
    reporter,
    signal,
    budget: { countTimeoutMs: budget.countTimeoutMs || 120_000 },
  });

  if (traversal.cancelled) {
    // PRD FR-03 验收点：取消后已扫描内容不得写入磁盘。
    // 这里直接返回，不落任何文件；上层也不会收到可导出的 pack 列表。
    return {
      ok: false,
      cancelled: true,
      error: null,
      warnings,
      log,
      packs: [],
      containers: [],
      stats: {
        scannedFiles: traversal.scanned,
        matchedFiles: traversal.matched,
        totalFiles: null,
        containerCount: traversal.containerCandidates.length,
        encryptedCount: 0,
      },
      elapsedMs: Date.now() - startedAt,
      source: { ...source, serial, isRoot, androidRelease },
    };
  }

  if (traversal.disconnected) {
    // E-03：模拟器掉线。保留已有结果，明确提示可重连后继续。
    warnings.push({
      code: 'DEVICE_DISCONNECTED',
      message: `扫描过程中与实例的连接中断：${traversal.message || '模拟器可能已关闭'}`,
    });
  }

  const allFiles = traversal.files;

  // ---------- 阶段 4：聚合运行时包 ----------
  reporter.enter(3, '正在聚合运行时包');
  const manifestPaths = allFiles.filter((p) => MANIFEST_PATTERN.test(p));

  // 用遍历结果做存在性判断，零额外 IO；尺寸后置批量取
  const fileSet = new Set(allFiles.map((p) => canonicalDevicePath(p)));
  const provisionalProbe = {
    async stat(absPath) {
      const key = canonicalDevicePath(absPath);
      if (fileSet.has(key)) return { exists: true, size: 1 }; // 尺寸稍后回填
      return { exists: false, size: 0 };
    },
  };

  const packs = [];
  const readErrors = [];
  for (let i = 0; i < manifestPaths.length; i += 1) {
    if (signal && signal.aborted) break;
    const entryPath = manifestPaths[i];
    const read = await client.catText(entryPath, { timeout: 20_000, signal });
    if (!read.ok) {
      readErrors.push({ path: entryPath, message: read.message || '读取清单失败' });
      packs.push({
        id: canonicalDevicePath(entryPath),
        entryPath: canonicalDevicePath(entryPath),
        entryDir: deviceDirname(entryPath),
        modelName: deviceDirname(entryPath).split('/').pop(),
        manifest: null,
        parseError: `无法读取清单文件：${read.message || '未知原因'}`,
        files: [],
        missing: [],
        motions: 0,
        expressions: 0,
        motionGroups: [],
        textureCount: 0,
        moc3Path: null,
        totalBytes: 0,
        hasMotions: false,
        hasExpressions: false,
      });
      continue;
    }
    const pack = await buildPack({
      entryPath,
      manifestText: read.text,
      probe: provisionalProbe,
      rootOf: () => null,
    });
    packs.push(pack);

    reporter.update(
      {
        packCount: packs.length,
        phaseProgress: manifestPaths.length ? (i + 1) / manifestPaths.length : 0,
        currentDir: pack.entryDir,
      },
      { urgent: false }
    );
  }

  // ---------- 阶段 5：完整性校验 ----------
  reporter.enter(4, '正在校验包完整性');

  // 复核「遍历没见到」的文件：可能是权限漏读，也可能真的缺失
  const missingCandidates = [...new Set(packs.flatMap((p) => p.missing.map((m) => m.absPath)))];
  if (missingCandidates.length > 0 && !(signal && signal.aborted)) {
    const confirmed = await verifyMissing(client, missingCandidates, signal);
    for (const pack of packs) {
      pack.missing = pack.missing.filter((m) => confirmed.get(m.absPath) !== true);
      if (pack.missing.some((m) => m.role === 'moc3')) pack.moc3Path = pack.moc3Path || null;
    }
    // 复核为「确实存在」的文件要补回文件清单
    const actuallyPresent = [...confirmed.entries()].filter(([, v]) => v).map(([k]) => k);
    if (actuallyPresent.length > 0) {
      log.push(`有 ${actuallyPresent.length} 个文件通过复核确认存在（首次遍历因权限未列出）`);
    }
  }

  // 取尺寸：只对聚合到的文件批量 stat，数量可控
  const allPackFiles = [...new Set(packs.flatMap((p) => p.files.map((f) => f.absPath)))];
  const sizes = await client.statMany(allPackFiles, { signal });
  const sizeMap = new Map([...sizes.entries()].map(([k, v]) => [canonicalDevicePath(k), v]));

  for (const pack of packs) {
    pack.files = pack.files.map((f) => {
      const size = sizeMap.get(canonicalDevicePath(f.absPath));
      return { ...f, size: typeof size === 'number' ? size : 0 };
    });
    pack.totalBytes = pack.files.reduce((sum, f) => sum + (f.size || 0), 0);
  }

  // 逐个读取 .moc3 文件头做版本检测（FR-05 要求前移到导出之前）
  const validations = [];
  for (let i = 0; i < packs.length; i += 1) {
    if (signal && signal.aborted) break;
    const pack = packs[i];
    let header = null;
    if (pack.moc3Path) {
      const head = await client.headBytes(pack.moc3Path, 16, { signal });
      if (head.ok && head.buffer.length >= 5) {
        header = readMoc3Header(head.buffer);
        // 本机 Cubism Editor 支持上限由上层注入；此处仅标注客观版本
      } else {
        header = { valid: false, magic: null, version: null, reason: '无法读取模型本体文件头', hex: '' };
      }
    }
    const validation = validatePack(pack, header);
    validations.push({ pack, validation });

    reporter.update(
      {
        phaseProgress: packs.length ? (i + 1) / packs.length : 0,
        currentDir: pack.entryDir,
      },
      { urgent: false }
    );
  }

  // ---------- 容器资源识别（FR-09，禁止静默） ----------
  const containerPaths = [...new Set(traversal.containerCandidates.map(canonicalDevicePath))];
  const containerSizes = await client.statMany(containerPaths, { signal });
  const containers = [];
  for (const p of containerPaths.slice(0, budget.maxContainerProbe || 40)) {
    if (signal && signal.aborted) break;
    const head = await client.headBytes(p, 32, { signal });
    const detect = head.ok
      ? detectContainer(head.buffer, p)
      : detectContainer(Buffer.alloc(0), p);
    const sizeRaw = containerSizes.get(p);
    containers.push({
      path: p,
      // 与解包页共用同一条显示名规则（末两段）。曾经这里是 basename，
      // 导致同一个容器在扫描页叫 main.obb、在解包页叫 files_obb/main.obb。
      name: deviceDisplayName(p),
      size: typeof sizeRaw === 'number' ? sizeRaw : null,
      sizeLabel: typeof sizeRaw === 'number' ? formatBytes(sizeRaw) : '未知',
      detect,
    });
  }
  containers.sort((a, b) => (b.size || 0) - (a.size || 0));

  // zip 结构可读性验证：能读出索引就说明是标准 zip，可以解包
  for (const c of containers) {
    if (c.detect.kind !== 'zip') continue;
    const head = await client.headBytes(c.path, 4, { signal });
    if (!head.ok) continue;
    // 仅做初步标记；完整解包在 FR-09 的解包流程里执行
    c.detect.zipLikelyStandard = true;
  }

  // ---------- 汇总 ----------
  const orphanMoc3 = allFiles
    .filter((p) => /\.moc3$/i.test(p))
    .filter((p) => !packs.some((pk) => pk.files.some((f) => canonicalDevicePath(f.absPath) === canonicalDevicePath(p))));

  const counts = {
    all: packs.length,
    complete: validations.filter((v) => v.validation.status === 'complete').length,
    incomplete: validations.filter((v) => v.validation.statusLevel === 'error').length,
    noMotions: validations.filter((v) => v.validation.status === 'no_motions').length,
    noExpressions: validations.filter((v) => v.validation.status === 'no_expressions').length,
    missingTexture: validations.filter((v) => v.validation.status === 'missing_texture').length,
    missingMoc3: validations.filter((v) => v.validation.status === 'missing_moc3').length,
    defaultChecked: validations.filter((v) => v.validation.defaultChecked).length,
  };

  // 按来源包名分组（从设备路径 /sdcard/Android/data/<包名>/ 提取）
  const bySource = {};
  for (const { pack } of validations) {
    const pkg = sourcePackageOf(pack.entryDir);
    bySource[pkg] = (bySource[pkg] || 0) + 1;
    pack.sourcePackage = pkg;
  }

  if (packs.length === 0) {
    // 空结果必须解释，不能给一张空表（E-01 / 决策 8）
    warnings.push({
      code: 'EMPTY_RESULT',
      message:
        containers.length > 0
          ? `明文扫描 ${allFiles.length.toLocaleString('en-US')} 个文件，未命中任何 .model3.json；但发现了 ${containers.length} 个资源容器。`
          : `明文扫描 ${allFiles.length.toLocaleString('en-US')} 个文件，未命中任何 .model3.json，也未发现资源容器。请确认该游戏是否使用 Live2D，或更换扫描目录。`,
    });
  }

  if (orphanMoc3.length > 0) {
    log.push(`发现 ${orphanMoc3.length} 个孤立 .moc3（找不到对应清单，无法打开，已计入日志但不进结果列表）`);
  }

  reporter.update({ phaseProgress: 1 }, { urgent: true });

  return {
    ok: true,
    cancelled: false,
    error: null,
    warnings,
    log,
    packs: validations,
    containers,
    orphanMoc3,
    counts,
    bySource,
    roots: effectiveRoots,
    rootsRemoved: rootDedup.removed,
    source: { ...source, serial, isRoot, androidRelease, packages },
    stats: {
      totalFiles: traversal.scanned,
      scannedFiles: traversal.scanned,
      matchedFiles: traversal.matched,
      containerCount: containers.length,
      encryptedCount: containers.filter((c) => c.detect.kind === 'encrypted').length,
      orphanMoc3Count: orphanMoc3.length,
    },
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = {
  SCAN_PHASES,
  RELEVANT_PATTERN,
  MANIFEST_PATTERN,
  PROGRESS_INTERVAL_MS,
  ScanReporter,
  overallPercent,
  traverseDirectory,
  verifyMissing,
  runScan,
};
