'use strict';

/**
 * 开发期静态校验：
 *   1. 用 `node --check` 检查全部 JS 的语法（ESM 文件先复制成 .mjs）；
 *   2. 检查 preload 暴露的 API 与渲染层实际调用的是否一一对应 ——
 *      这类「方法名对不上」的错误在运行时只表现为一个静默失效的按钮。
 *
 * 用法：node tools/verify.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmpcheck');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function syntaxCheck(files) {
  fs.mkdirSync(TMP, { recursive: true });
  const failures = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const isEsm = /^\s*(import|export)\s/m.test(source);
    let target = file;
    if (isEsm) {
      target = path.join(TMP, `${path.basename(file, '.js')}-${Math.abs(hash(file))}.mjs`);
      fs.writeFileSync(target, source, 'utf8');
    }
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    } catch (err) {
      failures.push({ file: path.relative(ROOT, file), message: String(err.stderr || err.message).split('\n').slice(0, 4).join('\n') });
    }
  }
  return failures;
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** preload 的方法名集合 vs 渲染层的调用点，做双向核对。 */
function checkApiSurface() {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'index.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');

  const exposed = new Set();
  const nsRe = /^\s{2}(\w+):\s*\{/gm;
  let m;
  while ((m = nsRe.exec(preload))) {
    const ns = m[1];
    const bodyStart = m.index + m[0].length;
    const body = preload.slice(bodyStart, preload.indexOf('\n  },', bodyStart));
    const methodRe = /^\s{4}(\w+):/gm;
    let mm;
    while ((mm = methodRe.exec(body))) exposed.add(`${ns}.${mm[1]}`);
  }

  const missing = [];
  const usedIpc = new Set();
  const callRe = /api\.(\w+)\.(\w+)\(/g;
  while ((m = callRe.exec(app))) {
    const key = `${m[1]}.${m[2]}`;
    usedIpc.add(key);
    if (!exposed.has(key)) missing.push(key);
  }

  const ipc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'ipc.js'), 'utf8');
  const channels = new Set();
  const chRe = /handle\('([^']+)'/g;
  while ((m = chRe.exec(ipc))) channels.add(m[1]);
  const invokeRe = /invoke\('([^']+)'/g;
  while ((m = invokeRe.exec(preload))) {
    if (!channels.has(m[1])) missing.push(`未注册的通道：${m[1]}`);
  }

  return { exposed: [...exposed].sort(), missing };
}

/**
 * 核对「解构出来的名字」是否真的存在于被 require 的模块上。
 *
 * 这条检查是拿血换来的：packer.js 曾经整个文件没有一个 module.exports，
 * 于是 `const { buildPack } = require('./packer')` 拿到 undefined ——
 * 语法检查全过、应用能启动、界面能渲染，只有真机扫到第一个清单时才崩。
 */
function checkCoreExports() {
  const coreDir = path.join(ROOT, 'src', 'main', 'core');
  const coreDir2 = path.join(ROOT, 'src', 'main');
  const problems = [];
  const checked = [];

  const load = (file) => {
    try {
      return { ok: true, exports: require(file) };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  };

  const sources = [...walkFiles(path.join(ROOT, 'src', 'main')), ...walkFiles(path.dirname(coreDir) + '/core')];
  const seen = new Set();

  for (const file of sources) {
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    const re = /const\s*\{([^}]+)\}\s*=\s*require\('(\.[^']+)'\)/g;
    let m;
    while ((m = re.exec(text))) {
      const names = m[1]
        .split(',')
        .map((s) => s.trim().split(':')[0].trim())
        .filter(Boolean);
      const target = path.resolve(path.dirname(file), m[2]);
      const resolved = fs.existsSync(`${target}.js`) ? `${target}.js` : target;
      if (!fs.existsSync(resolved)) continue;

      const loaded = load(resolved);
      if (!loaded.ok) {
        problems.push({ file: path.relative(ROOT, file), names: [loaded.message], target: path.relative(ROOT, resolved), note: 'require 失败' });
        continue;
      }
      checked.push(path.relative(ROOT, resolved));
      for (const name of names) {
        if (!(name in loaded.exports)) {
          problems.push({
            file: path.relative(ROOT, file),
            names: [name],
            target: path.relative(ROOT, resolved),
            note: '该模块没有导出这个名字',
          });
        }
      }
    }
  }

  void coreDir2;
  return { problems, checked: [...new Set(checked)].sort() };
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function main() {
  const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tools'))];
  const failures = syntaxCheck(files);
  const { exposed, missing } = checkApiSurface();
  const { problems, checked } = checkCoreExports();

  process.stdout.write(`语法检查：${files.length} 个文件，失败 ${failures.length}\n`);
  for (const f of failures) process.stdout.write(`  [FAIL] ${f.file}\n${f.message}\n`);
  process.stdout.write(`preload 暴露接口：${exposed.length} 个\n`);
  if (missing.length) {
    process.stdout.write(`接口对不上（${missing.length}）：\n`);
    for (const k of missing) process.stdout.write(`  [MISS] ${k}\n`);
  } else {
    process.stdout.write('接口核对：全部对得上\n');
  }
  process.stdout.write(`模块导出核对：${checked.length} 个模块\n`);
  if (problems.length) {
    for (const p of problems) {
      process.stdout.write(`  [EXPORT] ${p.target} 缺少 [${p.names.join(', ')}]，被 ${p.file} 解构引用\n`);
    }
  } else {
    process.stdout.write('模块导出核对：全部对得上\n');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures.length || missing.length || problems.length ? 1 : 0);
}

main();
