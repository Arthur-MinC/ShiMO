'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectContainer, readZipIndex, extractZipEntry, filterZipEntries } = require('../src/main/core/container');
const { makeZip } = require('./helpers/zip');

test('识别标准 zip', () => {
  const r = detectContainer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]), 'main.obb');
  assert.equal(r.kind, 'zip');
  assert.equal(r.extractable, true);
  assert.equal(r.unsupported, false);
});

test('识别 AssetBundle —— 并明确标注本工具不处理', () => {
  const r = detectContainer(Buffer.from('UnityFS\0\0\0\0\0\0', 'latin1'), 'live2d.ab');
  assert.equal(r.kind, 'assetbundle');
  assert.equal(r.extractable, false);
  assert.equal(r.unsupported, true);
  assert.ok(r.hint.includes('UABE'));
});

test('未知文件头被归为自定义加密，并带上具体字节', () => {
  const r = detectContainer(Buffer.from([0x4c, 0x32, 0x00, 0x01, 0x9a, 0x2f, 0x11, 0x00]), 'live2d.dat');
  assert.equal(r.kind, 'encrypted');
  assert.equal(r.extractable, false);
  assert.equal(r.unsupported, true);
  assert.ok(r.headerHex.startsWith('4C 32'));
});

test('明文文件不会被误判为容器', () => {
  const r = detectContainer(Buffer.from('{"Version":3}', 'utf8'), 'a.model3.json');
  assert.equal(r.kind, 'plain');
  assert.equal(r.unsupported, false);
});

test('readZipIndex + extractZipEntry 能原样取回内容（store 与 deflate）', () => {
  const big = 'x'.repeat(5000);
  const zip = makeZip([
    { name: 'a/plain.txt', data: 'hello 拾模', method: 0 },
    { name: 'a/deflated.json', data: big, method: 8 },
    { name: 'a/dir/', data: '', method: 0 },
  ]);

  const index = readZipIndex(zip);
  assert.equal(index.ok, true);
  assert.equal(index.entries.length, 3);

  const byName = new Map(index.entries.map((e) => [e.name, e]));
  const plain = extractZipEntry(zip, byName.get('a/plain.txt'));
  assert.equal(plain.ok, true);
  assert.equal(plain.buffer.toString('utf8'), 'hello 拾模');

  const deflated = extractZipEntry(zip, byName.get('a/deflated.json'));
  assert.equal(deflated.ok, true);
  assert.equal(deflated.buffer.toString('utf8'), big);
});

test('readZipIndex 对非 zip 数据如实失败', () => {
  const r = readZipIndex(Buffer.from('not a zip at all', 'utf8'));
  assert.equal(r.ok, false);
  assert.ok(r.message.includes('EOCD'));
});

test('extractZipEntry 拒绝过大的条目而不是硬吃内存', () => {
  const zip = makeZip([{ name: 'huge.bin', data: Buffer.alloc(2048), method: 0 }]);
  const index = readZipIndex(zip);
  const out = extractZipEntry(zip, index.entries[0], 1024);
  assert.equal(out.ok, false);
  assert.ok(out.message.includes('过大'));
});

test('filterZipEntries 会跳过目录条目', () => {
  const zip = makeZip([
    { name: 'm/', data: '', method: 0 },
    { name: 'm/x.model3.json', data: '{}', method: 0 },
  ]);
  const kept = filterZipEntries(readZipIndex(zip).entries, (n) => n.endsWith('.json'));
  assert.deepEqual(kept.map((e) => e.name), ['m/x.model3.json']);
});
