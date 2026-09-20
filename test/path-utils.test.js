'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalDevicePath,
  dedupeDevicePaths,
  deviceDirname,
  deviceBasename,
  safeJoinLocal,
  formatBytes,
} = require('../src/main/core/path-utils');

test('canonicalDevicePath 把 /sdcard 家族折叠成同一个路径', () => {
  const want = '/storage/emulated/0/Android/data';
  assert.equal(canonicalDevicePath('/sdcard/Android/data'), want);
  assert.equal(canonicalDevicePath('/storage/emulated/0/Android/data'), want);
  assert.equal(canonicalDevicePath('/mnt/shell/emulated/0/Android/data'), want);
  // 末尾斜杠不该产生两个不同路径
  assert.equal(canonicalDevicePath('/storage/emulated/0/Android/data/'), want);
});

test('canonicalDevicePath 折叠 . 与 ..', () => {
  assert.equal(canonicalDevicePath('/storage/emulated/0/Android/./data'), '/storage/emulated/0/Android/data');
  assert.equal(canonicalDevicePath('/storage/emulated/0/Android/obb/../data'), '/storage/emulated/0/Android/data');
});

test('dedupeDevicePaths 去掉别名重复与子路径', () => {
  const { kept, removed } = dedupeDevicePaths([
    '/sdcard/Android/data',
    '/storage/emulated/0/Android/data',
    '/storage/emulated/0/Android/data/com.sega.pjsk',
    '/storage/emulated/0/Android/obb',
  ]);
  assert.deepEqual(kept, ['/storage/emulated/0/Android/data', '/storage/emulated/0/Android/obb']);
  // 一条别名重复 + 一条被父目录覆盖
  assert.equal(removed.length, 2);
  assert.ok(removed.some((r) => r.reason.includes('等价')));
  assert.ok(removed.some((r) => r.reason.includes('父目录')));
});

test('deviceDirname / deviceBasename 处理根路径', () => {
  assert.equal(deviceDirname('/a/b/c.model3.json'), '/a/b');
  assert.equal(deviceBasename('/a/b/c.model3.json'), 'c.model3.json');
  assert.equal(deviceDirname('/a'), '/');
});

test('safeJoinLocal 拒绝越界路径（抛错，不静默写出目录外）', () => {
  const base = 'D:\\Live2D\\out';
  assert.ok(safeJoinLocal(base, 'model/tex.png').startsWith(base));
  // 游戏资源里的路径不可信，manifest 不能决定写到哪儿
  assert.throws(() => safeJoinLocal(base, '../escape.txt'), /越界/);
  assert.throws(() => safeJoinLocal(base, 'a/../../escape.txt'), /越界/);
});

test('formatBytes 在边界上不出现 1024.0 KB', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(undefined), '—');
});
