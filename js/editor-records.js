/* Editor — tabela de registros (edição na própria tabela). */

import { TYPES } from './config.js';
import { toBR, fmtTimeOfDay, escapeHtml, parseNumber } from './core/format.js';
import { $, showToast } from './ui.js';
import { S, persist, refresh, nowIso } from './editor.js';
import * as timer from './editor-timer.js';

export function init() {
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

export function render(stats) {
  const tb = $('recordsTable');
  if (!S.current.records.length) {
    tb.innerHTML = '<tr><td colspan="8" class="empty">Sem registros ainda</td></tr>';
    return;
  }
  const ed = S.readonly ? '' : ' contenteditable="true"';
  tb.innerHTML = S.current.records.map(r => {
    const outlier = stats.outliers.has(r.id);
    const cls = [r.excluded ? 'excluded' : '', r.interruption ? 'interruption' : ''].filter(Boolean).join(' ');
    const typeCell = r.interruption
      ? '<td><span class="badge type-interrupcao">⚡ Interrupção</span></td>'
      : '<td><select data-edit="type" aria-label="Tipo"' + (S.readonly ? ' disabled' : '') + '>' +
        TYPES.map(t => '<option' + (t === r.type ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></td>';
    const actions = S.readonly ? '' :
      '<div class="row-actions">' +
        (r.interruption ? '' : '<button type="button" data-action="toggle-exclude" title="' + (r.excluded ? 'Voltar a considerar nos cálculos' : 'Ignorar nos cálculos (sem excluir)') + '">' +
          (r.excluded ? 'Considerar' : 'Ignorar') + '</button>') +
        '<button type="button" class="danger" data-action="delete-record">Excluir</button>' +
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
  }).join('');
}
