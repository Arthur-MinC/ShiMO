'use strict';

/**
 * 拾模 · Electron 主进程入口。
 *
 * 窗口按设计稿 600×375 的 **2 倍**实现（1200×750），并使用自绘标题栏 ——
 * 设计稿里的标题栏是应用自己画的（左侧产品标识、右侧最小化/最大化/关闭），
 * 用系统原生标题栏没法 1:1 还原。
 */

const path = require('node:path');
const { app, BrowserWindow, shell, nativeTheme } = require('electron');

const logger = require('./core/logger');

// 日志要在一切之前就绪：后面任何一步失败，日志里都得有记录
const logReady = logger.init();
logger.installCrashHandlers();
const log = logger.scope('main');

const { registerIpc } = require('./ipc');

// 设计稿尺寸：600×375 × 2
const WINDOW_WIDTH = 1200;
const WINDOW_HEIGHT = 750;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 1000,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#FFFFFF',
    title: '拾模',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 把渲染进程的控制台输出转发到主进程 stdout，便于在终端里直接看到界面报错
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['verbose', 'info', 'warning', 'error'][level] || 'log';
    const where = sourceId ? `${String(sourceId).split(/[\\/]/).pop()}:${line}` : '';
    process.stdout.write(`[renderer:${tag}] ${message}${where ? ` (${where})` : ''}\n`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    process.stdout.write(`[renderer] 进程异常退出：${JSON.stringify(details)}\n`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    process.stdout.write(`[renderer] 页面加载失败 ${errorCode} ${errorDescription} ${validatedURL}\n`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    process.stdout.write('[shimo] window ready\n');
  });

  // 外链一律交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function getMainWindow() {
  return mainWindow;
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'light'; // 设计稿是浅色稿，不跟随系统深色
  const win = createWindow();
  registerIpc({ getMainWindow });
  log.info('应用已启动', { version: app.getVersion(), logFile: logger.file, logReady: logReady.ok });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  return win;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

module.exports = { getMainWindow };
