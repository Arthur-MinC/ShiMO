'use strict';

/**
 * IPC 契约层。
 *
 * 职责是把主进程的能力暴露给渲染进程，同时把所有会话状态留在主进程 ——
 * 渲染进程只拿展示用的数据，不持有 adb 客户端，也不能凭自己的状态去操作设备。
 *
 * 约定：
 *   - 所有 handler 一律返回 `{ ok, ... }` 结构，不向渲染进程抛异常；
 *   - 长任务（扫描、导出）走 AbortController，取消入口是独立通道；
 *   - 进度通过 `webContents.send` 单向推送，不用 invoke 轮询。
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const { ipcMain, dialog, shell, clipboard, app, BrowserWindow } = require('electron');

const { AdbClient, queryAdbServerVersion } = require('./core/adb');
const { discoverEmulators, selectDefaultInstance, findInstance } = require('./core/emulator-finder');
const { runScan, SCAN_PHASES } = require('./core/scanner');
const { runUnpack } = require('./core/unpacker');
const { exportPacks, buildDiagnosticsText, getFreeSpace } = require('./core/exporter');
const cubism = require('./core/cubism');
const { dedupeDevicePaths, formatBytes } = require('./core/path-utils');

const TOOL_VERSION = '1.0.0';

/** 默认扫描范围（FR-02）。 */
const DEFAULT_ROOTS = ['/storage/emulated/0/Android/data', '/storage/emulated/0/Android/obb'];

/** 应用级会话状态。**只存在于主进程**，渲染进程拿到的是它的投影。 */
const session = {
  discovery: null,
  adbPath: null,
  serial: null,
  instance: null,
  scanResult: null,
  scanController: null,
  exportController: null,
  unpackController: null,
  lastExport: null,
  diagnosticsPath: null,
  settings: {
    targetRoot: 'D:\\Live2D',
    cubismPath: null,
  },
};

function send(channel, payload) {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

/** 包装 handler，统一成 `{ok, ...}` 与异常兜底。 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const result = await fn(...args);
      return { ok: true, ...(result || {}) };
    } catch (err) {
      return {
        ok: false,
        error: err.code || 'internal_error',
        message: err.message || String(err),
      };
    }
  });
}

function requireClient() {
  if (!session.adbPath || !session.serial) {
    const err = new Error('尚未连接任何模拟器实例，请先在「连接模拟器」中选择一个运行中的实例。');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  return new AdbClient(session.adbPath, session.serial);
}

function registerIpc() {
  /* ---------------- 窗口控制（自绘标题栏需要） ---------------- */

  handle('window:minimize', () => {
    const w = BrowserWindow.getFocusedWindow();
    if (w) w.minimize();
    return {};
  });

  handle('window:toggleMaximize', () => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return { maximized: false };
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return { maximized: w.isMaximized() };
  });

  handle('window:close', () => {
    const w = BrowserWindow.getFocusedWindow();
    if (w) w.close();
    return {};
  });

  handle('app:info', () => ({
    version: TOOL_VERSION,
    name: app.getName(),
    electron: process.versions.electron,
    node: process.versions.node,
    defaultRoots: DEFAULT_ROOTS,
    settings: session.settings,
  }));

  /* ---------------- FR-01 模拟器发现 ---------------- */

  handle('emulator:discover', async (options = {}) => {
    const result = await discoverEmulators({ probeAllAdb: Boolean(options.probeAllAdb) });
    session.discovery = result;

    // 延续上次的选择时用 id 认实例 —— 未运行的实例 serial 是 null，
    // 用 serial 判会「null 等于 null」而误判成还连着（详见 emulator-finder.instanceKey）
    const previousId = session.instance ? session.instance.id : null;
    const inst = selectDefaultInstance(result.instances, previousId);
    session.instance = inst;
    session.serial = inst ? inst.serial : null;
    session.adbPath = inst ? inst.adbPath : null;

    return {
      instances: result.instances,
      installations: result.installations,
      rejected: result.rejected,
      warnings: result.warnings,
      serverVersion: result.serverVersion,
      adbReports: result.adbReports,
      runningProcessNames: result.runningProcessNames,
      selectedSerial: session.serial,
      selectedId: inst ? inst.id : null,
    };
  });

  handle('emulator:connect', async ({ id, serial, adbPath }) => {
    const discovery = session.discovery;
    const inst = findInstance(discovery ? discovery.instances : [], { id, serial });
    if (!inst) {
      return { ok: false, error: 'instance_not_found', message: `未找到实例 ${serial}，请重新检测。` };
    }
    if (!inst.running || inst.state !== 'device') {
      return {
        ok: false,
        error: 'instance_not_running',
        message: `「${inst.name}」当前${inst.stateLabel}。请先在模拟器中启动该实例，然后重新检测。`,
      };
    }
    session.serial = serial;
    session.adbPath = adbPath || inst.adbPath;
    session.instance = inst;

    // 顺手做一次连通性确认，失败就如实回报而不是等到扫描时才报错
    const client = new AdbClient(session.adbPath, session.serial);
    const probe = await client.shell('echo ready', { timeout: 10_000 });
    if (!probe.ok) {
      return {
        ok: false,
        error: 'connect_failed',
        message: `无法与实例通信：${probe.message || '未知原因'}`,
      };
    }
    return { instance: inst, adbPath: session.adbPath };
  });

  handle('emulator:tryRoot', async () => {
    const client = requireClient();
    const before = await client.whoami({ timeout: 10_000 });
    if (before.isRoot) return { alreadyRoot: true, message: '当前会话已是 root 身份。' };
    const result = await client.root({ timeout: 20_000 });
    const after = await client.whoami({ timeout: 10_000 });
    return {
      alreadyRoot: false,
      granted: after.isRoot,
      restricted: result.restricted,
      message: after.isRoot
        ? '已切换到 root 身份。'
        : result.restricted
          ? '该模拟器不接受 root 切换（部分厂商锁定了 SELinux 策略）。将继续以 shell 身份只读访问。'
          : `未能提权：${result.message || '未知原因'}`,
    };
  });

  /* ---------------- FR-02 扫描范围 ---------------- */

  handle('packages:list', async () => {
    const client = requireClient();
    const packages = await client.listPackages({ timeout: 30_000 });
    const details = [];
    for (const pkg of packages) {
      // 只标注哪些包在默认范围内有数据目录，避免为每个包都跑一次 pm path
      details.push({ packageName: pkg });
    }
    const roots = (session.scanResult && session.scanResult.roots) || DEFAULT_ROOTS;
    const existing = new Set();
    const probe = await client.shell(
      roots.map((r) => `ls -1 '${r}' 2>/dev/null`).join('; '),
      { timeout: 20_000 }
    );
    for (const line of probe.stdout.split('\n')) {
      const t = line.trim();
      if (t) existing.add(t);
    }
    for (const d of details) {
      d.visibleInDefaultRoots = existing.has(d.packageName);
    }
    details.sort((a, b) => Number(b.visibleInDefaultRoots) - Number(a.visibleInDefaultRoots));
    return { packages: details, total: details.length, visibleCount: details.filter((d) => d.visibleInDefaultRoots).length };
  });

  handle('paths:normalize', ({ roots }) => {
    const result = dedupeDevicePaths(roots || []);
    return { roots: result.kept, removed: result.removed, defaults: DEFAULT_ROOTS };
  });

  /* ---------------- FR-03 / 04 / 05 扫描 ---------------- */

  handle('scan:start', async ({ roots, adbRoot }) => {
    const client = requireClient();
    if (session.scanController) session.scanController.abort();
    const controller = new AbortController();
    session.scanController = controller;

    if (adbRoot) {
      await client.root({ timeout: 20_000 });
    }

    const requested = roots && roots.length ? roots : DEFAULT_ROOTS;
    session.scanResult = null;
    session.diagnosticsPath = null;

    const result = await runScan({
      baseClient: client,
      serial: session.serial,
      roots: requested,
      source: {
        instanceName: session.instance ? session.instance.name : session.serial,
        androidVersion: session.instance ? session.instance.androidVersion : '',
        adbAddress: session.instance ? session.instance.adbAddress : null,
      },
      signal: controller.signal,
      onProgress: (p) => send('scan:progress', p),
    });

    session.scanController = null;
    if (result.cancelled) {
      send('scan:cancelled', {});
      return { cancelled: true, phases: SCAN_PHASES };
    }

    session.scanResult = result;

    // 给渲染进程一份可直接渲染的投影（体积等已格式化好）
    return {
      cancelled: false,
      result: projectScanResult(result),
      phases: SCAN_PHASES,
    };
  });

  handle('scan:cancel', () => {
    if (session.scanController) {
      session.scanController.abort();
      return { cancelled: true, message: '已请求取消。已扫描的内容不会写入磁盘。' };
    }
    return { cancelled: false, message: '当前没有正在进行的扫描。' };
  });

  handle('scan:result', () => {
    if (!session.scanResult) return { hasResult: false };
    return { hasResult: true, result: projectScanResult(session.scanResult) };
  });

  /* ---------------- FR-09 容器解包 ---------------- */

  handle('unpack:run', async () => {
    const result = session.scanResult;
    if (!result) {
      return { ok: false, error: 'no_scan', message: '请先完成一次扫描，解包的对象来自扫描阶段识别出的容器。' };
    }
    const containers = (result.containers || []).filter((c) => c && c.path);
    if (containers.length === 0) {
      return {
        ok: false,
        error: 'no_container',
        message: '本次扫描没有发现可处理的资源容器（.obb / .zip / .dat 等）。',
      };
    }

    if (session.unpackController) session.unpackController.abort();
    const controller = new AbortController();
    session.unpackController = controller;

    const unpack = await runUnpack({
      client: requireClient(),
      containers,
      signal: controller.signal,
      onProgress: (p) => send('unpack:progress', p),
    });
    session.unpackController = null;

    // 解包成功的部分立刻并入会话结果：失败态页的主按钮是「用已解包内容继续」，
    // 点下去就能直接看到结果，不需要用户再扫一遍。
    mergeIntoScanResult(result, unpack.validations);

    return {
      ok: true,
      items: unpack.items,
      aggregatedPacks: unpack.aggregatedPacks,
      // 解包成功才有结果页；这里是给「用已解包内容继续」用的投影
      result: projectScanResult(result),
      diagnosticsName: 'diagnostics.txt',
      warnings: unpack.items
        .filter((i) => !i.ok)
        .map((i) => ({ code: `UNPACK_${i.reason.toUpperCase()}`, message: `${i.name}：${i.reasonLabel}` })),
    };
  });

  handle('unpack:cancel', () => {
    if (session.unpackController) {
      session.unpackController.abort();
      return { cancelled: true };
    }
    return { cancelled: false, message: '当前没有正在进行的解包任务。' };
  });

  /* ---------------- FR-07 导出 ---------------- */

  handle('export:preview', async ({ targetRoot, packIds }) => {
    const result = session.scanResult;
    if (!result || !result.packs) {
      return { ok: false, error: 'no_scan', message: '尚无扫描结果，无法导出。' };
    }
    const selected = pickPacks(result, packIds);
    if (selected.length === 0) {
      return { ok: false, error: 'no_selection', message: '请先勾选要导出的模型包。' };
    }
    const root = targetRoot || session.settings.targetRoot;
    const preview = await exportPacks({
      baseClient: requireClient(),
      serial: session.serial,
      packs: selected,
      targetRoot: root,
      source: buildSource(),
      dryRun: true,
      toolVersion: TOOL_VERSION,
    });
    // dryRun 模式下的空间预检已在 exportPacks 内完成
    const space = preview.space || (await getFreeSpace(root));
    return {
      ok: true,
      targetRoot: root,
      packs: selected.map((s) => ({
        packId: s.pack.id,
        modelName: s.pack.modelName,
        bytes: s.pack.totalBytes,
        bytesLabel: formatBytes(s.pack.totalBytes),
        files: s.pack.files.length,
        statusLabel: s.validation.statusLabel,
        statusLevel: s.validation.statusLevel,
      })),
      estimate: preview.estimate,
      estimateLabel: formatBytes(preview.estimate.bytes),
      space: space && space.ok ? { free: space.free, freeLabel: formatBytes(space.free) } : null,
      warnings: preview.warnings,
    };
  });

  handle('export:run', async ({ targetRoot, packIds, overwrite, saveDiagnostics }) => {
    const result = session.scanResult;
    if (!result || !result.packs) {
      return { ok: false, error: 'no_scan', message: '尚无扫描结果，无法导出。' };
    }
    const selected = pickPacks(result, packIds);
    if (selected.length === 0) {
      return { ok: false, error: 'no_selection', message: '请先勾选要导出的模型包。' };
    }
    if (session.exportController) session.exportController.abort();
    const controller = new AbortController();
    session.exportController = controller;

    const root = targetRoot || session.settings.targetRoot;
    const exportResult = await exportPacks({
      baseClient: requireClient(),
      serial: session.serial,
      packs: selected,
      targetRoot: root,
      source: buildSource(),
      signal: controller.signal,
      overwrite: Boolean(overwrite),
      toolVersion: TOOL_VERSION,
      onProgress: (p) => send('export:progress', p),
    });
    session.exportController = null;
    session.lastExport = exportResult;

    if (exportResult.blocked) {
      return {
        ok: false,
        error: 'insufficient_space',
        message: exportResult.warnings.find((w) => w.code === 'INSUFFICIENT_SPACE').message,
        space: exportResult.space,
        estimate: exportResult.estimate,
      };
    }

    // 写诊断报告（态 B 的「诊断报告已保存至 diagnostics.txt」）
    let diagnosticsPath = null;
    if (saveDiagnostics !== false) {
      try {
        const text = buildDiagnosticsText({
          scanResult: result,
          exportResult,
          source: { ...buildSource(), serial: session.serial, isRoot: result.source && result.source.isRoot, androidRelease: result.source && result.source.androidRelease },
          toolVersion: TOOL_VERSION,
        });
        diagnosticsPath = path.join(root, 'diagnostics.txt');
        await fsp.mkdir(root, { recursive: true });
        await fsp.writeFile(diagnosticsPath, text, 'utf8');
        session.diagnosticsPath = diagnosticsPath;
      } catch (err) {
        diagnosticsPath = null;
      }
    }

    return {
      ok: exportResult.ok,
      cancelled: exportResult.cancelled,
      targetRoot: root,
      totals: exportResult.totals,
      results: exportResult.results.map((r) => ({
        packId: r.packId,
        modelName: r.modelName,
        status: r.status,
        targetDir: r.targetDir,
        bytes: r.bytes || 0,
        bytesLabel: formatBytes(r.bytes || 0),
        files: r.written ? r.written.length : 0,
        reason: r.reason || null,
        failedFiles: r.failed || [],
      })),
      failedFiles: exportResult.failedFiles,
      diagnosticsPath,
      warnings: exportResult.warnings,
      // 供「用 Cubism Editor 打开」使用：找出每个包入口文件的本地路径
      entryPoints: buildEntryPoints(exportResult),
      elapsedMs: exportResult.elapsedMs,
    };
  });

  handle('export:cancel', () => {
    if (session.exportController) {
      session.exportController.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  handle('export:lastResult', () => {
    if (!session.lastExport) return { hasResult: false };
    return { hasResult: true };
  });

  handle('diagnostics:save', async ({ targetRoot }) => {
    if (!session.scanResult) {
      return { ok: false, error: 'no_scan', message: '尚无扫描结果，无法生成诊断报告。' };
    }
    const root = targetRoot || session.settings.targetRoot;
    const text = buildDiagnosticsText({
      scanResult: session.scanResult,
      exportResult: session.lastExport,
      source: { ...buildSource(), serial: session.serial, isRoot: session.scanResult.source && session.scanResult.source.isRoot },
      toolVersion: TOOL_VERSION,
    });
    await fsp.mkdir(root, { recursive: true });
    const target = path.join(root, 'diagnostics.txt');
    await fsp.writeFile(target, text, 'utf8');
    session.diagnosticsPath = target;
    return { path: target, text };
  });

  handle('diagnostics:copy', async () => {
    if (!session.scanResult) {
      return { ok: false, error: 'no_scan', message: '尚无扫描结果，无法生成诊断报告。' };
    }
    const text = buildDiagnosticsText({
      scanResult: session.scanResult,
      exportResult: session.lastExport,
      source: { ...buildSource(), serial: session.serial },
      toolVersion: TOOL_VERSION,
    });
    clipboard.writeText(text);
    return { copied: true, length: text.length };
  });

  /* ---------------- FR-08 Cubism Editor ---------------- */

  handle('cubism:detect', async ({ force, manualPath } = {}) => {
    const result = await cubism.detectCubismEditor({ force: Boolean(force), extraPath: manualPath });
    if (manualPath && result.found) session.settings.cubismPath = result.exePath;
    return result;
  });

  handle('cubism:open', async ({ entryPaths }) => {
    const detection = session.settings.cubismPath
      ? { found: true, exePath: session.settings.cubismPath }
      : await cubism.detectCubismEditor();

    const targets = (entryPaths || []).filter((p) => /\.model3\.json$/i.test(p));
    if (targets.length === 0) {
      return {
        ok: false,
        error: 'no_entry',
        message: '没有可打开的 .model3.json 入口文件。导出结果里可能存在缺失，请查看导出详情。',
      };
    }

    if (!detection.found) {
      return {
        ok: false,
        error: 'editor_not_found',
        message: '未检测到本机安装的 Cubism Editor。可用「打开文件夹」自行打开，或从官网下载后重试。',
        downloadUrl: cubism.DOWNLOAD_URL,
      };
    }

    // 编辑器通常一次只吃一个模型，这里打开第一个并在结果里说明其余未打开
    const first = targets[0];
    const launched = await cubism.launchEditor(detection.exePath, first);
    if (!launched.ok) {
      return { ok: false, error: 'launch_failed', message: launched.message, exePath: detection.exePath };
    }
    return {
      opened: first,
      exePath: detection.exePath,
      remaining: targets.slice(1),
      message: targets.length > 1 ? `已打开第 1 个模型，其余 ${targets.length - 1} 个未一同打开。` : '已打开。',
    };
  });

  handle('cubism:pickPath', async () => {
    const w = BrowserWindow.getFocusedWindow();
    const picked = await dialog.showOpenDialog(w, {
      title: '选择 Cubism Editor 可执行文件',
      properties: ['openFile'],
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
    const validated = await cubism.validateEditorPath(picked.filePaths[0]);
    if (!validated.ok) {
      return { ok: false, error: 'invalid_path', message: validated.message };
    }
    session.settings.cubismPath = validated.exePath;
    cubism.resetCache();
    return { path: validated.exePath };
  });

  /* ---------------- 系统交互 ---------------- */

  handle('shell:openPath', async ({ target }) => {
    if (!target) return { ok: false, message: '未指定要打开的路径。' };
    const err = await shell.openPath(target);
    if (err) return { ok: false, message: err };
    return { opened: target };
  });

  handle('shell:showInFolder', async ({ target }) => {
    if (!target) return { ok: false, message: '未指定路径。' };
    shell.showItemInFolder(target);
    return { shown: target };
  });

  handle('clipboard:write', ({ text }) => {
    if (typeof text !== 'string') return { ok: false, message: '没有可复制的内容。' };
    clipboard.writeText(text);
    return { copied: true, text };
  });

  handle('dialog:pickDirectory', async ({ title, defaultPath }) => {
    const w = BrowserWindow.getFocusedWindow();
    const picked = await dialog.showOpenDialog(w, {
      title: title || '选择文件夹',
      defaultPath: defaultPath || session.settings.targetRoot,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
    return { path: picked.filePaths[0] };
  });

  handle('settings:update', ({ targetRoot }) => {
    if (typeof targetRoot === 'string' && targetRoot.trim()) {
      session.settings.targetRoot = targetRoot.trim();
    }
    return { settings: session.settings };
  });

  handle('space:check', async ({ targetRoot }) => {
    const space = await getFreeSpace(targetRoot || session.settings.targetRoot);
    return space.ok
      ? { available: true, free: space.free, freeLabel: formatBytes(space.free), path: space.checkedAt }
      : { available: false, message: space.message };
  });

  /* ---------------- 会话重置 ---------------- */

  handle('session:reset', () => {
    if (session.scanController) session.scanController.abort();
    if (session.exportController) session.exportController.abort();
    if (session.unpackController) session.unpackController.abort();
    session.scanResult = null;
    session.lastExport = null;
    session.diagnosticsPath = null;
    return {};
  });
}

/* ---------------- 辅助 ---------------- */

function buildSource() {
  return {
    instanceName: session.instance ? session.instance.name : session.serial,
    androidVersion: session.instance ? session.instance.androidVersion : '',
    adbAddress: session.instance ? session.instance.adbAddress : null,
    serial: session.serial,
  };
}

/** 按 packIds 取出对应的包与校验结果；未指定则取默认勾选的。 */
function pickPacks(scanResult, packIds) {
  const all = scanResult.packs || [];
  if (!packIds || packIds.length === 0) {
    return all.filter((item) => item.validation.defaultChecked);
  }
  const wanted = new Set(packIds);
  return all.filter((item) => wanted.has(item.pack.id));
}

/**
 * 把新聚合出来的包并入既有扫描结果，并重算所有汇总值。
 *
 * 汇总值必须重算而不是自增：解包结果里可能有与明文扫描**同一个包**（先扫到清单、
 * 又从容器里解出同一份），按 id 去重后计数才对得上列表。
 */
function mergeIntoScanResult(result, newValidations) {
  if (!newValidations || newValidations.length === 0) return result;

  const existing = new Set((result.packs || []).map((item) => item.pack.id));
  const added = newValidations.filter((item) => !existing.has(item.pack.id));
  if (added.length === 0) return result;

  result.packs = [...(result.packs || []), ...added];

  const validations = result.packs;
  result.counts = {
    all: validations.length,
    complete: validations.filter((v) => v.validation.status === 'complete').length,
    incomplete: validations.filter((v) => v.validation.statusLevel === 'error').length,
    noMotions: validations.filter((v) => v.validation.status === 'no_motions').length,
    noExpressions: validations.filter((v) => v.validation.status === 'no_expressions').length,
    missingTexture: validations.filter((v) => v.validation.status === 'missing_texture').length,
    missingMoc3: validations.filter((v) => v.validation.status === 'missing_moc3').length,
    defaultChecked: validations.filter((v) => v.validation.defaultChecked).length,
  };

  const bySource = {};
  for (const { pack } of validations) {
    const pkg = pack.sourcePackage || '未知来源';
    bySource[pkg] = (bySource[pkg] || 0) + 1;
  }
  result.bySource = bySource;

  result.stats = {
    ...result.stats,
    unpackedPacks: added.length,
  };

  result.log = [...(result.log || []), `解包聚合：新增 ${added.length} 个运行时包`];
  return result;
}

/** 把扫描结果整理成渲染进程直接可用、且体积已格式化的投影。 */
function projectScanResult(result) {
  const counts = result.counts || {};
  return {
    ok: result.ok,
    elapsedMs: result.elapsedMs,
    elapsedLabel: `${(result.elapsedMs / 1000).toFixed(1)} 秒`,
    roots: result.roots,
    rootsRemoved: result.rootsRemoved,
    stats: {
      scannedFiles: (result.stats && result.stats.scannedFiles) || 0,
      matchedFiles: (result.stats && result.stats.matchedFiles) || 0,
      containerCount: (result.stats && result.stats.containerCount) || 0,
      encryptedCount: (result.stats && result.stats.encryptedCount) || 0,
      orphanMoc3Count: (result.stats && result.stats.orphanMoc3Count) || 0,
      scannedFilesLabel: ((result.stats && result.stats.scannedFiles) || 0).toLocaleString('en-US'),
    },
    counts,
    bySource: result.bySource || {},
    source: {
      serial: result.source ? result.source.serial : null,
      isRoot: result.source ? result.source.isRoot : false,
      androidRelease: result.source ? result.source.androidRelease : '',
      packageCount: result.source && result.source.packages ? result.source.packages.length : 0,
    },
    packs: (result.packs || []).map((item) => ({
      id: item.pack.id,
      modelName: item.pack.modelName,
      entryPath: item.pack.entryPath,
      entryDir: item.pack.entryDir,
      sourcePackage: item.pack.sourcePackage || '',
      motions: item.pack.motions,
      expressions: item.pack.expressions,
      textureCount: item.pack.textureCount,
      motionGroups: item.pack.motionGroups,
      totalBytes: item.pack.totalBytes,
      bytesLabel: formatBytes(item.pack.totalBytes),
      fileCount: item.pack.files.length,
      // 内容列只写「动作 · 表情」——缺了什么由状态列与 statusDetail 表达，
      // 混在一起会让状态列失去扫读价值（设计稿的表格列宽也容不下）。
      contentLabel: `${item.pack.motions} 动作 · ${item.pack.expressions} 表情`,
      status: item.validation.status,
      statusLabel: item.validation.statusLabel,
      statusLevel: item.validation.statusLevel,
      statusDetail: item.validation.statusDetail,
      defaultChecked: item.validation.defaultChecked,
      moc3Version: item.validation.moc3Version,
      moc3Compat: item.validation.moc3Compat,
      issues: item.validation.issues,
      missing: item.pack.missing.map((m) => ({ relPath: m.relPath, role: m.role, reason: m.reason })),
    })),
    containers: (result.containers || []).map((c) => ({
      path: c.path,
      name: c.name,
      sizeLabel: c.sizeLabel,
      kind: c.detect.kind,
      label: c.detect.label,
      headerHex: c.detect.headerHex,
      extractable: c.detect.extractable,
      unsupported: c.detect.unsupported,
      hint: c.detect.hint,
    })),
    orphanMoc3: result.orphanMoc3 || [],
    warnings: result.warnings || [],
    log: result.log || [],
  };
}

/** 从导出结果里算出每个包入口文件的本地路径，供一键打开使用。 */
function buildEntryPoints(exportResult) {
  const points = [];
  for (const r of exportResult.results || []) {
    if (!r.targetDir) continue;
    const modelFile = `${r.modelName}.model3.json`;
    points.push({
      packId: r.packId,
      modelName: r.modelName,
      targetDir: r.targetDir,
      entryPath: path.join(r.targetDir, modelFile),
      status: r.status,
    });
  }
  return points;
}

module.exports = { registerIpc, session, TOOL_VERSION, DEFAULT_ROOTS };
