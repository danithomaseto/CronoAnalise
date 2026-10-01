/* Editor do estudo — núcleo: estado, abrir/novo/fechar, gravação, campos,
   abas, somente leitura, exclusão e exportações. As partes ficam em:
     editor-timer.js    cronômetro, marcações, interrupções, desfazer
     editor-stages.js   etapas (cadastro, edição, ordem)
     editor-records.js  tabela de registros
     editor-stats.js    indicadores, takt e gráficos
     editor-history.js  linha do tempo e versões no servidor */

import { FIELD_LABELS } from './config.js';
import * as storage from './storage.js';
import { computeStats } from './core/stats.js';
import { buildCSV } from './core/csv.js';
import { createWorkbook } from './core/xlsx.js';
import { buildReportSheets } from './core/report.js';
import { createStudy, nextStagePos } from './core/model.js';
import { fmtDate, escapeHtml, parseNumber, uid, safeFilename, autoStudyName, stableStringify } from './core/format.js';
import { $, showToast, downloadFile } from './ui.js';
import * as timer from './editor-timer.js';
import * as stages from './editor-stages.js';
import * as records from './editor-records.js';
import * as statsUI from './editor-stats.js';
import * as history from './editor-history.js';

const HISTORY_LIMIT = 50;

/* Estado compartilhado entre as partes do editor. */
export const S = {
  current: null,    // estudo aberto (cópia em memória)
  unsaved: false,   // estudo novo ainda não gravado (só grava na 1ª alteração)
  readonly: false   // estudo compartilhado só para leitura
};

let pendingSave = null; // debounce da digitação
let requestSync = () => {};
let onDeleted = () => {};

export const nowIso = () => new Date().toISOString();

export function initEditor(opts) {
  requestSync = opts.requestSync || requestSync;
  onDeleted = opts.onDeleted || onDeleted;

  const main = $('editorMain');
  main.addEventListener('input', onFieldInput);
  main.addEventListener('change', onFieldChange);
  $('studyList').addEventListener('change', e => {
    const id = e.target.value;
    if (id && (!S.current || id !== S.current.id)) openStudy(id);
  });

  timer.init();
  stages.init();
  records.init();
  statsUI.init();
  history.init();
}

export function getCurrent() { return S.current; }
export function isUnsaved() { return S.unsaved; }
export function isReadonly() { return S.readonly; }
export function hasPendingEdits() { return !!pendingSave; }

/* ---------- Abrir / novo / fechar ---------- */
export function openStudy(id) {
  flush();
  const s = storage.getStudy(id);
  if (!s) { showToast('Estudo não encontrado'); return false; }
  S.current = s;
  S.unsaved = false;
  enter();
  return true;
}

export function newStudy(template = null) {
  flush();
  const now = nowIso();
  const s = createStudy({ id: uid('study'), now });
  if (template) {
    s.name = template.name + ' (novo)';
    ['process', 'observer', 'rating', 'allowance', 'demand', 'availableMin'].forEach(k => {
      if (template[k] !== undefined && template[k] !== '') s[k] = template[k];
    });
    s.stages = template.stages.map((st, i) => ({
      id: uid('st'), name: st.name, type: st.type, pos: i, u: now,
      ...(st.countsOutput ? { countsOutput: true } : {})
    }));
    s.history = [{ ts: now, text: 'Estudo criado a partir do modelo "' + template.name + '"' }];
  }
  S.current = s;
  S.unsaved = !template;
  enter();
  if (template) persist(); else $('studyName').focus();
}

function enter() {
  S.readonly = !S.unsaved && !storage.canEdit(S.current.id);
  document.body.classList.toggle('readonly', S.readonly);
  timer.enter();
  showTab('crono');
  renderAll();
  if (S.readonly) showToast('Estudo compartilhado com você somente para leitura');
}

export function close() {
  flush();
  S.current = null;
  S.unsaved = false;
  S.readonly = false;
  document.body.classList.remove('readonly');
  timer.leave();
}

/* ---------- Gravação ---------- */
export function addHistory(text) {
  S.current.history.push({ ts: nowIso(), text });
  if (S.current.history.length > HISTORY_LIMIT) S.current.history.splice(0, S.current.history.length - HISTORY_LIMIT);
}

/* Data de edição de um campo do estudo (para a mesclagem entre aparelhos). */
export function touchField(field) {
  S.current.fieldTs = { ...(S.current.fieldTs || {}), [field]: nowIso() };
}

export function persist(historyText) {
  if (!S.current || S.readonly) return;
  clearTimeout(pendingSave);
  pendingSave = null;
  if (historyText) addHistory(historyText);
  if (!S.current.name.trim()) {
    S.current.name = autoStudyName();
    touchField('name');
    if (document.activeElement !== $('studyName')) $('studyName').value = S.current.name;
  }
  S.current.updatedAt = nowIso();
  const before = S.current;
  const merged = storage.putStudy(S.current);
  if (merged) {
    S.unsaved = false;
    S.current = merged;
    requestSync();
    // a mesclagem trouxe algo de outro aparelho? redesenha o que mudou
    if (merged.records.length !== before.records.length || merged.stages.length !== before.stages.length) {
      stages.render();
      refresh();
      timer.renderLastMark();
    }
  }
  renderStudyMeta();
  renderStudyList();
}

function scheduleSave() {
  clearTimeout(pendingSave);
  pendingSave = setTimeout(() => { pendingSave = null; persist(); }, 600);
}

export function flush() {
  if (pendingSave) persist();
}

/* Atualização vinda da nuvem ou de outra aba. */
export function applyExternalUpdate() {
  if (!S.current) return;
  timer.reloadFromStorage();
  if (!pendingSave && !S.unsaved) { // edição local em andamento vence
    const s = storage.getStudy(S.current.id);
    if (!s) {
      showToast('Este estudo foi excluído ou deixou de ser compartilhado com você');
      onDeleted();
      return;
    }
    const ro = !storage.canEdit(S.current.id);
    // compara o conteúdo: a mesclagem mantém a maior data, que pode ser a deste aparelho
    if (stableStringify(s) !== stableStringify(S.current) || ro !== S.readonly) {
      S.current = s;
      S.readonly = ro;
      document.body.classList.toggle('readonly', ro);
      renderAll();
      showToast('Estudo atualizado com alterações de outro aparelho');
      return;
    }
  }
  renderStudyList();
}

/* ---------- Campos do estudo ---------- */
const NUM_FIELDS = { rating: v => v > 0, allowance: v => v >= 0, demand: v => v > 0, availableMin: v => v > 0 };

function onFieldInput(e) {
  const f = e.target.dataset.field;
  if (!f || !S.current || S.readonly) return;
  const v = e.target.value;
  if (NUM_FIELDS[f]) {
    const trimmed = v.trim();
    const n = parseNumber(trimmed);
    if (trimmed === '') delete S.current[f];
    else if (NUM_FIELDS[f](n)) S.current[f] = n;
    else return;
    refresh();
  } else {
    S.current[f] = v;
    if (f === 'name') $('printTitle').textContent = v;
  }
  touchField(f);
  scheduleSave();
}

function onFieldChange(e) {
  const f = e.target.dataset.field;
  if (!f || !S.current || S.readonly) return;
  if (f === 'name') {
    const trimmed = S.current.name.trim();
    if (trimmed !== S.current.name) { S.current.name = trimmed; touchField('name'); scheduleSave(); }
    const dup = storage.listStudies().some(s => s.id !== S.current.id && s.name.trim().toLowerCase() === S.current.name.toLowerCase());
    if (dup) showToast('Atenção: já existe outro estudo com este nome');
  }
  flush();
  if (f === 'name' && !$('studyName').value.trim()) $('studyName').value = S.current.name;
}

/* ---------- Indicadores ---------- */
export function getStats() {
  return computeStats(S.current, storage.getPrefs());
}

/* Recalcula e redesenha indicadores + registros. */
export function refresh() {
  if (!S.current) return;
  const st = getStats();
  records.render(st);
  statsUI.render(st);
}

/* ---------- Metadados / lista / campos ---------- */
export function renderStudyMeta() {
  if (!S.current) return;
  const acc = storage.getAccess(S.current.id);
  let line = S.unsaved
    ? 'Novo estudo — será salvo automaticamente na primeira alteração.'
    : 'Criado: ' + fmtDate(S.current.createdAt) + '  ·  Última edição: ' + fmtDate(S.current.updatedAt);
  if (acc.role !== 'owner') line += '  ·  Compartilhado por ' + (acc.ownerEmail || 'outro usuário') + (acc.role === 'viewer' ? ' (somente leitura)' : ' (pode editar)');
  $('studyMetaLine').textContent = line;
  if (!$('editorHistory').hidden) history.render();
}

export function renderStudyList() {
  const sel = $('studyList');
  const list = storage.listStudies().slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  sel.innerHTML = '<option value="">Selecione um estudo salvo…</option>' +
    list.map(s => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>').join('');
  sel.value = S.current && !S.unsaved ? S.current.id : '';
}

function renderFields() {
  const c = S.current;
  const set = (id, v) => { const el = $(id); if (el.value !== v && document.activeElement !== el) el.value = v; };
  const num = v => (v !== undefined ? String(v).replace('.', ',') : '');
  set('studyName', c.name);
  set('process', c.process);
  set('operator', c.operator);
  set('observer', c.observer);
  set('notes', c.notes);
  ['rating', 'allowance', 'demand', 'availableMin'].forEach(k => set(k, num(c[k])));
  if (['rating', 'allowance', 'demand', 'availableMin'].some(k => c[k] !== undefined)) $('stdParams').open = true;
  document.querySelectorAll('#editorMain [data-field]').forEach(el => { el.readOnly = S.readonly; });
  $('printTitle').textContent = c.name;
  $('printDate').textContent = 'Relatório gerado em ' + new Date().toLocaleString('pt-BR');
  $('cycle').textContent = c.currentCycle;
  $('btnDeleteCurrent').textContent = storage.isOwner(c.id) || S.unsaved ? 'Excluir' : 'Sair do compartilhamento';
}

export function renderAll() {
  if (!S.current) return;
  renderFields();
  stages.render();
  refresh();
  renderStudyMeta();
  renderStudyList();
  history.render();
  timer.renderLastMark();
  timer.updateUI();
}

export function showTab(tab) {
  const hist = tab === 'hist';
  $('editorMain').hidden = hist;
  $('editorHistory').hidden = !hist;
  $('tabCrono').classList.toggle('active', !hist);
  $('tabHist').classList.toggle('active', hist);
  $('tabCrono').setAttribute('aria-selected', String(!hist));
  $('tabHist').setAttribute('aria-selected', String(hist));
  if (hist && S.current) history.render(); else if (S.current) statsUI.relayout();
}

/* ---------- Excluir / exportar / imprimir ---------- */
export function deleteCurrent(leaveShare) {
  if (!S.current) return;
  const c = S.current;
  const owner = S.unsaved || storage.isOwner(c.id);
  if (!owner) { leaveShare(c.id); return; }
  if (!confirm('Excluir permanentemente o estudo "' + c.name + '"? Esta ação não pode ser desfeita.')) return;
  const id = c.id;
  const wasUnsaved = S.unsaved;
  clearTimeout(pendingSave);
  pendingSave = null;
  S.current = null;
  S.unsaved = false;
  if (!wasUnsaved) {
    storage.removeStudy(id);
    requestSync();
  }
  storage.removeTimer(id);
  timer.forget(id);
  showToast('Estudo excluído');
  onDeleted();
}

export function forgetStudy(id) {
  timer.forget(id);
}

export function exportCSV() {
  if (!S.current) return;
  flush();
  const csv = buildCSV(S.current, getStats());
  downloadFile(safeFilename(S.current.name || 'Estudo') + '.csv', '﻿' + csv, 'text/csv;charset=utf-8;');
  persist('Exportado CSV');
  showToast('CSV exportado');
}

export function exportXLSX() {
  if (!S.current) return;
  flush();
  const bytes = createWorkbook(buildReportSheets(S.current, getStats()));
  downloadFile(safeFilename(S.current.name || 'Estudo') + '.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  persist('Exportado Excel');
  showToast('Planilha Excel exportada');
}

export function printStudy() {
  if (!S.current) return;
  flush();
  showTab('crono');
  $('printTitle').textContent = S.current.name;
  $('printDate').textContent = 'Relatório gerado em ' + new Date().toLocaleString('pt-BR');
  statsUI.relayout(720);
  setTimeout(() => { window.print(); statsUI.relayout(); }, 50);
}

export function saveNow() {
  if (S.current) persist();
}

/* Campos de texto com rótulos configuráveis (config.js). */
export function labels() {
  document.querySelectorAll('[data-label]').forEach(el => {
    const k = el.dataset.label;
    if (FIELD_LABELS[k]) el.textContent = FIELD_LABELS[k];
  });
  ['operator', 'observer'].forEach(k => { $(k).placeholder = FIELD_LABELS[k]; });
}

export { nextStagePos };
