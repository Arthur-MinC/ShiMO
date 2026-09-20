'use strict';

/**
 * 各屏主区的溢出基线（单位 CSS px）。
 *
 * 背景：设计稿每一屏都按「一屏装得下」画，但实测有三屏装不下 —— 因为
 * 主区高度由**用户数据**决定（发现几个容器、勾了几个包、解出几个模型），
 * 设计稿是按最少的量估的。2026-09-17 决策：**接受滚动**，不为了塞进一屏
 * 去压间距和字号（11 / 12px 已是设计系统底线，再压就不可读）。
 *
 * 于是「存在滚动」被认可，但「溢出多少」必须锁住。否则以后有人把间距
 * 调大一点、或在某一屏多加一段说明，界面悄悄变胖而没人发现 —— 截图看得见，
 * 但没人会去逐张比高度。这里把实测值记下来当基线，超了就红。
 *
 * 为什么记「实测值 + 容差」而不是拍一个上限：上限是凭空想的数，改起来没依据；
 * 实测值有来源，容差说明允许的抖动幅度。要调基线就得有意识地确认一次版式变化，
 * 而不是随手改大。
 *
 * 容差怎么给的：
 *   - 零溢出的三屏给 0。它们本来就装得下，一旦溢出就是新问题，不该被容差吃掉。
 *   - 有溢出的三屏给 16px（约 3% 主区高度），吸收字体渲染/行高的细微抖动。
 *
 * 已知未锁住的边界：这里只量「整屏溢出」，不量「某一屏的某个区块被推出视野」。
 * 主按钮那条由 main.js 的 readPrimaryButtons 单独负责。
 */

const DEFAULT_TOLERANCE = 16;

const LAYOUT_BASELINE = {
  connect: { measured: 0, tolerance: 0, note: '一屏装得下（实例列表短）' },
  scanning: { measured: 0, tolerance: 0, note: '一屏装得下（进度态是固定高度）' },
  results: { measured: 0, tolerance: 0, note: '一屏装得下（结果表自带内部滚动）' },
  done: { measured: 152, tolerance: DEFAULT_TOLERANCE, note: '导出摘要 + 已导出模型表；勾选的包多时靠滚动' },
  empty: { measured: 155, tolerance: DEFAULT_TOLERANCE, note: '容器清单 + 能力边界说明；容器多时靠滚动' },
  unpackFail: { measured: 51, tolerance: DEFAULT_TOLERANCE, note: '逐项处理结果列表' },
};

/** 该屏允许的最大溢出；没有基线返回 null。 */
function maxOverflowFor(screen) {
  const entry = LAYOUT_BASELINE[screen];
  if (!entry) return null;
  return entry.measured + entry.tolerance;
}

/**
 * 比对一屏的溢出量。
 *
 * @param {string} screen
 * @param {number} overflow 主区 scrollHeight - clientHeight
 * @returns {{screen:string, overflow:number, limit:number|null, status:'ok'|'over'|'unbaselined', delta:number|null}}
 */
function checkLayout(screen, overflow) {
  const entry = LAYOUT_BASELINE[screen];
  if (!entry) {
    return { screen, overflow, limit: null, status: 'unbaselined', delta: null };
  }
  const limit = maxOverflowFor(screen);
  return {
    screen,
    overflow,
    limit,
    status: overflow > limit ? 'over' : 'ok',
    delta: overflow - limit,
  };
}

/** 屏清单里哪些屏还没有基线。返回空数组表示覆盖完整。 */
function missingBaselines(screens) {
  return screens.map((s) => (typeof s === 'string' ? s : s.screen)).filter((screen) => !LAYOUT_BASELINE[screen]);
}

module.exports = { LAYOUT_BASELINE, DEFAULT_TOLERANCE, maxOverflowFor, checkLayout, missingBaselines };
