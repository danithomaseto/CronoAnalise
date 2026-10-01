/* Utilitários de interface: toast, modais, menu, tema e download de arquivos. */

import * as storage from './storage.js';

export const $ = id => document.getElementById(id);

/* ---------- Toast ---------- */
let toastTimer = null;
export function showToast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- Modais (foco, Esc, clique fora) ---------- */
let openModalEl = null;
let returnFocus = null;
let onCloseCb = null;

export function openModal(id, { onClose, focus } = {}) {
  if (openModalEl) closeModal();
  const el = $(id);
  returnFocus = document.activeElement;
  onCloseCb = onClose || null;
  el.hidden = false;
  openModalEl = el;
  const target = focus ? $(focus) : el.querySelector('input:not([type=hidden]):not([hidden]),select,textarea,button');
  if (target) setTimeout(() => target.focus(), 0);
}

export function closeModal() {
  if (!openModalEl) return;
  openModalEl.hidden = true;
  openModalEl = null;
  const cb = onCloseCb;
  onCloseCb = null;
  if (cb) cb();
  if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  returnFocus = null;
}

export function isModalOpen() {
  return !!openModalEl;
}

export function initModals() {
  document.addEventListener('mousedown', e => {
    if (openModalEl && e.target === openModalEl) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (!openModalEl) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
    if (e.key === 'Tab') {
      // mantém o foco dentro do modal
      const f = [...openModalEl.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
        .filter(x => !x.disabled && !x.hidden && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

/* ---------- Menu do topo ---------- */
export function toggleMenu(force) {
  const dd = $('menuDropdown');
  const open = dd.classList.toggle('open', force);
  $('menuBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}

export function closeMenu() {
  toggleMenu(false);
}

export function initMenu() {
  document.addEventListener('click', e => {
    const wrap = $('menuWrap');
    if (wrap && !wrap.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('menuDropdown').classList.contains('open')) {
      closeMenu();
      $('menuBtn').focus();
    }
  });
}

/* ---------- Tema ---------- */
export function isDark() {
  return document.documentElement.classList.contains('dark-theme');
}

export function applyThemeUI() {
  const dark = isDark();
  const btn = $('btnTheme');
  if (btn) btn.textContent = dark ? '☀️ Tema Claro' : '🌙 Tema Escuro';
  const chk = $('settingsThemeToggle');
  if (chk) chk.checked = dark;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f1216' : '#1c2128');
}

export function toggleTheme() {
  const dark = document.documentElement.classList.toggle('dark-theme');
  storage.setTheme(dark ? 'dark' : 'light');
  applyThemeUI();
}

/* ---------- Download ---------- */
export function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- Status de sincronização ---------- */
const STATUS_TEXT = {
  pending: '● Alterações pendentes',
  syncing: '🔄 Sincronizando...',
  saved: '✔ Salvo',
  offline: '📴 Offline — salvo neste aparelho',
  error: '⚠ Erro ao sincronizar — salvo neste aparelho'
};

export function setSyncStatus(status) {
  const el = $('syncStatus');
  if (!el) return;
  el.textContent = STATUS_TEXT[status] || '';
  el.className = 'autosave-status as-' + status;
}

export function setSyncTime(text) {
  const el = $('syncTime');
  if (el) el.textContent = text || '';
}
