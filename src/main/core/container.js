'use strict';

/**
 * 容器资源识别与标准 zip / obb 解包（FR-09）。
 *
 * 这一层的存在理由写在 PRD 风险 R-01 里：明文扫描只在资源直接落盘时成立。
 * 相当一部分游戏把 Live2D 打进 obb / zip / AssetBundle / 自定义加密容器，
 * 此时按 .model3.json 扩展名扫描一个都扫不到。
 *
 * 于是有了两条明确的产品约束：
 *   1. 遇到不支持的容器时**禁止静默返回空结果**（FR-09 验收点），
 *      必须列出已发现的容器、大小、格式判断；
 *   2. 本版能力边界必须写清楚：明文资源 + 标准 zip/obb 能处理，
 *      AssetBundle 与自定义加密容器如实标注不支持。
 */

const zlib = require('node:zlib');

/** 已知文件头签名。顺序即匹配优先级。 */
const SIGNATURES = [
  { kind: 'zip', label: '标准 zip', bytes: [0x50, 0x4b, 0x03, 0x04], extractable: true },
  { kind: 'zip', label: '标准 zip（空包）', bytes: [0x50, 0x4b, 0x05, 0x06], extractable: true },
  { kind: 'zip', label: '标准 zip（分卷）', bytes: [0x50, 0x4b, 0x07, 0x08], extractable: false },
  { kind: 'gzip', label: 'gzip 压缩', bytes: [0x1f, 0x8b], extractable: false },
  { kind: 'zstd', label: 'zstd 压缩', bytes: [0x28, 0xb5, 0x2f, 0xfd], extractable: false },
  { kind: 'bzip2', label: 'bzip2 压缩', bytes: [0x42, 0x5a, 0x68], extractable: false },
  { kind: 'xz', label: 'xz 压缩', bytes: [0xfd, 0x37, 0x7a, 0x58], extractable: false },
];

/** 以 ASCII 开头的文件头（AssetBundle 家族等）。 */
const ASCII_SIGNATURES = [
  { kind: 'assetbundle', label: 'Unity AssetBundle（UnityFS）', ascii: 'UnityFS', extractable: false },
  { kind: 'assetbundle', label: 'Unity AssetBundle（UnityWeb）', ascii: 'UnityWeb', extractable: false },
  { kind: 'assetbundle', label: 'Unity AssetBundle（UnityRaw）', ascii: 'UnityRaw', extractable: false },
  { kind: 'assetbundle', label: 'Unity AssetBundle（UnityArchive）', ascii: 'UnityArchive', extractable: false },
  { kind: 'zip', label: '标准 zip（自解压头）', ascii: 'PK', extractable: true },
];

/** 按扩展名判断是否值得读文件头做格式判断。 */
const CONTAINER_EXTENSIONS = [
  '.obb',
  '.zip',
  '.unity3d',
  '.ab',
  '.bundle',
  '.pak',
  '.dat',
  '.bin',
  '.assets',
  '.arc',
  '.cpk',
  '.7z',
  '.rar',
  '.gz',
  '.xz',
  '.bz2',
  '.zst',
];

function extensionOf(filename) {
  const name = String(filename);
  const base = name.slice(name.lastIndexOf('/') + 1);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx).toLowerCase();
}

function isContainerCandidate(filename) {
  return CONTAINER_EXTENSIONS.includes(extensionOf(filename));
}

function toHex(buffer, length = 8) {
  return [...buffer.subarray(0, Math.min(length, buffer.length))]
    .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
    .join(' ');
}

/**
 * 判断文件头是否为「像文本/JSON 的明文」，用于区分「没打包」与「打包了」。
 */
function looksLikeText(buffer) {
  const slice = buffer.subarray(0, Math.min(512, buffer.length));
  if (slice.length === 0) return false;
  let printable = 0;
  for (const b of slice) {
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b < 0x7f)) printable += 1;
    // UTF-8 多字节序列的首字节也视为可打印
    else if (b >= 0xc2 && b <= 0xf4) printable += 1;
  }
  return printable / slice.length > 0.9;
}

/**
 * 识别容器格式。
 *
 * @param {Buffer} header 文件头若干字节（建议 ≥ 16，越多越准）
 * @param {string} filename 用于扩展名辅助判断
 * @returns {object} 格式判断结果
 */
function detectContainer(header, filename = '') {
  const ext = extensionOf(filename);
  const hex = toHex(header, 8);
  const buf = header || Buffer.alloc(0);

  for (const sig of SIGNATURES) {
    if (buf.length >= sig.bytes.length && sig.bytes.every((b, i) => buf[i] === b)) {
      return finish(sig.kind, sig.label, sig.extractable, hex, ext, true);
    }
  }

  const ascii = buf.subarray(0, 16).toString('latin1');
  for (const sig of ASCII_SIGNATURES) {
    if (ascii.startsWith(sig.ascii)) {
      const label =
        sig.kind === 'zip' && /^PK/.test(ascii) && !/^PK\x03\x04/.test(ascii)
          ? '疑似自解压 zip'
          : sig.label;
      return finish(sig.kind, label, sig.extractable, hex, ext, true);
    }
  }

  if (buf.length === 0) {
    return finish('unknown', '无法读取文件头', false, hex, ext, false);
  }

  if (looksLikeText(buf)) {
    return finish('plain', '明文文件（非容器）', true, hex, ext, true);
  }

  // 走到这里说明文件头不匹配任何已知格式。PRD 态 B 要求写明具体特征，
  // 所以把文件头字节带上，而不是笼统写「未知格式」。
  const printable = buf
    .subarray(0, 4)
    .every((b) => b >= 0x20 && b < 0x7f)
    ? `（ASCII "${buf.subarray(0, 4).toString('latin1')}"）`
    : '';
  return finish(
    'encrypted',
    `自定义加密头 0x${hex.replace(/\s/g, '')}${printable}`,
    false,
    hex,
    ext,
    false
  );
}

function finish(kind, label, extractable, hex, ext, recognized) {
  return {
    kind,
    label,
    extractable,
    headerHex: hex,
    extension: ext,
    recognized,
    /** 是否为「本工具无法处理」的容器 —— 决定是否进入失败清单。 */
    unsupported: !extractable && kind !== 'plain',
    hint:
      kind === 'assetbundle'
        ? 'AssetBundle 需经 UABE / AssetStudio 解析，且动作需做「Unity 动画 → motion3.json」格式转换，本工具不处理。'
        : kind === 'encrypted'
          ? '文件头不是任何已知压缩格式，通常为游戏自定义加密。本工具不内置解密算法，也不绕过加密保护。'
          : kind === 'zip'
            ? '标准 zip 结构，可尝试自动解包后重新聚合。'
            : '',
  };
}

/* ------------------------------------------------------------------ *
 * 最小 zip 读取器
 * 只用 Node 内置 zlib，不引入第三方依赖。
 * ------------------------------------------------------------------ */

const EOCD_SIGNATURE = 0x06054b50;
const CDFH_SIGNATURE = 0x02014b50;
const LFH_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557; // 注释最长 65535 + EOCD 本身 22

/** 定位中央目录结束记录（EOCD）。 */
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      const commentLen = buffer.readUInt16LE(i + 20);
      if (i + 22 + commentLen <= buffer.length) return i;
    }
  }
  return -1;
}

/**
 * 读取 zip 索引（不解析文件内容）。
 * @returns {{ok:boolean, entries:Array, message:string, empty:boolean}}
 */
function readZipIndex(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) {
    return { ok: false, entries: [], empty: false, message: '未找到 zip 中央目录记录（EOCD），不是标准 zip 结构' };
  }
  const total = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buffer.length) break;
    if (buffer.readUInt32LE(offset) !== CDFH_SIGNATURE) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset, isDir: name.endsWith('/') });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  return {
    ok: true,
    entries,
    empty: entries.length === 0,
    message: entries.length === 0 ? 'zip 中央目录为空' : `共 ${entries.length} 个条目`,
  };
}

/** 解压单个条目到内存。条目过大时拒绝 —— 避免把 400MB 的 obb 整包读进内存。 */
function extractZipEntry(buffer, entry, maxBytes = 64 * 1024 * 1024) {
  if (entry.uncompressedSize > maxBytes) {
    return { ok: false, buffer: Buffer.alloc(0), message: `条目过大（${entry.uncompressedSize} 字节），已跳过` };
  }
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== LFH_SIGNATURE) {
    return { ok: false, buffer: Buffer.alloc(0), message: '本地文件头校验失败，条目可能已损坏' };
  }
  const nameLen = buffer.readUInt16LE(at + 26);
  const extraLen = buffer.readUInt16LE(at + 28);
  const dataStart = at + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    return { ok: false, buffer: Buffer.alloc(0), message: '压缩数据越界，条目可能已损坏' };
  }
  const raw = buffer.subarray(dataStart, dataEnd);

  try {
    if (entry.method === 0) return { ok: true, buffer: Buffer.from(raw), message: '' };
    if (entry.method === 8) return { ok: true, buffer: zlib.inflateRawSync(raw), message: '' };
    return { ok: false, buffer: Buffer.alloc(0), message: `不支持的压缩方法 ${entry.method}` };
  } catch (err) {
    return { ok: false, buffer: Buffer.alloc(0), message: `解压失败：${err.message}` };
  }
}

/** 在 zip 索引中按扩展名筛选条目 —— 解包时只取我们关心的那一小部分。 */
function filterZipEntries(entries, matcher) {
  return entries.filter((e) => !e.isDir && matcher(e.name));
}

module.exports = {
  SIGNATURES,
  ASCII_SIGNATURES,
  CONTAINER_EXTENSIONS,
  extensionOf,
  isContainerCandidate,
  detectContainer,
  readZipIndex,
  extractZipEntry,
  filterZipEntries,
  toHex,
  looksLikeText,
};
