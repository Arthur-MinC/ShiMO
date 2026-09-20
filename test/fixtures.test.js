'use strict';

/**
 * 自检 fixture 与真实规则的一致性。
 *
 * 存在的理由：自检截图是「界面是否符合设计稿」的唯一凭据，而 fixture 里的
 * 显示名是**手写**的。手写值一旦和 `deviceDisplayName` 的规则漂开，截图就会
 * 显示一个真实运行时永远不会出现的名字 —— 等于截图为实现打掩护。
 *
 * 这里不重新实现规则，直接调真规则；漂了就红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { deviceDisplayName, sourcePackageOf, formatBytes } = require('../src/main/core/path-utils');
const fixtures = require('../tools/selfcheck/fixtures');

/** 递归收集所有形如 { path, name } 的容器条目。 */
function collectContainers(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectContainers(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    if (typeof node.path === 'string' && typeof node.name === 'string' && node.path.startsWith('/')) {
      out.push(node);
    }
    for (const value of Object.values(node)) collectContainers(value, out);
  }
  return out;
}

test('fixture 里的容器显示名等于 deviceDisplayName 算出来的名字', () => {
  const containers = collectContainers(fixtures);
  assert.ok(containers.length >= 3, `至少应有 3 个容器 fixture，实际 ${containers.length}`);

  for (const c of containers) {
    assert.equal(c.name, deviceDisplayName(c.path), `容器 ${c.path} 的显示名与规则不符`);
  }
});

test('fixture 里的容器都带上来源包名可解析的设备路径', () => {
  for (const c of collectContainers(fixtures)) {
    assert.equal(sourcePackageOf(c.path), 'com.sega.pjsk', `容器 ${c.path} 的来源包名不符`);
  }
});

test('fixture 的容器体积标签与 formatBytes 的写法一致（含单位与一位小数）', () => {
  for (const c of collectContainers(fixtures)) {
    assert.match(c.sizeLabel, /^\d+(\.\d)? (KB|MB|GB)$/, `${c.path} 的体积标签 ${c.sizeLabel} 不是 formatBytes 的格式`);
  }
  // 真规则也得同意这个格式，避免两边各写一套
  assert.equal(formatBytes(412 * 1024 * 1024), '412.0 MB');
});

/**
 * 实例 fixture 的字段必须服从发现层的真实契约。
 *
 * 这里栽过一次：fixture 给未运行的实例手写了 serial（`emulator-5554`），
 * 而真实运行时它们是 `null`。于是「选中项用 serial 匹配」的 bug 在真机上表现为
 * 「界面选中了未运行的实例」，在自检截图里却完全看不出来 —— 字段被填漂亮了，
 * 又一次替实现打了掩护。
 */
test('fixture 的实例 id 唯一且非空 —— 它是认实例的唯一身份键', () => {
  const ids = fixtures.INSTANCES.map((i) => i.id);
  assert.ok(ids.length >= 2, `实例 fixture 太少（${ids.length}），覆盖不到多实例场景`);
  for (const inst of fixtures.INSTANCES) {
    assert.ok(inst.id, `${inst.name} 缺 id`);
    assert.equal(typeof inst.id, 'string');
  }
  assert.equal(new Set(ids).size, ids.length, `实例 id 有重复：${ids.join(', ')}`);
});

test('未运行的实例 serial 必须是 null —— 它压根没出现在 adb devices 里', () => {
  for (const inst of fixtures.INSTANCES) {
    if (inst.state === 'not_running') {
      assert.equal(
        inst.serial,
        null,
        `${inst.name} 标为未运行却带着 serial=${JSON.stringify(inst.serial)}；` +
          `真实发现层在这种状态下给的是 null，填一个假 serial 会让「用 serial 认实例」的 bug 在截图里隐身`
      );
    }
  }
  // 至少要留一个未运行实例：否则「不能选中未运行实例」这条根本没被截图覆盖
  assert.ok(
    fixtures.INSTANCES.some((i) => i.state === 'not_running'),
    '实例 fixture 里应保留一个未运行的实例'
  );
});

test('fixture 的 running 与 state 不互相矛盾', () => {
  for (const inst of fixtures.INSTANCES) {
    assert.equal(Boolean(inst.running), inst.state === 'device', `${inst.name} 的 running 与 state 不一致`);
  }
});

test('默认选中的那个实例确实可连接', () => {
  const { selectDefaultInstance } = require('../src/main/core/emulator-finder');
  const picked = selectDefaultInstance(fixtures.INSTANCES, null);
  assert.ok(picked, 'fixture 里应当有一个可自动选中的实例');
  assert.equal(picked.id, fixtures.INSTANCE.id, '自检选中项与 selectDefaultInstance 的结论不一致');
  assert.equal(picked.state, 'device');
});
