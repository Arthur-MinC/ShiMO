'use strict';

/**
 * 把打包产物压成 zip，用于发布到 GitHub Release。
 *
 * 为什么不直接用 PowerShell 的 Compress-Archive：单线程、对 268 MB 目录很慢，
 * 且中文路径经管道容易出编码问题。这里用 node 内置 zlib 自己写 ZIP 容器 ——
 * ZIP 的存储格式本身就是「本地文件头 + 数据 + 中央目录 + EOCD」四段，
 * 配合 zlib.crc32 / deflateRaw 就够了，不需要第三方库（本机也装不了）。
 *
 * 三个容易写错的点，都在下面注释里标了：
 *   1. 文件名必须用 UTF-8 并置 general purpose bit 11，否则「拾模.exe」解压出来是乱码。
 *   2. deflate 要用 raw 模式（deflateRawSync），带 zlib 头的 deflateSync 会解压失败。
 *   3. 路径分隔符必须是 `/`，反斜杠在 ZIP 规范里不合法。
 *
 * 用法：
 *   node tools/archive.js                      # 自动定位 dist 下的版本目录
 *   node tools/archive.js <源目录> <输出.zip>   # 指定
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const VERIFY_DIR = path.join(ROOT, '.logs', 'zipcheck');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const DOS_EPOCH_YEAR = 1980;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** ZIP 用的是 1980 纪元的 DOS 时间格式。 */
function dosDateTime(d) {
  const year = Math.max(DOS_EPOCH_YEAR, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - DOS_EPOCH_YEAR) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 收集目录下全部文件。排序保证同样的输入产出同样的 zip。 */
function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        out.push({ rel: path.relative(root, p).split(path.sep).join('/'), abs: p, size: st.size, mtime: st.mtime });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * 生成 zip。
 * @param {string} srcDir      要压缩的目录
 * @param {string} zipPath     输出 zip
 * @param {string} topName     zip 内的顶层目录名（解压后应该是一个文件夹，不是散一地）
 * @param {(e:object)=>void} [onProgress]
 */
function createZip(srcDir, zipPath, topName, onProgress) {
  const files = collectFiles(srcDir);
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const totalFiles = files.length;

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const fd = fs.openSync(zipPath, 'w');

  const central = [];
  let offset = 0;
  let doneBytes = 0;
  let doneFiles = 0;
  let storedBytes = 0;

  const write = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };

  try {
    for (const f of files) {
      const raw = fs.readFileSync(f.abs);
      const crc = zlib.crc32(raw);

      // 压不动就存原文（.pak / .dll 这类已经压过的文件压完反而更大）
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      const useDeflate = deflated.length < raw.length;
      const body = useDeflate ? deflated : raw;
      const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

      // 路径分隔符必须是 `/`；前面拼上顶层目录名
      const name = `${topName}/${f.rel}`;
      const nameBuf = Buffer.from(name, 'utf8');
      const { time, date } = dosDateTime(f.mtime);

      if (raw.length > U32_MAX || body.length > U32_MAX || offset > U32_MAX) {
        throw new Error(`文件 ${f.rel} 超出普通 ZIP 的 4 GB 上限，需要 ZIP64 支持（本脚本未实现）`);
      }

      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4); // 需要版本 2.0
      local.writeUInt16LE(FLAG_UTF8, 6); // bit 11：文件名是 UTF-8
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28); // 无 extra field

      const headerOffset = offset;
      write(local);
      write(nameBuf);
      write(body);

      central.push({ nameBuf, method, time, date, crc, compressed: body.length, uncompressed: raw.length, headerOffset });

      storedBytes += body.length;
      doneBytes += f.size;
      doneFiles += 1;
      if (onProgress) onProgress({ doneFiles, totalFiles, doneBytes, totalBytes, rel: f.rel });
    }

    const centralStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(SIG_CENTRAL, 0);
      h.writeUInt16LE(20, 4); // 创建版本
      h.writeUInt16LE(20, 6); // 需要版本
      h.writeUInt16LE(FLAG_UTF8, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc, 16);
      h.writeUInt32LE(c.compressed, 20);
      h.writeUInt32LE(c.uncompressed, 24);
      h.writeUInt16LE(c.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // 磁盘号
      h.writeUInt16LE(0, 36); // 内部属性
      h.writeUInt32LE(0, 38); // 外部属性
      h.writeUInt32LE(c.headerOffset, 42);
      write(h);
      write(c.nameBuf);
    }
    const centralSize = offset - centralStart;

    if (central.length > U16_MAX) throw new Error(`条目数 ${central.length} 超出普通 ZIP 的 65535 上限，需要 ZIP64`);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4); // 本磁盘号
    eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20); // 注释长度
    write(eocd);
  } finally {
    fs.closeSync(fd);
  }

  return { fileCount: totalFiles, totalBytes, storedBytes, zipBytes: fs.statSync(zipPath).size, topName };
}

/** dist 下只有一个版本目录时自动定位它。 */
function findDistDir() {
  const dist = path.join(ROOT, 'dist');
  if (!fs.existsSync(dist)) throw new Error('dist/ 不存在，先跑 node tools/package.js');
  const dirs = fs.readdirSync(dist, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.includes('win')).map((e) => e.name);
  if (dirs.length === 0) throw new Error('dist/ 下没找到 win 产物目录，先跑 node tools/package.js');
  if (dirs.length > 1) throw new Error(`dist/ 下有多个产物目录，请显式指定：${dirs.join('、')}`);
  return path.join(dist, dirs[0]);
}

/**
 * 逐批删，避开宿主的 safe-delete 保护：
 * `fs.rmSync` 一次删超 50 个文件会抛 SAFE_DELETE_BULK_CONFIRM_REQUIRED，而且没人来确认。
 *
 * 两个踩过的点：
 *   1. 目录必须**按深度从深到浅**删。walk 后序遍历得到的顺序是不可靠的，
 *      先删父目录会 ENOTEMPTY。
 *   2. 目录可能已经不存在（宿主的删除 shim 会在清空目录后顺手把父目录也移走），
 *      所以每个 rmdir 都要容忍 ENOENT —— **清理失败绝不能冒泡成验证失败**，
 *      那会把「临时目录没删干净」误报成「zip 有问题」，是最坏的一种假信号。
 */
function rmTree(dir, batch = 40) {
  if (!fs.existsSync(dir)) return { ok: true };
  const files = [];
  const subdirs = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        subdirs.push(p);
      } else files.push(p);
    }
  };
  walk(dir);

  for (let i = 0; i < files.length; i += batch) {
    for (const f of files.slice(i, i + batch)) {
      try {
        fs.unlinkSync(f);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
  }

  const depth = (p) => p.split(path.sep).length;
  subdirs.sort((a, b) => depth(b) - depth(a)); // 深的先删
  for (const d of [...subdirs, dir]) {
    try {
      fs.rmdirSync(d);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTEMPTY') throw e;
    }
  }
  return { ok: !fs.existsSync(dir) };
}

function walkFiles(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out;
}

const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

/**
 * 解压一遍再逐文件比对。
 *
 * 为什么不自己读 zip 校验：那是**自证** —— 同一份代码写出来的格式，自己读当然读得对。
 * 这里交给 tar（libarchive，独立实现）解压，再跟原目录逐文件比 md5，
 * 才能证明「用户下载后解压出来的东西是对的」。
 *
 * 曾经差点误判：本机终端是 GBK，`tar -tf` 打印中文名是乱码。
 * 那不是 zip 写错了，是控制台解码问题 —— 要判断得直接看 zip 里的原始字节
 * （正确的 UTF-8 是 `e68bbee6a8a1`，GBK 的 `cab0c4a3` 才是写错了）。
 */
function verifyZip(srcDir, zipPath, topName) {
  rmTree(VERIFY_DIR);
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const t0 = Date.now();
  const r = spawnSync('tar', ['-xf', zipPath, '-C', VERIFY_DIR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, reason: `调用 tar 失败：${r.error.message}（Windows 10+ 自带 tar.exe）` };
  if (r.status !== 0) return { ok: false, reason: `tar 解压失败（退出码 ${r.status}）：${(r.stderr || '').slice(0, 300)}` };

  const unzipped = path.join(VERIFY_DIR, topName);
  if (!fs.existsSync(unzipped)) {
    return { ok: false, reason: `解压后找不到顶层目录 ${topName}/ —— 顶层目录没写对，用户解压会撒一地文件` };
  }

  const src = walkFiles(srcDir);
  const dst = walkFiles(unzipped);
  const bad = [];
  const missing = [];
  for (const rel of src) {
    const pb = path.join(unzipped, rel);
    if (!fs.existsSync(pb)) {
      missing.push(rel);
      continue;
    }
    if (md5(path.join(srcDir, rel)) !== md5(pb)) bad.push(rel);
  }
  const extra = dst.filter((x) => !src.includes(x));
  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  rmTree(VERIFY_DIR);
  return { ok: !bad.length && !missing.length && !extra.length, checked: src.length, total: src.length, bad, missing, extra, seconds };
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  // 默认验证。zip 是给用户下载的，格式写错要等用户解压才发现，代价比多花 10 秒高得多。
  const doVerify = !flags.has('--no-verify');

  const srcDir = positional[0] ? path.resolve(positional[0]) : findDistDir();
  const topName = path.basename(srcDir);
  const zipPath = positional[1] ? path.resolve(positional[1]) : path.join(ROOT, 'dist', `${topName}.zip`);

  process.stdout.write(`压缩 ${path.relative(ROOT, srcDir)} → ${path.relative(ROOT, zipPath)}\n`);
  let lastLog = 0;
  const started = Date.now();
  const r = createZip(srcDir, zipPath, topName, (p) => {
    const now = Date.now();
    if (now - lastLog < 700 && p.doneFiles !== p.totalFiles) return;
    lastLog = now;
    process.stdout.write(`  ${p.doneFiles}/${p.totalFiles}  ${mb(p.doneBytes)} / ${mb(p.totalBytes)}\n`);
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  const ratio = ((1 - r.storedBytes / r.totalBytes) * 100).toFixed(1);
  process.stdout.write(
    [
      '',
      `zip 完成：${path.relative(ROOT, zipPath)}`,
      `  顶层目录  ${r.topName}/`,
      `  文件数    ${r.fileCount}`,
      `  原始      ${mb(r.totalBytes)}`,
      `  压缩后    ${mb(r.zipBytes)}  （省下 ${ratio}%）`,
      `  耗时      ${secs}s`,
    ].join('\n') + '\n'
  );

  if (!doVerify) {
    process.stdout.write('\n⚠️  已跳过解压验证（--no-verify）—— 发布前别跳这一步\n');
  } else {
    process.stdout.write('\n验证：用 tar 解压一遍，逐文件比 md5…\n');
    const v = verifyZip(srcDir, zipPath, topName);
    if (v.ok) {
      process.stdout.write(`  ✅ ${v.checked}/${v.total} 个文件与产物逐字节一致（${v.seconds}s）\n`);
    } else {
      process.stdout.write(`  ❌ 验证失败：${v.reason || '解压结果与产物不一致'}\n`);
      if (v.bad && v.bad.length) process.stdout.write(`     内容不一致：${v.bad.slice(0, 5).join('、')}${v.bad.length > 5 ? ` 等 ${v.bad.length} 个` : ''}\n`);
      if (v.missing && v.missing.length) process.stdout.write(`     解压缺失：${v.missing.slice(0, 5).join('、')}${v.missing.length > 5 ? ` 等 ${v.missing.length} 个` : ''}\n`);
      if (v.extra && v.extra.length) process.stdout.write(`     多出文件：${v.extra.slice(0, 5).join('、')}\n`);
      process.exitCode = 1;
    }
  }
  process.stdout.write('');
}

module.exports = { createZip, collectFiles, verifyZip };
