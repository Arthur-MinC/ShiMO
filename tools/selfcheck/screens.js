'use strict';

/**
 * 自检覆盖的屏幕清单。
 *
 * 为什么单独成一个模块、而不是写在 main.js 里：main.js 顶部就
 * `require('electron')`，一旦被 require，纯 Node 下拿不到 app / BrowserWindow。
 * 而「每屏都必须有布局基线」这条检查需要在单测里跑，单测是纯 Node —— 
 * 所以屏清单必须放在一个不碰 electron 的文件里。
 *
 * 新增屏幕时这里加一行，`test/layout-baseline.test.js` 会强制要求同时补基线。
 */
const SCREENS = [
  { file: '01-connect', screen: 'connect', label: '屏 1 · 连接模拟器' },
  { file: '02-scanning', screen: 'scanning', label: '屏 2 · 扫描中（进度态）' },
  { file: '03-results', screen: 'results', label: '屏 3 · 扫描结果' },
  { file: '04-done', screen: 'done', label: '屏 4 · 导出完成' },
  { file: '05-empty', screen: 'empty', label: '态 A · 扫描结果为空' },
  { file: '06-unpack-fail', screen: 'unpackFail', label: '态 B · 解包失败' },
];

module.exports = { SCREENS };
