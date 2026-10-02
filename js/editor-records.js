/* Editor — tabela de registros (edição na própria tabela).
   Estudos grandes (mais de 300 registros): a tabela desenha só as linhas
   visíveis (rolagem virtual), para a tela não travar. */

import { TYPES } from './config.js';
import { toBR, fmtTimeOfDay, escapeHtml, parseNumber } from './core/format.js';
import { $, showToast } from './ui.js';
import { S, persist, refresh, nowIso } from './editor.js';
import * as timer from './editor-timer.js';

const VIRTUAL_MIN = 300;
const OVERSCAN = 20;
let lastStats = null;
let rowH = 38;
let windowStart = -1;
let printing = false;
let scrollRaf = 0;

export function init() {
  const wrap = $('recordsWrap');
  wrap.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderWindow(false); });
  }, { passive: true });
  const tb = $('recordsTable');
  tb.addEventListener('focusout', onFocusOut);
  tb.addEventListener('keydown', e => {
    if (e.target.matches('td[data-edit]') && e.key === 'Enter' && e.target.dataset.edit !== 'note') { e.preventDefault(); e.target.blur(); }
    if (e.target.matches('td[data-edit]') && e.key === 'Escape') { e.preventDefault(); refresh(); }
  });
  tb.addEventListener('change', e => {
    if (e.target.matches('select[data-edit="type"]')) edit(e.target.closest('tr').dataset.id, 'type', e.target.value);
  });
}

function onFocusOut(e) {
  const td = e.target;
  if (!td.matches || !td.matches('td[data-edit]')) return;
  const tr = td.closest('tr');
  // guarda para onde o foco foi, para devolvê-lo após redesenhar a tabela
  const next = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#recordsTable [data-edit]');
  const nextRef = next ? { id: next.closest('tr').dataset.id, field: next.dataset.edit } : null;
  edit(tr.dataset.id, td.dataset.edit, td.innerText);
  if (nextRef) {
    const row = $('recordsTable').querySelector('tr[data-id="' + CSS.escape(nextRef.id) + '"]');
    const cell = row && row.querySelector('[data-edit="' + nextRef.field + '"]');
    if (cell) cell.focus();
  }
}

function edit(id, field, value) {
  if (S.readonly) return;
  const r = S.current.records.find(x => x.id === id);
  if (!r) return;
  let changed = false;
  if (field === 'time') {
    const v = Math.max(0, parseNumber(value));
    if (v !== r.time) { r.time = v; changed = true; }
  } else if (field === 'stageName') {
    const v = String(value).replace(/\s+/g, ' ').trim();
    if (v && v !== r.stageName) { r.stageName = v; changed = true; }
  } else if (field === 'type') {
    if (TYPES.includes(value) && value !== r.type) { r.type = value; changed = true; }
  } else if (field === 'qty') {
    const v = Math.max(0, parseNumber(value));
    if (v !== r.qty) { r.qty = v; changed = true; }
  } else if (field === 'note') {
    const v = String(value).trim();
    if (v !== (r.note || '')) { if (v) r.note = v; else delete r.note; changed = true; }
  }
  if (changed) { r.u = nowIso(); persist(); }
  refresh();
  timer.renderLastMark();
}

export function remove(id) {
  if (S.readonly) return;
  const index = S.current.records.findIndex(r => r.id === id);
  if (index < 0) return;
  const [record] = S.current.records.splice(index, 1);
  S.current.deletedRecords = { ...(S.current.deletedRecords || {}), [id]: nowIso() };
  timer.pushUndo({ type: 'delete-record', record, index });
  persist('Registro excluído');
  refresh();
  timer.renderLastMark();
  showToast('Registro excluído — use ↶ Desfazer se foi sem querer');
}

export function toggleExclude(id) {
  if (S.readonly) return;
  const r = S.current.records.find(x => x.id === id);
  if (!r || r.interruption) return;
  if (r.excluded) delete r.excluded; else r.excluded = true;
  r.u = nowIso();
  persist(r.excluded ? 'Registro ignorado nos cálculos' : 'Registro voltou aos cálculos');
  refresh();
}

function rowHtml(r, stats) {
  const ed = S.readonly ? '' : ' contenteditable="true"';
  const outlier = stats.outliers.has(r.id);
  const cls = [r.excluded ? 'excluded' : '', r.interruption ? 'interruption' : ''].filter(Boolean).join(' ');
  const typeCell = r.interruption
    ? '<td><span class="badge type-interrupcao">⚡ Interrupção</span></td>'
    : '<td><select data-edit="type" aria-label="Tipo"' + (S.readonly ? ' disabled' : '') + '>' +
      TYPES.map(t => '<option' + (t === r.type ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></td>';
  const nPhotos = (r.photos || []).length;
  const photos = nPhotos ? '<button type="button" class="photo-chip" data-action="record-photos" title="Ver as fotos deste registro">🖼 ' + nPhotos + '</button>' : '';
  const actions = S.readonly ? (photos ? '<div class="row-actions">' + photos + '</div>' : '') :
    '<div class="row-actions">' +
      (r.interruption ? '' : '<button type="button" data-action="toggle-exclude" title="' + (r.excluded ? 'Voltar a considerar nos cálculos' : 'Ignorar nos cálculos (sem excluir)') + '">' +
        (r.excluded ? 'Considerar' : 'Ignorar') + '</button>') +
      '<button type="button" data-action="record-photo" title="Fotografar este registro" aria-label="Foto">📷</button>' + photos +
      '<button type="button" class="danger icon-btn" data-action="delete-record" title="Excluir registro" aria-label="Excluir registro">✕</button>' +
    '</div>';
  return '<tr data-id="' + escapeHtml(r.id) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
    '<td>' + r.cycle + '</td>' +
    '<td' + (r.interruption ? '' : ed) + ' data-edit="stageName">' + escapeHtml(r.stageName) + '</td>' +
    typeCell +
    '<td' + ed + ' data-edit="time" inputmode="decimal"' +
      (outlier ? ' class="outlier" title="Fora de ±2σ da média desta etapa — confira se não foi um toque errado"' : '') + '>' +
      toBR(r.time) + (outlier ? ' ⚠' : '') + '</td>' +
    '<td' + (r.interruption ? '' : ed) + ' data-edit="qty" inputmode="decimal">' + toBR(r.qty ?? 1, 0) + '</td>' +
    '<td class="muted">' + escapeHtml(fmtTimeOfDay(r.ts)) + '</td>' +
    '<td class="note-cell"' + ed + ' data-edit="note" data-placeholder="—">' + escapeHtml(r.note || '') + '</td>' +
    '<td class="no-print">' + actions + '</td></tr>';
}

export function render(stats) {
  lastStats = stats;
  const tb = $('recordsTable');
  const wrap = $('recordsWrap');
  const recs = S.current.records;
  const virtual = !printing && recs.length > VIRTUAL_MIN;
  wrap.classList.toggle('virtual', virtual);
  const hint = $('recordsHint');
  hint.hidden = !virtual;
  if (virtual) hint.textContent = recs.length + ' registros — a tabela mostra só as linhas visíveis; role dentro dela para ver as demais.';
  if (!recs.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">Sem registros ainda</td></tr>';
    return;
  }
  if (!virtual) {
    tb.innerHTML = recs.map(r => rowHtml(r, stats)).join('');
    return;
  }
  // grudado no fim (acompanhando as marcações)? continua no fim
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - rowH * 2;
  renderWindow(true);
  if (atBottom) { wrap.scrollTop = wrap.scrollHeight; renderWindow(false); }
}

/* Desenha só a janela visível, com espaçadores no lugar das demais linhas. */
function renderWindow(force) {
  const wrap = $('recordsWrap');
  if (!wrap.classList.contains('virtual') || !S.current || !lastStats) return;
  const tb = $('recordsTable');
  if (!force && tb.contains(document.activeElement)) return; // editando uma célula
  const recs = S.current.records;
  const view = wrap.clientHeight || 600;
  const start = Math.max(0, Math.floor(wrap.scrollTop / rowH) - OVERSCAN);
  if (!force && Math.abs(start - windowStart) < OVERSCAN / 2) return;
  windowStart = start;
  const end = Math.min(recs.length, start + Math.ceil(view / rowH) + OVERSCAN * 2);
  const spacer = h => h > 0 ? '<tr class="spacer" aria-hidden="true"><td colspan="8" style="height:' + h + 'px"></td></tr>' : '';
  tb.innerHTML = spacer(start * rowH) + recs.slice(start, end).map(r => rowHtml(r, lastStats)).join('') + spacer((recs.length - end) * rowH);
  const first = tb.querySelector('tr[data-id]');
  if (first && first.offsetHeight && Math.abs(first.offsetHeight - rowH) > 2) { rowH = first.offsetHeight; if (force) renderWindow(true); }
}

/* Impressão: todas as linhas. */
export function prepareForPrint(on) {
  printing = on;
  if (S.current && lastStats) render(lastStats);
}

/* ---------- Fotos ---------- */
export function attachPhoto(recordId, photo) {
  const r = S.current && S.current.records.find(x => x.id === recordId);
  if (!r) return false;
  r.photos = [...(r.photos || []).filter(p => p.id !== photo.id), photo];
  r.u = nowIso();
  persist('Foto anexada a "' + r.stageName + '" (ciclo ' + r.cycle + ')');
  refresh();
  return true;
}

export function detachPhoto(recordId, photoId) {
  const r = S.current && S.current.records.find(x => x.id === recordId);
  if (!r || S.readonly) return false;
  r.photos = (r.photos || []).filter(p => p.id !== photoId);
  if (!r.photos.length) delete r.photos;
  r.u = nowIso();
  persist('Foto removida');
  refresh();
  return true;
}
