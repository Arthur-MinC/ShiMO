'use strict';

/**
 * 自检用的假数据。
 *
 * 数值刻意照抄设计稿，这样截出来的图能直接和
 * `design/shimo-desktop-live2d-design.html` 逐项比对 —— 名字、体积、计数、
 * 状态标签全部一一对应，凡是数字对不上就说明渲染层算错了。
 *
 * 两处**故意**与设计稿不同，均为修正设计稿自身的矛盾：
 *
 *   1. 屏 3 侧栏「无动作」计数：设计稿写 0，但表格里 honami_normal 的状态就是
 *      「无动作」。同一屏内自相矛盾，实现按 1 取，保证筛选计数与列表一致。
 *   2. 屏 3 的默认勾选：设计稿把「缺纹理」的 minori_normal 打了勾，
 *      与它自己第 5 条设计决策（残包不自动勾）冲突。实现按决策与 PRD 走，
 *      故勾选数为 3 个包 / 44.6 MB，而非设计稿标注的 4 个包 / 65.9 MB。
 *
 * 容器的 `name` 不要手写完了就算 —— 它必须等于
 * `path-utils.deviceDisplayName(path)`，即「应用目录下的相对路径」。
 * `test/fixtures.test.js` 会逐条核对，漂了就红：截图一旦显示真实运行时不存在的
 * 名字，就等于截图为实现打掩护。
 */

/**
 * 实例列表的假数据，字段取值必须服从发现层的真实契约：
 *
 *   - `state: 'not_running'` 表示「装了但没启动」，它压根没出现在 adb devices 里，
 *     因此 **`serial` 必须是 `null`**（`adbAddress` 仍可由已知端口推算出来）；
 *   - `state: 'offline' / 'unauthorized'` 表示 adb 报了但不可用，这种实例
 *     是**有 serial** 的；
 *   - `running` 为真当且仅当 `state === 'device'`；
 *   - `id` 恒存在且唯一 —— 它是认实例的唯一身份键。
 *
 * ⚠️ 这里踩过坑：未运行的两个实例原先手写了 `serial`（`emulator-5554` 之类），
 * 而真实运行时它们是 `null`。于是「选中项用 serial 匹配」的 bug 在真机上表现为
 * 「界面选中了未运行的实例」，而在自检截图里完全看不出来 —— fixture 把字段填漂亮了，
 * 又一次替实现打了掩护。`test/fixtures.test.js` 现在会核对这几条。
 */
const INSTANCES = [
  {
    id: '127.0.0.1:16384',
    name: 'MuMu 模拟器 12 · Player1',
    serial: '127.0.0.1:16384',
    running: true,
    state: 'device',
    stateLabel: '运行中',
    androidVersion: 'Android 12',
    isRoot: true,
    abi: 'x86_64',
    adbPath: 'E:\\software\\MuMuPlayer-12.0\\shell\\adb.exe',
    adbAddress: '127.0.0.1:16384',
    needsAdbRoot: false,
  },
  {
    id: 'offline:ldplayer:E:\\software\\LDPlayer9',
    name: '雷电模拟器 9',
    serial: null,
    running: false,
    state: 'not_running',
    stateLabel: '未运行',
    androidVersion: '',
    isRoot: false,
    abi: '',
    adbPath: 'E:\\software\\LDPlayer9\\adb.exe',
    adbAddress: '127.0.0.1:5555',
    needsAdbRoot: false,
  },
  {
    id: 'offline:bluestacks:C:\\Program Files\\BlueStacks_nxt',
    name: 'BlueStacks 5',
    serial: null,
    running: false,
    state: 'not_running',
    stateLabel: '未运行',
    androidVersion: '',
    isRoot: false,
    abi: '',
    adbPath: 'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
    adbAddress: '127.0.0.1:5555',
    needsAdbRoot: false,
  },
];

const INSTANCE = INSTANCES[0];

const ROOTS = [
  { path: '/storage/emulated/0/Android/data', checked: true },
  { path: '/storage/emulated/0/Android/obb', checked: true },
];

const SOURCE_DIR = '/storage/emulated/0/Android/data/com.sega.pjsk/files/live2d';

function pack(spec) {
  return {
    id: `${SOURCE_DIR}/${spec.name}/${spec.name}.model3.json`,
    modelName: spec.name,
    entryPath: `${SOURCE_DIR}/${spec.name}/${spec.name}.model3.json`,
    entryDir: `${SOURCE_DIR}/${spec.name}`,
    sourcePackage: spec.pkg,
    motions: spec.motions,
    expressions: spec.expressions,
    motionGroups: spec.motionGroups || ['Idle', 'Tap'],
    textureCount: spec.textures || 2,
    totalBytes: spec.bytes,
    bytesLabel: spec.bytesLabel,
    fileCount: spec.files || 12,
    contentLabel:
      `${spec.motions} 动作 · ${spec.expressions} 表情` + (spec.missingCount ? ` · 缺 ${spec.missingCount} 项` : ''),
    status: spec.status,
    statusLabel: spec.statusLabel,
    statusLevel: spec.statusLevel,
    statusDetail: spec.statusDetail,
    defaultChecked: spec.statusLevel === 'ok' && spec.motions > 0,
    moc3Version: spec.moc3Version || 4,
    moc3Compat: { label: 'moc3 ver 4', minEditor: 'Cubism 4.2', worksWith: 'Cubism 4.2 / 5', note: '' },
    issues: [],
    missing: Array.from({ length: spec.missingCount || 0 }, (_, i) => ({
      relPath: `${spec.name}.2048/texture_0${i + 1}.png`,
      role: 'texture',
      reason: '目录中不存在该文件',
    })),
  };
}

const PACKS = [
  pack({
    name: 'ichika_normal', pkg: 'com.sega.pjsk', motions: 12, expressions: 4,
    bytes: 19_503_513, bytesLabel: '18.6 MB', files: 31, status: 'complete', statusLabel: '完整', statusLevel: 'ok',
    statusDetail: '全部引用文件均已就位',
  }),
  pack({
    name: 'saki_normal', pkg: 'com.sega.pjsk', motions: 8, expressions: 2,
    bytes: 14_889_779, bytesLabel: '14.2 MB', files: 26, status: 'complete', statusLabel: '完整', statusLevel: 'ok',
    statusDetail: '全部引用文件均已就位',
  }),
  pack({
    name: 'minori_normal', pkg: 'com.sega.pjsk', motions: 10, expressions: 6, missingCount: 2,
    bytes: 22_334_234, bytesLabel: '21.3 MB', files: 28, status: 'missing_texture', statusLabel: '缺纹理', statusLevel: 'error',
    statusDetail: '清单引用的纹理图集不存在：minori_normal.2048/texture_01.png；清单引用的纹理图集不存在：minori_normal.2048/texture_02.png',
  }),
  pack({
    name: 'haruka_normal', pkg: 'com.sega.pjsk', motions: 6, expressions: 2,
    bytes: 12_373_197, bytesLabel: '11.8 MB', files: 22, status: 'complete', statusLabel: '完整', statusLevel: 'ok',
    statusDetail: '全部引用文件均已就位',
  }),
  pack({
    name: 'shiho_normal', pkg: 'com.sega.pjsk', motions: 9, expressions: 3,
    bytes: 9_856_614, bytesLabel: '9.4 MB', files: 24, status: 'complete', statusLabel: '完整', statusLevel: 'ok',
    statusDetail: '全部引用文件均已就位',
  }),
  pack({
    name: 'honami_normal', pkg: 'com.sega.pjsk', motions: 0, expressions: 2,
    bytes: 7_549_798, bytesLabel: '7.2 MB', files: 9, status: 'no_motions', statusLabel: '无动作', statusLevel: 'warning',
    statusDetail: '包内没有动作文件（motions），导入后模型不会有任何动态',
  }),
];

/** 屏 3 侧栏计数。注意「无动作」为 1 —— 与列表里 honami_normal 的状态一致。 */
const COUNTS = { all: 6, complete: 4, incomplete: 1, noMotions: 1 };

const SCAN = {
  ok: true,
  elapsedMs: 4200,
  elapsedLabel: '4.2 秒',
  roots: ['/storage/emulated/0/Android/data', '/storage/emulated/0/Android/obb'],
  rootsRemoved: [],
  stats: {
    scannedFiles: 58_214,
    scannedFilesLabel: '58,214',
    matchedFiles: 214,
    containerCount: 0,
    encryptedCount: 0,
    orphanMoc3Count: 1,
  },
  counts: COUNTS,
  bySource: { 'com.sega.pjsk': 5, 'com.bilibili.azurlane': 1 },
  source: { serial: INSTANCE.serial, isRoot: true, androidRelease: '12', packageCount: 2 },
  packs: PACKS,
  containers: [],
  orphanMoc3: [`${SOURCE_DIR}/orphan/orphan.model3.moc3`],
  warnings: [],
  log: ['归一化扫描范围：/sdcard/Android/data → /storage/emulated/0/Android/data'],
};

/* ---------- 屏 2 · 扫描中 ---------- */

const PROGRESS = {
  phaseKey: 'traverse',
  phaseLabel: '遍历资源目录',
  phaseIndex: 3,
  phaseTotal: 5,
  phaseProgress: 0.64,
  percent: 64,
  currentDir: `${SOURCE_DIR}/`,
  scannedFiles: 8412,
  totalFiles: 13_140,
  matchedFiles: 214,
  packCount: 9,
  containerCount: 0,
  elapsedMs: 12_000,
  etaMs: 8000,
  message: '已统计目标规模：13,140 个文件',
  recentPacks: [
    { modelName: 'ichika_normal', motions: 12, expressions: 4, missing: 0, totalBytes: 19_503_513 },
    { modelName: 'saki_normal', motions: 8, expressions: 2, missing: 0, totalBytes: 14_889_779 },
  ],
};

const RECENT_PACKS = PROGRESS.recentPacks.map((rp) => ({
  modelName: rp.modelName,
  bytesLabel: rp.totalBytes > 18_000_000 ? '18.6 MB' : '14.2 MB',
  contentLabel: `${rp.motions} 动作 · ${rp.expressions} 表情`,
}));

/* ---------- 屏 4 · 导出完成 ---------- */

const TARGET_ROOT = 'D:\\Live2D\\pjsk_extract';

// 5 个包的字节数与文件数必须与 results 里逐包一致，否则侧栏汇总会和明细对不上：
// 19503513 + 14889779 + 12373197 + 9856614 + 22334234 = 78,957,337（75.3 MB）
// 31 + 26 + 22 + 24 + 26 = 129 个文件
const EXPORT_RESULT = {
  ok: true,
  targetRoot: `${TARGET_ROOT}\\com.sega.pjsk`,
  totals: { exported: 5, files: 129, bytes: 78_957_337, skipped: 0, failed: 0 },
  elapsedMs: 6800,
  results: [
    { packId: PACKS[0].id, modelName: 'ichika_normal', status: 'exported', targetDir: `${TARGET_ROOT}\\com.sega.pjsk\\ichika_normal`, bytesLabel: '18.6 MB', files: 31, failedFiles: [] },
    { packId: PACKS[1].id, modelName: 'saki_normal', status: 'exported', targetDir: `${TARGET_ROOT}\\com.sega.pjsk\\saki_normal`, bytesLabel: '14.2 MB', files: 26, failedFiles: [] },
    { packId: PACKS[3].id, modelName: 'haruka_normal', status: 'exported', targetDir: `${TARGET_ROOT}\\com.sega.pjsk\\haruka_normal`, bytesLabel: '11.8 MB', files: 22, failedFiles: [] },
    { packId: PACKS[4].id, modelName: 'shiho_normal', status: 'exported', targetDir: `${TARGET_ROOT}\\com.sega.pjsk\\shiho_normal`, bytesLabel: '9.4 MB', files: 24, failedFiles: [] },
    { packId: PACKS[2].id, modelName: 'minori_normal', status: 'partial', targetDir: `${TARGET_ROOT}\\com.sega.pjsk\\minori_normal`, bytesLabel: '21.3 MB', files: 26, reason: '缺纹理', failedFiles: [{ rel: 'minori_normal.2048/texture_01.png', reason: '源文件不存在' }] },
  ],
  entryPoints: [
    { packId: PACKS[0].id, modelName: 'ichika_normal', targetDir: `${TARGET_ROOT}\\com.sega.pjsk\\ichika_normal`, entryPath: `${TARGET_ROOT}\\com.sega.pjsk\\ichika_normal\\ichika_normal.model3.json`, status: 'exported' },
  ],
  failedFiles: [{ modelName: 'minori_normal', rel: 'minori_normal.2048/texture_01.png', reason: '源文件不存在' }],
  diagnosticsPath: `${TARGET_ROOT}\\com.sega.pjsk\\diagnostics.txt`,
  warnings: [{ code: 'EXPORTING_INCOMPLETE_PACK', message: 'minori_normal 状态为「缺纹理」，仍按你的勾选导出。' }],
};

/* ---------- 态 A · 扫描结果为空 ---------- */

const EMPTY_SCAN = {
  ...SCAN,
  packs: [],
  counts: { all: 0, complete: 0, incomplete: 0, noMotions: 0 },
  bySource: {},
  stats: { scannedFiles: 12_480, scannedFilesLabel: '12,480', matchedFiles: 0, containerCount: 3, encryptedCount: 1, orphanMoc3Count: 0 },
  containers: [
    { path: '/storage/emulated/0/Android/data/com.sega.pjsk/files_obb/main.obb', name: 'files_obb/main.obb', sizeLabel: '412 MB', kind: 'zip', label: '标准 zip', headerHex: '50 4B 03 04', extractable: true, unsupported: false, hint: '' },
    { path: '/storage/emulated/0/Android/data/com.sega.pjsk/files/cache/live2d.dat', name: 'files/cache/live2d.dat', sizeLabel: '86 MB', kind: 'unknown', label: '文件头未知', headerHex: '4C 32 00 01', extractable: false, unsupported: true, hint: '文件头不像常见的压缩或归档格式，可能是游戏自定义加密容器' },
    { path: '/storage/emulated/0/Android/data/com.sega.pjsk/files/assetbundle/live2d.ab', name: 'files/assetbundle/live2d.ab', sizeLabel: '204 MB', kind: 'unity3d', label: 'AssetBundle（UnityFS）', headerHex: '55 6E 69 74 79 46 53', extractable: false, unsupported: true, hint: 'AssetBundle 需要 UABE / AssetStudio 解析，本工具不处理' },
  ],
  warnings: [{ code: 'EMPTY_RESULT', message: '本次扫描未命中任何 .model3.json' }],
};

/* ---------- 态 B · 解包失败 ---------- */

const UNPACK_RESULT = {
  ok: true,
  aggregatedPacks: 12,
  diagnosticsName: 'diagnostics.txt',
  items: [
    { name: 'files_obb/main.obb', ok: false, reasonLabel: '未知压缩格式', reason: 'unknown_compression' },
    { name: 'files/cache/live2d.dat', ok: false, reasonLabel: '自定义加密头 0x4C32', reason: 'encrypted_header' },
    { name: 'files/live2d_pack.zip', ok: true, packCount: 12 },
  ],
};

module.exports = {
  INSTANCES,
  INSTANCE,
  ROOTS,
  SCAN,
  PROGRESS,
  RECENT_PACKS,
  EXPORT_RESULT,
  EMPTY_SCAN,
  UNPACK_RESULT,
  TARGET_ROOT,
};
