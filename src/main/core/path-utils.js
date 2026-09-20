'use strict';

/**
 * 路径工具。
 *
 * PRD FR-02 验收点：`/sdcard` 与 `/storage/emulated/0` 是同一目录的两种写法，
 * 必须去重，同一目录不得扫描两次。真机已验证（Android 9 / emulator-5554）：
 * `ls /sdcard/Android/data/` 与 `ls /storage/emulated/0/Android/data/` 返回同一份内容。
 *
 * 除了「写法不同」，还有一种更隐蔽的重复：父子路径同时出现在扫描范围里
 * （例如用户既勾了 `/sdcard/Android/data` 又手动加了它的子目录）。这会造成重复遍历，
 * 所以去重分两层：先做别名归一，再去掉被其他条目包含的子路径。
 */

const path = require('node:path');

/** 设备端等价前缀 → 规范前缀。顺序重要：长的先匹配。 */
const DEVICE_ALIASES = [
  ['/mnt/shell/emulated/0', '/storage/emulated/0'],
  ['/storage/emulated/legacy', '/storage/emulated/0'],
  ['/storage/self/primary', '/storage/emulated/0'],
  ['/mnt/sdcard', '/storage/emulated/0'],
  ['/sdcard', '/storage/emulated/0'],
];

/** 判断是否为设备端绝对路径（形如 /sdcard/...）。 */
function isDevicePath(p) {
  return typeof p === 'string' && p.startsWith('/');
}

/**
 * 归一化设备路径：别名替换、折叠 `.` 与 `..`、折叠重复斜杠、去掉尾部斜杠（根目录除外）。
 * 不做大小写转换 —— 安卓文件系统区分大小写，擅自小写会造成假去重。
 *
 * 折叠 `.` / `..` 是去重正确性的前提：`/sdcard/Android/./data` 与
 * `/sdcard/Android/data` 指的是同一个目录，不折叠就会当成两个扫描范围各扫一遍。
 */
function canonicalDevicePath(input) {
  if (!isDevicePath(input)) return '';
  let p = String(input).trim().replace(/\\/g, '/');
  for (const [alias, real] of DEVICE_ALIASES) {
    if (p === alias || p.startsWith(`${alias}/`)) {
      p = real + p.slice(alias.length);
      break;
    }
  }
  p = p.replace(/\/{2,}/g, '/');

  // 逐段折叠，根目录不可被 `..` 弹出
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }

  const joined = `/${out.join('/')}`;
  return joined === '/' ? '/' : joined;
}

/**
 * 去重扫描范围，返回保留项与被移除项（含原因，供日志与 UI 解释）。
 *
 * @param {string[]} list
 * @returns {{kept:string[], removed:Array<{path:string, reason:string, duplicateOf:string}>}}
 */
function dedupeDevicePaths(list) {
  const kept = [];
  const removed = [];
  const seen = new Map();

  for (const raw of list || []) {
    const canonical = canonicalDevicePath(raw);
    if (!canonical) {
      if (raw) removed.push({ path: String(raw), reason: '不是合法的设备路径', duplicateOf: '' });
      continue;
    }
    if (seen.has(canonical)) {
      removed.push({ path: raw, reason: '与已有路径等价（同一目录的另一种写法）', duplicateOf: seen.get(canonical) });
      continue;
    }
    seen.set(canonical, raw);
    kept.push(canonical);
  }

  // 第二层：去掉被其他条目包含的子路径
  const finalKept = [];
  for (const p of kept) {
    const parent = kept.find((other) => other !== p && p.startsWith(`${other}/`));
    if (parent) {
      removed.push({ path: p, reason: '已被父目录覆盖', duplicateOf: parent });
    } else {
      finalKept.push(p);
    }
  }

  return { kept: finalKept, removed };
}

/** 设备路径拼接。 */
function joinDevicePath(...segments) {
  const joined = segments
    .filter((s) => s !== undefined && s !== null && s !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/** 设备路径的父目录。 */
function deviceDirname(p) {
  const c = canonicalDevicePath(p);
  const idx = c.lastIndexOf('/');
  return idx <= 0 ? '/' : c.slice(0, idx);
}

/** 设备路径的文件名。 */
function deviceBasename(p) {
  const c = canonicalDevicePath(p);
  return c.slice(c.lastIndexOf('/') + 1);
}

/** `/Android/data|obb/<包名>/` 之后的部分。与 sourcePackageOf 共用同一段约定。 */
const ANDROID_APP_SUBPATH_RE = /\/Android\/(?:data|obb)\/[^/]+\/(.+)$/;

/**
 * 容器在界面上的显示名。
 *
 * 规则：**去掉 `/Android/data|obb/<包名>/` 前缀后的相对路径**。
 * 设计稿两条异常态里的标签就是这个形式，三条标签都由这一条规则还原出来：
 *
 *   /Android/data/com.sega.pjsk/files_obb/main.obb      → files_obb/main.obb
 *   /Android/data/com.sega.pjsk/files/cache/live2d.dat  → files/cache/live2d.dat
 *   /Android/data/com.sega.pjsk/files/live2d_pack.zip   → files/live2d_pack.zip
 *
 * 为什么不用文件名（`main.obb`）：同一游戏下 `files_obb/main.obb` 与
 * `files/patch/main.obb` 会撞成同一个名字，用户分不清在处理哪一个。
 * 为什么不用「包名/文件名」：一个游戏常有多个同级容器目录，仍然会撞。
 * 为什么不用完整路径：工具栏已经显示了扫描范围，重复一遍只会挤掉有用信息。
 *
 * 不在 `/Android/data|obb/<包名>/` 下的路径（自定义目录、内存里的虚拟路径）
 * 退回末两段 —— 这类路径没有「应用目录」的概念，取最后两级是最小可用信息。
 *
 * 扫描页与解包页显示的是同一批容器，**必须共用这一份**。曾经扫描页用 basename、
 * 解包页用另一套，同一个容器在相邻两屏里叫两个名字，用户会当成两个不同的文件。
 */
function deviceDisplayName(p) {
  const c = canonicalDevicePath(p);
  const inAppDir = ANDROID_APP_SUBPATH_RE.exec(c);
  if (inAppDir) return inAppDir[1];
  const parts = c.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * 从设备路径推出所属应用包名，供结果页「来源」分组使用。
 *
 * 与 `deviceDisplayName` 同样的理由收在这里：这个正则在扫描器和解包器里
 * 各写过一份，两处一旦改歪，同一批包在「来源」分组和「导出目录名」上就会分家。
 */
function sourcePackageOf(devicePath) {
  const m = /\/Android\/(?:data|obb)\/([^/]+)/.exec(canonicalDevicePath(devicePath));
  return m ? m[1] : '未知来源';
}

/** 把设备上的绝对路径转换成导出包内的相对路径（去掉扫描根前缀）。 */
function toRelativeInside(fullPath, roots) {
  const c = canonicalDevicePath(fullPath);
  for (const root of roots) {
    const r = canonicalDevicePath(root);
    if (c === r) return '';
    if (c.startsWith(`${r}/`)) return c.slice(r.length + 1);
  }
  return c.replace(/^\//, '');
}

/**
 * 把包内相对路径安全地落到本地磁盘。
 * 拒绝 `..` 逃逸 —— 游戏资源里的路径不可信，不能让 manifest 决定写到哪儿。
 */
function safeJoinLocal(baseDir, relative) {
  const parts = String(relative)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) {
    throw new Error(`越界路径已拒绝：${relative}`);
  }
  return path.join(baseDir, ...parts);
}

/** Windows 保留字符清理（仅用于本地临时命名，导出正式文件名绝不做替换 —— FR-07）。 */
function sanitizeLocalName(name) {
  return String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

/** 人类可读体积。UI 与 manifest.txt 共用，保证两处数字一致。 */
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** 精确到字节的数字（带千位分隔），用于导出摘要这类需要「对得上」的场景。 */
function formatExactBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('en-US')} 字节`;
}

/** 时长格式化：秒 → 「6.8 秒」/「1 分 12 秒」。 */
function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${(ms / 1000).toFixed(1)} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} 分 ${s} 秒`;
}

module.exports = {
  DEVICE_ALIASES,
  isDevicePath,
  canonicalDevicePath,
  dedupeDevicePaths,
  joinDevicePath,
  deviceDirname,
  deviceBasename,
  deviceDisplayName,
  sourcePackageOf,
  toRelativeInside,
  safeJoinLocal,
  sanitizeLocalName,
  formatBytes,
  formatExactBytes,
  formatDuration,
};
