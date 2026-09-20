'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractReferences,
  buildPack,
  computeAggregateBytes,
  countAggregateFiles,
  findOrphanMoc3,
} = require('../src/main/core/packer');
const { makeManifest } = require('./helpers/zip');

const DIR = '/storage/emulated/0/Android/data/com.sega.pjsk/files/live2d/ichika';

/** 内存文件系统探针：与设备上的探针接口一致，但不需要任何设备。 */
function fakeProbe(sizes) {
  return {
    async stat(absPath) {
      const size = sizes[absPath];
      return size === undefined ? { exists: false, size: 0 } : { exists: true, size };
    },
  };
}

function fullTree(prefix = DIR) {
  return {
    [`${prefix}/ichika.model3.json`]: 512,
    [`${prefix}/ichika.moc3`]: 4096,
    [`${prefix}/ichika.2048/texture_00.png`]: 2048,
    [`${prefix}/ichika.physics3.json`]: 128,
    [`${prefix}/motions/idle.motion3.json`]: 256,
    [`${prefix}/expressions/f01.exp3.json`]: 96,
  };
}

test('extractReferences 兼容字符串与 { File } 两种写法', () => {
  const refs = extractReferences({
    FileReferences: {
      Moc: 'a.moc3',
      Textures: [{ File: 'a.2048/tex_00.png' }],
      Motions: { Idle: ['motions/a.motion3.json', { File: 'motions/b.motion3.json' }] },
      Expressions: [{ Name: 'e', File: 'expressions/e.exp3.json' }],
    },
  });
  const byRole = (role) => refs.filter((r) => r.role === role);
  assert.equal(byRole('moc3').length, 1);
  assert.equal(byRole('texture').length, 1);
  assert.equal(byRole('motion').length, 2);
  assert.equal(byRole('expression').length, 1);
  assert.deepEqual(byRole('motion').map((r) => r.group), ['Idle', 'Idle']);
});

test('同一文件被多处引用只计一次（不改体积总和）', () => {
  const manifest = JSON.stringify({
    FileReferences: {
      Moc: 'a.moc3',
      Motions: { Idle: [{ File: 'motions/shared.motion3.json' }] },
      EyeBlink: [{ File: 'motions/shared.motion3.json' }],
      LipSync: [{ File: 'motions/shared.motion3.json' }],
    },
  });
  const sizes = { [`${DIR}/a.moc3`]: 10, [`${DIR}/motions/shared.motion3.json`]: 20 };
  return buildPack({
    entryPath: `${DIR}/a.model3.json`,
    manifestText: manifest,
    probe: fakeProbe(sizes),
    rootOf: () => DIR,
  }).then((pack) => {
    const motionFiles = pack.files.filter((f) => f.role === 'motion');
    assert.equal(motionFiles.length, 1);
    // 清单自身 + moc3 + 共用动作文件，共用文件只出现一次
    assert.equal(pack.totalBytes, Buffer.byteLength(manifest, 'utf8') + 10 + 20);
  });
});

test('buildPack 解析完整包并算出动作/表情/纹理数', async () => {
  const pack = await buildPack({
    entryPath: `${DIR}/ichika.model3.json`,
    manifestText: makeManifest('ichika'),
    probe: fakeProbe(fullTree()),
    rootOf: () => DIR,
  });
  assert.equal(pack.modelName, 'ichika');
  assert.equal(pack.motions, 1);
  assert.equal(pack.expressions, 1);
  assert.equal(pack.textureCount, 1);
  assert.equal(pack.missing.length, 0);
  assert.equal(pack.hasMotions, true);
  assert.ok(pack.moc3Path.endsWith('ichika.moc3'));
});

test('引用文件缺失时进入 missing 而不是被静默忽略', async () => {
  const sizes = fullTree();
  delete sizes[`${DIR}/ichika.2048/texture_00.png`];
  const pack = await buildPack({
    entryPath: `${DIR}/ichika.model3.json`,
    manifestText: makeManifest('ichika'),
    probe: fakeProbe(sizes),
    rootOf: () => DIR,
  });
  assert.equal(pack.missing.length, 1);
  assert.equal(pack.missing[0].role, 'texture');
  assert.equal(pack.missing[0].relPath, 'ichika.2048/texture_00.png');
});

test('清单不是合法 JSON 时给出 parseError 而不是抛异常', async () => {
  const pack = await buildPack({
    entryPath: `${DIR}/broken.model3.json`,
    manifestText: '{ this is not json',
    probe: fakeProbe({}),
    rootOf: () => DIR,
  });
  assert.ok(pack.parseError.includes('清单不是合法 JSON'));
  assert.equal(pack.files.length, 0);
});

test('computeAggregateBytes 对不同包共享的文件只计一次', () => {
  const shared = { absPath: '/x/shared.png', size: 100 };
  const a = { files: [{ absPath: '/x/a.moc3', size: 10 }, shared] };
  const b = { files: [{ absPath: '/x/b.moc3', size: 20 }, shared] };
  assert.equal(computeAggregateBytes([a, b]), 130);
  assert.equal(countAggregateFiles([a, b]), 3);
});

test('findOrphanMoc3 只挑出没有被任何清单引用的 moc3', async () => {
  const pack = await buildPack({
    entryPath: `${DIR}/ichika.model3.json`,
    manifestText: makeManifest('ichika'),
    probe: fakeProbe(fullTree()),
    rootOf: () => DIR,
  });
  const all = [`${DIR}/ichika.moc3`, `${DIR}/../orphan/lost.moc3`];
  const orphans = findOrphanMoc3(all, [pack]);
  assert.deepEqual(orphans, [`${DIR}/../orphan/lost.moc3`]);
});
