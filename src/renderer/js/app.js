// 应用入口：状态机、事件绑定、IPC 编排

import { SCREEN_RENDERERS } from './screens.js';
import { toast, openModal, closeModal, esc, formatBytes } from './util.js';

const api = window.shimo;

const state = {
  screen: 'connect',
  discovering: false,
  instances: [],
  selectedId: null,
  selectedSerial: null,
  instance: null,
  roots: [],
  customPath: '',
  progress: null,
  recentPacks: [],
  scan: null,
  filter: 'all',
  selected: new Set(),
  exportResult: null,
  unpackResult: null,
  cubism: null,
  adbLabel: '',
  statusText: '',
  statusRight: '',
  busy: false,
};

/* ============================================================
   渲染
   ============================================================ */

function currentRenderer() {
  return SCREEN_RENDERERS[state.screen] || SCREEN_RENDERERS.connect;
}

function render() {
  const view = currentRenderer()(state);

  const pathbox = document.getElementById('pathbox');
  const pathText = document.getElementById('pathboxText');
  pathText.textContent = view.toolbar.pathText || '';
  pathbox.className = 'pathbox' + (view.toolbar.pathMuted ? ' pathbox--muted' : '') + (view.toolbar.pathWarn ? ' pathbox--warn' : '');
  pathbox.title = view.toolbar.pathText || '';

  const btn = document.getElementById('toolbarBtn');
  btn.textContent = view.toolbar.btnText;
  btn.dataset.action = view.toolbar.btnAction || '';
  btn.dataset.path = (view.toolbar.btnData && view.toolbar.btnData.path) || '';
  btn.className = 'btn ' + (view.toolbar.btnGhost ? 'btn--ghost' : 'btn--primary');
  btn.disabled = Boolean(view.toolbar.btnDisabled);

  document.getElementById('sidebar').innerHTML = view.sidebar;
  document.getElementById('main').innerHTML = view.main;

  const statusText = document.getElementById('statusText');
  statusText.textContent = view.status.text || '';
  statusText.className = 'statusbar__text' + (view.status.textClass ? ` ${view.status.textClass}` : '');
  document.getElementById('statusRight').textContent = view.status.right || state.adbLabel || '';
}

function setScreen(screen) {
  state.screen = screen;
  render();
}

/** 局部更新：勾选包时只改相关行，不重建整个主区（否则会丢滚动位置）。 */
function refreshSelectionUi() {
  const allPacks = (state.scan && state.scan.packs) || [];
  const selectedPacks = allPacks.filter((p) => state.selected.has(p.id));
  const total = selectedPacks.reduce((s, p) => s + (p.totalBytes || 0), 0);

  const sum = document.querySelector('.table-foot__sum');
  if (sum) sum.textContent = `已选 ${selectedPacks.length} 个包 · ${formatBytes(total)}`;

  const exportBtn = document.querySelector('[data-action="open-export"]');
  if (exportBtn) exportBtn.disabled = selectedPacks.length === 0;

  document.querySelectorAll('tr[data-action="toggle-pack"]').forEach((tr) => {
    const id = tr.dataset.id;
    const on = state.selected.has(id);
    tr.classList.toggle('is-selected', on);
    const check = tr.querySelector('.check');
    if (check) check.setAttribute('aria-checked', String(on));
  });
}

/* ============================================================
   启动
   ============================================================ */

async function boot() {
  bindGlobalEvents();

  const info = await api.app.info();
  if (info && info.ok) {
    const defaults = info.defaultRoots || [];
    // 归一化在主进程完成（别名折叠 + 父子目录去重）。这里必须 await ——
    // 少写一个 await 拿到的是 Promise，`r.ok` 恒为 undefined，去重结果被静默丢弃。
    const r = await api.paths.normalize(defaults);
    const roots = r && r.ok ? r.roots : defaults;
    state.roots = roots.map((p) => ({ path: p, checked: true }));
    if (r && r.ok && (r.removed || []).length > 0) state.rootsRemoved = r.removed;
  }

  render();
  await discover();
}

async function discover() {
  state.discovering = true;
  state.statusText = '正在检测本机模拟器…';
  render();

  const res = await api.emulator.discover({});
  state.discovering = false;

  if (!res || !res.ok) {
    state.statusText = `检测失败：${(res && res.message) || '未知原因'}`;
    state.instances = [];
    render();
    return;
  }

  state.instances = res.instances || [];
  state.selectedSerial = res.selectedSerial || null;
  state.selectedId = res.selectedId || null;
  // 用 id 认实例：未运行实例的 serial 是 null，`find(i => i.serial === null)`
  // 会命中列表里第一个未运行实例，把它渲染成「当前选中」—— 用户于是看到
  // 一个没在跑的实例详情，还被要求去启动它，而真正在跑的那个反倒没被选上。
  state.instance = state.selectedId ? state.instances.find((i) => i.id === state.selectedId) || null : null;

  const report = (res.adbReports || []).find((r) => r.deviceCount > 0) || (res.adbReports || [])[0];
  if (report) {
    const name = String(report.adbPath || '').split(/[\\/]/).pop();
    state.adbLabel = `ADB ${name} ${report.version || ''}`.trim() + (report.serverKilled ? '（本次已重启 ADB 服务）' : '');
  }

  // 检测到 Cubism Editor 与否会影响屏 4 的降级表现，这里先探一次
  api.cubism.detect({}).then((c) => {
    if (c && c.ok) state.cubism = c;
  });

  if ((res.warnings || []).length > 0) {
    const first = res.warnings[0];
    if (first.code === 'NO_EMULATOR_FOUND') {
      state.statusText = first.message;
    } else if (first.code !== 'INSTALL_DIRS_REJECTED') {
      toast(first.message, 'warn');
    }
  }

  if (state.instances.length > 0 && !state.statusText.startsWith('检测失败')) {
    const running = state.instances.filter((i) => i.running).length;
    state.statusText = `就绪 · 检测到 ${state.instances.length} 个模拟器${running ? ` · ${running} 个运行中` : ''}`;
  }

  render();
}

/* ============================================================
   扫描
   ============================================================ */

function collectRoots() {
  const roots = state.roots.filter((r) => r.checked).map((r) => r.path);
  const custom = (state.customPath || '').trim();
  if (custom) roots.push(custom);
  return roots;
}

async function startScan() {
  const roots = collectRoots();
  if (roots.length === 0) {
    toast('请至少选择一个扫描范围。', 'warn');
    return;
  }

  state.progress = {
    phaseIndex: 1,
    phaseLabel: '探测模拟器实例',
    percent: 0,
    currentDir: '',
    scannedFiles: 0,
    matchedFiles: 0,
    packCount: 0,
    elapsedMs: 0,
    etaMs: null,
  };
  state.recentPacks = [];
  state.scanRootsLabel = roots.join('  ');
  state.statusText = '扫描中…';
  setScreen('scanning');

  const res = await api.scan.start({ roots });

  if (!res || !res.ok) {
    toast((res && res.message) || '扫描失败', 'warn');
    setScreen('connect');
    await discover();
    return;
  }

  if (res.cancelled) {
    toast('已取消扫描。已扫描的内容没有写入磁盘。');
    state.statusText = '已取消扫描 · 未写入任何文件';
    setScreen('connect');
    render();
    return;
  }

  applyScanResult(res.result);
}

function applyScanResult(scan) {
  state.scan = scan;
  state.filter = 'all';
  state.selected = new Set();

  // FR-06 验收点：完整包默认勾选，残留包默认不勾选
  for (const p of scan.packs || []) {
    if (p.defaultChecked) state.selected.add(p.id);
  }

  if ((scan.packs || []).length === 0) {
    state.statusText = '扫描完成 · 未命中任何运行时包';
    setScreen('empty');
  } else {
    state.statusText = `扫描完成 · ${scan.packs.length} 个运行时包 · 耗时 ${scan.elapsedLabel}`;
    setScreen('results');
  }

  for (const w of scan.warnings || []) {
    if (w.code === 'EMPTY_RESULT') continue;
    if (w.code === 'NOT_ROOT') continue; // 已在界面以提示行呈现
    toast(w.message, 'warn');
  }
}

/* ============================================================
   导出
   ============================================================ */

async function openExportDialog() {
  const packIds = [...state.selected];
  if (packIds.length === 0) {
    toast('请先勾选要导出的模型包。', 'warn');
    return;
  }

  const preview = await api.exportPacks.preview({ packIds });
  if (!preview || !preview.ok) {
    toast((preview && preview.message) || '无法准备导出。', 'warn');
    return;
  }

  const rows = preview.packs
    .map(
      (p) =>
        `<div class="result-item">` +
        `<span class="result-item__text">${esc(p.modelName)}</span>` +
        `<span class="muted" style="font-size:var(--fs-aux)">${p.files} 个文件</span>` +
        `<span class="muted" style="font-size:var(--fs-aux);min-width:110px;text-align:right">${esc(p.bytesLabel)}</span>` +
        `<span class="${p.statusLevel === 'ok' ? 'status-tag--ok' : 'status-tag--warn'}" style="min-width:100px;text-align:right;font-size:var(--fs-aux)">${esc(p.statusLabel)}</span>` +
        `</div>`
    )
    .join('');

  const spaceLine = preview.space
    ? `<p style="margin:12px 0 0">目标磁盘可用空间 <strong>${esc(preview.space.freeLabel)}</strong>，本次需要约 <strong>${esc(preview.estimateLabel)}</strong>。</p>`
    : `<p style="margin:12px 0 0" class="callout__warn-line">无法读取目标磁盘可用空间，请自行确认容量充足。</p>`;

  const body =
    `<p class="field-label" style="margin-bottom:12px">导出内容</p>` +
    `<div class="result-list">${rows}</div>` +
    `<p style="margin:20px 0 0">导出位置 <strong class="selectable">${esc(preview.targetRoot)}</strong></p>` +
    spaceLine +
    `<p style="margin:16px 0 0" class="muted-3" style="font-size:var(--fs-status)">导出后每个模型目录下会生成 manifest.txt，记录来源、校验结论与完整文件清单。</p>`;

  openModal({
    title: `导出 ${preview.packs.length} 个运行时包`,
    sub: `合计 ${preview.estimateLabel} · ${preview.estimate.files} 个文件`,
    body,
    actions: [
      { label: '更改位置', action: 'change-target', close: false },
      { label: '取消', action: 'cancel' },
      { label: '开始导出', action: 'confirm-export', kind: 'primary', close: false },
    ],
    async onAction(action) {
      if (action === 'change-target') {
        const picked = await api.system.pickDirectory({ title: '选择导出位置', defaultPath: preview.targetRoot });
        if (picked && picked.ok && !picked.canceled) {
          await api.system.updateSettings({ targetRoot: picked.path });
          closeModal();
          await openExportDialog();
        }
        return;
      }
      if (action === 'confirm-export') {
        await runExport(preview.targetRoot, packIds);
      }
    },
  });
}

async function runExport(targetRoot, packIds) {
  closeModal();

  state.statusText = '正在导出…';
  state.exportResult = null;
  render();

  const unsub = api.exportPacks.onProgress((p) => {
    state.statusText = `正在导出 ${p.modelName}（${p.index + 1}/${p.total}）`;
    render();
  });

  const res = await api.exportPacks.run({ targetRoot, packIds, overwrite: false });
  unsub();

  if (!res || !res.ok) {
    if (res && res.error === 'insufficient_space') {
      openModal({
        title: '磁盘空间不足',
        body:
          `<p style="margin:0 0 12px">${esc(res.message)}</p>` +
          `<p style="margin:0" class="muted">导出已在写入前被拦截，磁盘上没有任何残留文件。</p>`,
        actions: [
          { label: '更改位置', action: 'retry-change', close: false },
          { label: '知道了', action: 'close' },
        ],
        async onAction(action) {
          if (action === 'retry-change') {
            const picked = await api.system.pickDirectory({ title: '选择导出位置', defaultPath: targetRoot });
            if (picked && picked.ok && !picked.canceled) {
              await api.system.updateSettings({ targetRoot: picked.path });
              closeModal();
              await runExport(picked.path, packIds);
            }
          }
        },
      });
      state.statusText = '导出被拦截：磁盘空间不足';
      render();
      return;
    }
    toast((res && res.message) || '导出失败', 'warn');
    state.statusText = '导出失败';
    setScreen('results');
    return;
  }

  state.exportResult = res;
  state.statusText = `导出完成 · ${res.targetRoot}`;
  setScreen('done');

  for (const w of res.warnings || []) {
    if (w.code === 'EXPORTING_INCOMPLETE_PACK') toast(w.message, 'warn');
  }
}

/* ============================================================
   解包（FR-09）
   ============================================================ */

async function tryUnpack() {
  state.busy = true;
  state.statusText = '正在尝试解包资源容器…';
  render();

  const unsub = api.unpack.onProgress((p) => {
    state.statusText = p.done ? '正在整理解包结果…' : `正在解包 ${p.name}（${p.index + 1}/${p.total}）`;
    render();
  });

  const res = await api.unpack.run();
  unsub();
  state.busy = false;

  if (!res || !res.ok) {
    toast((res && res.message) || '解包流程无法启动。', 'warn');
    state.statusText = '解包未执行';
    render();
    return;
  }

  state.unpackResult = res;
  if (res.result) state.scan = res.result;

  const failed = (res.items || []).filter((i) => !i.ok);

  // 全部成功就没必要看失败页 —— 直接进结果页，别让用户白点一次
  if (failed.length === 0) {
    state.statusText = `解包完成 · 聚合 ${res.aggregatedPacks} 个运行时包`;
    toast(`解包成功，已聚合 ${res.aggregatedPacks} 个运行时包。`, 'ok');
    applyScanResult(res.result);
    return;
  }

  const succeeded = (res.items || []).length - failed.length;
  state.statusText = `解包完成 · ${succeeded} 成功 / ${failed.length} 失败`;
  setScreen('unpackFail');
}

function continueWithUnpacked() {
  // 解包成功的内容已在主进程并入会话结果，这里直接用返回的投影
  const merged = state.unpackResult && state.unpackResult.result;
  if (merged && (merged.packs || []).length > 0) {
    applyScanResult(merged);
    toast('已用解包内容继续。', 'ok');
    return;
  }
  if (state.scan && (state.scan.packs || []).length > 0) {
    applyScanResult(state.scan);
    return;
  }
  toast('解包内容中没有可用的运行时包。', 'warn');
}

/* ============================================================
   日志 / 诊断
   ============================================================ */

function viewLog() {
  const scan = state.scan || {};
  const lines = [];
  lines.push('===== 扫描日志 =====');
  lines.push(`扫描范围：${(scan.roots || []).join('、')}`);
  lines.push(`扫描文件：${(scan.stats && scan.stats.scannedFiles) || 0}`);
  lines.push(`相关文件：${(scan.stats && scan.stats.matchedFiles) || 0}`);
  lines.push(`聚合包数：${(scan.packs || []).length}`);
  lines.push('');
  lines.push('----- 警告 -----');
  for (const w of scan.warnings || []) lines.push(`· ${w.message}`);
  lines.push('');
  lines.push('----- 处理记录 -----');
  for (const l of scan.log || []) lines.push(`· ${l}`);
  if ((scan.orphanMoc3 || []).length) {
    lines.push('');
    lines.push('----- 孤立 .moc3（无法打开，未进结果列表）-----');
    for (const p of scan.orphanMoc3) lines.push(`· ${p}`);
  }
  if (state.scan && scan.rootsRemoved && scan.rootsRemoved.length) {
    lines.push('');
    lines.push('----- 扫描范围去重 -----');
    for (const r of scan.rootsRemoved) lines.push(`· ${r.path} —— ${r.reason}`);
  }

  openModal({
    title: '扫描日志',
    sub: '仅记录本次扫描过程中的判断与警告，可整段复制用于排查。',
    body: `<pre class="text-view">${esc(lines.join('\n'))}</pre>`,
    actions: [
      { label: '复制全部', action: 'copy-log', close: false },
      { label: '关闭', action: 'close' },
    ],
    async onAction(action) {
      if (action === 'copy-log') {
        const r = await api.system.copy(lines.join('\n'));
        if (r && r.ok) toast('日志已复制到剪贴板。', 'ok');
      }
    },
  });
}

async function copyDiagnostics() {
  const r = await api.diagnostics.copy();
  if (r && r.ok) toast('诊断报告已复制到剪贴板。', 'ok');
  else toast((r && r.message) || '无法生成诊断报告。', 'warn');
}

/* ============================================================
   事件
   ============================================================ */

function bindGlobalEvents() {
  // 窗口控制
  document.querySelectorAll('[data-win]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.win;
      if (kind === 'minimize') api.window.minimize();
      else if (kind === 'maximize') api.window.toggleMaximize();
      else if (kind === 'close') api.window.close();
    });
  });

  // 扫描进度（主进程推送）
  api.scan.onProgress((p) => {
    state.progress = p;
    // 「最近聚合」列表：进度页要让用户看见包在往外冒，只给百分比是不够的
    if (Array.isArray(p.recentPacks) && p.recentPacks.length > 0) {
      state.recentPacks = p.recentPacks.map((rp) => ({
        modelName: rp.modelName,
        bytesLabel: formatBytes(rp.totalBytes),
        contentLabel: `${rp.motions} 动作 · ${rp.expressions} 表情`,
      }));
    }
    if (state.screen === 'scanning') render();
  });

  // 主区事件委托
  document.body.addEventListener('click', onActionClick);
  document.body.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const target = ev.target.closest('[data-action]');
    if (target && target.tagName !== 'BUTTON' && target.classList.contains('check-row')) {
      ev.preventDefault();
      target.click();
    }
  });

  // 自定义路径输入：失焦时保存，避免切屏丢失
  document.body.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'customRoot') state.customPath = ev.target.value;
  });
}

async function onActionClick(ev) {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  if (el.disabled) return;
  const action = el.dataset.action;

  switch (action) {
    case 'rediscover':
      await api.system.resetSession();
      await discover();
      break;

    case 'select-instance': {
      const inst = state.instances.find((i) => i.id === el.dataset.id);
      if (!inst) break;
      if (!inst.running) {
        openModal({
          title: `${inst.name} 未运行`,
          body:
            `<p style="margin:0 0 12px">该实例当前<strong>${esc(inst.stateLabel)}</strong>，无法通过 ADB 访问。ADB 通道要求实例处于运行状态。</p>` +
            `<p style="margin:0" class="muted">请先在模拟器中启动它。若它由多开器创建，请打开多开器后启动对应实例。</p>`,
          actions: [{ label: '知道了', action: 'close' }],
        });
        break;
      }
      // 传 id 而不是 serial：未运行实例的 serial 是 null，主进程按 serial 找会
      // 命中另一个（序列也是 null 的）实例 —— 多开时必然连错对象
      const res = await api.emulator.connect({ id: inst.id, serial: inst.serial, adbPath: inst.adbPath });
      if (res && res.ok) {
        state.instance = res.instance;
        state.selectedId = inst.id;
        state.selectedSerial = inst.serial;
        state.statusText = `已连接 ${inst.name}`;
      } else {
        toast((res && res.message) || '连接失败', 'warn');
      }
      render();
      break;
    }

    case 'manual-add':
      openModal({
        title: '手动添加模拟器路径',
        sub: '选择模拟器的安装目录，工具会从中寻找自带 adb 并探测实例。',
        body:
          `<p class="muted" style="margin:0 0 16px">常见位置：MuMu 为 <code>…\\MuMuPlayer-12.0</code>，` +
          `雷电为 <code>…\\LDPlayer9</code>，夜神为 <code>…\\Nox</code>。</p>`,
        actions: [
          { label: '取消', action: 'cancel' },
          { label: '选择目录', action: 'pick', kind: 'primary', close: false },
        ],
        async onAction(a) {
          if (a !== 'pick') return;
          const picked = await api.system.pickDirectory({ title: '选择模拟器安装目录' });
          if (!picked || !picked.ok || picked.canceled) return;
          closeModal();
          toast(`已记录路径：${picked.path}。请点「重新检测」让工具扫描该目录。`, 'ok');
        },
      });
      break;

    case 'toggle-root': {
      const path = el.dataset.path;
      const item = state.roots.find((r) => r.path === path);
      if (!item) break;
      item.checked = !item.checked;
      el.setAttribute('aria-checked', String(item.checked));
      break;
    }

    case 'pick-shared-dir': {
      const picked = await api.system.pickDirectory({ title: '选择本机共享目录' });
      if (picked && picked.ok && !picked.canceled) {
        state.customPath = picked.path;
        const input = document.getElementById('customRoot');
        if (input) input.value = picked.path;
      }
      break;
    }

    case 'start-scan': {
      if (state.screen !== 'connect') {
        setScreen('connect');
        await new Promise((r) => setTimeout(r, 0));
      }
      await startScan();
      break;
    }

    case 'try-root': {
      const res = await api.emulator.tryRoot();
      toast((res && res.message) || '已请求提权。', res && res.granted ? 'ok' : 'warn');
      if (res && (res.granted || res.alreadyRoot)) await discover();
      break;
    }

    case 'apps-list': {
      const res = await api.packages.list();
      if (!res || !res.ok) {
        toast((res && res.message) || '读取应用列表失败', 'warn');
        break;
      }
      const rows = (res.packages || [])
        .slice(0, 400)
        .map(
          (p) =>
            `<div class="result-item">` +
            `<span class="result-item__text mono">${esc(p.packageName)}</span>` +
            `<span class="result-item__status" style="color:${p.visibleInDefaultRoots ? 'var(--accent)' : 'var(--text-3)'}">` +
            `${p.visibleInDefaultRoots ? '在默认范围内可见' : '默认范围内无数据目录'}</span>` +
            `</div>`
        )
        .join('');
      openModal({
        title: '从已安装应用中选择',
        sub: `共 ${res.total} 个应用，其中 ${res.visibleCount} 个在默认扫描范围内有数据目录。`,
        body: `<div class="result-list" style="user-select:text">${rows}</div>`,
        actions: [{ label: '关闭', action: 'close' }],
      });
      break;
    }

    case 'cancel-scan': {
      const res = await api.scan.cancel();
      toast((res && res.message) || '已请求取消。因扫描过程不写盘，不会留下残留文件。');
      break;
    }

    case 'set-filter': {
      state.filter = el.dataset.filter;
      render();
      break;
    }

    case 'toggle-pack': {
      const id = el.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      refreshSelectionUi();
      break;
    }

    case 'select-complete': {
      state.selected = new Set((state.scan.packs || []).filter((p) => p.defaultChecked).map((p) => p.id));
      refreshSelectionUi();
      toast(`已选中 ${state.selected.size} 个完整包。`, 'ok');
      break;
    }

    case 'open-export':
      await openExportDialog();
      break;

    case 'copy-path': {
      const target = el.dataset.path || (state.exportResult && state.exportResult.targetRoot) || '';
      const r = await api.system.copy(target);
      if (r && r.ok) toast('路径已复制到剪贴板。', 'ok');
      break;
    }

    case 'open-folder': {
      const target = el.dataset.path || (state.exportResult && state.exportResult.targetRoot) || '';
      const r = await api.system.openPath(target);
      if (!r || !r.ok) toast((r && r.message) || '无法打开该位置。', 'warn');
      break;
    }

    case 'cubism-open': {
      const entries = (state.exportResult && state.exportResult.entryPoints) || [];
      const targets = entries.filter((e) => e.status === 'exported' || e.status === 'partial').map((e) => e.entryPath);
      const res = await api.cubism.open({ entryPaths: targets });
      if (res && res.ok) {
        toast('已启动 Cubism Editor 并载入模型。', 'ok');
      } else if (res && res.error === 'editor_not_found') {
        openModal({
          title: '未检测到 Cubism Editor',
          body:
            `<p style="margin:0 0 12px">${esc(res.message)}</p>` +
            `<p style="margin:0 0 12px" class="muted">要打开的是模型目录下的 <code>.model3.json</code> 文件，` +
            `不是 <code>.moc3</code>。Cubism Editor 目前只有 Windows 与 macOS 版本。</p>`,
          actions: [
            { label: '打开文件夹', action: 'open-folder-now' },
            { label: '去官网下载', action: 'goto-download' },
            { label: '手动指定位置', action: 'pick-editor', close: false },
          ],
          async onAction(a) {
            if (a === 'open-folder-now') {
              const dir = (state.exportResult && state.exportResult.targetRoot) || '';
              api.system.openPath(dir);
            }
            if (a === 'goto-download') api.system.openPath(api.cubism.downloadUrl);
            if (a === 'pick-editor') {
              const picked = await api.cubism.pickPath();
              if (picked && picked.ok) {
                toast('已记录 Cubism Editor 位置。', 'ok');
                closeModal();
                await api.cubism.open({ entryPaths: targets });
              }
            }
          },
        });
      } else {
        toast((res && res.message) || '启动失败。', 'warn');
      }
      break;
    }

    case 'cubism-detect': {
      const res = await api.cubism.detect({ force: true });
      if (res && res.found) toast(`已检测到 Cubism Editor：${res.exePath}`, 'ok');
      else {
        openModal({
          title: '未检测到 Cubism Editor',
          body:
            `<p style="margin:0 0 12px">本机没有找到 Live2D Cubism Editor。导出功能不受影响，只是无法从这里一键打开模型。</p>` +
            `<p style="margin:0" class="muted">查看模型需要安装 Cubism Editor（Windows / macOS）。</p>`,
          actions: [
            { label: '去官网下载', action: 'goto' },
            { label: '知道了', action: 'close' },
          ],
          onAction(a) {
            if (a === 'goto') api.system.openPath(api.cubism.downloadUrl);
          },
        });
      }
      break;
    }

    case 'try-unpack':
      await tryUnpack();
      break;

    case 'change-roots':
      setScreen('connect');
      break;

    case 'view-log':
      viewLog();
      break;

    case 'copy-diagnostics':
      await copyDiagnostics();
      break;

    case 'continue-with-unpacked':
      continueWithUnpacked();
      break;

    default:
      break;
  }
}

boot();

/**
 * 自检钩子。
 *
 * 只暴露渲染层**本来就已经持有**的状态：没有 API、没有 Node 能力，
 * 主进程侧的自检工具靠它把六个屏幕逐个渲染出来截图，
 * 避免为了看一眼界面而必须真的连一台模拟器。
 */
window.__shimoDebug = {
  state,
  render,
  setScreen(screen) {
    state.screen = screen;
    render();
  },
  patch(next) {
    Object.assign(state, next);
    // selected 在渲染层是 Set；注入方只能给数组（Set 过不了结构化克隆）
    if (Array.isArray(state.selected)) state.selected = new Set(state.selected);
    render();
  },
};
