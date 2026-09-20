#!/usr/bin/env node
'use strict';

/**
 * 开发启动器。
 *
 * 存在的唯一理由：`ELECTRON_RUN_AS_NODE=1` 一旦出现在环境里，electron.exe 会
 * 退化成纯 Node 进程 —— `require('electron')` 返回的是二进制路径字符串，
 * `app` / `BrowserWindow` 全是 undefined，紧接着在 `app.whenReady()` 上崩掉：
 *
 *     TypeError: Cannot read properties of undefined (reading 'whenReady')
 *
 * 这个变量常由宿主程序（例如以 Electron 内置 Node 跑脚本的工具链）注入并继承下来，
 * 用户往往不知道它的存在。这里显式清掉，让启动行为可预期。
 *
 * 注意：本文件用 `node` 执行，而不是 electron —— 在纯 Node 下
 * `require('electron')` 恰好返回二进制路径，正好拿来 spawn。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');

let electronPath;
try {
  electronPath = require('electron');
} catch {
  process.stderr.write('未找到 electron 依赖，请先执行 npm install。\n');
  process.exit(1);
}

if (typeof electronPath !== 'string') {
  // 万一被 Electron 本体执行了，说明调用方式不对
  process.stderr.write('启动器必须用 node 执行：node tools/launch.js\n');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// 开发期把日志写到仓库内，便于直接查看
if (!env.SHIMO_LOG_DIR) env.SHIMO_LOG_DIR = path.join(root, '.logs');

// `--app <目录>` 用于启动仓库内的其它 Electron 入口（例如自检工具），
// 默认 '' 表示本应用自身。
let appPath = '.';
const args = process.argv.slice(2);
const appFlag = args.indexOf('--app');
if (appFlag !== -1) {
  const value = args[appFlag + 1];
  if (!value) {
    process.stderr.write('--app 需要一个目录参数\n');
    process.exit(1);
  }
  appPath = path.resolve(root, value);
  args.splice(appFlag, 2);
}

const child = spawn(electronPath, [appPath, ...args], { cwd: root, env, stdio: 'inherit' });

child.on('error', (err) => {
  process.stderr.write(`无法启动 Electron：${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code === null ? 0 : code);
});
