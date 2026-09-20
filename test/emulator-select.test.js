'use strict';

/**
 * 实例身份与默认选择的规则（FR-01）。
 *
 * 起因是一起真实 bug：本机雷电模拟器明明在运行，界面却选中了**未运行**的 MuMu，
 * 还提示「该实例当前未运行，请先启动它」—— 让用户去启动一个本来就在跑的模拟器。
 *
 * 根因一句话：**拿 `serial` 当实例身份，而未运行实例的 `serial` 是 `null`。**
 * `null === null` 为真，于是
 *   - `list.some(i => i.serial === null)` 恒真 → 「上次选的还在」被误判 → 跳过自动选中；
 *   - `list.find(i => i.serial === null)` → 返回第一个未运行实例 → 被当成当前选中项。
 *
 * 这些用例锁的就是「身份一律用 id、默认选择只挑可连接的实例」这两条。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { instanceKey, findInstance, selectDefaultInstance } = require('../src/main/core/emulator-finder');

const RUNNING = {
  id: '127.0.0.1:16384',
  serial: '127.0.0.1:16384',
  name: 'MuMu 模拟器',
  running: true,
  state: 'device',
};

/** 装了但没启动：没出现在 adb devices 里，serial 必然是 null。 */
const IDLE_LD = {
  id: 'offline:ldplayer:E:\\software\\LDPlayer9',
  serial: null,
  name: '雷电模拟器 9',
  running: false,
  state: 'not_running',
};

const IDLE_NOX = {
  id: 'offline:nox:D:\\Nox',
  serial: null,
  name: '夜神模拟器',
  running: false,
  state: 'not_running',
};

/** adb 报了但不可用：这种实例**是有 serial** 的，别和「没启动」混为一谈。 */
const OFFLINE = {
  id: 'emulator-5554',
  serial: 'emulator-5554',
  name: '雷电实例',
  running: false,
  state: 'offline',
};

test('身份键用 id，不用 serial', () => {
  assert.equal(instanceKey(RUNNING), RUNNING.id);
  assert.equal(instanceKey(IDLE_LD), IDLE_LD.id);
  assert.equal(instanceKey(null), null);
});

test('找实例优先用 id —— 多个未运行实例的 serial 都是 null，靠 serial 必然找错', () => {
  const list = [IDLE_LD, IDLE_NOX, RUNNING];
  assert.equal(findInstance(list, { id: IDLE_NOX.id }).name, '夜神模拟器');
  assert.equal(findInstance(list, { id: IDLE_LD.id }).name, '雷电模拟器 9');
  assert.equal(findInstance(list, { id: RUNNING.id }).name, 'MuMu 模拟器');

  // 只给 serial=null 时谁都不该被找到 —— 这正是不能用 serial 认实例的原因
  assert.equal(findInstance(list, { serial: null }), null);
  assert.equal(findInstance(list, {}), null);
  assert.equal(findInstance([], { id: '不存在' }), null);
});

test('默认选择只挑运行中且 adb 可达的实例', () => {
  const picked = selectDefaultInstance([IDLE_LD, OFFLINE, RUNNING], null);
  assert.equal(picked.id, RUNNING.id);
  // 顺序换了也一样：不会因为未运行实例排在前面就选中它
  assert.equal(selectDefaultInstance([RUNNING, IDLE_LD], null).id, RUNNING.id);
});

test('没有可连接的实例时什么都不选，而不是退而求其次选未运行的', () => {
  assert.equal(selectDefaultInstance([IDLE_LD, IDLE_NOX], null), null);
  // offline 有 serial，但 adb 不通，同样不算可连接
  assert.equal(selectDefaultInstance([IDLE_LD, OFFLINE], null), null);
  assert.equal(selectDefaultInstance([], null), null);
});

test('延续上次选择的前提是它现在仍然可连接', () => {
  const list = [IDLE_LD, RUNNING];
  assert.equal(selectDefaultInstance(list, RUNNING.id).id, RUNNING.id);

  // 上次选的那个已经关掉了 → 不再延续，改为挑一个能用的
  assert.equal(selectDefaultInstance(list, IDLE_LD.id).id, RUNNING.id);

  // 一个能用的都没有时返回 null：用户上次选的实例已关机，
  // 界面该显示「未检测到可用实例」而不是继续把它当成选中项
  assert.equal(selectDefaultInstance([IDLE_LD], IDLE_LD.id), null);
});

test('脏数据（running 与 state 互相矛盾）不足以让它被选中', () => {
  const inconsistent = { id: 'x', serial: null, running: true, state: 'not_running' };
  assert.equal(selectDefaultInstance([inconsistent], null), null);
});
