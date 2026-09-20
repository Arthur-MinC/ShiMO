'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { readMoc3Header, validatePack, buildManifestText } = require('../src/main/core/validator');
const { makeMoc3 } = require('./helpers/zip');

/** 造一个最小的 pack 描述，只填校验用得上的字段。 */
function pack(overrides = {}) {
  const base = {
    id: '/d/a/a.model3.json',
    entryPath: '/d/a/a.model3.json',
    entryDir: '/d/a',
    modelName: 'a',
    parseError: null,
    files: [],
    missing: [],
    motions: 1,
    motionGroups: ['Idle'],
    expressions: 1,
    textureCount: 1,
    moc3Path: '/d/a/a.moc3',
    totalBytes: 100,
    hasMotions: true,
    hasExpressions: true,
  };
  return { ...base, ...overrides };
}

test('readMoc3Header 读出魔数与版本号', () => {
  const header = readMoc3Header(makeMoc3(4));
  assert.equal(header.valid, true);
  assert.equal(header.magic, 'MOC3');
  assert.equal(header.version, 4);
});

test('readMoc3Header 对损坏文件头返回 valid:false 而不是当成版本 0', () => {
  const bad = readMoc3Header(Buffer.from('XXXX\x04\x00', 'latin1'));
  assert.equal(bad.valid, false);
  assert.equal(bad.version, null);
  assert.ok(bad.reason.includes('MOC3'));

  const tooShort = readMoc3Header(Buffer.from('MO'));
  assert.equal(tooShort.valid, false);
  assert.ok(tooShort.reason.includes('长度不足'));
});

test('全部就位 → 完整，且默认勾选', () => {
  const v = validatePack(pack(), readMoc3Header(makeMoc3(4)));
  assert.equal(v.status, 'complete');
  assert.equal(v.statusLevel, 'ok');
  assert.equal(v.defaultChecked, true);
  assert.equal(v.moc3Version, 4);
  assert.equal(v.moc3Compat.minEditor, 'Cubism 4.2');
});

test('缺纹理 → 错误级、默认不勾选，且状态标签是「缺纹理」而不是笼统的「有风险」', () => {
  const v = validatePack(
    pack({ missing: [{ absPath: '/d/a/tex_01.png', relPath: 'a.2048/texture_01.png', role: 'texture', reason: '文件不存在' }] }),
    readMoc3Header(makeMoc3(4))
  );
  assert.equal(v.status, 'missing_texture');
  assert.equal(v.statusLabel, '缺纹理');
  assert.equal(v.statusLevel, 'error');
  assert.equal(v.defaultChecked, false);
  assert.ok(v.statusDetail.includes('texture_01.png'));
});

test('缺 moc3 → 错误级，优先于缺纹理报告', () => {
  const v = validatePack(
    pack({
      moc3Path: null,
      missing: [
        { absPath: '/d/a/a.moc3', relPath: 'a.moc3', role: 'moc3', reason: '文件不存在' },
        { absPath: '/d/a/t.png', relPath: 'a.2048/t.png', role: 'texture', reason: '文件不存在' },
      ],
    }),
    null
  );
  assert.equal(v.status, 'missing_moc3');
  assert.equal(v.defaultChecked, false);
});

test('无动作 → 警告级、默认不勾选，但模型本身能打开', () => {
  const v = validatePack(pack({ motions: 0, hasMotions: false }), readMoc3Header(makeMoc3(4)));
  assert.equal(v.status, 'no_motions');
  assert.equal(v.statusLevel, 'warning');
  assert.equal(v.defaultChecked, false);
  assert.equal(v.errorCount, 0);
});

test('无表情 → 警告级，仍可勾选（不影响打开）', () => {
  const v = validatePack(pack({ expressions: 0, hasExpressions: false }), readMoc3Header(makeMoc3(4)));
  assert.equal(v.status, 'no_expressions');
  assert.equal(v.statusLevel, 'warning');
  assert.equal(v.defaultChecked, true);
});

test('清单损坏 → broken', () => {
  const v = validatePack(pack({ parseError: '清单不是合法 JSON' }), null);
  assert.equal(v.status, 'broken');
  assert.equal(v.statusLevel, 'error');
  assert.equal(v.defaultChecked, false);
});

test('moc3 头部损坏被当作错误而不是放行', () => {
  const v = validatePack(pack(), readMoc3Header(Buffer.from('NOPE\x04', 'latin1')));
  assert.equal(v.status, 'broken');
  assert.equal(v.defaultChecked, false);
});

test('未知的 moc3 版本给出提示文案而不是静默当成已知版本', () => {
  const v = validatePack(pack(), readMoc3Header(makeMoc3(9)));
  assert.equal(v.moc3Version, 9);
  assert.equal(v.moc3Compat.minEditor, '未知');
  assert.ok(v.moc3Compat.note.includes('9'));
});

test('manifest.txt 包含来源、校验结论与完整文件清单', () => {
  const p = pack({
    files: [
      { absPath: '/d/a/a.model3.json', relPath: 'a.model3.json', size: 512, exportRelPath: 'a/a.model3.json' },
      { absPath: '/d/a/a.moc3', relPath: 'a.moc3', size: 4096, exportRelPath: 'a/a.moc3' },
    ],
  });
  const v = validatePack(p, readMoc3Header(makeMoc3(4)));
  const text = buildManifestText({
    pack: p,
    validation: v,
    source: { instanceName: 'MuMu 模拟器 12', adbAddress: '127.0.0.1:16384', androidVersion: 'Android 12', packageName: 'com.sega.pjsk' },
    exportedAt: '2026-09-16 18:00:00',
    toolVersion: '1.0.0',
    savedRoot: 'D:\\Live2D\\pjsk_extract',
  });
  for (const section of ['[来源]', '[导出]', '[模型]', '[完整性校验]', '[文件清单]']) {
    assert.ok(text.includes(section), `缺少章节 ${section}`);
  }
  assert.ok(text.includes('com.sega.pjsk'));
  assert.ok(text.includes('a/a.moc3'));
  assert.ok(text.includes('完整'));
});
