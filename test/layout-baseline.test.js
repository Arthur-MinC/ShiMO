'use strict';

/**
 * 布局基线的自检测试。
 *
 * 这里测的不是「溢出多少」，而是**基线这套机制本身**有没有漏洞：
 * 最危险的情况是新增了一屏却忘了补基线 —— 那时自检会安静地跳过它，
 * 看上去还是「6 屏全过」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { SCREENS } = require('../tools/selfcheck/screens');
const {
  LAYOUT_BASELINE,
  DEFAULT_TOLERANCE,
  maxOverflowFor,
  checkLayout,
  missingBaselines,
} = require('../tools/selfcheck/layout-baseline');

test('每一屏都必须有布局基线', () => {
  assert.deepEqual(missingBaselines(SCREENS), []);
});

test('missingBaselines 能认出漏掉基线的屏', () => {
  assert.deepEqual(missingBaselines(['connect', '不存在的屏']), ['不存在的屏']);
  // 也接受完整的 screen 条目，不必调用方先拆一遍
  assert.deepEqual(missingBaselines([{ screen: 'connect' }, { screen: '未来新屏' }]), ['未来新屏']);
});

test('基线不残留已经删掉的屏', () => {
  const known = new Set(SCREENS.map((s) => s.screen));
  const extra = Object.keys(LAYOUT_BASELINE).filter((s) => !known.has(s));
  assert.deepEqual(extra, [], '这些基线指向的屏已经不在自检清单里，应当删掉以免误导');
});

test('实测值是非负整数，容差是正数', () => {
  for (const [screen, entry] of Object.entries(LAYOUT_BASELINE)) {
    assert.ok(Number.isInteger(entry.measured) && entry.measured >= 0, `${screen} 的 measured 必须是非负整数`);
    assert.ok(Number.isInteger(entry.tolerance) && entry.tolerance >= 0, `${screen} 的 tolerance 必须是非负整数`);
    assert.ok(entry.note, `${screen} 缺 note：基线数字要能追溯到「为什么是这个值」`);
  }
});

test('零溢出的屏不给容差', () => {
  // 装得下的屏一旦溢出就是新问题，容差会把它吃掉
  for (const [screen, entry] of Object.entries(LAYOUT_BASELINE)) {
    if (entry.measured === 0) assert.equal(entry.tolerance, 0, `${screen} 本就没溢出，不该给容差`);
  }
});

test('checkLayout 的判定边界', () => {
  const limit = maxOverflowFor('done');
  assert.equal(limit, LAYOUT_BASELINE.done.measured + DEFAULT_TOLERANCE);

  assert.equal(checkLayout('done', 0).status, 'ok');
  assert.equal(checkLayout('done', limit).status, 'ok', '正好等于上限算通过');
  assert.equal(checkLayout('done', limit + 1).status, 'over', '超一个像素就该报出来');
  assert.equal(checkLayout('done', limit + 1).delta, 1);

  // 零容差的屏：溢出 1px 即失败
  assert.equal(checkLayout('results', 0).status, 'ok');
  assert.equal(checkLayout('results', 1).status, 'over');
});

test('没有基线时返回 unbaselined 而不是当成通过', () => {
  const r = checkLayout('未来新屏', 0);
  assert.equal(r.status, 'unbaselined');
  assert.equal(r.limit, null);
  assert.equal(maxOverflowFor('未来新屏'), null);
});
