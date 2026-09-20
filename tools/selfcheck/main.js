'use strict';

/**
 * 六屏自检。
 *
 * 单独跑一个 Electron 入口，把渲染层真实加载起来，逐屏注入 fixture 后
 * `capturePage()` 落 PNG，同时把每屏的可见文本一并导出。
 *
 * 为什么需要它：Windows 上 GUI 进程的 stdout 拿不到，而「看一眼界面」如果
 * 必须真的连一台模拟器，界面回归就不可能自动化。这里让六个屏幕全部可复现、
 * 可截图、可文本比对。
 *
 * 用法：node tools/launch.js --app tools/selfcheck
 * 产出：output/selfcheck/*.png + report.json
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// 截图必须**字节可重现**，否则「截图进版本库」会持续产生噪音 diff：
// 每次重跑自检 5/6 张 PNG 都显示已修改，真发生 UI 变化时反而看不出来，
// 真信号被编码抖动淹没。
//
// 抖动的来源是次像素抗锯齿（LCD text）——它依赖 GPU 与屏幕子像素排列；
// 色彩配置同理。这两条钉死之后，同样的 fixture 就能渲染出同样的字节。
app.commandLine.appendSwitch('disable-lcd-text');
app.commandLine.appendSwitch('force-color-profile', 'srgb');

const logger = require('../../src/main/core/logger');
logger.init();
logger.installCrashHandlers();
const log = logger.scope('selfcheck');

const { registerIpc } = require('../../src/main/ipc');
const fixtures = require('./fixtures');
const { SCREENS } = require('./screens');
const { checkLayout, missingBaselines, maxOverflowFor } = require('./layout-baseline');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'output', 'selfcheck');

const consoleMessages = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个屏幕对应的一整套状态。 */
function stateFor(screen) {
  const base = {
    screen,
    discovering: false,
    instances: fixtures.INSTANCES,
    selectedId: fixtures.INSTANCE.id,
    selectedSerial: fixtures.INSTANCE.serial,
    instance: fixtures.INSTANCE,
    roots: fixtures.ROOTS,
    customPath: '',
    filter: 'all',
    selected: new Set(),
    scan: fixtures.SCAN,
    progress: fixtures.PROGRESS,
    recentPacks: fixtures.RECENT_PACKS,
    exportResult: fixtures.EXPORT_RESULT,
    unpackResult: fixtures.UNPACK_RESULT,
    statusText: '',
    statusRight: 'ADB adb.exe 1.0.41',
  };

  if (screen === 'connect') {
    return { ...base, statusText: '就绪 · 检测到 3 个模拟器 · 1 个运行中' };
  }
  if (screen === 'results') {
    return { ...base, selected: new Set(fixtures.SCAN.packs.filter((p) => p.defaultChecked).map((p) => p.id)) };
  }
  if (screen === 'done') {
    return {
      ...base,
      selected: new Set(['ichika_normal', 'saki_normal', 'haruka_normal', 'shiho_normal', 'minori_normal'].map((n) => fixtures.SCAN.packs.find((p) => p.modelName === n).id)),
    };
  }
  if (screen === 'empty') {
    return { ...base, scan: fixtures.EMPTY_SCAN };
  }
  if (screen === 'unpackFail') {
    return { ...base, scan: fixtures.EMPTY_SCAN, unpackResult: fixtures.UNPACK_RESULT };
  }
  return base;
}

/** 把 Set 之类不可结构化克隆的值转成数组，方便注入。 */
function serialize(state) {
  return { ...state, selected: [...state.selected] };
}

async function waitForDebugHook(win, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) {
    const ready = await win.webContents.executeJavaScript('Boolean(window.__shimoDebug)').catch(() => false);
    if (ready) return true;
    if (Date.now() - started > timeoutMs) return false;
    await sleep(120);
  }
}

/** 读出这一屏真正渲染出来的文本，交给文本比对。 */
function readVisibleText() {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.innerText.replace(/\n{2,}/g, '\n').trim() : '';
  };
  return {
    titlebar: pick('.titlebar'),
    toolbar: pick('.toolbar'),
    sidebar: pick('.sidebar'),
    main: pick('.main'),
    statusbar: pick('.statusbar'),
  };
}

/**
 * 主按钮是否落在首屏内。
 *
 * 这条检查是拿血换来的：态 A 的主按钮曾经掉到折叠线以下（内容高度取决于
 * 「发现了几个容器」，容器一多就顶出去了），而它恰恰是那一屏唯一的出路。
 * 截图看得见、文本比对看不见 —— 只有量几何才拦得住。
 */
function readPrimaryButtons() {
  const out = [];
  document.querySelectorAll('.btn--primary').forEach((b) => {
    const r = b.getBoundingClientRect();
    out.push({
      action: b.dataset.action || '',
      text: b.textContent.trim(),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight + 0.5,
    });
  });
  return out;
}

/**
 * 主区是否溢出一屏，以及是否超出该屏的基线。
 *
 * 两件事分开看：
 *   - 溢出本身是**被接受的**（见 tools/selfcheck/layout-baseline.js 的说明），
 *     设计稿按最少数据量估的，容器/包一多就装不下，决策是让用户滚。
 *   - 但溢出**涨上去**不行。涨了要么是间距被改大、要么是某屏多了内容块，
 *     都属于没人会主动发现的版式回归。
 */
function readLayout() {
  const main = document.querySelector('.main');
  if (!main) return null;
  const viewport = window.innerHeight;
  return {
    viewport,
    mainClientHeight: main.clientHeight,
    mainScrollHeight: main.scrollHeight,
    overflow: Math.max(0, main.scrollHeight - main.clientHeight),
    scrollbarVisible: main.scrollHeight > main.clientHeight + 1,
  };
}

/**
 * 侧栏实例列表的高亮情况。
 *
 * 起因：未运行的实例 serial 是 null，侧栏曾按 `inst.serial === state.selectedSerial`
 * 判高亮 —— `null === null` 让**所有未运行实例一起亮起来**。截图里「亮了几个」
 * 很难用眼睛数，而且亮错一个看上去也像个正常界面，只有断言拦得住。
 *
 * 同时记下高亮项有没有在线的状态点：高亮一个连不上的实例，正是那起
 * 「界面选中了未运行的 MuMu、却让用户去启动本就在运行的雷电」的直接表现。
 */
function readInstanceSidebar() {
  // 必须限定 data-action="select-instance"：结果页的筛选栏也用 .side-item，
  // 不限定就会把「选中的筛选项」当成「选中的实例」来报错
  const items = [...document.querySelectorAll('.side-item[data-action="select-instance"]')];
  if (items.length === 0) return null;
  const active = items.filter((el) => el.classList.contains('is-active'));
  return {
    count: items.length,
    activeIds: active.map((el) => el.dataset.id || ''),
    allActiveOnline: active.every((el) => el.querySelector('.dot--on') !== null),
  };
}

/**
 * 不变量检查：构造一组「截图里没有、但真实会遇到」的状态来断言。
 *
 * 为什么不能只靠截图：六个屏是照着设计稿画的，而设计稿没有「一个运行中的实例都没有」
 * 这一屏 —— 可它恰恰出过 bug。没有可自动选中的实例时 `selectedId` 是 null，
 * 侧栏若用 serial 判高亮，会把**所有未运行实例**（serial 都是 null）一起点亮，
 * 主区还会挑中其中一个没在跑的显示详情。界面看上去像正常选中了一台模拟器，
 * 截图完全看不出来。
 *
 * 所以这里不截图、只断言：patch 出一组全未运行的实例，读 DOM，检查「没有任何高亮」。
 */
async function checkInvariants(win) {
  const results = [];
  const patch = async (state) => {
    await win.webContents.executeJavaScript(
      `window.__shimoDebug.patch(${JSON.stringify(state).replace(/</g, '\\u003c')})`
    );
    await sleep(220);
  };
  const readTitle = async () =>
    win.webContents.executeJavaScript(`(document.querySelector('.page-title')||{}).textContent||''`);

  // 不变量 1：列表里全是未运行的实例时，不得选中任何一个
  const idleInstances = fixtures.INSTANCES.filter((i) => i.state !== 'device');
  if (idleInstances.length >= 1) {
    await patch({
      ...serialize(stateFor('connect')),
      instances: idleInstances,
      selectedId: null,
      selectedSerial: null,
      instance: null,
    });
    const sidebar = await win.webContents.executeJavaScript(`(${readInstanceSidebar.toString()})()`);
    const title = await readTitle();

    const activeIds = sidebar ? sidebar.activeIds : [];
    results.push({
      label: '没有运行中的实例时，侧栏不得高亮任何一个',
      pass: activeIds.length === 0,
      detail: `高亮了 ${activeIds.length} 个：${activeIds.join('、') || '（无）'}`,
    });
    results.push({
      label: '没有运行中的实例时，主区给出启动引导',
      pass: title.includes('未检测到') || title.includes('未选择'),
      detail: `主区标题是「${title}」`,
    });
  }

  for (const r of results) {
    if (r.pass) log.info(`不变量成立：${r.label}`, { detail: r.detail });
    else log.error(`不变量被破坏：${r.label}`, { detail: r.detail });
  }
  return results;
}

async function capture(win, file, entry) {
  const text = await win.webContents.executeJavaScript(`(${readVisibleText.toString()})()`);
  const buttons = await win.webContents.executeJavaScript(`(${readPrimaryButtons.toString()})()`);
  const layout = await win.webContents.executeJavaScript(`(${readLayout.toString()})()`);
  const sidebar = await win.webContents.executeJavaScript(`(${readInstanceSidebar.toString()})()`);
  const image = await win.webContents.capturePage();
  const target = path.join(OUT_DIR, `${file}.png`);
  fs.writeFileSync(target, image.toPNG());
  const size = image.getSize();
  const layoutCheck = layout ? checkLayout(entry.screen, layout.overflow) : null;
  log.info(`已截图 ${file}`, {
    w: size.width,
    h: size.height,
    label: entry.label,
    overflow: layout ? layout.overflow : null,
    limit: layoutCheck ? layoutCheck.limit : null,
    activeInstances: sidebar ? sidebar.activeIds : null,
  });

  const buried = buttons.filter((b) => !b.inViewport);
  for (const b of buried) {
    log.warn(`「${b.text}」不在首屏内，需要滚屏才能看到`, { screen: entry.label, action: b.action, top: b.top, bottom: b.bottom });
  }

  // 侧栏高亮唯一，且只能落在在线实例上
  let sidebarProblem = null;
  if (sidebar && sidebar.activeIds.length > 1) {
    sidebarProblem = `同时高亮了 ${sidebar.activeIds.length} 个实例：${sidebar.activeIds.join('、')}`;
  } else if (sidebar && sidebar.activeIds.length === 1 && !sidebar.allActiveOnline) {
    sidebarProblem = `高亮的实例「${sidebar.activeIds[0]}」并不在线（没有在线的状态点）`;
  }
  if (sidebarProblem) log.error('侧栏实例高亮不对', { screen: entry.label, problem: sidebarProblem });

  return {
    ...entry,
    file: `${file}.png`,
    size,
    text,
    buttons,
    buriedButtons: buried.map((b) => b.text),
    layout,
    layoutCheck,
    sidebar,
    sidebarProblem,
  };
}

async function run() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 新增屏幕却忘了补基线，比溢出超标更值得先拦下来：没有基线就没人看得住它
  const unbaselined = missingBaselines(SCREENS);
  if (unbaselined.length) {
    log.error('这些屏还没有布局基线，先在 tools/selfcheck/layout-baseline.js 里补上', { screens: unbaselined });
    app.exit(2);
    return;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 750,
    useContentSize: true,
    frame: false,
    show: true,
    backgroundColor: '#FFFFFF',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const rec = { level, message, line, file: String(sourceId).split(/[\\/]/).pop() };
    consoleMessages.push(rec);
    // 立刻落盘：自检一旦中途抛异常，攒在内存里的报错就再也写不出去了
    if (level >= 2) log[level >= 3 ? 'error' : 'warn'](`[界面] ${rec.message}`, { file: rec.file, line: rec.line });
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const rec = { level: 3, message: `页面加载失败 ${code} ${desc} ${url}`, line: 0, file: '' };
    consoleMessages.push(rec);
    log.error(rec.message);
  });

  const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await loaded;

  const hookReady = await waitForDebugHook(win);
  if (!hookReady) {
    log.error('渲染层没有暴露自检钩子，界面很可能已经报错');
  }

  // 先让应用按真实流程跑一遍启动（含真实 ADB 探测），证明启动链路本身是通的
  await sleep(3500);
  const bootText = await win.webContents.executeJavaScript(`(${readVisibleText.toString()})()`);
  const bootImage = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, '00-boot.png'), bootImage.toPNG());

  const report = {
    generatedAt: new Date().toISOString(),
    outDir: OUT_DIR,
    boot: { size: bootImage.getSize(), text: bootText },
    screens: [],
    consoleMessages,
  };

  for (const entry of SCREENS) {
    const state = serialize(stateFor(entry.screen));
    try {
      await win.webContents.executeJavaScript(
        `window.__shimoDebug.patch(${JSON.stringify(state).replace(/</g, '\\u003c')})`
      );
    } catch (err) {
      // 某一屏渲染失败不该让整轮自检没有产出，记下来继续
      log.error(`渲染「${entry.label}」失败`, err);
      report.screens.push({ ...entry, file: null, error: err.message, text: null });
      continue;
    }
    await sleep(260); // 让一次 layout + paint 落定再截
    report.screens.push(await capture(win, entry.file, entry));
  }

  // 六屏跑完再验不变量：它会改状态，放在截图之后才不会污染截图
  const invariants = await checkInvariants(win);

  const overBaseline = report.screens.filter((s) => s.layoutCheck && s.layoutCheck.status === 'over');
  for (const s of overBaseline) {
    log.error('主区溢出超出基线，版式变胖了', {
      screen: s.label,
      overflow: s.layoutCheck.overflow,
      limit: s.layoutCheck.limit,
      delta: s.layoutCheck.delta,
    });
  }

  const buried = report.screens.filter((s) => s.buriedButtons && s.buriedButtons.length > 0);
  if (buried.length) {
    log.warn('有主按钮落在首屏之外', {
      screens: buried.map((s) => `${s.label}：${s.buriedButtons.join('、')}`),
    });
  } else {
    log.info('首屏检查：全部主按钮都在视野内');
  }

  const sidebarBroken = report.screens.filter((s) => s.sidebarProblem);

  // 布局与实例结论单独成段落盘：光看 PNG 分不出「滚动是设计允许的」还是
  // 「版式被改胖了」，也数不出侧栏到底亮了几个实例
  report.consoleMessages = consoleMessages;
  report.layoutSummary = {
    baselines: Object.fromEntries(SCREENS.map((s) => [s.screen, maxOverflowFor(s.screen)])),
    screens: report.screens.map((s) => ({
      screen: s.screen,
      label: s.label,
      overflow: s.layout ? s.layout.overflow : null,
      limit: s.layoutCheck ? s.layoutCheck.limit : null,
      status: s.layoutCheck ? s.layoutCheck.status : 'unbaselined',
    })),
    overBaseline: overBaseline.map((s) => s.label),
    buriedButtons: buried.map((s) => `${s.label}：${s.buriedButtons.join('、')}`),
    renderFailures: report.screens.filter((s) => s.error).map((s) => s.label),
  };
  report.instanceSummary = {
    sidebar: report.screens
      .filter((s) => s.sidebar)
      .map((s) => ({ screen: s.screen, label: s.label, count: s.sidebar.count, activeIds: s.sidebar.activeIds })),
    problems: sidebarBroken.map((s) => `${s.label}：${s.sidebarProblem}`),
    invariants,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  // 退出码只看**硬失败**：界面报错、某一屏没渲染出来、溢出超基线、侧栏高亮错、
  // 不变量被破坏。
  // 「主按钮被推到首屏外」目前只告警 —— 它同样严重，但阈值依赖内容量，
  // 先按告警积累几轮再决定要不要升级成硬失败。
  const hardFailures = consoleMessages.filter((m) => m.level >= 3).length > 0;
  const renderFailed = report.screens.some((s) => s.error);
  const invariantsBroken = invariants.filter((r) => !r.pass);
  const failed =
    hardFailures || renderFailed || overBaseline.length > 0 || sidebarBroken.length > 0 || invariantsBroken.length > 0;

  log.info('自检完成', {
    screens: report.screens.length,
    errors: consoleMessages.length,
    overBaseline: overBaseline.map((s) => s.label),
    sidebarProblems: sidebarBroken.map((s) => s.label),
    invariantsBroken: invariantsBroken.map((r) => r.label),
  });
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(() => {
  // 注册真实 IPC：启动期 boot() 会真的去探测模拟器，这条链路也要覆盖
  registerIpc();
  run().catch((err) => {
    log.error('自检异常终止', err);
    app.exit(2);
  });
});
