'use strict';

/**
 * 导出与另存为（FR-07）。
 *
 * 几个不能妥协的点：
 *
 * 1. **相对路径原样保持**。整个文件夹必须一起搬，单独拷一个 .moc3 毫无意义。
 *    为此导出时以 `.model3.json` 所在目录为包根，按它在包内的相对位置落盘。
 *
 * 2. **文件名不转码、不替换**。模型名常含日文与特殊字符。
 *    因此这里**不用 `adb pull`** —— adb 是命令行工具，Windows 上的参数编码
 *    不受我们控制，日文文件名有被转码或替换的风险。
 *    改用 `adb exec-out cat` 拿字节流、由 Node 自己写文件，编码全程在我们的掌控中。
 *    （实测代价可从并发弥补，见 CONCURRENCY。）
 *
 * 3. **空间提前拦截**。写之前就算清楚要多少，不够就停，别写到一半失败。
 *
 * 4. **断点续传**。已完成的包（目标目录里已有 manifest.txt）直接跳过。
 *    这解决「导到一半磁盘满 / 模拟器掉线」后的重试体验。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { formatBytes, sanitizeLocalName } = require('./path-utils');
const { buildManifestText } = require('./validator');

/** 并发拉取文件数。adb 是进程级调用，适度并发能显著缩短导出时间。 */
const CONCURRENCY = 6;

/** 单文件大小上限。超过则跳过并如实登记，避免把内存吃满。 */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/**
 * 查询目标磁盘可用空间。
 * Node 20+ 的 fs.statfs 在 Windows 上可用；不可用时返回 null，由调用方降级处理。
 */
async function getFreeSpace(targetPath, { signal } = {}) {
  try {
    let probe = targetPath;
    // 目标目录可能还不存在，向上找到第一个存在的祖先
    while (probe && !fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const stat = await fsp.statfs(probe, { bigint: true });
    const free = stat.bavail * stat.bsize;
    const total = stat.blocks * stat.bsize;
    return { ok: true, free: Number(free), total: Number(total), checkedAt: probe };
  } catch (err) {
    return { ok: false, free: null, total: null, message: err.message };
  }
}

/** 计算一次导出需要写入的字节数（按文件绝对路径去重，避免共享文件被重复计算）。 */
function estimateExportBytes(packs) {
  const seen = new Set();
  let bytes = 0;
  let files = 0;
  for (const item of packs) {
    const pack = item.pack || item;
    for (const f of pack.files || []) {
      const key = f.absPath;
      if (seen.has(key)) continue;
      seen.add(key);
      bytes += f.size || 0;
      files += 1;
    }
  }
  return { bytes, files };
}

/** 生成导出用的本地目录名。只做「不可用于文件名」的字符替换，不动日文与中文。 */
function safeSegment(name) {
  return sanitizeLocalName(String(name || 'unnamed')).slice(0, 120) || 'unnamed';
}

/** 计算某个包在本地导出目录中的落点。 */
function packTargetDir(targetRoot, pack) {
  const pkg = pack.sourcePackage || '未知来源';
  return path.join(targetRoot, safeSegment(pkg), safeSegment(pack.modelName));
}

/** 并发执行带限流的任务队列。 */
async function runPool(tasks, limit, { signal } = {}) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (signal && signal.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * 判断包是否已完整导出过（断点续传依据）。
 * 以 manifest.txt 存在且非空作为「这个包导完了」的标记。
 */
async function isAlreadyExported(dir) {
  try {
    const st = await fsp.stat(path.join(dir, 'manifest.txt'));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * 导出一个运行时包。
 *
 * @param {object} args
 * @param {import('./adb').AdbClient} args.client 已绑定 serial 的客户端
 * @param {object} args.pack
 * @param {object} args.validation
 * @param {string} args.targetDir 该包的本地目标目录
 * @param {object} args.source 来源信息（写进 manifest）
 * @param {AbortSignal} [args.signal]
 * @param {Function} [args.onFile] 每写一个文件的回调
 */
async function exportSinglePack({ client, pack, validation, targetDir, source, signal, onFile, toolVersion, savedRoot, skippedFiles }) {
  await fsp.mkdir(targetDir, { recursive: true });

  const written = [];
  const failed = [];

  const tasks = pack.files.map((file) => async () => {
    if (signal && signal.aborted) return;
    const rel = file.exportRelPath || file.relPath;
    // 用包内相对路径落盘，路径结构原样保持（FR-07 验收点）
    const localPath = path.join(targetDir, ...String(rel).split('/').filter(Boolean));

    if ((file.size || 0) > MAX_FILE_BYTES) {
      failed.push({ rel, reason: `文件过大（${formatBytes(file.size)}），已跳过以免内存不足` });
      return;
    }

    try {
      await fsp.mkdir(path.dirname(localPath), { recursive: true });
      const read = await client.catBuffer(file.absPath, { signal, timeout: 0 });
      if (!read.ok || read.buffer.length === 0) {
        failed.push({ rel, reason: read.message || '读取失败或文件为空' });
        return;
      }
      await fsp.writeFile(localPath, read.buffer);
      written.push({ rel, bytes: read.buffer.length });
      if (onFile) onFile({ rel, bytes: read.buffer.length });
    } catch (err) {
      failed.push({ rel, reason: err.message });
    }
  });

  await runPool(tasks, CONCURRENCY, { signal });

  if (signal && signal.aborted) {
    return { status: 'cancelled', written, failed, targetDir };
  }

  const manifestText = buildManifestText({
    pack,
    validation,
    source,
    exportedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    toolVersion,
    savedRoot,
    cancelledNote:
      skippedFiles && skippedFiles.length > 0
        ? `本次导出有 ${skippedFiles.length} 个文件未能写入（原因见上方校验段落），该包可能不完整。`
        : null,
  });

  await fsp.writeFile(path.join(targetDir, 'manifest.txt'), manifestText, 'utf8');

  return {
    status: failed.length > 0 ? 'partial' : 'exported',
    written,
    failed,
    targetDir,
    bytes: written.reduce((s, w) => s + w.bytes, 0),
  };
}

/**
 * 批量导出。
 *
 * @param {object} args
 * @param {import('./adb').AdbClient} args.baseClient
 * @param {string} args.serial
 * @param {Array<{pack:object, validation:object}>} args.packs 已勾选的包
 * @param {string} args.targetRoot 导出根目录
 * @param {object} args.source
 * @param {AbortSignal} [args.signal]
 * @param {Function} [args.onProgress]
 * @param {boolean} [args.overwrite] 覆盖已有结果而不是跳过
 * @param {boolean} [args.dryRun] 只做预检不写盘（用于导出前的确认弹窗）
 */
async function exportPacks({
  baseClient,
  serial,
  packs,
  targetRoot,
  source = {},
  signal,
  onProgress,
  overwrite = false,
  dryRun = false,
  toolVersion = '1.0.0',
}) {
  const startedAt = Date.now();
  const warnings = [];
  const client = baseClient.withSerial(serial);

  const estimate = estimateExportBytes(packs);

  // ---------- 空间预检（E-04）----------
  const space = await getFreeSpace(targetRoot, { signal });
  if (!space.ok) {
    warnings.push({
      code: 'SPACE_CHECK_FAILED',
      message: `无法读取目标磁盘可用空间：${space.message || '未知原因'}。将继续导出，但请注意磁盘容量。`,
    });
  } else if (space.free < estimate.bytes * 1.05) {
    warnings.push({
      code: 'INSUFFICIENT_SPACE',
      message:
        `目标磁盘可用空间不足：需要约 ${formatBytes(estimate.bytes)}，` +
        `当前可用 ${formatBytes(space.free)}。请清理磁盘或更换导出位置后重试。`,
      blocker: true,
    });
    return {
      ok: false,
      blocked: true,
      error: 'insufficient_space',
      warnings,
      estimate,
      space,
      results: [],
      elapsedMs: Date.now() - startedAt,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      estimate,
      space,
      warnings,
      results: packs.map((item) => ({
        packId: item.pack.id,
        modelName: item.pack.modelName,
        targetDir: packTargetDir(targetRoot, item.pack),
        status: 'planned',
      })),
      elapsedMs: Date.now() - startedAt,
    };
  }

  // ---------- 逐包导出 ----------
  const results = [];
  for (let i = 0; i < packs.length; i += 1) {
    if (signal && signal.aborted) break;
    const item = packs[i];
    const pack = item.pack;
    const targetDir = packTargetDir(targetRoot, pack);

    if (onProgress) {
      onProgress({
        index: i,
        total: packs.length,
        phase: 'export',
        modelName: pack.modelName,
        percent: Math.round((i / Math.max(1, packs.length)) * 100),
        message: `正在导出 ${pack.modelName}`,
      });
    }

    if (!overwrite && (await isAlreadyExported(targetDir))) {
      results.push({
        packId: pack.id,
        modelName: pack.modelName,
        targetDir,
        status: 'skipped',
        reason: '该包此前已导出完成，已跳过',
        written: [],
        failed: [],
        bytes: 0,
      });
      continue;
    }

    if (item.validation.statusLevel === 'error' && !overwrite) {
      // 残包默认不勾选；如果调用方仍然传进来，如实标注但仍执行，由调用方决定
      warnings.push({
        code: 'EXPORTING_INCOMPLETE_PACK',
        message: `「${pack.modelName}」未通过完整性校验（${item.validation.statusLabel}），仍按请求导出。`,
      });
    }

    const single = await exportSinglePack({
      client,
      pack,
      validation: item.validation,
      targetDir,
      source: {
        instanceName: source.instanceName,
        adbAddress: source.adbAddress || source.serial || serial,
        androidVersion: source.androidVersion,
        packageName: pack.sourcePackage,
      },
      signal,
      onFile: null,
      toolVersion,
      savedRoot: targetRoot,
      skippedFiles: null,
    });

    results.push({ packId: pack.id, modelName: pack.modelName, ...single });
  }

  const cancelled = Boolean(signal && signal.aborted);

  const totals = {
    requested: packs.length,
    exported: results.filter((r) => r.status === 'exported').length,
    partial: results.filter((r) => r.status === 'partial').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    cancelled: results.filter((r) => r.status === 'cancelled').length,
    bytes: results.reduce((s, r) => s + (r.bytes || 0), 0),
    files: results.reduce((s, r) => s + (r.written ? r.written.length : 0), 0),
  };

  // 逐条列出失败文件，不留「部分资源处理失败」这种无法行动的表述（E-02 验收点）
  const allFailed = results.flatMap((r) =>
    (r.failed || []).map((f) => ({ modelName: r.modelName, rel: f.rel, reason: f.reason }))
  );

  return {
    ok: !cancelled && totals.exported + totals.partial > 0,
    cancelled,
    targetRoot,
    results,
    totals,
    failedFiles: allFailed,
    estimate,
    space,
    warnings,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * 生成导出诊断报告（态 B 的「已写入诊断报告」）。
 * 逐项写清哪个容器、失败在哪一步，而不是笼统的「部分资源处理失败」。
 */
function buildDiagnosticsText({ scanResult, exportResult, source, toolVersion }) {
  const lines = [];
  const rule = '='.repeat(64);
  lines.push(rule);
  lines.push('拾模 · 诊断报告');
  lines.push(rule);
  lines.push('');
  lines.push(`生成时间      ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
  lines.push(`工具版本      拾模 ${toolVersion}`);
  lines.push('');
  lines.push('[数据来源]');
  lines.push(`  模拟器实例    ${(source && source.instanceName) || '—'}`);
  lines.push(`  实例标识      ${(source && source.serial) || '—'}`);
  lines.push(`  Android 版本  ${(source && source.androidRelease) || '—'}`);
  lines.push(`  ADB 会话身份  ${source && source.isRoot ? 'root' : 'shell（未提权）'}`);
  lines.push('');

  if (scanResult) {
    lines.push('[扫描概况]');
    lines.push(`  扫描范围      ${(scanResult.roots || []).join('、') || '—'}`);
    lines.push(`  已扫描文件    ${(scanResult.stats && scanResult.stats.scannedFiles) || 0}`);
    lines.push(`  相关文件      ${(scanResult.stats && scanResult.stats.matchedFiles) || 0}`);
    lines.push(`  聚合到的包    ${(scanResult.packs || []).length}`);
    lines.push(`  发现的容器    ${(scanResult.containers || []).length}`);
    lines.push('');

    if (scanResult.containers && scanResult.containers.length > 0) {
      lines.push('[发现的资源容器]');
      for (const c of scanResult.containers) {
        lines.push(`  ${c.name}`);
        lines.push(`      路径      ${c.path}`);
        lines.push(`      体积      ${c.sizeLabel}`);
        lines.push(`      格式判断  ${c.detect.label}`);
        lines.push(`      文件头    ${c.detect.headerHex}`);
        lines.push(`      本版支持  ${c.detect.extractable ? '是（标准 zip 结构）' : '否'}`);
        if (c.detect.hint) lines.push(`      说明      ${c.detect.hint}`);
        lines.push('');
      }
    }

    lines.push('[能力边界]');
    lines.push('  本版支持：明文资源（.model3.json / .moc3 等直接落盘）、标准 zip / obb 结构。');
    lines.push('  本版不支持：AssetBundle（.unity3d / .ab）、游戏自定义加密容器。');
    lines.push('  说明：本工具不内置任何解密算法，也不绕过任何加密保护。');
    lines.push('');

    if (scanResult.orphanMoc3 && scanResult.orphanMoc3.length > 0) {
      lines.push('[孤立模型本体]');
      lines.push('  以下 .moc3 找不到对应的 .model3.json 清单，无法打开，故未进入结果列表：');
      for (const p of scanResult.orphanMoc3.slice(0, 50)) lines.push(`    ${p}`);
      if (scanResult.orphanMoc3.length > 50) lines.push(`    …另有 ${scanResult.orphanMoc3.length - 50} 个`);
      lines.push('');
    }
  }

  if (exportResult) {
    lines.push('[导出概况]');
    lines.push(`  目标位置      ${exportResult.targetRoot || '—'}`);
    lines.push(`  请求包数      ${exportResult.totals.requested}`);
    lines.push(`  成功          ${exportResult.totals.exported}`);
    lines.push(`  部分成功      ${exportResult.totals.partial}`);
    lines.push(`  跳过          ${exportResult.totals.skipped}`);
    lines.push(`  写入文件      ${exportResult.totals.files}`);
    lines.push(`  写入体积      ${formatBytes(exportResult.totals.bytes)}`);
    lines.push('');
    if (exportResult.failedFiles && exportResult.failedFiles.length > 0) {
      lines.push('[未能写入的文件]');
      for (const f of exportResult.failedFiles) {
        lines.push(`  ${f.modelName} / ${f.rel}`);
        lines.push(`      原因      ${f.reason}`);
      }
      lines.push('');
    }
  }

  if (scanResult && scanResult.warnings && scanResult.warnings.length > 0) {
    lines.push('[警告]');
    for (const w of scanResult.warnings) lines.push(`  · ${w.message}`);
    lines.push('');
  }
  if (scanResult && scanResult.log && scanResult.log.length > 0) {
    lines.push('[日志]');
    for (const l of scanResult.log) lines.push(`  · ${l}`);
    lines.push('');
  }

  lines.push('本报告由拾模自动生成，用于排查扫描与导出过程中发现的问题。');
  lines.push('');
  return lines.join('\r\n');
}

module.exports = {
  CONCURRENCY,
  MAX_FILE_BYTES,
  getFreeSpace,
  estimateExportBytes,
  packTargetDir,
  isAlreadyExported,
  exportSinglePack,
  exportPacks,
  buildDiagnosticsText,
  safeSegment,
};
