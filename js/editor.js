/* Editor do estudo: cronômetro, etapas, registros, indicadores, observações. */

import { TYPES, FIELD_LABELS } from './config.js';
import * as storage from './storage.js';
import * as T from './core/timer.js';
import { computeStats } from './core/stats.js';
import { buildCSV } from './core/csv.js';
import { createStudy } from './core/model.js';
import {
  toBR, fmtClock, fmtDate, fmtTimeOfDay, escapeHtml, parseNumber, uid, safeFilename, autoStudyName
} from './core/format.js';
import { $, showToast, openModal, closeModal, downloadFile } from './ui.js';

const HISTORY_LIMIT = 50;
const UNDO_LIMIT = 50;
const DOUBLE_TAP_MS = 300;

let current = null;       // estudo aberto (cópia em memória)
let unsaved = false;      // estudo novo ainda não gravado (só grava na 1ª alteração)
let curTimer = T.newTimer();
let pendingSave = null;   // debounce da digitação
let tickHandle = null;
let wakeLock = null;
let lastTap = { at: 0, stageId: null };
let editingStageId = null;
const undoStacks = new Map(); // studyId → operações desfazíveis (só nesta sessão)

let requestSync = () => {};
let onDeleted = () => {};

export function initEditor(opts) {
  requestSync = opts.requestSync || requestSync;
  onDeleted = opts.onDeleted || onDeleted;

  const main = $('editorMain');
  main.addEventListener('input', onFieldInput);
  main.addEventListener('change', onFieldChange);

  $('studyList').addEventListener('change', e => {
    const id = e.target.value;
    if (id && (!current || id !== current.id)) openStudy(id);
  });
  $('qty').addEventListener('input', () => {
    const e = $('qty');
    if (parseNumber(e.value) < 0) e.value = 0;
  });
  $('stageForm').addEventListener('submit', e => { e.preventDefault(); addStage(); });
  $('stageEditForm').addEventListener('submit', e => { e.preventDefault(); saveStageEdit(); });

  const tb = $('recordsTable');
  tb.addEventListener('focusout', onRecordFocusOut);
  tb.addEventListener('keydown', e => {
    if (e.target.matches('td[data-edit]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  tb.addEventListener('change', e => {
    if (e.target.matches('select[data-edit="type"]')) {
      editRecord(e.target.closest('tr').dataset.id, 'type', e.target.value);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current && curTimer.running) requestWakeLock();
  });
}

export function getCurrent() { return current; }
export function isUnsaved() { return unsaved; }
export function hasPendingEdits() { return !!pendingSave; }

/* ---------- Abrir / novo / fechar ---------- */
export function openStudy(id) {
  flush();
  const s = storage.getStudy(id);
  if (!s) { showToast('Estudo não encontrado'); return false; }
  current = s;
  unsaved = false;
  curTimer = storage.getTimer(id) || T.newTimer();
  enter();
  return true;
}

export function newStudy() {
  flush();
  current = createStudy({ id: uid('study') });
  unsaved = true;
  curTimer = T.newTimer();
  enter();
  $('studyName').focus();
}

function enter() {
  lastTap = { at: 0, stageId: null };
  $('qty').value = 1;
  showTab('crono');
  renderAll();
  startTick();
  if (curTimer.running) requestWakeLock();
}

export function close() {
  flush();
  current = null;
  unsaved = false;
  stopTick();
  releaseWakeLock();
}

/* ---------- Gravação ---------- */
function addHistory(text) {
  current.history.push({ ts: new Date().toISOString(), text });
  if (current.history.length > HISTORY_LIMIT) current.history.splice(0, current.history.length - HISTORY_LIMIT);
}

export function persist(historyText) {
  if (!current) return;
  clearTimeout(pendingSave);
  pendingSave = null;
  if (historyText) addHistory(historyText);
  if (!current.name.trim()) {
    current.name = autoStudyName();
    if (document.activeElement !== $('studyName')) $('studyName').value = current.name;
  }
  current.updatedAt = new Date().toISOString();
  if (storage.putStudy(current)) {
    unsaved = false;
    requestSync();
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
  if (!current) return;
  const t = storage.getTimer(current.id);
  if (t) { curTimer = t; updateTimerUI(); }
  if (!pendingSave && !unsaved) { // edição local em andamento vence
    const s = storage.getStudy(current.id);
    if (!s) {
      showToast('Este estudo foi excluído em outro aparelho');
      onDeleted();
      return;
    }
    if (Date.parse(s.updatedAt) > Date.parse(current.updatedAt)) {
      current = s;
      renderAll();
      showToast('Estudo atualizado com alterações de outro aparelho');
      return;
    }
  }
  renderStudyList();
}

/* ---------- Campos do estudo ---------- */
function onFieldInput(e) {
  const f = e.target.dataset.field;
  if (!f || !current) return;
  const v = e.target.value;
  if (f === 'rating' || f === 'allowance') {
    const trimmed = v.trim();
    const n = parseNumber(trimmed);
    if (trimmed === '') delete current[f];
    else if (f === 'rating' ? n > 0 : n >= 0) current[f] = n;
    refresh();
  } else {
    current[f] = v;
    if (f === 'name') $('printTitle').textContent = v;
  }
  scheduleSave();
}

function onFieldChange(e) {
  const f = e.target.dataset.field;
  if (!f || !current) return;
  if (f === 'name') {
    const trimmed = current.name.trim();
    if (trimmed !== current.name) { current.name = trimmed; scheduleSave(); }
    const dup = storage.listStudies().some(s => s.id !== current.id && s.name.trim().toLowerCase() === current.name.toLowerCase());
    if (dup) showToast('Atenção: já existe outro estudo com este nome');
  }
  flush();
  if (f === 'name' && !$('studyName').value.trim()) $('studyName').value = current.name;
}

/* ---------- Cronômetro ---------- */
function saveTimer() {
  if (current) storage.setTimer(current.id, curTimer);
}

export function startTimer() {
  if (!current) return;
  if (unsaved) persist();
  curTimer = T.start(curTimer, Date.now());
  saveTimer();
  updateTimerUI();
  requestWakeLock();
}

export function pauseTimer() {
  if (!current) return;
  curTimer = T.pause(curTimer, Date.now());
  saveTimer();
  updateTimerUI();
  releaseWakeLock();
}

export function toggleTimer() {
  if (curTimer.running) pauseTimer(); else startTimer();
}

export function resetTimer() {
  if (!current || T.isIdle(curTimer)) return;
  pushUndo({ type: 'reset', prevTimer: curTimer });
  curTimer = T.newTimer();
  saveTimer();
  updateTimerUI();
  renderLastMark();
  releaseWakeLock();
  showToast('Cronômetro zerado — use ↶ Desfazer se foi sem querer');
}

export function newCycle() {
  if (!current) return;
  pushUndo({ type: 'cycle', prevCycle: current.currentCycle, prevLastMark: curTimer.lastMark });
  current.currentCycle++;
  curTimer = T.newCycle(curTimer, Date.now());
  saveTimer();
  $('qty').value = 1;
  persist();
  $('cycle').textContent = current.currentCycle;
  renderLastMark();
  updateTimerUI();
}

function updateTimerUI() {
  if (!current) return;
  const now = Date.now();
  const elapsed = T.elapsedOf(curTimer, now);
  $('timer').textContent = fmtClock(elapsed);
  $('liveElement').textContent = toBR(T.liveSeconds(curTimer, now), 1) + 's';
  const start = $('btnStart');
  start.disabled = curTimer.running;
  start.textContent = !curTimer.running && elapsed > 0 ? '▶ Retomar' : '▶ Iniciar';
  $('btnPause').disabled = !curTimer.running;
}

function startTick() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (current && curTimer.running && document.visibilityState === 'visible') updateTimerUI();
  }, 100);
}

function stopTick() {
  clearInterval(tickHandle);
  tickHandle = null;
}

/* Wake Lock: mantém a tela acesa durante a coleta */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* não crítico se não houver suporte */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/* ---------- Quantidade ---------- */
export function changeQty(delta) {
  const e = $('qty');
  e.value = Math.max(0, parseNumber(e.value) + delta);
}

function readQty() {
  const raw = $('qty').value.trim();
  const n = parseFloat(raw.replace(',', '.'));
  return raw === '' || isNaN(n) ? 1 : Math.max(0, n);
}

/* ---------- Marcação ---------- */
export function markStage(stageId) {
  if (!current) return;
  const stage = current.stages.find(s => s.id === stageId);
  if (!stage) return;
  const now = Date.now();
  if (!curTimer.running && T.liveSeconds(curTimer, now) < 0.05) {
    showToast('Inicie o cronômetro (▶) antes de marcar as etapas');
    return;
  }
  if (lastTap.stageId === stageId && now - lastTap.at < DOUBLE_TAP_MS) return; // toque duplo acidental
  lastTap = { at: now, stageId };

  const { timer, seconds } = T.mark(curTimer, now);
  const qtyEl = $('qty');
  const record = {
    id: uid('r'),
    cycle: current.currentCycle,
    stageId: stage.id,
    stageName: stage.name,
    type: stage.type,
    time: seconds,
    qty: readQty(),
    ts: new Date(now).toISOString()
  };
  current.records.push(record);
  pushUndo({ type: 'mark', recordId: record.id, prevLastMark: curTimer.lastMark, prevQty: qtyEl.value });
  curTimer = timer;
  saveTimer();
  qtyEl.value = 1;
  flashStage(stageId);
  persist();
  refresh();
  renderLastMark();
  updateTimerUI();
}

export function markStageByIndex(i) {
  if (current && current.stages[i]) markStage(current.stages[i].id);
}

function flashStage(id) {
  const el = document.querySelector('.stage-wrap[data-id="' + CSS.escape(id) + '"] .stage');
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 350);
}

/* ---------- Desfazer ---------- */
function pushUndo(op) {
  if (!current) return;
  const stack = undoStacks.get(current.id) || [];
  stack.push(op);
  if (stack.length > UNDO_LIMIT) stack.shift();
  undoStacks.set(current.id, stack);
}

function describeUndo(op) {
  if (!op) return 'Nada para desfazer';
  if (op.type === 'mark') {
    const r = current.records.find(x => x.id === op.recordId);
    return 'Desfazer marcação' + (r ? ' "' + r.stageName + '" (' + toBR(r.time) + ' s)' : '');
  }
  if (op.type === 'cycle') return 'Desfazer novo ciclo';
  if (op.type === 'reset') return 'Desfazer zerar cronômetro';
  if (op.type === 'delete-record') return 'Desfazer exclusão de registro';
  return 'Desfazer';
}

export function undo() {
  if (!current) return;
  const stack = undoStacks.get(current.id) || [];
  const op = stack.pop();
  if (!op) return;
  let msg = 'Desfeito';
  if (op.type === 'mark') {
    current.records = current.records.filter(r => r.id !== op.recordId);
    curTimer = { ...curTimer, lastMark: op.prevLastMark }; // o tempo volta para o elemento atual
    $('qty').value = op.prevQty;
    lastTap = { at: 0, stageId: null };
    msg = 'Marcação desfeita';
  } else if (op.type === 'cycle') {
    current.currentCycle = op.prevCycle;
    curTimer = { ...curTimer, lastMark: op.prevLastMark };
    msg = 'Novo ciclo desfeito';
  } else if (op.type === 'reset') {
    curTimer = op.prevTimer;
    msg = 'Cronômetro restaurado';
    if (curTimer.running) requestWakeLock();
  } else if (op.type === 'delete-record') {
    current.records.splice(Math.min(op.index, current.records.length), 0, op.record);
    msg = 'Registro restaurado';
  }
  saveTimer();
  persist();
  $('cycle').textContent = current.currentCycle;
  refresh();
  renderLastMark();
  updateTimerUI();
  showToast(msg);
}

function renderLastMark() {
  if (!current) return;
  const stack = undoStacks.get(current.id) || [];
  const top = stack[stack.length - 1];
  const btn = $('btnUndo');
  btn.disabled = !top;
  btn.title = describeUndo(top);
  btn.setAttribute('aria-label', describeUndo(top));
  const last = current.records[current.records.length - 1];
  $('lastMarkText').innerHTML = last
    ? 'Última: <b>' + escapeHtml(last.stageName) + '</b> — ' + toBR(last.time) + ' s · ciclo ' + last.cycle
    : 'Nenhuma marcação ainda';
}

/* ---------- Etapas ---------- */
function addStage() {
  const nameEl = $('stageName');
  const n = nameEl.value.trim();
  if (!n) { nameEl.focus(); return; }
  current.stages.push({ id: uid('st'), name: n, type: $('stageType').value });
  nameEl.value = '';
  nameEl.focus();
  persist('Etapa "' + n + '" adicionada');
  renderStages();
}

export function removeStage(id) {
  const s = current.stages.find(x => x.id === id);
  if (!s) return;
  if (!confirm('Remover esta etapa da lista de captura? Os registros já marcados com ela são mantidos.')) return;
  current.stages = current.stages.filter(x => x.id !== id);
  persist('Etapa "' + s.name + '" removida');
  renderStages();
  refresh();
}

export function openStageEdit(id) {
  const s = current.stages.find(x => x.id === id);
  if (!s) return;
  editingStageId = id;
  $('editStageName').value = s.name;
  $('editStageType').value = s.type;
  $('editStageOutput').checked = !!s.countsOutput;
  openModal('stageEditModal', { focus: 'editStageName', onClose: () => { editingStageId = null; } });
}

function saveStageEdit() {
  const s = current && current.stages.find(x => x.id === editingStageId);
  if (!s) { closeModal(); return; }
  const newName = $('editStageName').value.trim();
  if (!newName) { $('editStageName').focus(); return; }
  const newType = $('editStageType').value;
  const oldName = s.name;
  s.name = newName;
  s.type = newType;
  if ($('editStageOutput').checked) s.countsOutput = true; else delete s.countsOutput;
  current.records.forEach(r => {
    if (r.stageId === s.id) { r.stageName = newName; r.type = newType; }
  });
  closeModal();
  persist(oldName !== newName
    ? 'Etapa "' + oldName + '" renomeada para "' + newName + '"'
    : 'Etapa "' + newName + '" editada');
  renderStages();
  refresh();
  renderLastMark();
}

function renderStages() {
  const wrap = $('stages');
  wrap.innerHTML = '';
  if (!current.stages.length) {
    wrap.innerHTML = '<p class="empty">Nenhuma etapa cadastrada ainda. Adicione as etapas do processo acima.</p>';
    return;
  }
  current.stages.forEach((s, i) => {
    const wrapDiv = document.createElement('div');
    wrapDiv.className = 'stage-wrap';
    wrapDiv.dataset.id = s.id;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stage type-' + s.type.toLowerCase();
    btn.dataset.action = 'mark';
    btn.dataset.id = s.id;
    const name = document.createElement('span');
    name.className = 'stage-name';
    name.textContent = s.name;
    const type = document.createElement('span');
    type.className = 'stage-type';
    type.textContent = s.type + (s.countsOutput ? ' · 📦 produção' : '');
    btn.append(name, type);
    if (i < 9) {
      const key = document.createElement('span');
      key.className = 'stage-key';
      key.textContent = String(i + 1);
      key.setAttribute('aria-hidden', 'true');
      btn.append(key);
    }

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'stage-remove';
    rm.title = 'Remover etapa';
    rm.setAttribute('aria-label', 'Remover etapa ' + s.name);
    rm.textContent = '✕';
    rm.dataset.action = 'remove-stage';
    rm.dataset.id = s.id;

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'stage-edit';
    edit.title = 'Editar etapa';
    edit.setAttribute('aria-label', 'Editar etapa ' + s.name);
    edit.textContent = '✎';
    edit.dataset.action = 'edit-stage';
    edit.dataset.id = s.id;

    wrapDiv.append(btn, rm, edit);
    wrap.appendChild(wrapDiv);
  });
}

/* ---------- Registros ---------- */
function onRecordFocusOut(e) {
  const td = e.target;
  if (!td.matches || !td.matches('td[data-edit]')) return;
  const tr = td.closest('tr');
  // guarda para onde o foco foi, para devolvê-lo após redesenhar a tabela
  const next = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('#recordsTable [data-edit]');
  const nextRef = next ? { id: next.closest('tr').dataset.id, field: next.dataset.edit } : null;
  editRecord(tr.dataset.id, td.dataset.edit, td.innerText);
  if (nextRef) {
    const row = $('recordsTable').querySelector('tr[data-id="' + CSS.escape(nextRef.id) + '"]');
    const cell = row && row.querySelector('[data-edit="' + nextRef.field + '"]');
    if (cell) cell.focus();
  }
}

function editRecord(id, field, value) {
  const r = current.records.find(x => x.id === id);
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
  }
  if (changed) persist();
  refresh();
  renderLastMark();
}

export function deleteRecord(id) {
  const index = current.records.findIndex(r => r.id === id);
  if (index < 0) return;
  const [record] = current.records.splice(index, 1);
  pushUndo({ type: 'delete-record', record, index });
  persist('Registro excluído');
  refresh();
  renderLastMark();
  showToast('Registro excluído — use ↶ Desfazer se foi sem querer');
}

export function toggleExclude(id) {
  const r = current.records.find(x => x.id === id);
  if (!r) return;
  if (r.excluded) delete r.excluded; else r.excluded = true;
  persist(r.excluded ? 'Registro ignorado nos cálculos' : 'Registro voltou aos cálculos');
  refresh();
}

function renderRecords(stats) {
  const tb = $('recordsTable');
  if (!current.records.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">Sem registros ainda</td></tr>';
    return;
  }
  tb.innerHTML = current.records.map(r => {
    const typeOptions = TYPES.map(t => '<option' + (t === r.type ? ' selected' : '') + '>' + t + '</option>').join('');
    const outlier = stats.outliers.has(r.id);
    return '<tr data-id="' + escapeHtml(r.id) + '"' + (r.excluded ? ' class="excluded"' : '') + '>' +
      '<td>' + r.cycle + '</td>' +
      '<td contenteditable="true" data-edit="stageName">' + escapeHtml(r.stageName) + '</td>' +
      '<td><select data-edit="type" aria-label="Tipo">' + typeOptions + '</select></td>' +
      '<td contenteditable="true" data-edit="time" inputmode="decimal"' +
        (outlier ? ' class="outlier" title="Fora de ±2σ da média desta etapa — confira se não foi um toque errado"' : '') + '>' +
        toBR(r.time) + (outlier ? ' ⚠' : '') + '</td>' +
      '<td contenteditable="true" data-edit="qty" inputmode="decimal">' + toBR(r.qty ?? 1, 0) + '</td>' +
      '<td class="muted">' + escapeHtml(fmtTimeOfDay(r.ts)) + '</td>' +
      '<td class="no-print"><div class="row-actions">' +
        '<button type="button" data-action="toggle-exclude" title="' + (r.excluded ? 'Voltar a considerar nos cálculos' : 'Ignorar nos cálculos (sem excluir)') + '">' +
          (r.excluded ? 'Considerar' : 'Ignorar') + '</button>' +
        '<button type="button" class="danger" data-action="delete-record">Excluir</button>' +
      '</div></td></tr>';
  }).join('');
}

/* ---------- Indicadores ---------- */
function kpi(label, value, note, small) {
  return '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-val' + (small ? ' small' : '') + '">' + value + '</span>' +
    (note ? '<span class="kpi-note">' + note + '</span>' : '') + '</div>';
}

function renderStats(st) {
  let kpis =
    kpi('Tempo Total', toBR(st.total) + 's') +
    kpi('Quantidade Total', toBR(st.qtyTotal, 0), st.usesOutputStages ? 'só etapas 📦 de produção' : '') +
    kpi('Produtividade', toBR(st.productivity) + '/h') +
    kpi('% Valor Agregado', toBR(st.vaPct, 1) + '%') +
    kpi('Ciclos', String(st.cycleCount)) +
    kpi('Tempo Médio de Ciclo', toBR(st.avgCycle) + 's');
  if (st.hasStdParams) kpis += kpi('Tempo Padrão de Ciclo', toBR(st.stdCycle) + 's', 'ritmo ' + toBR(st.rating, 0) + '% · tol. ' + toBR(st.allowance, 0) + '%');

  const bars = TYPES.map(t => {
    const v = st.byType[t] || 0;
    const pct = st.total > 0 ? v / st.total * 100 : 0;
    return '<div class="typebar-row">' +
      '<span class="typebar-label">' + t + '</span>' +
      '<div class="typebar-track"><div class="typebar-fill fill-' + t.toLowerCase() + '" style="width:' + pct.toFixed(2) + '%"></div></div>' +
      '<span class="typebar-val">' + toBR(v) + 's (' + toBR(pct, 1) + '%)</span>' +
    '</div>';
  }).join('');

  const std = st.hasStdParams;
  const rows = st.summary.map(s => {
    let nCell = '—';
    if (s.nRequired !== null) {
      nCell = s.enough
        ? '<span class="ok" title="Amostra suficiente">' + s.nRequired + ' ✓</span>'
        : '<span class="warn" title="Faltam ' + (s.nRequired - s.count) + ' ocorrência(s)">' + s.nRequired + '</span>';
    }
    return '<tr><td>' + escapeHtml(s.name) + '</td>' +
      '<td><span class="badge type-' + escapeHtml(String(s.type).toLowerCase()) + '">' + escapeHtml(s.type) + '</span></td>' +
      '<td>' + s.count + '</td>' +
      '<td>' + toBR(s.total) + '</td>' +
      '<td>' + toBR(s.avg) + '</td>' +
      '<td>' + toBR(s.min) + '</td>' +
      '<td>' + toBR(s.max) + '</td>' +
      '<td>' + toBR(s.sd) + '</td>' +
      '<td>' + toBR(s.cv, 1) + '</td>' +
      '<td>' + nCell + '</td>' +
      '<td>' + toBR(s.qty, 0) + '</td>' +
      '<td>' + toBR(s.productivity) + '</td>' +
      (std ? '<td>' + toBR(s.normal) + '</td><td>' + toBR(s.standard) + '</td>' : '') +
      '</tr>';
  }).join('');
  const cols = std ? 14 : 12;

  const notes = [
    'n nec. = ciclos necessários para ' + st.confidence + '% de confiança e erro de ±' + st.errorPct + '% (ajuste em Configurações). ✓ = amostra suficiente.'
  ];
  if (st.outliers.size) notes.push(st.outliers.size + ' registro(s) marcado(s) com ⚠ estão fora de ±2σ da média da etapa.');
  if (st.excludedCount) notes.push(st.excludedCount + ' registro(s) ignorado(s) nos cálculos.');

  $('stats').innerHTML =
    '<div class="kpi-grid">' + kpis + '</div>' +
    '<div class="typebar-wrap">' + bars + '</div>' +
    '<div class="table-wrap"><table class="summary-table"><thead><tr>' +
      '<th>Etapa</th><th>Tipo</th><th>Ocorr.</th><th>Total(s)</th><th>Média(s)</th><th>Mín(s)</th><th>Máx(s)</th>' +
      '<th title="Desvio padrão">DP(s)</th><th title="Coeficiente de variação">CV%</th><th title="Ciclos necessários">n nec.</th>' +
      '<th>Qtd</th><th>un/h</th>' + (std ? '<th>T. Normal(s)</th><th>T. Padrão(s)</th>' : '') +
    '</tr></thead><tbody>' + (rows || '<tr><td colspan="' + cols + '" class="empty">Sem registros ainda</td></tr>') + '</tbody></table></div>' +
    '<p class="hint" style="margin:10px 0 0">' + notes.join('<br>') + '</p>';
}

/* Recalcula e redesenha indicadores + registros. */
export function refresh() {
  if (!current) return;
  const st = computeStats(current, storage.getPrefs());
  renderRecords(st);
  renderStats(st);
}

/* ---------- Histórico / metadados / lista ---------- */
function renderHistory() {
  const el = $('historyTimeline');
  const hist = current.history || [];
  if (!hist.length) { el.innerHTML = '<p class="empty">Sem eventos registrados ainda.</p>'; return; }
  el.innerHTML = hist.slice().reverse().map(h =>
    '<div class="history-item"><div class="history-time">' + fmtDate(h.ts) + '</div><div class="history-text">' + escapeHtml(h.text) + '</div></div>'
  ).join('');
}

function renderStudyMeta() {
  if (!current) return;
  $('studyMetaLine').textContent = unsaved
    ? 'Novo estudo — será salvo automaticamente na primeira alteração.'
    : 'Criado: ' + fmtDate(current.createdAt) + '  ·  Última edição: ' + fmtDate(current.updatedAt);
  if (!$('editorHistory').hidden) renderHistory();
}

function renderStudyList() {
  const sel = $('studyList');
  const studies = storage.listStudies().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  sel.innerHTML = '<option value="">Selecione um estudo salvo…</option>' +
    studies.map(s => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>').join('');
  sel.value = current && !unsaved ? current.id : '';
}

function renderFields() {
  const set = (id, v) => { const el = $(id); if (el.value !== v) el.value = v; };
  set('studyName', current.name);
  set('process', current.process);
  set('operator', current.operator);
  set('observer', current.observer);
  set('notes', current.notes);
  const num = v => (v !== undefined ? String(v).replace('.', ',') : '');
  if (document.activeElement !== $('rating')) set('rating', num(current.rating));
  if (document.activeElement !== $('allowance')) set('allowance', num(current.allowance));
  if (current.rating !== undefined || current.allowance !== undefined) $('stdParams').open = true;
  $('printTitle').textContent = current.name;
  $('cycle').textContent = current.currentCycle;
}

function renderAll() {
  if (!current) return;
  renderFields();
  renderStages();
  refresh();
  renderStudyMeta();
  renderStudyList();
  renderHistory();
  renderLastMark();
  updateTimerUI();
}

export function showTab(tab) {
  const hist = tab === 'hist';
  $('editorMain').hidden = hist;
  $('editorHistory').hidden = !hist;
  $('tabCrono').classList.toggle('active', !hist);
  $('tabHist').classList.toggle('active', hist);
  $('tabCrono').setAttribute('aria-selected', String(!hist));
  $('tabHist').setAttribute('aria-selected', String(hist));
  if (hist && current) renderHistory();
}

/* ---------- Excluir / exportar / imprimir ---------- */
export function deleteCurrent() {
  if (!current) return;
  if (!confirm('Excluir permanentemente o estudo "' + current.name + '"? Esta ação não pode ser desfeita.')) return;
  const id = current.id;
  const wasUnsaved = unsaved;
  clearTimeout(pendingSave);
  pendingSave = null;
  current = null;
  unsaved = false;
  if (!wasUnsaved) {
    storage.removeStudy(id);
    requestSync();
  }
  storage.removeTimer(id);
  undoStacks.delete(id);
  showToast('Estudo excluído');
  onDeleted();
}

export function forgetStudy(id) {
  undoStacks.delete(id);
}

export function exportCSV() {
  if (!current) return;
  flush();
  const st = computeStats(current, storage.getPrefs());
  const csv = buildCSV(current, st);
  downloadFile(safeFilename(current.name || 'Estudo') + '.csv', '﻿' + csv, 'text/csv;charset=utf-8;');
  persist('Exportado CSV');
  showToast('CSV exportado');
}

export function printStudy() {
  if (!current) return;
  flush();
  showTab('crono');
  $('printTitle').textContent = current.name;
  window.print();
}

export function saveNow() {
  if (!current) return;
  persist();
}

export function labels() {
  document.querySelectorAll('[data-label]').forEach(el => {
    const k = el.dataset.label;
    if (FIELD_LABELS[k]) el.textContent = FIELD_LABELS[k];
  });
  ['operator', 'observer'].forEach(k => { $(k).placeholder = FIELD_LABELS[k]; });
}
