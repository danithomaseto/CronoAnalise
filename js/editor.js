/* Editor do estudo — núcleo: estado, abrir/novo/fechar, gravação, campos,
   abas, somente leitura, exclusão e exportações. As partes ficam em:
     editor-timer.js    cronômetro, marcações, interrupções, desfazer
     editor-stages.js   etapas (cadastro, edição, ordem)
     editor-records.js  tabela de registros
     editor-stats.js    indicadores, takt e gráficos
     editor-balance.js  balanceamento de linha (postos × takt)
     editor-sampling.js amostragem do trabalho (estudos do tipo "sampling")
     editor-a3.js       relatório A3
     editor-history.js  linha do tempo e versões no servidor */

import { FIELD_LABELS } from './config.js';
import * as storage from './storage.js';
import { computeStats } from './core/stats.js';
import { samplingStats } from './core/sampling.js';
import { buildCSV, buildSamplingCSV } from './core/csv.js';
import { createWorkbook } from './core/xlsx.js';
import { buildReportSheets, buildSamplingSheets } from './core/report.js';
import { createStudy, nextStagePos } from './core/model.js';
import { fmtDate, escapeHtml, parseNumber, uid, safeFilename, autoStudyName, stableStringify } from './core/format.js';
import { $, showToast, downloadFile } from './ui.js';
import * as timer from './editor-timer.js';
import * as stages from './editor-stages.js';
import * as records from './editor-records.js';
import * as statsUI from './editor-stats.js';
import * as balanceUI from './editor-balance.js';
import * as samplingUI from './editor-sampling.js';
import * as a3UI from './editor-a3.js';
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
let onStudyDeleted = () => {};
let statsMemo = { study: null, key: '', value: null };

export const nowIso = () => new Date().toISOString();

export function initEditor(opts) {
  requestSync = opts.requestSync || requestSync;
  onDeleted = opts.onDeleted || onDeleted;
  onStudyDeleted = opts.onStudyDeleted || onStudyDeleted;

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
  balanceUI.init();
  samplingUI.init();
  a3UI.init();
  history.init();
}

export function isSampling() {
  return !!(S.current && S.current.kind === 'sampling');
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

export function newStudy(template = null, kind = undefined) {
  flush();
  const now = nowIso();
  const k = template ? template.kind : kind;
  const s = createStudy({ id: uid('study'), now, kind: k });
  if (template) {
    s.name = template.name + ' (novo)';
    ['process', 'observer', 'rating', 'allowance', 'demand', 'availableMin', 'samplingPlan'].forEach(f => {
      if (template[f] !== undefined && template[f] !== '') s[f] = JSON.parse(JSON.stringify(template[f]));
    });
    s.stages = template.stages.map((st, i) => ({
      id: uid('st'), name: st.name, type: st.type, pos: i, u: now,
      ...(st.countsOutput ? { countsOutput: true } : {}),
      ...(st.station ? { station: st.station } : {}),
      ...(st.wh ? { wh: { ...st.wh } } : {})
    }));
    if (k === 'sampling') {
      s.categories = (template.categories || []).map((c, i) => ({ id: uid('cat'), name: c.name, productive: !!c.productive, pos: i, u: now }));
    }
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
  applyKind();
  timer.enter();
  showTab('crono');
  renderAll();
  if (S.readonly) showToast('Estudo compartilhado com você somente para leitura');
}

/* Cronoanálise ou amostragem do trabalho: mostra as seções do tipo do estudo. */
function applyKind() {
  const sampling = isSampling();
  document.body.classList.toggle('kind-sampling', sampling);
  $('tabCrono').textContent = sampling ? 'Amostragem' : 'Cronômetro';
  $('studyPanelTitle').textContent = sampling ? 'Estudo de amostragem do trabalho' : 'Estudo';
  if (sampling) samplingUI.enter(); else samplingUI.leave();
}

export function close() {
  flush();
  S.current = null;
  S.unsaved = false;
  S.readonly = false;
  document.body.classList.remove('readonly', 'kind-sampling');
  timer.leave();
  samplingUI.leave();
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
    if (merged.records.length !== before.records.length || merged.stages.length !== before.stages.length ||
        (merged.observations || []).length !== (before.observations || []).length) {
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

/* Campos com dois controles na tela (ex.: tempo disponível na cronoanálise e na amostragem). */
function syncTwins(field, source) {
  document.querySelectorAll('#editorMain [data-field="' + field + '"]').forEach(el => {
    if (el !== source && document.activeElement !== el) el.value = source.value;
  });
}

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
    syncTwins(f, e.target);
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

/* ---------- Indicadores ----------
   Memorizados: o mesmo estudo (mesmo objeto) com as mesmas preferências não é
   recalculado — em estudos grandes, várias partes da tela usam o resultado. */
export function getStats() {
  const prefs = storage.getPrefs();
  const key = prefs.confidence + '|' + prefs.error;
  if (statsMemo.study === S.current && statsMemo.key === key && statsMemo.value && statsMemo.sig === statsSig(S.current)) return statsMemo.value;
  const value = isSampling() ? samplingStats(S.current, prefs) : computeStats(S.current, prefs);
  statsMemo = { study: S.current, key, value, sig: statsSig(S.current) };
  return value;
}

/* Assinatura barata do conteúdo que entra nos cálculos (o objeto pode ser
   alterado no lugar entre um cálculo e outro). */
function statsSig(s) {
  if (!s) return '';
  const recs = s.kind === 'sampling' ? (s.observations || []) : (s.records || []);
  const last = recs[recs.length - 1];
  return [recs.length, s.updatedAt, last ? (last.u || last.ts || '') + last.id : '',
    s.rating, s.allowance, s.demand, s.availableMin, (s.stages || []).length, (s.categories || []).length].join('|');
}

export function invalidateStats() {
  statsMemo = { study: null, key: '', value: null };
}

/* Recalcula e redesenha indicadores + registros. No Modo Campo esses painéis
   ficam escondidos: o redesenho espera a saída do modo (toques mais rápidos). */
let staleInField = false;

export function refresh() {
  if (!S.current) return;
  invalidateStats();
  if (isSampling()) { samplingUI.render(); return; }
  if (document.body.classList.contains('field')) { staleInField = true; return; }
  staleInField = false;
  const st = getStats();
  records.render(st);
  statsUI.render(st);
  balanceUI.render(st);
}

export function fieldModeChanged(on) {
  if (!on && staleInField) refresh();
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
  set('samplingMinutes', num(c.availableMin));
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
  if (isSampling()) samplingUI.renderAll(); else stages.render();
  refresh();
  renderStudyMeta();
  renderStudyList();
  history.render();
  a3UI.render();
  timer.renderLastMark();
  timer.updateUI();
}

export function currentTab() {
  if (!$('editorHistory').hidden) return 'hist';
  if (!$('editorA3').hidden) return 'a3';
  return 'crono';
}

export function showTab(tab) {
  const t = ['hist', 'a3'].includes(tab) ? tab : 'crono';
  $('editorMain').hidden = t !== 'crono';
  $('editorHistory').hidden = t !== 'hist';
  $('editorA3').hidden = t !== 'a3';
  [['tabCrono', 'crono'], ['tabA3', 'a3'], ['tabHist', 'hist']].forEach(([id, k]) => {
    $(id).classList.toggle('active', t === k);
    $(id).setAttribute('aria-selected', String(t === k));
  });
  if (!S.current) return;
  if (t === 'hist') history.render();
  else if (t === 'a3') a3UI.render();
  else if (isSampling()) samplingUI.relayout();
  else { statsUI.relayout(); balanceUI.relayout(); }
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
    onStudyDeleted(id, c);
  }
  storage.removeTimer(id);
  timer.forget(id);
  showToast('Estudo excluído');
  onDeleted();
}

export function forgetStudy(id) {
  timer.forget(id);
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function buildCSVText() {
  return isSampling() ? buildSamplingCSV(S.current, getStats()) : buildCSV(S.current, getStats());
}

/* Planilha do estudo atual: { filename, bytes } */
export function buildXLSX() {
  const sheets = isSampling() ? buildSamplingSheets(S.current, getStats()) : buildReportSheets(S.current, getStats());
  return { filename: safeFilename(S.current.name || 'Estudo') + '.xlsx', bytes: createWorkbook(sheets) };
}

export function exportCSV() {
  if (!S.current) return;
  flush();
  downloadFile(safeFilename(S.current.name || 'Estudo') + '.csv', '﻿' + buildCSVText(), 'text/csv;charset=utf-8;');
  persist('Exportado CSV');
  showToast('CSV exportado');
}

export function exportXLSX() {
  if (!S.current) return;
  flush();
  const { filename, bytes } = buildXLSX();
  downloadFile(filename, bytes, XLSX_MIME);
  persist('Exportado Excel');
  showToast('Planilha Excel exportada');
}

export function printStudy() {
  if (!S.current) return;
  flush();
  showTab('crono');
  $('printTitle').textContent = S.current.name;
  $('printDate').textContent = 'Relatório gerado em ' + new Date().toLocaleString('pt-BR');
  records.prepareForPrint(true);
  const relayout = w => { if (isSampling()) samplingUI.relayout(w); else { statsUI.relayout(w); balanceUI.relayout(w); } };
  relayout(720);
  setTimeout(() => { window.print(); relayout(); records.prepareForPrint(false); }, 50);
}

export function printA3() {
  if (!S.current) return;
  flush();
  a3UI.print();
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
