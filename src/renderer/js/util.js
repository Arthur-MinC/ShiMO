// 通用工具：转义、提示、模态、格式化

export function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('en-US');
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${(Number(ms) / 1000).toFixed(1)} 秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} 分 ${s} 秒`;
}

/* ---------------- Toast ---------------- */

const toastLayer = () => document.getElementById('toastLayer');

export function toast(message, type = '') {
  const layer = toastLayer();
  if (!layer) return;
  const el = document.createElement('div');
  el.className = `toast${type ? ` toast--${type}` : ''}`;
  el.textContent = message;
  layer.appendChild(el);
  const life = Math.min(9000, 2600 + String(message).length * 60);
  setTimeout(() => {
    el.style.transition = 'opacity 200ms ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, life);
}

/* ---------------- 模态 ---------------- */

let modalCleanup = null;

export function closeModal() {
  const layer = document.getElementById('modalLayer');
  if (!layer) return;
  layer.hidden = true;
  layer.innerHTML = '';
  if (modalCleanup) {
    modalCleanup();
    modalCleanup = null;
  }
}

/**
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} [spec.sub]
 * @param {string} spec.body HTML
 * @param {Array<{label:string, kind?:string, action:string, data?:object, close?:boolean}>} spec.actions
 * @param {(ev:Event)=>void} [spec.onClick] 内部点击处理
 */
export function openModal(spec) {
  const layer = document.getElementById('modalLayer');
  if (!layer) return;

  const actions = (spec.actions || [])
    .map(
      (a) =>
        `<button class="btn ${a.kind === 'primary' ? 'btn--primary' : 'btn--ghost'}" type="button" ` +
        `data-modal-action="${esc(a.action || '')}" data-modal-close="${a.close === false ? 'false' : 'true'}">${esc(a.label)}</button>`
    )
    .join('');

  layer.innerHTML =
    `<div class="modal" role="dialog" aria-modal="true">` +
    `<h2 class="modal__title">${esc(spec.title || '')}</h2>` +
    (spec.sub ? `<p class="modal__sub">${esc(spec.sub)}</p>` : '') +
    `<div class="modal__body">${spec.body || ''}</div>` +
    (actions ? `<div class="modal__foot">${actions}</div>` : '') +
    `</div>`;
  layer.hidden = false;

  const onLayerClick = (ev) => {
    if (ev.target === layer) {
      closeModal();
      return;
    }
    const btn = ev.target.closest('[data-modal-action]');
    if (btn) {
      const action = btn.getAttribute('data-modal-action');
      const shouldClose = btn.getAttribute('data-modal-close') !== 'false';
      if (spec.onAction) spec.onAction(action, btn, { close: shouldClose });
      if (shouldClose) closeModal();
      return;
    }
    if (spec.onClick) spec.onClick(ev);
  };

  const onKey = (ev) => {
    if (ev.key === 'Escape') closeModal();
  };

  layer.addEventListener('click', onLayerClick);
  document.addEventListener('keydown', onKey);
  modalCleanup = () => {
    layer.removeEventListener('click', onLayerClick);
    document.removeEventListener('keydown', onKey);
  };
}

/* ---------------- 小组件片段 ---------------- */

export const checkIcon = (size = 34, color = '#0F766E', bg = '#F0FDFA') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 34 34" aria-hidden="true">` +
  `<circle cx="17" cy="17" r="17" fill="${bg}"/>` +
  `<path d="M10 17.5l5 5l9.5-11" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const warnIcon = (size = 34) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 34 34" aria-hidden="true">` +
  `<circle cx="17" cy="17" r="16" fill="#FFFBEB" stroke="#FDE68A" stroke-width="1.6"/>` +
  `<text x="17" y="17" font-size="20" font-weight="600" fill="#B45309" text-anchor="middle" dominant-baseline="central">!</text></svg>`;

export const searchIcon = (size = 34) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 34 34" aria-hidden="true">` +
  `<circle cx="15" cy="15" r="7.5" fill="none" stroke="#71717A" stroke-width="2.2"/>` +
  `<path d="M20.5 20.5L26 26" stroke="#71717A" stroke-width="2.2" stroke-linecap="round"/></svg>`;

/** 状态标签的样式类。 */
export function statusTagClass(level) {
  if (level === 'ok') return 'status-tag status-tag--ok';
  if (level === 'error') return 'status-tag status-tag--error';
  if (level === 'warning') return 'status-tag status-tag--warn';
  return 'status-tag status-tag--muted';
}
