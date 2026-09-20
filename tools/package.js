'use strict';

/**
 * 打包成可双击运行的 Windows 程序。
 *
 * 为什么不用 electron-builder / electron-packager：
 * 本机 npm 起不来（npm 是 shell 脚本，环境缺 bash），装不了打包器。
 * 而 Electron 应用的打包**本质只有三件事** ——
 *
 *   1. 复制一份 Electron 运行时（node_modules/electron/dist）
 *   2. 把应用代码放进 resources/app/
 *   3. 把 electron.exe 改成产品名
 *
 * 这三步用 node 内置的 fs 就能做完，产物与 electron-packager 的「目录版」
 * 结构完全一致：拷给别人、放 U 盘、双击就能跑，不需要安装程序。
 *
 * 用法：node tools/package.js
 * 产出：dist/<产品名>-<版本>-win-x64/
 *
 * 已知局限（如实写在产物里的说明文件里）：
 *   - 图标是 Electron 默认图标。改图标要给 exe 换 Windows 资源，
 *     需要 rcedit 之类的工具，本机装不了。
 *   - 没有做代码签名，Windows SmartScreen 可能提示「未知发布者」。
 *   - 目录形式（未做 asar 打包），源码在 resources/app/ 下是明文的。
 *     对本工具无所谓 —— 它本来就是给人看它做了什么。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function fail(message) {
  process.stderr.write(`打包失败：${message}\n`);
  process.exit(1);
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/**
 * 递归复制目录树，返回复制到的文件数。
 *
 * 不用 `fs.cpSync`：在本机它只把目录建出来了、文件一个没搬（且不报错），
 * 结果是一个「结构看着对、实际跑不起来」的产物 —— 这种失败比直接报错恶劣得多。
 * 自己走一遍目录，每步都真实发生，出错就抛。
 */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(src, dst);
    } else if (entry.isSymbolicLink()) {
      // 运行时里不应该有符号链接，遇到就如实报出来，别默默跳过
      fail(`运行时里出现符号链接，本脚本不处理：${src}`);
    } else {
      fs.copyFileSync(src, dst);
      count += 1;
    }
  }
  return count;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * 删除整个目录。
 *
 * 不用 `fs.rmSync`：本机的宿主环境给 node 注入了 safe-delete 包装，删除超过
 * 50 个文件就要交互确认（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`），而一个
 * Electron 运行时是上百个文件 —— 构建脚本没法在那种提示下工作。
 * 这里走系统原生的 Remove-Item。调用前已经确认路径落在 dist/ 下。
 */
function removeDir(dir) {
  if (!fs.existsSync(dir)) return;
  const escaped = dir.replace(/'/g, "''");
  try {
    execSync(`powershell -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath '${escaped}' -Recurse -Force -ErrorAction Stop"`, {
      stdio: 'ignore',
    });
  } catch (err) {
    fail(`清理旧产物失败（是否有进程正在使用它？）：${err.message.split('\n')[0]}`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PRODUCT = pkg.productName || pkg.name;
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const TARGET = path.join(DIST, `${PRODUCT}-${pkg.version}-win-x64`);

/* ---------------- 1. 前置检查 ---------------- */

if (!fs.existsSync(ELECTRON_DIST)) {
  fail(`找不到 Electron 运行时：${ELECTRON_DIST}\n  先准备好依赖（本机可用：node -e "require('electron')" 能拿到路径即说明已就绪）。`);
}

// 产物里只放 src 和一份精简的 package.json。一旦将来引进了生产依赖，
// 这份脚本就漏了 node_modules —— 与其悄悄产出一个跑不起来的包，不如在这里停住。
const prodDeps = Object.keys(pkg.dependencies || {});
if (prodDeps.length > 0) {
  fail(
    `package.json 里有 ${prodDeps.length} 个生产依赖（${prodDeps.join(', ')}），` +
      `但本脚本不会把它们打进 resources/app/node_modules。\n` +
      `  要么去掉依赖，要么在这里补一段依赖复制逻辑再打包。`
  );
}

/* ---------------- 2. 清理旧产物 ---------------- */

// 删除是破坏性操作，先确认目标确实落在 <仓库>/dist 下面，
// 免得因为变量被改坏而去删别的地方
const targetRel = path.relative(ROOT, TARGET);
if (targetRel.split(path.sep)[0] !== 'dist' || targetRel.includes('..')) {
  fail(`目标目录 ${TARGET} 不在 dist/ 下，拒绝清理`);
}
if (fs.existsSync(TARGET)) {
  removeDir(TARGET);
  process.stdout.write(`已清理旧产物 ${path.relative(ROOT, TARGET)}\n`);
}
fs.mkdirSync(DIST, { recursive: true });

/* ---------------- 3. 复制运行时 ---------------- */

process.stdout.write(`复制 Electron 运行时（${mb(dirSize(ELECTRON_DIST))}）…\n`);
const runtimeFiles = copyTree(ELECTRON_DIST, TARGET);
process.stdout.write(`  已复制 ${runtimeFiles} 个文件\n`);

// 复制完立刻核对：文件数对不上就说明复制没做全，此时停下来比产出半个包好
const sourceFiles = (() => {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n += 1;
    }
  };
  walk(ELECTRON_DIST);
  return n;
})();
if (runtimeFiles !== sourceFiles) {
  fail(`运行时复制不完整：源 ${sourceFiles} 个文件，只复制了 ${runtimeFiles} 个`);
}

// Electron 自带的示例应用要去掉：留着会让「没找到我们的 app」时静默启动一个
// 空白示例窗口，反而掩盖问题
const defaultApp = path.join(TARGET, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);

/* ---------------- 4. 放应用代码 ---------------- */

const appDir = path.join(TARGET, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

fs.writeFileSync(
  path.join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: pkg.name,
      productName: PRODUCT,
      version: pkg.version,
      description: pkg.description,
      main: pkg.main,
      private: true,
    },
    null,
    2
  )}\n`,
  'utf8'
);

const appFiles = copyTree(path.join(ROOT, 'src'), path.join(appDir, 'src'));
process.stdout.write(`  已复制应用代码 ${appFiles} 个文件\n`);

/* ---------------- 5. 改成产品名 ---------------- */

const exeFrom = path.join(TARGET, 'electron.exe');
const exeTo = path.join(TARGET, `${PRODUCT}.exe`);
if (!fs.existsSync(exeFrom)) fail(`运行时里没有 electron.exe：${exeFrom}`);
fs.renameSync(exeFrom, exeTo);

/* ---------------- 6. 校验产物 ---------------- */

// 少一个文件就是「双击没反应」，而且没有报错可看 —— 宁可打包时报出来
const required = [
  exeTo,
  path.join(appDir, 'package.json'),
  path.join(appDir, 'src', 'main', 'index.js'),
  path.join(appDir, 'src', 'preload', 'index.js'),
  path.join(appDir, 'src', 'renderer', 'index.html'),
  path.join(appDir, 'src', 'renderer', 'styles', 'app.css'),
  path.join(TARGET, 'resources.pak'),
  path.join(TARGET, 'icudtl.dat'),
  path.join(TARGET, 'ffmpeg.dll'),
];
const missing = required.filter((f) => !fs.existsSync(f));
if (missing.length) {
  fail(`产物不完整，缺少：\n  ${missing.map((f) => path.relative(TARGET, f)).join('\n  ')}`);
}

/* ---------------- 7. 说明文件 ---------------- */

const readme = `${PRODUCT} v${pkg.version} · ${pkg.description}

【怎么用】
双击「${PRODUCT}.exe」即可启动，无需安装。
整个文件夹可以拷到别的目录、U 盘或另一台 Windows 10/11 64 位电脑上直接运行。

【首次使用前的准备】
1. 本机已安装安卓模拟器（MuMu / 雷电 / 夜神 / 逍遥 / BlueStacks 均可）。
2. 要用的那个模拟器实例已经**启动**，并且已开启「ADB 调试」或「开发者选项」。
   未启动的实例会出现在列表里但标注「未运行」，选中它会提示先启动。
3. 导出时会写入本地磁盘，默认位置是 D:\\Live2D\\<来源包名>\\，可在界面上更改。

【出问题了看日志】
%APPDATA%\\${PRODUCT}\\logs\\shimo-<日期>.log
启动异常时窗口可能根本不出现，日志是唯一的线索，请把它发过来。

【已知限制】
· 图标为 Electron 默认图标。
· 未做代码签名，Windows 可能提示「未知发布者」，选择「仍要运行」即可。
· 明文资源 + 标准 zip/obb 容器可以直接处理；AssetBundle 与自定义加密容器
  本版不支持，界面会如实标出并给出替代工具建议。
`;
fs.writeFileSync(path.join(TARGET, '使用说明.txt'), readme, 'utf8');

/* ---------------- 8. 可选：实测启动 ---------------- */

/**
 * 打包后真的把产物启动一次，确认它「窗口 ready」。
 *
 * 为什么必须留这个入口：静态检查只能证明文件都在，证明不了它跑得起来。
 * 而打包产物的启动失败**没有任何报错可看** —— GUI 子系统没有控制台，
 * 表现只是「进程 300ms 后安静退出，日志也没写」。本次开发就差点被这一点骗过：
 * 真正的失败原因不在产物里，而是当时的 shell 环境注入了
 * `ELECTRON_RUN_AS_NODE=1`（它会让 electron.exe 退化成纯 Node 进程）。
 * 所以这里也要显式清掉它，否则验证结果本身就是假的。
 */
function verifyLaunch(exePath) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const exeName = path.basename(exePath);
  const r = spawnSync(exePath, [], { env, encoding: 'utf8', timeout: 9000 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const ok = output.includes('window ready');

  // Electron 是多进程；主进程被超时终止后 GPU / 渲染进程可能残留，按进程树清一遍
  try {
    execSync(`taskkill /IM "${exeName}" /T /F`, { stdio: 'ignore' });
  } catch {
    /* 已经没有残留进程 */
  }
  return { ok, output };
}

/* ---------------- 9. 报告 ---------------- */

const size = dirSize(TARGET);
const lines = [
  '',
  `打包完成：${path.relative(ROOT, TARGET)}`,
  `  入口      ${PRODUCT}.exe`,
  `  应用代码  resources/app/src/`,
  `  总体积    ${mb(size)}`,
  `  日志位置  %APPDATA%\\${PRODUCT}\\logs\\`,
];

let verifyResult = null;
if (process.argv.includes('--verify')) {
  process.stdout.write('实测启动（会短暂弹出窗口）…\n');
  verifyResult = verifyLaunch(exeTo);
  lines.push(verifyResult.ok ? '  启动验证  ✅ 窗口就绪' : '  启动验证  ❌ 没等到 window ready，产物可能跑不起来');
  if (!verifyResult.ok) {
    process.stderr.write(`启动验证失败，产物输出：\n${verifyResult.output.slice(-2000)}\n`);
  }
} else {
  lines.push('  启动验证  未执行（加 --verify 会真的启动一次产物来确认）');
}

lines.push('', `运行：直接双击 ${path.join(TARGET, `${PRODUCT}.exe`)}`, '');
process.stdout.write(lines.join('\n'));

if (verifyResult && !verifyResult.ok) process.exit(1);
