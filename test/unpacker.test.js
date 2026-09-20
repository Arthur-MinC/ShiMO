'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runUnpack,
  unpackContainer,
  planFor,
  planEntries,
  displayName,
  sourcePackageOf,
  MAX_CONTAINER_BYTES,
} = require('../src/main/core/unpacker');
const { detectContainer, readZipIndex } = require('../src/main/core/container');
const { makeZip, makeMoc3, makeManifest } = require('./helpers/zip');

const CONTAINER_PATH = '/storage/emulated/0/Android/data/com.sega.pjsk/files_obb/main.obb';

/** 一个内容完整的标准 zip：模型目录 + 一个无关文件 + 一个目录条目。 */
function live2dZip(modelName = 'ichika') {
  const dir = `live2d/${modelName}`;
  return makeZip([
    { name: `${dir}/${modelName}.model3.json`, data: makeManifest(modelName), method: 8 },
    { name: `${dir}/${modelName}.moc3`, data: makeMoc3(4), method: 8 },
    { name: `${dir}/${modelName}.2048/texture_00.png`, data: Buffer.alloc(64, 7), method: 8 },
    { name: `${dir}/${modelName}.physics3.json`, data: '{"Physics":[]}', method: 8 },
    { name: `${dir}/motions/idle.motion3.json`, data: '{"Version":3}', method: 8 },
    { name: `${dir}/expressions/f01.exp3.json`, data: '{"Version":3}', method: 8 },
    { name: 'readme.txt', data: 'not a live2d file', method: 0 },
  ]);
}

function zipContainer(path = CONTAINER_PATH, buffer = live2dZip()) {
  return {
    path,
    name: path.split('/').pop(),
    size: buffer.length,
    sizeLabel: `${buffer.length} B`,
    detect: detectContainer(buffer.subarray(0, 8), path.split('/').pop()),
  };
}

/** 只实现 catBuffer 的假客户端 —— 解包逻辑不需要更多能力。 */
function fakeClient(buffer, { ok = true, message = '' } = {}) {
  return {
    async catBuffer() {
      return { ok, buffer: ok ? buffer : Buffer.alloc(0), message, cancelled: false };
    },
  };
}

test('displayName 显示应用目录下的相对路径，与设计稿的写法一致', () => {
  // 设计稿两条异常态里的三条标签，全部由这一条规则还原
  assert.equal(displayName('/storage/emulated/0/Android/data/com.sega.pjsk/files_obb/main.obb'), 'files_obb/main.obb');
  assert.equal(displayName('/storage/emulated/0/Android/data/com.sega.pjsk/files/cache/live2d.dat'), 'files/cache/live2d.dat');
  assert.equal(displayName('/storage/emulated/0/Android/data/com.sega.pjsk/files/live2d_pack.zip'), 'files/live2d_pack.zip');
  // /sdcard 别名与 /storage/emulated/0 是同一目录，显示名必须一致
  assert.equal(displayName('/sdcard/Android/obb/com.sega.pjsk/main.obb'), 'main.obb');
  // 不在应用目录下的路径退回末两段
  assert.equal(displayName('/a/b/c.dat'), 'b/c.dat');
  assert.equal(displayName('/c.dat'), 'c.dat');
  assert.equal(displayName(CONTAINER_PATH), 'files_obb/main.obb');
});

/**
 * 扫描页与解包页显示的是同一批容器，名字必须来自同一份规则。
 * 这两处曾经各写各的（扫描页 basename、解包页末两段），同一个容器在相邻两屏
 * 里叫两个名字 —— 用户会以为是两个不同的文件。
 */
test('容器显示名在扫描器与解包器之间保持一致', () => {
  const { deviceDisplayName } = require('../src/main/core/path-utils');
  const samples = [
    CONTAINER_PATH,
    '/storage/emulated/0/Android/obb/com.sega.pjsk/main.obb',
    '/storage/emulated/0/Android/data/com.bilibili.azurlane/files/AssetBundles/live2d/live2d.ab',
    '/sdcard/Android/data/com.x.y/files/cache/live2d.dat',
  ];
  for (const p of samples) {
    assert.equal(displayName(p), deviceDisplayName(p));
    // 末两段以外的东西不得出现在显示名里
    assert.ok(!displayName(p).includes('storage'), displayName(p));
  }
});

test('sourcePackageOf 从设备路径还原应用包名', () => {
  assert.equal(sourcePackageOf(CONTAINER_PATH), 'com.sega.pjsk');
  assert.equal(sourcePackageOf('/storage/emulated/0/Android/obb/com.x.y/main.obb'), 'com.x.y');
  assert.equal(sourcePackageOf('/tmp/a.zip'), '未知来源');
});

test('planFor：AssetBundle 与加密容器被明确拒绝，且给出可读原因', () => {
  const ab = planFor({ detect: detectContainer(Buffer.from('UnityFS\0\0\0', 'latin1'), 'a.ab') });
  assert.equal(ab.action, 'reject');
  assert.equal(ab.reason, 'unsupported_assetbundle');
  assert.ok(ab.reasonLabel.includes('UABE'));

  const enc = planFor({ detect: detectContainer(Buffer.from([0x4c, 0x32, 0x00, 0x01]), 'a.dat') });
  assert.equal(enc.action, 'reject');
  assert.equal(enc.reasonLabel, '自定义加密头 0x4C32');

  const zip = planFor({ detect: detectContainer(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'a.obb') });
  assert.equal(zip.action, 'unpack');
});

test('planEntries：只取模型目录的整棵子树，无关文件不参与聚合', () => {
  const entries = readZipIndex(live2dZip()).entries;
  const { manifests, dirs, wanted } = planEntries(entries);
  assert.deepEqual(manifests.map((e) => e.name), ['live2d/ichika/ichika.model3.json']);
  assert.deepEqual(dirs, ['/live2d/ichika']);
  const names = wanted.map((e) => e.name);
  assert.ok(names.includes('live2d/ichika/ichika.moc3'));
  assert.ok(names.includes('live2d/ichika/motions/idle.motion3.json'));
  assert.ok(!names.includes('readme.txt'));
});

test('解包一个标准 zip：聚合出完整包，来源包名与 moc3 版本都正确', async () => {
  const buffer = live2dZip();
  const { item, validations } = await unpackContainer({
    client: fakeClient(buffer),
    container: zipContainer(CONTAINER_PATH, buffer),
    signal: null,
  });

  assert.equal(item.ok, true);
  assert.equal(item.packCount, 1);
  // 显示名是「应用目录下的相对路径」。设计稿两条异常态写的都是这个形式，
  // 而且扫描页与解包页必须对同一个容器给出同一个名字。
  assert.equal(item.name, 'files_obb/main.obb');

  assert.equal(validations.length, 1);
  const { pack, validation } = validations[0];
  assert.equal(pack.modelName, 'ichika');
  assert.equal(pack.sourcePackage, 'com.sega.pjsk');
  assert.equal(pack.motions, 1);
  assert.equal(pack.expressions, 1);
  assert.equal(pack.textureCount, 1);
  assert.equal(pack.missing.length, 0);
  assert.equal(validation.status, 'complete');
  assert.equal(validation.defaultChecked, true);
  // 内存里的 .moc3 也要读版本，不能因为「不在磁盘上」就跳过兼容性判定
  assert.equal(validation.moc3Version, 4);
  assert.equal(validation.moc3Compat.minEditor, 'Cubism 4.2');
});

test('压缩包里的模型缺纹理 → 状态是「缺纹理」，不是笼统的失败', async () => {
  const dir = 'live2d/minori';
  const buffer = makeZip([
    { name: `${dir}/minori.model3.json`, data: makeManifest('minori'), method: 8 },
    { name: `${dir}/minori.moc3`, data: makeMoc3(4), method: 8 },
    // texture_00.png 故意不给
    { name: `${dir}/motions/idle.motion3.json`, data: '{}', method: 8 },
    { name: `${dir}/expressions/f01.exp3.json`, data: '{}', method: 8 },
  ]);
  const { item, validations } = await unpackContainer({
    client: fakeClient(buffer),
    container: zipContainer(CONTAINER_PATH, buffer),
    signal: null,
  });
  assert.equal(item.ok, true);
  assert.equal(validations[0].validation.status, 'missing_texture');
  assert.equal(validations[0].validation.defaultChecked, false);
});

test('zip 里没有 .model3.json → 如实报「容器内未找到」，不静默返回空', async () => {
  const buffer = makeZip([{ name: 'assets/logo.png', data: Buffer.alloc(16, 1), method: 0 }]);
  const { item, validations } = await unpackContainer({
    client: fakeClient(buffer),
    container: zipContainer(CONTAINER_PATH, buffer),
    signal: null,
  });
  assert.equal(item.ok, false);
  assert.equal(item.reason, 'no_manifest_in_container');
  assert.equal(validations.length, 0);
});

test('挂 zip 扩展名但内容不是 zip → 报「未知压缩格式」', async () => {
  const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
  const { item } = await unpackContainer({
    client: fakeClient(buffer),
    container: zipContainer(CONTAINER_PATH, buffer),
    signal: null,
  });
  assert.equal(item.ok, false);
  assert.equal(item.reason, 'not_standard_zip');
  assert.equal(item.reasonLabel, '未知压缩格式');
});

test('超过体积上限的容器被拒绝，并说明本版不流式解包', async () => {
  const container = { ...zipContainer(), size: MAX_CONTAINER_BYTES + 1 };
  const { item } = await unpackContainer({ client: fakeClient(Buffer.alloc(0)), container, signal: null });
  assert.equal(item.ok, false);
  assert.equal(item.reason, 'container_too_large');
  // 报的是真实体积（192.0 MB），不是笼统的「太大」
  assert.ok(item.reasonLabel.includes('192.0 MB'), item.reasonLabel);
  assert.ok(item.reasonLabel.includes('流式'));
});

test('读取容器失败时把原因带出来', async () => {
  const container = zipContainer();
  const { item } = await unpackContainer({
    client: fakeClient(Buffer.alloc(0), { ok: false, message: 'device offline' }),
    container,
    signal: null,
  });
  assert.equal(item.ok, false);
  assert.equal(item.reason, 'zip_read_failed');
  assert.ok(item.reasonLabel.includes('device offline'));
});

test('runUnpack 逐项处理并汇报进度，失败项不阻断后续容器', async () => {
  const good = live2dZip('ichika');
  const zipPath = '/storage/emulated/0/Android/data/com.sega.pjsk/files/live2d_pack.zip';
  const datPath = '/storage/emulated/0/Android/data/com.sega.pjsk/files/cache/live2d.dat';
  const datBody = Buffer.from([0x4c, 0x32, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);

  const client = {
    async catBuffer(path) {
      return { ok: true, buffer: path === zipPath ? good : datBody, message: '', cancelled: false };
    },
  };

  const progress = [];
  const containers = [
    { path: datPath, size: datBody.length, detect: detectContainer(datBody.subarray(0, 8), 'live2d.dat') },
    { path: zipPath, size: good.length, detect: detectContainer(good.subarray(0, 8), 'live2d_pack.zip') },
  ];

  const result = await runUnpack({ client, containers, onProgress: (p) => progress.push(p) });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].ok, false);
  assert.equal(result.items[0].reasonLabel, '自定义加密头 0x4C32');
  assert.equal(result.items[1].ok, true);
  assert.equal(result.aggregatedPacks, 1);
  assert.ok(progress.length >= 2);
  assert.equal(progress[progress.length - 1].done, true);
});

test('取消后不再继续处理后续容器', async () => {
  const good = live2dZip();
  const paths = ['/a/x.zip', '/a/y.zip'];
  const controller = new AbortController();
  const client = {
    async catBuffer() {
      return { ok: true, buffer: good, message: '', cancelled: false };
    },
  };
  const containers = paths.map((p) => ({
    path: p,
    size: good.length,
    detect: detectContainer(good.subarray(0, 8), 'x.zip'),
  }));

  const result = await runUnpack({
    client,
    containers,
    signal: controller.signal,
    // 在第 2 个容器开始前取消：第 1 个应已完成，第 2 个不该再被读取
    onProgress: (p) => {
      if (p.index === 1) controller.abort();
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.aggregatedPacks, 1);
});
