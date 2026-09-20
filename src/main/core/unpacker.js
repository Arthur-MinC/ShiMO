'use strict';

/**
 * 容器解包（FR-09）。
 *
 * 为什么必须有这一层：相当一部分游戏不把 Live2D 资源明文落盘，而是打进
 * `.obb` / zip。扫描器按 `.model3.json` 扩展名扫，这类游戏会**一个都扫不到**。
 * 如果界面上只有一个空表格，用户的结论只会是「软件坏了」。所以扫描阶段识别出的
 * 压缩容器，必须在这里被真正尝试解开一次，并把成败逐项讲清楚。
 *
 * 能力边界（写进界面，不静默）：
 *   - 支持：标准 zip / obb（有可读的中央目录），以及 zip 内直接放着的明文资源；
 *   - 不支持：AssetBundle（.unity3d / .ab）、游戏自定义加密容器、7z / rar；
 *     本工具不内置任何解密算法，也不绕过加密保护。
 *   - 体积上限：容器本体超过 `MAX_CONTAINER_BYTES` 时如实拒绝。本版读整包进内存，
 *     不做流式解包 —— 与其悄悄失败，不如直接说明「太大，本版不处理」。
 *
 * 解包结果只在内存里，**不落盘**。要落到磁盘必须走导出流程（FR-07），
 * 这样「取消扫描不留残留文件」的承诺才成立。
 */

const { readZipIndex, extractZipEntry } = require('./container');
const { buildPack } = require('./packer');
const {
  canonicalDevicePath,
  deviceDirname,
  deviceDisplayName,
  sourcePackageOf,
  formatBytes,
} = require('./path-utils');
const { validatePack, readMoc3Header } = require('./validator');

/** 容器本体读取上限：超过就不读，避免把 400MB 的 obb 整包灌进内存。 */
const MAX_CONTAINER_BYTES = 192 * 1024 * 1024;
/** 单个容器内实际解压出来的总字节上限。 */
const MAX_EXTRACT_BYTES = 320 * 1024 * 1024;
/** 解包后认定属于某个模型包的入口清单。 */
const MANIFEST_RE = /\.model3\.json$/i;

/** 需要真正读出来参与聚合的文件类型。其余条目不解压，省内存也省时间。 */
const NEEDED_RE = /\.(model3\.json|moc3|physics3\.json|pose3\.json|cdi3\.json|motion3\.json|exp3\.json|userdata3\.json|png|webp|jpg|jpeg|bmp)$/i;

/** 失败原因码 → 面向用户的一句话。含糊的「部分资源处理失败」等于没说。 */
const REASON_LABELS = {
  container_too_large: '容器过大，本版不内置流式解包',
  zip_read_failed: '读取容器内容失败',
  not_standard_zip: '未知压缩格式',
  no_manifest_in_container: '容器内未找到 .model3.json',
  nothing_extractable: '容器内没有本工具支持的资源文件',
  extract_failed: '解压失败',
  unsupported_assetbundle: 'AssetBundle 需 UABE / AssetStudio 解析',
  unsupported_encrypted: '自定义加密头',
  unsupported_format: '格式不支持',
  cancelled: '已取消',
};

/**
 * 容器在界面上的显示名。
 *
 * 规则本体在 `path-utils.deviceDisplayName`（扫描页显示同一批容器，必须共用一份），
 * 这里保留一个同名转发是为了让「解包侧」的调用点读起来仍是一个本地概念。
 */
function displayName(devicePath) {
  return deviceDisplayName(devicePath);
}

/** 来源包名由 `path-utils.sourcePackageOf` 提供，扫描器与解包器共用同一份规则。 */

/**
 * 判断某个容器该怎么处理。
 * @returns {{action:'unpack'|'reject', reason:string, reasonLabel:string}}
 */
function planFor(container) {
  const detect = container.detect || { kind: 'unknown', label: '未知格式', unsupported: true, headerHex: '' };

  if (detect.kind === 'zip' && detect.extractable) return { action: 'unpack', reason: '', reasonLabel: '' };

  if (detect.kind === 'assetbundle') {
    return { action: 'reject', reason: 'unsupported_assetbundle', reasonLabel: REASON_LABELS.unsupported_assetbundle };
  }
  if (detect.kind === 'encrypted') {
    // 设计稿的写法是「自定义加密头 0x4C32」—— 只取前两字节，太长没法读
    const hex = String(detect.headerHex || '').split(' ').slice(0, 2).join('');
    return {
      action: 'reject',
      reason: 'unsupported_encrypted',
      reasonLabel: hex ? `${REASON_LABELS.unsupported_encrypted} 0x${hex}` : REASON_LABELS.unsupported_encrypted,
    };
  }
  return { action: 'reject', reason: 'unsupported_format', reasonLabel: detect.label || REASON_LABELS.unsupported_format };
}

/**
 * 决定要从 zip 里取出哪些条目。
 *
 * 关键约束：清单里的引用全部是**相对清单自身**的路径，所以只要某个目录下存在
 * `.model3.json`，该目录下的整棵子树都必须一起取出，否则聚合时必然报「缺纹理」。
 * 目录之外的条目按扩展名过滤即可。
 */
function planEntries(entries) {
  const manifests = entries.filter((e) => !e.isDir && MANIFEST_RE.test(e.name));
  const dirs = [...new Set(manifests.map((e) => deviceDirname(`/${e.name}`)))];

  const wanted = entries.filter((e) => {
    if (e.isDir) return false;
    const abs = `/${e.name}`;
    if (dirs.some((d) => abs.startsWith(`${d}/`))) return true;
    return NEEDED_RE.test(e.name);
  });

  return { manifests, dirs, wanted };
}

/**
 * 为解包出来的条目构造一个「虚拟设备树」，复用与扫描完全相同的聚合逻辑。
 *
 * 虚拟路径保留容器的原始设备路径，好处是：
 *   - `buildPack` 的相对路径解析不用改；
 *   - 来源包名（/Android/data/<pkg>/）能被同一套正则识别出来。
 */
function createMemoryProbe(rootPrefix, files) {
  const exists = new Set(files.keys());
  return {
    async stat(absPath) {
      const p = canonicalDevicePath(absPath);
      const buf = files.get(p);
      if (!buf) return { exists: false, size: 0 };
      return { exists: true, size: buf.length };
    },
    async readText(absPath) {
      const buf = files.get(canonicalDevicePath(absPath));
      return buf ? buf.toString('utf8') : null;
    },
    root: rootPrefix,
  };
}

/**
 * 解包单个容器。
 * @returns {Promise<{item:object, validations:Array}>}
 */
async function unpackContainer({ client, container, signal, budget = {} }) {
  const name = displayName(container.path);
  const base = { name, path: container.path, size: container.size, sizeLabel: container.sizeLabel || formatBytes(container.size) };
  const limits = { readTimeoutMs: budget.readTimeoutMs || 120_000 };

  if (signal && signal.aborted) {
    return { item: { ...base, ok: false, reason: 'cancelled', reasonLabel: REASON_LABELS.cancelled, packCount: 0 }, validations: [] };
  }

  const plan = planFor(container);
  if (plan.action === 'reject') {
    return { item: { ...base, ok: false, reason: plan.reason, reasonLabel: plan.reasonLabel, packCount: 0 }, validations: [] };
  }

  if ((container.size || 0) > MAX_CONTAINER_BYTES) {
    return {
      item: {
        ...base,
        ok: false,
        reason: 'container_too_large',
        reasonLabel: `${REASON_LABELS.container_too_large}（本容器 ${formatBytes(container.size)}）`,
        packCount: 0,
      },
      validations: [],
    };
  }

  const read = await client.catBuffer(container.path, { timeout: limits.readTimeoutMs, signal });
  if (!read.ok) {
    const cancelled = Boolean(read.cancelled) || Boolean(signal && signal.aborted);
    return {
      item: {
        ...base,
        ok: false,
        reason: cancelled ? 'cancelled' : 'zip_read_failed',
        reasonLabel: cancelled ? REASON_LABELS.cancelled : `${REASON_LABELS.zip_read_failed}：${read.message || '未知原因'}`,
        packCount: 0,
      },
      validations: [],
    };
  }

  const zip = readZipIndex(read.buffer);
  if (!zip.ok) {
    return {
      item: { ...base, ok: false, reason: 'not_standard_zip', reasonLabel: REASON_LABELS.not_standard_zip, packCount: 0, detail: zip.message },
      validations: [],
    };
  }

  const { manifests, dirs, wanted } = planEntries(zip.entries);
  if (manifests.length === 0) {
    return {
      item: {
        ...base,
        ok: false,
        reason: 'no_manifest_in_container',
        reasonLabel: REASON_LABELS.no_manifest_in_container,
        packCount: 0,
        detail: `中央目录共 ${zip.entries.length} 个条目，均不含 .model3.json`,
      },
      validations: [],
    };
  }

  // 真正解压
  const rootPrefix = `/unpacked${canonicalDevicePath(container.path)}`;
  const files = new Map();
  let extractedBytes = 0;
  const extractErrors = [];

  for (const entry of wanted) {
    if (signal && signal.aborted) break;
    if (extractedBytes > MAX_EXTRACT_BYTES) {
      extractErrors.push({ name: entry.name, message: `解压总量超过上限（${formatBytes(MAX_EXTRACT_BYTES)}），剩余条目已跳过` });
      break;
    }
    const out = extractZipEntry(read.buffer, entry);
    if (!out.ok) {
      extractErrors.push({ name: entry.name, message: out.message });
      continue;
    }
    files.set(`${rootPrefix}/${entry.name}`, out.buffer);
    extractedBytes += out.buffer.length;
  }

  if (files.size === 0) {
    return {
      item: {
        ...base,
        ok: false,
        reason: 'extract_failed',
        reasonLabel: REASON_LABELS.extract_failed,
        packCount: 0,
        detail: extractErrors[0] ? extractErrors[0].message : '没有条目被成功解压',
      },
      validations: [],
    };
  }

  // 聚合：与磁盘扫描走同一套 buildPack，行为不会出现两套解释
  const probe = createMemoryProbe(rootPrefix, files);
  const validations = [];
  const pkg = sourcePackageOf(container.path);

  for (const manifest of manifests) {
    const entryPath = `${rootPrefix}/${manifest.name}`;
    const buf = files.get(entryPath);
    if (!buf) continue;
    const pack = await buildPack({
      entryPath,
      manifestText: buf.toString('utf8'),
      probe,
      rootOf: () => rootPrefix,
    });
    if (pack.parseError) continue;

    pack.sourcePackage = pkg;
    pack.fromContainer = { name, path: container.path };
    pack.displayDir = deviceDirname(entryPath).slice(rootPrefix.length + 1);

    // moc3 版本判定要用真实文件头，这里的数据就在内存里，没有理由跳过
    let moc3Header = null;
    if (pack.moc3Path && files.has(pack.moc3Path)) {
      moc3Header = readMoc3Header(files.get(pack.moc3Path).subarray(0, 8));
    }
    validations.push({ pack, validation: validatePack(pack, moc3Header) });
  }

  if (validations.length === 0) {
    return {
      item: {
        ...base,
        ok: false,
        reason: 'nothing_extractable',
        reasonLabel: REASON_LABELS.nothing_extractable,
        packCount: 0,
        detail: `容器内有 ${manifests.length} 个清单，但均无法解析`,
      },
      validations: [],
    };
  }

  return {
    item: {
      ...base,
      ok: true,
      reason: '',
      reasonLabel: '',
      packCount: validations.length,
      entryCount: files.size,
      extractedBytes,
      manifestCount: manifests.length,
      modelDirs: dirs.length,
      extractErrors,
    },
    validations,
  };
}

/**
 * 批量解包。
 *
 * @param {object} args
 * @param {object} args.client      AdbClient
 * @param {Array}  args.containers  扫描阶段识别出的容器（含 detect 结果）
 * @param {AbortSignal} [args.signal]
 * @param {(p:object)=>void} [args.onProgress]
 * @returns {Promise<{items:Array, validations:Array, aggregatedPacks:number}>}
 */
async function runUnpack({ client, containers, signal, onProgress, budget = {} }) {
  const limits = {
    readTimeoutMs: budget.readTimeoutMs || 120_000,
  };
  const list = (containers || []).filter((c) => c && c.path);
  const items = [];
  const validations = [];

  for (let i = 0; i < list.length; i += 1) {
    if (signal && signal.aborted) break;
    if (onProgress) onProgress({ index: i, total: list.length, name: displayName(list[i].path) });
    // 取消是在上面那次进度回调里发出的（「下一个容器开始前取消」），
    // 所以回调之后必须再判一次 —— 否则循环开头那次判断永远看不到取消，
    // 用户点了取消还是会多读一个容器。
    if (signal && signal.aborted) break;
    const result = await unpackContainer({ client, container: list[i], signal, budget: limits });
    items.push(result.item);
    validations.push(...result.validations);
  }

  if (onProgress) onProgress({ index: list.length, total: list.length, name: '', done: true });

  return { items, validations, aggregatedPacks: validations.length };
}

module.exports = {
  runUnpack,
  unpackContainer,
  planFor,
  planEntries,
  createMemoryProbe,
  displayName,
  sourcePackageOf,
  REASON_LABELS,
  MAX_CONTAINER_BYTES,
  MAX_EXTRACT_BYTES,
  NEEDED_RE,
};
