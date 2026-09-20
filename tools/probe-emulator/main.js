'use strict';

/**
 * 模拟器发现链路的诊断入口。
 *
 * 目的：把 `discoverEmulators()` 的原始输出原样打出来，用来回答
 * 「界面上显示的实例列表和状态，是不是探测结果本来的样子」。
 *
 * 为什么需要它：自检只截界面，界面上看到的已经是渲染层的解释结果。
 * 一旦「自动选中了未运行的实例」这类问题出现，光看截图分不清是
 * 发现层判错了状态、还是 ipc 选错了实例、还是渲染层挑错了——必须看原始数据。
 *
 * 用法：node tools/launch.js --app tools/probe-emulator
 * 产出：日志（.logs/ 下最新一份）里的 `发现结果` 一条
 */

const { app } = require('electron');

const logger = require('../../src/main/core/logger');
logger.init();
const log = logger.scope('probe-emulator');

const { discoverEmulators } = require('../../src/main/core/emulator-finder');

app.whenReady().then(async () => {
  try {
    const started = Date.now();
    const r = await discoverEmulators({});
    log.info('发现结果', {
      elapsedMs: Date.now() - started,
      serverVersion: r.serverVersion,
      instanceCount: r.instances.length,
      runningCount: r.instances.filter((i) => i.running).length,
      deviceStateCount: r.instances.filter((i) => i.state === 'device').length,
      // 自动选择用的就是这个条件，和 ipc.js 里保持一致
      wouldAutoSelect: (r.instances.find((i) => i.running && i.state === 'device') || {}).name || null,
      instances: r.instances.map((i) => ({
        name: i.name,
        id: i.id,
        serial: i.serial,
        running: i.running,
        state: i.state,
        stateLabel: i.stateLabel,
        adbAddress: i.adbAddress,
        androidVersion: i.androidVersion,
        adbPath: i.adbPath,
        isRoot: i.isRoot,
      })),
      warnings: r.warnings,
      installations: (r.installations || []).map((i) => ({ vendor: i.vendor, name: i.name, dir: i.dir })),
      rejected: r.rejected,
    });
    app.exit(0);
  } catch (err) {
    log.error('探测失败', err);
    app.exit(1);
  }
});
