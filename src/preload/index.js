'use strict';

/**
 * preload：渲染进程与主进程之间唯一的通道。
 *
 * 开启 contextIsolation、关闭 nodeIntegration，渲染进程拿不到任何 Node 能力，
 * 只能调用这里显式列出的方法。这样即使界面代码出问题，也碰不到文件系统与设备。
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** 订阅主进程推送，返回取消订阅函数。 */
function subscribe(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
  },

  app: {
    info: () => invoke('app:info'),
  },

  emulator: {
    discover: (options) => invoke('emulator:discover', options || {}),
    connect: (payload) => invoke('emulator:connect', payload),
    tryRoot: () => invoke('emulator:tryRoot'),
  },

  paths: {
    normalize: (roots) => invoke('paths:normalize', { roots }),
  },

  packages: {
    list: () => invoke('packages:list'),
  },

  scan: {
    start: (payload) => invoke('scan:start', payload || {}),
    cancel: () => invoke('scan:cancel'),
    result: () => invoke('scan:result'),
    onProgress: (handler) => subscribe('scan:progress', handler),
    onCancelled: (handler) => subscribe('scan:cancelled', handler),
  },

  exportPacks: {
    preview: (payload) => invoke('export:preview', payload || {}),
    run: (payload) => invoke('export:run', payload || {}),
    cancel: () => invoke('export:cancel'),
    onProgress: (handler) => subscribe('export:progress', handler),
  },

  unpack: {
    run: () => invoke('unpack:run'),
    cancel: () => invoke('unpack:cancel'),
    onProgress: (handler) => subscribe('unpack:progress', handler),
  },

  diagnostics: {
    save: (payload) => invoke('diagnostics:save', payload || {}),
    copy: () => invoke('diagnostics:copy'),
  },

  cubism: {
    detect: (payload) => invoke('cubism:detect', payload || {}),
    open: (payload) => invoke('cubism:open', payload || {}),
    pickPath: () => invoke('cubism:pickPath'),
    downloadUrl: 'https://www.live2d.com/download/cubism/',
  },

  system: {
    openPath: (target) => invoke('shell:openPath', { target }),
    showInFolder: (target) => invoke('shell:showInFolder', { target }),
    copy: (text) => invoke('clipboard:write', { text }),
    pickDirectory: (payload) => invoke('dialog:pickDirectory', payload || {}),
    spaceCheck: (targetRoot) => invoke('space:check', { targetRoot }),
    updateSettings: (payload) => invoke('settings:update', payload || {}),
    resetSession: () => invoke('session:reset'),
  },
};

contextBridge.exposeInMainWorld('shimo', api);
