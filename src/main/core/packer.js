'use strict';

/**
 * 运行时包聚合（FR-04）。
 *
 * 这是全工具的技术核心：**包不是「扫出来的」，是「聚出来的」**。
 * 磁盘上一个包由若干散落文件构成，唯一的锚点是 `.model3.json`。
 * 孤立存在的 `.moc3` 没有清单，打开不了，因此不进结果列表（只进日志）。
 *
 * 本模块刻意做成纯逻辑 + 注入式文件系统接口（FileProbe），
 * 好处是能在没有模拟器的情况下用内存数据跑完整单测。
 */

const { deviceDirname, deviceBasename, canonicalDevicePath } = require('./path-utils');

/** Cubism 清单里可能出现的引用字段 → 角色标记。 */
const REFERENCE_ROLES = {
  Moc: 'moc3',
  Physics: 'physics3',
  Pose: 'pose3',
  DisplayInfo: 'cdi3',
  UserData: 'userdata',
  Expressions: 'expression',
  Motions: 'motion',
  Textures: 'texture',
  EyeBlink: 'eyeblink',
  LipSync: 'lipsync',
};

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** 兼容两种写法：字符串路径，或 `{ File: '...' }` 对象。 */
function fileOf(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (typeof entry === 'object') {
    if (typeof entry.File === 'string') return entry.File;
    if (typeof entry.Path === 'string') return entry.Path;
  }
  return null;
}

/**
 * 从清单里抽出全部引用。
 * 返回值保留 role 与所属 motion group —— 校验与 UI「12 动作 · 4 表情」都要用。
 */
function extractReferences(manifest) {
  const refs = [];
  const fr = (manifest && manifest.FileReferences) || {};

  const push = (relPath, role, group) => {
    const f = fileOf(relPath);
    if (!f) return;
    refs.push({ relPath: f, role, group: group || null });
  };

  push(fr.Moc, REFERENCE_ROLES.Moc);
  for (const t of asArray(fr.Textures)) push(t, REFERENCE_ROLES.Textures);
  push(fr.Physics, REFERENCE_ROLES.Physics);
  push(fr.Pose, REFERENCE_ROLES.Pose);
  push(fr.DisplayInfo, REFERENCE_ROLES.DisplayInfo);
  push(fr.UserData, REFERENCE_ROLES.UserData);

  for (const e of asArray(fr.Expressions)) push(e, REFERENCE_ROLES.Expressions);

  const motions = fr.Motions || {};
  for (const group of Object.keys(motions)) {
    for (const m of asArray(motions[group])) push(m, REFERENCE_ROLES.Motions, group);
  }

  // 眼动与口型同步也引用动作文件，属于包的一部分
  for (const b of asArray(fr.EyeBlink)) push(b, REFERENCE_ROLES.EyeBlink);
  for (const l of asArray(fr.LipSync)) push(l, REFERENCE_ROLES.LipSync);

  return refs;
}

/** 相对路径解析：基准必须是清单自身所在目录（FR-04 验收点）。 */
function resolveAgainst(entryPath, relPath) {
  const base = deviceDirname(entryPath);
  const cleaned = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (cleaned.startsWith('/')) return canonicalDevicePath(cleaned);
  const parts = `${base}/${cleaned}`.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return `/${stack.join('/')}`;
}

/**
 * 聚合单个运行时包。
 *
 * @param {object} args
 * @param {string} args.entryPath     .model3.json 的绝对设备路径
 * @param {string} args.manifestText  清单文本（已 UTF-8 解码）
 * @param {object} args.probe         文件系统探针 { exists, stat, readText }
 * @param {(p:string)=>string} [args.rootOf] 用于计算导出时的相对路径
 * @returns {Promise<object>} 包描述
 */
async function buildPack({ entryPath, manifestText, probe, rootOf }) {
  const entry = canonicalDevicePath(entryPath);
  const entryDir = deviceDirname(entry);
  const dirName = deviceBasename(entryDir);

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    return {
      id: entry,
      entryPath: entry,
      entryDir,
      modelName: dirName,
      manifest: null,
      parseError: `清单不是合法 JSON：${err.message}`,
      files: [],
      missing: [],
      motions: 0,
      expressions: 0,
      motionGroups: [],
      textureCount: 0,
      moc3Path: null,
      totalBytes: 0,
    };
  }

  const refs = extractReferences(manifest);

  // 清单自身也是包的一部分，且是入口
  const entries = [{ absPath: entry, relPath: deviceBasename(entry), role: 'manifest', size: Buffer.byteLength(manifestText, 'utf8') }];

  const files = [];
  const missing = [];
  const seen = new Set([entry]);

  for (const ref of refs) {
    const abs = resolveAgainst(entry, ref.relPath);
    if (seen.has(abs)) {
      // 同一文件被清单内多处引用（例如动作同时用于 EyeBlink），只保留一份
      continue;
    }
    seen.add(abs);
    const stat = await probe.stat(abs);
    if (!stat || !stat.exists) {
      missing.push({ absPath: abs, relPath: ref.relPath, role: ref.role, reason: '文件不存在' });
      continue;
    }
    if (stat.size === 0) {
      missing.push({ absPath: abs, relPath: ref.relPath, role: ref.role, reason: '文件为空' });
      continue;
    }
    files.push({ absPath: abs, relPath: ref.relPath, role: ref.role, group: ref.group, size: stat.size });
  }

  const motionFiles = files.filter((f) => f.role === 'motion');
  const motionGroups = [...new Set(motionFiles.map((f) => f.group).filter(Boolean))];
  const moc3 = files.find((f) => f.role === 'moc3') || null;

  const present = [...entries, ...files];
  const totalBytes = present.reduce((sum, f) => sum + (f.size || 0), 0);

  // 导出时的相对路径基准：优先用调用方给的调用根，否则退回清单所在目录名
  const baseRoot = rootOf ? rootOf(entry) : entryDir;
  for (const f of present) {
    f.exportRelPath = relativeForExport(f.absPath, baseRoot);
  }

  return {
    id: entry,
    entryPath: entry,
    entryDir,
    modelName: dirName,
    manifestVersion: manifest.Version === undefined ? null : manifest.Version,
    manifest,
    parseError: null,
    files: present,
    missing,
    motions: motionFiles.length,
    motionGroups,
    expressions: files.filter((f) => f.role === 'expression').length,
    textureCount: files.filter((f) => f.role === 'texture').length,
    moc3Path: moc3 ? moc3.absPath : null,
    moc3Size: moc3 ? moc3.size : 0,
    totalBytes,
    hasMotions: motionFiles.length > 0,
    hasExpressions: files.some((f) => f.role === 'expression'),
  };
}

/** 计算导出用的包内相对路径（去掉调用根前缀）。 */
function relativeForExport(absPath, root) {
  const a = canonicalDevicePath(absPath);
  const r = canonicalDevicePath(root);
  if (a === r) return deviceBasename(a);
  if (a.startsWith(`${r}/`)) return a.slice(r.length + 1);
  return deviceBasename(a);
}

/**
 * 多包合计体积，按共享文件去重（FR-04 验收点：
 * 「同一文件被多个包引用时不得重复计入体积总和」）。
 *
 * 这在真实场景里很常见：多个模型共用同一套纹理图集或同一份 physics3.json，
 * 简单相加会让底部汇总比实际导出体积大。
 */
function computeAggregateBytes(packs) {
  const seen = new Set();
  let total = 0;
  for (const pack of packs) {
    for (const f of pack.files || []) {
      const key = canonicalDevicePath(f.absPath);
      if (seen.has(key)) continue;
      seen.add(key);
      total += f.size || 0;
    }
  }
  return total;
}

/** 合计文件数（同样按绝对路径去重）。 */
function countAggregateFiles(packs) {
  const seen = new Set();
  for (const pack of packs) {
    for (const f of pack.files || []) seen.add(canonicalDevicePath(f.absPath));
  }
  return seen.size;
}

/**
 * 找出孤立 moc3：磁盘上存在 .moc3，但没有任何清单引用它。
 * 它们不进结果列表，但必须计入日志（FR-04 验收点），否则用户会以为文件丢了。
 */
function findOrphanMoc3(allFilePaths, packs) {
  const referenced = new Set();
  for (const pack of packs) {
    for (const f of pack.files || []) referenced.add(canonicalDevicePath(f.absPath));
    if (pack.moc3Path) referenced.add(canonicalDevicePath(pack.moc3Path));
  }
  return allFilePaths
    .filter((p) => /\.moc3$/i.test(p))
    .filter((p) => !referenced.has(canonicalDevicePath(p)));
}

module.exports = {
  REFERENCE_ROLES,
  extractReferences,
  resolveAgainst,
  buildPack,
  relativeForExport,
  computeAggregateBytes,
  countAggregateFiles,
  findOrphanMoc3,
};
