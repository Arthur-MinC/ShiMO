// 六屏渲染。严格对应设计稿：屏 1 连接模拟器 / 屏 2 扫描中 / 屏 3 扫描结果 /
// 屏 4 导出完成，以及异常与边界态的 态 A 扫描结果为空 / 态 B 解包失败。

import { esc, formatNumber, formatDuration, formatBytes, statusTagClass, checkIcon, warnIcon, searchIcon } from './util.js';

const PHASE_LABELS = ['探测模拟器实例', '拉取应用清单', '遍历资源目录', '聚合运行时包', '完整性校验'];

/**
 * 状态列的配色。
 *
 * 设计稿把「无动作 / 无表情」画成辅助灰而不是警告橙 —— 这类包能正常打开，
 * 只是少了动态，把它们和「缺纹理」染成同一个颜色会稀释警告色的含义。
 * 数据层仍然把无动作标为 warning（它确实默认不勾选），只在呈现上区分开。
 */
function packStatusClass(p) {
  if (p.status === 'complete') return 'status-tag status-tag--ok';
  if (p.status === 'no_motions' || p.status === 'no_expressions') return 'status-tag status-tag--muted';
  return statusTagClass(p.statusLevel);
}

/**
 * 实例的短名（模拟器本身，不含实例标识）。
 *
 * 检测器给出的 name 形如「MuMu 模拟器 · 127.0.0.1:16384」——把串号也塞了进去。
 * 侧栏一行放不下，而串号属于「点进去才需要确认」的细节。所以侧栏只留模拟器名，
 * 完整名字给主区标题。设计与这个信息分层一致。
 */
function shortInstanceName(inst) {
  if (!inst) return '';
  const raw = String(inst.name || '');
  const cut = raw.indexOf(' · ');
  return cut > 0 ? raw.slice(0, cut) : raw;
}

/**
 * 扫描范围的简称。
 *
 * 工具栏只有一行，把多个路径首尾相接会变成一串读不出重点的路径，还会把右侧按钮挤掉。
 * 取第一个 + 总数，用户扫一眼就知道「扫几处、从哪开始」。
 */
function scopeLabel(state) {
  const checked = (state.roots || []).filter((r) => r.checked).map((r) => r.path);
  const custom = (state.customPath || '').trim();
  const paths = custom ? [...checked, custom] : checked;
  if (paths.length === 0) return '未选择扫描范围';
  if (paths.length === 1) return paths[0];
  return `${paths[0]} 等 ${paths.length} 处`;
}

/* ============================================================
   屏 1 · 连接模拟器  （FR-01、FR-02）
   ============================================================ */

export function renderConnect(state) {
  const insts = state.instances || [];

  const sidebarItems = insts.length
    ? insts
        .map((inst) => {
          // 只用 id 判高亮。不能退回用 serial：未运行实例的 serial 是 null，
          // `null === null` 会让列表里所有未运行实例一起亮起来。
          const active = Boolean(state.selectedId) && inst.id === state.selectedId;
          const online = inst.running && inst.state === 'device';
          const rootLabel = online ? (inst.isRoot ? ' · root' : '') : '';
          const sub = online
            ? `运行中${inst.androidVersion ? ` · ${esc(inst.androidVersion)}` : ''}${rootLabel}`
            : `${esc(inst.stateLabel)}${inst.androidVersion ? ` · ${esc(inst.androidVersion)}` : ''}`;
          // 「未运行」是正常状态，不是异常 —— 用中性灰点。
          // 只有实例确实在跑、却处于不可用状态（未授权 / 掉线）才配得上警告色。
          const broken = inst.running && inst.state !== 'device';
          const dot = online ? 'dot--on' : broken ? 'dot--warn' : 'dot--off';
          return (
            `<button class="side-item${active ? ' is-active' : ''}" type="button" data-action="select-instance" data-id="${esc(inst.id)}">` +
            `<span class="side-item__body">` +
            `<span class="side-item__title">${esc(shortInstanceName(inst))}</span>` +
            `<span class="side-item__sub">${sub}</span>` +
            `</span>` +
            `<span class="dot ${dot}" aria-hidden="true"></span>` +
            `</button>`
          );
        })
        .join('')
    : `<div class="side-note">正在检测本机模拟器…</div>`;

  const sidebar =
    `<div class="side-title">模拟器</div>` +
    `<div class="side-section">${sidebarItems}</div>` +
    `<button class="side-add" type="button" data-action="manual-add">+ 手动添加模拟器路径</button>`;

  const inst = state.instance;
  let main;

  if (state.discovering && insts.length === 0) {
    main =
      `<div class="page-head"><h1 class="page-title">正在检测本机模拟器</h1>` +
      `<p class="page-sub">枚举进程、安装目录与 ADB 端口，无需手动填写任何路径。</p></div>` +
      `<div class="row-flex" style="gap:20px;color:var(--text-2)"><span class="spin"></span><span>请稍候…</span></div>`;
  } else if (!inst) {
    main =
      `<div class="page-head"><h1 class="page-title">未检测到可用的模拟器实例</h1>` +
      `<p class="page-sub">请确认模拟器软件已安装，并启动其中一个实例后重新检测。</p></div>` +
      `<div class="callout callout--warn">` +
      `<p style="margin:0 0 12px"><strong>驱动与权限提示</strong></p>` +
      `<p style="margin:0 0 8px">1. 模拟器需要在设置中开启「ADB 调试」或「开发者选项」。</p>` +
      `<p style="margin:0 0 8px">2. 若模拟器正在运行但仍未列出，可点「重新检测」；检测会同时扫描进程与安装目录。</p>` +
      `<p style="margin:0">3. 本工具只读访问模拟器文件系统，不会修改游戏安装目录内的任何内容。</p>` +
      `</div>` +
      `<div class="btn-row"><button class="btn btn--primary" type="button" data-action="rediscover">重新检测</button>` +
      `<button class="btn btn--ghost" type="button" data-action="cubism-detect">检测本机 Cubism Editor</button></div>`;
  } else {
    const online = inst.running && inst.state === 'device';
    const adbLine = [
      inst.adbAddress ? `ADB ${inst.adbAddress}` : `ADB ${inst.adbPath || '—'}`,
      inst.androidVersion,
      inst.isRoot ? '已 root' : '未提权（shell）',
      inst.abi ? inst.abi : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const rootChecks = (state.roots || [])
      .map(
        (r) =>
          `<div class="check-row" data-action="toggle-root" data-path="${esc(r.path)}" role="checkbox" aria-checked="${r.checked}">` +
          `<span class="check" aria-hidden="true"></span>` +
          `<span class="check-row__label">${esc(r.path)}</span>` +
          `</div>`
      )
      .join('');

    const rootNote = inst.needsAdbRoot
      ? `<div class="bullet-line bullet-line--warn"><span class="bullet-line__dot"></span>` +
        `<span>当前以 shell 身份连接。<code>/sdcard/Android/data</code> 下部分目录可能读不到内容，可尝试以 root 身份重连。</span></div>`
      : '';

    main =
      `<div class="page-head">` +
      `<h1 class="page-title">${esc(inst.name)}</h1>` +
      `<p class="page-sub">${esc(adbLine)}</p>` +
      `</div>` +
      `<div class="divider"></div>` +
      `<p class="field-label">扫描范围</p>` +
      rootChecks +
      `<div style="margin-top:24px">` +
      `<p class="field-label">其他路径（可选）</p>` +
      `<div class="field-row">` +
      `<input class="text-input" id="customRoot" type="text" placeholder="模拟器共享目录，例如 C:\\MuMuShared\\" value="${esc(state.customPath || '')}">` +
      `<button class="btn btn--ghost btn--sm" type="button" data-action="pick-shared-dir">浏览本机目录</button>` +
      `</div>` +
      `</div>` +
      rootNote +
      `<div class="btn-row">` +
      `<button class="btn btn--primary" type="button" data-action="start-scan" ${online ? '' : 'disabled'}>开始扫描</button>` +
      (inst.needsAdbRoot
        ? `<button class="btn btn--ghost" type="button" data-action="try-root">以 root 身份重连</button>`
        : '') +
      `<button class="btn btn--ghost" type="button" data-action="apps-list">从已安装应用中选择</button>` +
      `</div>` +
      (online ? '' : `<div class="callout callout--warn" style="margin-top:24px"><p style="margin:0">该实例当前<strong>${esc(inst.stateLabel)}</strong>。请先在模拟器中启动它，或改选其他运行中的实例。</p></div>`);
  }

  return {
    toolbar: {
      // 设计稿的工具栏显示「实例名 · 当前扫描路径」，而不是 ADB 地址 ——
      // 地址是技术细节，用户在确认的是「马上要扫哪里」。
      // 多选范围时只展示第一个并注明总数，避免把几个路径首尾拼成一行天书。
      pathText: inst ? `${shortInstanceName(inst)} · ${scopeLabel(state)}` : '未连接实例',
      pathMuted: !inst,
      btnText: '重新检测',
      btnAction: 'rediscover',
      // 设计稿里工具栏按钮一律是白底描边，主操作始终留在主区
      btnGhost: true,
      btnDisabled: state.discovering,
    },
    sidebar,
    main,
    status: {
      text: state.statusText || (insts.length ? `就绪 · 检测到 ${insts.length} 个模拟器` : '就绪 · 未检测到模拟器'),
      right: state.statusRight || '',
    },
  };
}

/* ============================================================
   屏 2 · 扫描中（进度态）  （FR-03）
   核心原则：用户判断程序是否卡死的唯一依据，是路径与计数在变化。
   ============================================================ */

export function renderScanning(state) {
  const p = state.progress || {};
  const phaseIndex = (p.phaseIndex || 1) - 1;

  const phases = PHASE_LABELS.map((label, i) => {
    const cls = i < phaseIndex ? 'phase phase--done' : i === phaseIndex ? 'phase phase--active' : 'phase';
    const ring = i < phaseIndex ? 'ring ring--done' : i === phaseIndex ? 'ring ring--active' : 'ring';
    const inner =
      i < phaseIndex
        ? `<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M7 13.4l4 4l8-9" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        : '';
    return `<div class="${cls}"><span class="phase__icon"><span class="${ring}">${inner}</span></span><span class="phase__label">${esc(label)}</span></div>`;
  }).join('');

  const sidebar =
    `<div class="side-title">扫描阶段</div>` +
    `<div class="phase-list"><div class="phase-list__rail"></div>${phases}</div>` +
    `<div class="side-divider"></div>` +
    `<div class="side-note">取消后已扫描的内容<br>不会写入磁盘。</div>`;

  const percent = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
  const eta = Number.isFinite(p.etaMs) && p.etaMs > 0 ? `预计剩余 ${formatDuration(p.etaMs)}` : '';
  const elapsed = formatDuration(p.elapsedMs || 0);
  const total = p.totalFiles !== null && p.totalFiles !== undefined ? formatNumber(p.totalFiles) : null;

  const recent = (state.recentPacks || [])
    .slice(-2)
    .map(
      (pk) =>
        `<div class="result-item">` +
        `<span class="bullet-line__dot" style="background:var(--accent);margin-top:0"></span>` +
        `<span class="result-item__text" style="font-weight:500">${esc(pk.modelName)}</span>` +
        `<span class="muted" style="font-size:var(--fs-aux)">${esc(pk.contentLabel)}</span>` +
        `<span class="muted" style="font-size:var(--fs-aux);min-width:110px;text-align:right">${esc(pk.bytesLabel)}</span>` +
        `</div>`
    )
    .join('');

  const main =
    `<div class="page-head">` +
    // 设计稿：主标题固定为「正在扫描资源目录」，当前阶段名放在副标题里
    `<h1 class="page-title">正在扫描资源目录</h1>` +
    `<p class="page-sub">${esc(state.instance ? state.instance.name : '')} · 阶段 ${p.phaseIndex || 1} / ${p.phaseTotal || 5}` +
    `${p.phaseLabel ? ` · ${esc(p.phaseLabel)}` : ''} · 已用时 ${elapsed}</p>` +
    `</div>` +
    `<div class="progress"><div class="progress__fill" style="width:${percent}%"></div></div>` +
    `<div class="progress-meta">` +
    `<span class="progress-meta__percent">${percent}%</span>` +
    `<span class="progress-meta__eta">${esc(eta)}</span>` +
    `</div>` +
    `<div class="divider"></div>` +
    `<p class="field-label">当前目录</p>` +
    `<p class="mono selectable" style="color:var(--text);margin:0 0 16px">${esc(p.currentDir || '—')}</p>` +
    `<p class="muted" style="margin:0">已扫描 ${formatNumber(p.scannedFiles || 0)}` +
    `${total ? ` / ${total}` : ''} 个文件 · ` +
    `匹配 ${formatNumber(p.matchedFiles || 0)} 个 · 已聚合 ${formatNumber(p.packCount || 0)} 个运行时包` +
    `${p.containerCount ? ` · 发现容器 ${p.containerCount} 个` : ''}</p>` +
    `<div class="divider"></div>` +
    `<div class="row-flex" style="justify-content:space-between;margin-bottom:8px">` +
    `<span class="field-label" style="margin:0">最近聚合</span>` +
    `<span class="muted-3" style="font-size:var(--fs-aux)">共 ${formatNumber(p.packCount || 0)} 个</span>` +
    `</div>` +
    (recent || `<p class="muted-3" style="font-size:var(--fs-aux);margin:8px 0 0">尚未聚合到运行时包</p>`);

  return {
    toolbar: {
      pathText: state.instance ? `${shortInstanceName(state.instance)} · ${scopeLabel(state)}` : '',
      btnText: '取消扫描',
      btnAction: 'cancel-scan',
      btnGhost: true,
    },
    sidebar,
    main,
    status: {
      text:
        `扫描中 · 已扫描 ${formatNumber(p.scannedFiles || 0)} 个文件 · ` +
        `已聚合 ${formatNumber(p.packCount || 0)} 个包 · 用时 ${elapsed}`,
      right: state.statusRight || '',
    },
  };
}

/* ============================================================
   屏 3 · 扫描结果  （FR-04、FR-05、FR-06）
   ============================================================ */

export function renderResults(state) {
  const scan = state.scan || { packs: [], counts: {}, bySource: {} };
  const counts = scan.counts || {};
  const filter = state.filter || 'all';

  const filters = [
    { key: 'all', label: '全部', count: counts.all || 0, warn: false },
    { key: 'complete', label: '完整', count: counts.complete || 0, warn: false },
    { key: 'incomplete', label: '缺文件', count: counts.incomplete || 0, warn: (counts.incomplete || 0) > 0 },
    { key: 'no_motions', label: '无动作', count: counts.noMotions || 0, warn: false },
  ];

  const filterHtml = filters
    .map(
      (f) =>
        `<button class="side-item${filter === f.key ? ' is-active' : ''}" type="button" data-action="set-filter" data-filter="${f.key}">` +
        `<span class="side-item__title">${esc(f.label)}</span>` +
        `<span class="side-item__count${f.warn ? ' is-warn' : ''}">${f.count}</span>` +
        `</button>`
    )
    .join('');

  const sources = Object.entries(scan.bySource || {}).sort((a, b) => b[1] - a[1]);
  const sourceHtml = sources.length
    ? sources
        .map(
          (entry) =>
            `<button class="side-item${filter === `src:${entry[0]}` ? ' is-active' : ''}" type="button" data-action="set-filter" data-filter="src:${esc(entry[0])}">` +
            `<span class="side-item__title" style="font-size:var(--fs-aux)">${esc(entry[0])}</span>` +
            `<span class="side-item__count">${entry[1]}</span>` +
            `</button>`
        )
        .join('')
    : `<div class="side-note">未识别到来源包名</div>`;

  const sidebar =
    `<div class="side-title">筛选</div>` +
    `<div class="side-section">${filterHtml}</div>` +
    `<div class="side-divider"></div>` +
    `<div class="side-title">来源</div>` +
    `<div class="side-section">${sourceHtml}</div>`;

  // 过滤后的列表
  const allPacks = scan.packs || [];
  const visible = allPacks.filter((p) => {
    if (filter === 'all') return true;
    if (filter === 'complete') return p.status === 'complete';
    if (filter === 'incomplete') return p.statusLevel === 'error';
    if (filter === 'no_motions') return p.status === 'no_motions';
    if (filter.startsWith('src:')) return p.sourcePackage === filter.slice(4);
    return true;
  });

  const rows = visible
    .map((p) => {
      const checked = state.selected.has(p.id);
      return (
        `<tr class="${checked ? 'is-selected' : ''}" data-action="toggle-pack" data-id="${esc(p.id)}">` +
        `<td class="col-check"><span class="check" role="checkbox" aria-checked="${checked}" tabindex="0"></span></td>` +
        `<td class="col-name">${esc(p.modelName)}</td>` +
        `<td class="col-content">${esc(p.contentLabel)}</td>` +
        `<td class="col-size">${esc(p.bytesLabel)}</td>` +
        `<td class="col-status"><span class="${packStatusClass(p)}" title="${esc(p.statusDetail)}">${esc(p.statusLabel)}</span></td>` +
        `</tr>`
      );
    })
    .join('');

  const table = visible.length
    ? `<table class="table">` +
      `<thead><tr>` +
      `<th class="col-check"></th><th class="col-name">模型</th><th class="col-content">内容</th>` +
      `<th class="col-size">体积</th><th class="col-status">状态</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted" style="padding:48px 0">当前筛选条件下没有模型包。</p>`;

  const selectedPacks = allPacks.filter((p) => state.selected.has(p.id));
  const selectedBytes = selectedPacks.reduce((s, p) => s + (p.totalBytes || 0), 0);
  const selectedLabel = `已选 ${selectedPacks.length} 个包 · ${formatBytes(selectedBytes)}`;

  const main =
    `<div class="scroll-area">${table}</div>` +
    `<div class="table-foot">` +
    `<span class="table-foot__sum">${esc(selectedLabel)}</span>` +
    `<div class="btn-row" style="margin:0">` +
    `<button class="btn btn--ghost btn--sm" type="button" data-action="select-complete">仅选完整包</button>` +
    `<button class="btn btn--primary" type="button" data-action="open-export" ${selectedPacks.length ? '' : 'disabled'}>导出…</button>` +
    `</div>` +
    `</div>`;

  return {
    toolbar: {
      pathText: state.instance ? `${shortInstanceName(state.instance)} · ${scopeLabel(state)}` : '',
      btnText: '重新扫描',
      btnAction: 'start-scan',
      btnGhost: true,
    },
    sidebar,
    main,
    status: {
      text: `扫描完成 · ${counts.all || 0} 个运行时包 · 耗时 ${scan.elapsedLabel || '—'}`,
      right: state.statusRight || '',
    },
  };
}

/* ============================================================
   屏 4 · 导出完成（FR-07、FR-08）
   ============================================================ */

export function renderDone(state) {
  const ex = state.exportResult || {};
  const totals = ex.totals || {};

  const entry = (ex.entryPoints || [])[0];
  const pathText = entry ? entry.targetDir : ex.targetRoot || '';

  const issues = collectExportIssues(state, ex);

  const sidebar =
    `<div class="side-title">本次导出</div>` +
    `<div class="side-stat"><span class="side-stat__big">${totals.exported || 0}</span>` +
    `<span class="side-stat__unit">个运行时包</span></div>` +
    `<div class="side-divider"></div>` +
    `<div class="side-kv"><span class="side-kv__k">文件</span><span class="side-kv__v">${formatNumber(totals.files || 0)}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">体积</span><span class="side-kv__v">${esc(formatBytes(totals.bytes))}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">耗时</span><span class="side-kv__v">${esc(formatDuration(ex.elapsedMs || 0))}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">跳过</span><span class="side-kv__v">${totals.skipped || 0}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">校验</span>` +
    `<span class="side-kv__v ${issues.warnCount > 0 ? 'is-warn' : 'is-ok'}">${issues.warnCount > 0 ? `${issues.warnCount} 项提示` : '全部通过'}</span></div>`;

  const issueHtml = issues.items.length
    ? issues.items
        .map(
          (i) =>
            `<div class="bullet-line ${i.level === 'warn' ? 'bullet-line--warn' : 'bullet-line--muted'}">` +
            `<span class="bullet-line__dot"></span><span>${esc(i.text)}</span></div>`
        )
        .join('')
    : `<div class="bullet-line bullet-line--ok"><span class="bullet-line__dot"></span><span>全部文件均已按原始目录结构写入。</span></div>`;

  const main =
    `<div class="done-badge">` +
    `<span class="done-badge__ring">${checkIcon(46, '#0F766E', 'transparent')}</span>` +
    `<div><h1 class="done-badge__title">导出完成</h1>` +
    `<p class="done-badge__sub">已写入磁盘，可直接用 Cubism Editor 打开</p></div>` +
    `</div>` +
    `<p class="field-label">保存位置</p>` +
    `<div class="path-row">` +
    `<span class="path-row__text selectable" title="${esc(pathText)}">${esc(pathText)}</span>` +
    `<button class="path-row__btn" type="button" data-action="copy-path" data-path="${esc(pathText)}">复制</button>` +
    `</div>` +
    `<div class="btn-row">` +
    `<button class="btn btn--primary" type="button" data-action="cubism-open">用 Cubism Editor 打开</button>` +
    `<button class="btn btn--ghost" type="button" data-action="open-folder" data-path="${esc(pathText)}">打开文件夹</button>` +
    `<button class="btn btn--ghost" type="button" data-action="copy-path" data-path="${esc(pathText)}">复制路径</button>` +
    `</div>` +
    `<div class="divider" style="margin-top:32px"></div>` +
    issueHtml +
    `<div class="bullet-line bullet-line--muted"><span class="bullet-line__dot"></span>` +
    `<span>在 Cubism Editor 里选择 <code>.model3.json</code>，不是 <code>.moc3</code></span></div>` +
    `<div class="bullet-line bullet-line--muted"><span class="bullet-line__dot"></span>` +
    `<span>导出目录中的 <code>manifest.txt</code> 记录了来源、校验结论与完整文件清单，可用于事后追溯</span></div>`;

  return {
    toolbar: {
      pathText: ex.targetRoot || '',
      btnText: '打开目录',
      btnAction: 'open-folder',
      btnGhost: true,
      btnData: { path: ex.targetRoot || '' },
    },
    sidebar,
    main,
    status: {
      text: `导出完成 · ${ex.targetRoot || ''}${issues.warnCount > 0 ? ` · ${issues.warnCount} 项提示` : ''}`,
      right: state.statusRight || '',
    },
  };
}

/**
 * 汇总导出完成页的提示项。
 *
 * 收敛规则是这一页的关键：一次导出可能有十几个包，如果逐包逐文件地列，
 * 提示区会变成一面墙，用户直接跳过 —— 那就等于没提示。所以：
 *   - 同属一个包的问题合并成一行（校验状态 + 写入失败的文件数）；
 *   - moc3 版本兼容性按「所需编辑器版本」分组，同类只出现一次并列出模型名。
 */
function collectExportIssues(state, ex) {
  const items = [];
  const packById = new Map(((state.scan && state.scan.packs) || []).map((p) => [p.id, p]));

  for (const r of ex.results || []) {
    if (r.status === 'skipped') {
      items.push({ level: 'muted', text: `「${r.modelName}」此前已导出完成，本次已跳过。` });
      continue;
    }
    const p = packById.get(r.packId);
    const bits = [];
    if (p && p.status !== 'complete') bits.push(`校验状态为「${p.statusLabel}」`);
    const failed = r.failedFiles || [];
    if (failed.length > 0) {
      bits.push(`${failed.length} 个文件未能写入（${failed[0].rel}：${failed[0].reason}）`);
    }
    if (bits.length > 0) {
      items.push({ level: 'warn', text: `「${r.modelName}」${bits.join('；')}，已在 manifest.txt 中标记。` });
    }
  }

  const compat = new Map();
  for (const p of (state.scan && state.scan.packs) || []) {
    if (!state.selected.has(p.id) || !p.moc3Compat) continue;
    const minEditor = p.moc3Compat.minEditor;
    if (!minEditor || minEditor === 'Cubism 3.0') continue;
    const key = `${p.moc3Compat.label}|${minEditor}`;
    if (!compat.has(key)) compat.set(key, { label: p.moc3Compat.label, minEditor, names: [] });
    compat.get(key).names.push(p.modelName);
  }
  for (const g of compat.values()) {
    items.push({
      level: 'warn',
      text:
        `${g.names.length} 个模型为 ${g.label}，需要 ${g.minEditor} 或更高版本才能打开` +
        `（${g.names.join('、')}）。旧版编辑器会直接拒绝加载且不给出可读原因。`,
    });
  }

  return { items, warnCount: items.filter((i) => i.level === 'warn').length };
}

/* ============================================================
   态 A · 扫描结果为空  （FR-10 E-01 / 决策 8）
   最坏的设计是给一张空表格 —— 用户唯一的结论会是「软件坏了」。
   这一页承担诊断职责：说清扫到了什么、为什么没命中、下一步能做什么。
   ============================================================ */

export function renderEmpty(state) {
  const scan = state.scan || {};
  const stats = scan.stats || {};
  const containers = scan.containers || [];
  const encrypted = stats.encryptedCount || 0;

  const sidebar =
    `<div class="side-title">本次扫描</div>` +
    `<div class="side-stat"><span class="side-stat__big is-muted">0</span>` +
    `<span class="side-stat__unit">个运行时包</span></div>` +
    `<div class="side-divider"></div>` +
    `<div class="side-kv"><span class="side-kv__k">扫描文件</span><span class="side-kv__v">${esc(stats.scannedFilesLabel || '0')}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">明文命中</span><span class="side-kv__v">0</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">压缩容器</span>` +
    `<span class="side-kv__v ${containers.length ? 'is-warn' : ''}">${containers.length}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">疑似加密</span>` +
    `<span class="side-kv__v ${encrypted ? 'is-warn' : ''}">${encrypted}</span></div>` +
    `<div class="side-divider"></div>` +
    `<div class="side-note">扫描仅读取文件，<br>未做任何修改。</div>`;

  // 本屏的结论就是「一个都没命中」，清单里每一项都是这个结论的原因，
  // 所以设计稿把容器行一律画成警示色 —— 没有哪一项是「好的」。
  //
  // 文件头字节不放在行内：它会把行撑到折行（`文件头 55 6E` 被切成两行），
  // 而这一屏装不下多出来的高度。这些字节在诊断报告里是逐项完整记录的
  // （见 exporter 的 [发现的资源容器]），行上留 title 供悬停查看即可。
  const containerList = containers.length
    ? containers
        .map(
          (c) =>
            `<div class="bullet-line bullet-line--warn"${c.headerHex ? ` title="文件头 ${esc(c.headerHex)}"` : ''}>` +
            `<span class="bullet-line__dot"></span>` +
            `<span><code>${esc(c.name)}</code>  ·  ${esc(c.sizeLabel)}  ·  ${esc(c.label)}</span>` +
            `</div>`
        )
        .join('') +
      `<div class="bullet-line bullet-line--muted"><span class="bullet-line__dot"></span>` +
      `<span>以上容器均不含明文 <code>.model3.json</code>，这是本次命中数为 0 的直接原因。</span></div>`
    : `<div class="bullet-line bullet-line--muted"><span class="bullet-line__dot"></span><span>未发现压缩容器，目标目录中也没有 Live2D 相关文件。</span></div>`;

  const extractable = containers.filter((c) => c.extractable && c.kind === 'zip');
  const unsupported = containers.filter((c) => c.unsupported);

  // 照设计稿压缩到两行：异常态一屏里还要放下清单和三个按钮，
  // 能力边界用一两句话说完就够，把篇幅留给「为什么没命中」。
  const boundary =
    `<div class="callout callout--warn">` +
    `<p style="margin:0 0 8px" class="callout__warn-line">` +
    `${extractable.length ? `${extractable.length} 个标准 zip / obb 容器可自动解包；` : ''}` +
    `${unsupported.length ? `${unsupported.length} 个容器本工具暂不支持。` : (extractable.length ? '' : '未发现可自动解包的容器。')}</p>` +
    `<p style="margin:0">解包后重新扫描，或更换目录确认游戏是否使用 Live2D。` +
    `能力边界仅限明文资源与标准 zip / obb，<strong>不内置任何解密算法</strong>。</p>` +
    `</div>`;

  const main =
    `<div class="done-badge">` +
    `<span class="empty-icon">${searchIcon(34)}</span>` +
    `<div><h1 class="done-badge__title">未找到可用的运行时包</h1>` +
    `<p class="done-badge__sub">明文扫描 ${esc(stats.scannedFilesLabel || '0')} 个文件，未命中任何 .model3.json</p></div>` +
    `</div>` +
    `<div class="divider"></div>` +
    `<div class="row-flex" style="justify-content:space-between;margin-bottom:12px">` +
    `<span class="field-label" style="margin:0">已发现的资源容器</span>` +
    `<span class="muted-3" style="font-size:var(--fs-aux)">${containers.length} 项</span>` +
    `</div>` +
    containerList +
    `<div style="margin-top:24px">${boundary}</div>` +
    `<div class="btn-row btn-row--sticky">` +
    `<button class="btn btn--primary" type="button" data-action="try-unpack" ${extractable.length ? '' : 'disabled'}>尝试解包压缩资源</button>` +
    `<button class="btn btn--ghost" type="button" data-action="change-roots">更换扫描目录</button>` +
    `<button class="btn btn--ghost" type="button" data-action="view-log">查看扫描日志</button>` +
    `</div>`;

  return {
    toolbar: {
      pathText: state.instance ? `${shortInstanceName(state.instance)} · ${scopeLabel(state)}` : '',
      btnText: '重新扫描',
      btnAction: 'start-scan',
      btnGhost: true,
    },
    sidebar,
    main,
    status: {
      text:
        `扫描完成 · ${esc(stats.scannedFilesLabel || '0')} 个文件 · 明文命中 0 · ` +
        `压缩容器 ${containers.length} · 加密容器 ${encrypted}`,
      textClass: 'is-warn',
      right: state.statusRight || '',
    },
  };
}

/* ============================================================
   态 B · 解包失败  （FR-09、FR-10 E-02 / 决策 9）
   主按钮是「用已解包内容继续」，不是「重试」——
   加密容器重试一百次还是解不开，而成功解出的那部分才是用户的真实收益。
   ============================================================ */

export function renderUnpackFail(state) {
  const u = state.unpackResult || {};
  const items = u.items || [];
  const failed = items.filter((i) => !i.ok);
  const succeeded = items.filter((i) => i.ok);
  const aggregated = u.aggregatedPacks || 0;

  const sidebar =
    `<div class="side-title">解包任务</div>` +
    `<div class="side-stat"><span class="side-stat__big is-warn">${failed.length}</span>` +
    `<span class="side-stat__unit">项失败</span></div>` +
    `<div class="side-divider"></div>` +
    `<div class="side-kv"><span class="side-kv__k">尝试</span><span class="side-kv__v">${items.length}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">成功</span><span class="side-kv__v is-ok">${succeeded.length}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">失败</span><span class="side-kv__v is-warn">${failed.length}</span></div>` +
    `<div class="side-kv"><span class="side-kv__k">已聚合</span><span class="side-kv__v">${aggregated}</span></div>` +
    `<div class="side-divider"></div>` +
    `<div class="side-note">诊断报告已保存至<br>${esc(u.diagnosticsName || 'diagnostics.txt')}</div>`;

  const rows = items
    .map((item) => {
      const icon = item.ok
        ? `<span class="result-item__icon result-item__icon--ok">` +
          `<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path d="M7 13.4l4 4l8-9" fill="none" stroke="#FFFFFF" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`
        : `<span class="result-item__icon result-item__icon--warn">!</span>`;
      const status = item.ok ? `成功 · 聚合 ${item.packCount || 0} 个包` : `失败 · ${item.reasonLabel}`;
      return (
        `<div class="result-item ${item.ok ? 'result-item--ok' : ''}">` +
        icon +
        `<span class="result-item__text">${esc(item.name)}</span>` +
        `<span class="result-item__status">${esc(status)}</span>` +
        `</div>`
      );
    })
    .join('');

  const main =
    `<div class="done-badge">` +
    `<span class="done-badge__ring done-badge__ring--warn">${warnIcon(38)}</span>` +
    `<div><h1 class="done-badge__title">解包失败</h1>` +
    `<p class="done-badge__sub">${items.length} 个资源容器中 ${succeeded.length} 个成功，${failed.length} 个无法处理</p></div>` +
    `</div>` +
    `<div class="divider"></div>` +
    `<div class="row-flex" style="justify-content:space-between;margin-bottom:12px">` +
    `<span class="field-label" style="margin:0">处理结果</span>` +
    `<span class="muted-3" style="font-size:var(--fs-aux)">${items.length} 项</span>` +
    `</div>` +
    `<div class="result-list">${rows || '<p class="muted">没有可处理的容器。</p>'}</div>` +
    `<div style="margin-top:24px">` +
    `<div class="bullet-line bullet-line--muted"><span class="bullet-line__dot"></span>` +
    `<span>失败原因：容器不是标准 zip 结构，或文件头为游戏自定义加密。</span></div>` +
    `<div class="bullet-line bullet-line--muted"><span class="bullet-line__dot"></span>` +
    `<span>本工具支持明文资源与标准 zip / obb；上两项已写入诊断报告。</span></div>` +
    `</div>` +
    `<div class="btn-row btn-row--sticky">` +
    `<button class="btn btn--primary" type="button" data-action="continue-with-unpacked" ${aggregated ? '' : 'disabled'}>用已解包内容继续</button>` +
    `<button class="btn btn--ghost" type="button" data-action="view-log">查看日志</button>` +
    `<button class="btn btn--ghost" type="button" data-action="copy-diagnostics">复制诊断</button>` +
    `</div>`;

  return {
    toolbar: {
      pathText: state.instance ? `${shortInstanceName(state.instance)} · 资源容器` : '',
      btnText: '重新解包',
      btnAction: 'try-unpack',
      btnGhost: true,
    },
    sidebar,
    main,
    status: {
      text: `解包完成 · ${succeeded.length} 成功 / ${failed.length} 失败 · 诊断信息可复制`,
      textClass: failed.length ? 'is-warn' : '',
      right: state.statusRight || '',
    },
  };
}

export const SCREEN_RENDERERS = {
  connect: renderConnect,
  scanning: renderScanning,
  results: renderResults,
  done: renderDone,
  empty: renderEmpty,
  unpackFail: renderUnpackFail,
};
