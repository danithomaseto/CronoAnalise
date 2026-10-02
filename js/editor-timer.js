/* Editor — cronômetro, marcações, interrupções e desfazer. */

import * as storage from './storage.js';
import * as T from './core/timer.js';
import { toBR, fmtClock, escapeHtml, parseNumber, uid } from './core/format.js';
import { $, showToast } from './ui.js';
import { S, persist, refresh, touchField, nowIso } from './editor.js';

const UNDO_LIMIT = 50;
const DOUBLE_TAP_MS = 300;

let cur = T.newTimer();
let tickHandle = null;
let wakeLock = null;
let lastTap = { at: 0, stageId: null };
const undoStacks = new Map(); // studyId → operações desfazíveis (só nesta sessão)

export function init() {
  $('qty').addEventListener('input', () => {
    const e = $('qty');
    if (parseNumber(e.value) < 0) e.value = 0;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.current && cur.running) requestWakeLock();
  });
}

export function enter() {
  cur = storage.getTimer(S.current.id) || T.newTimer();
  lastTap = { at: 0, stageId: null };
  $('qty').value = 1;
  startTick();
  if (cur.running) requestWakeLock();
}

export function leave() {
  stopTick();
  releaseWakeLock();
}

export function reloadFromStorage() {
  const t = S.current && storage.getTimer(S.current.id);
  if (t) { cur = t; updateUI(); }
}

export function forget(id) {
  undoStacks.delete(id);
}

function save() {
  if (S.current) storage.setTimer(S.current.id, cur);
}

/* ---------- Controles ---------- */
export function start() {
  if (!S.current || S.readonly) return;
  if (S.unsaved) persist();
  cur = T.start(cur, Date.now());
  save();
  updateUI();
  requestWakeLock();
}

export function pause() {
  if (!S.current || S.readonly) return;
  cur = T.pause(cur, Date.now());
  save();
  updateUI();
  releaseWakeLock();
}

export function toggle() {
  if (cur.running) pause(); else start();
}

export function reset() {
  if (!S.current || S.readonly || T.isIdle(cur)) return;
  pushUndo({ type: 'reset', prevTimer: cur });
  cur = T.newTimer();
  save();
  updateUI();
  renderLastMark();
  releaseWakeLock();
  showToast('Cronômetro zerado — use ↶ Desfazer se foi sem querer');
}

export function newCycle() {
  if (!S.current || S.readonly) return;
  pushUndo({ type: 'cycle', prevCycle: S.current.currentCycle, prevLastMark: cur.lastMark });
  S.current.currentCycle++;
  touchField('currentCycle');
  cur = T.newCycle(cur, Date.now());
  save();
  $('qty').value = 1;
  persist();
  $('cycle').textContent = S.current.currentCycle;
  renderLastMark();
  updateUI();
}

export function lastRecordId() {
  const recs = S.current ? S.current.records : [];
  return recs.length ? recs[recs.length - 1].id : null;
}

export function updateUI() {
  if (!S.current) return;
  const now = Date.now();
  const elapsed = T.elapsedOf(cur, now);
  $('timer').textContent = fmtClock(elapsed);
  $('liveElement').textContent = toBR(T.liveSeconds(cur, now), 1) + 's';
  const startBtn = $('btnStart');
  startBtn.disabled = cur.running || S.readonly;
  startBtn.textContent = !cur.running && elapsed > 0 ? '▶ Retomar' : '▶ Iniciar';
  $('btnPause').disabled = !cur.running || S.readonly;
}

function startTick() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (S.current && cur.running && document.visibilityState === 'visible') updateUI();
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

function vibrate() {
  try {
    if (storage.getPrefs().vibrate !== false && navigator.vibrate) navigator.vibrate(25);
  } catch (e) { /* sem suporte */ }
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
function canMark(key) {
  if (!S.current || S.readonly) return false;
  const now = Date.now();
  if (!cur.running && T.liveSeconds(cur, now) < 0.05) {
    showToast('Inicie o cronômetro (▶) antes de marcar as etapas');
    return false;
  }
  if (lastTap.stageId === key && now - lastTap.at < DOUBLE_TAP_MS) return false; // toque duplo acidental
  lastTap = { at: now, stageId: key };
  return now;
}

function addRecord(record, now, flashSel) {
  const qtyEl = $('qty');
  const { timer: next, seconds } = T.mark(cur, now);
  record.id = uid('r');
  record.cycle = S.current.currentCycle;
  record.time = seconds;
  record.ts = new Date(now).toISOString();
  S.current.records.push(record);
  pushUndo({ type: 'mark', recordId: record.id, prevLastMark: cur.lastMark, prevQty: qtyEl.value });
  cur = next;
  save();
  qtyEl.value = 1;
  vibrate();
  if (flashSel) flash(flashSel);
  persist();
  refresh();
  renderLastMark();
  updateUI();
}

export function markStage(stageId) {
  const stage = S.current && S.current.stages.find(s => s.id === stageId);
  if (!stage) return;
  const now = canMark(stageId);
  if (!now) return;
  addRecord({ stageId: stage.id, stageName: stage.name, type: stage.type, qty: readQty() }, now,
    '.stage-wrap[data-id="' + CSS.escape(stageId) + '"] .stage');
}

export function markStageByIndex(i) {
  if (S.current && S.current.stages[i]) markStage(S.current.stages[i].id);
}

/* Interrupção (elemento estranho): registra o tempo à parte, fora dos cálculos. */
export function markInterruption() {
  const now = canMark('__interruption');
  if (!now) return;
  addRecord({ stageId: null, stageName: 'Interrupção', type: 'Interrupção', qty: 0, interruption: true }, now, '#btnInterruption');
  showToast('Interrupção registrada — use 📝 para anotar o motivo');
}

function flash(sel) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 350);
}

/* Observação na última marcação (ex.: motivo da interrupção). */
export function noteLast() {
  if (!S.current || S.readonly) return;
  const last = S.current.records[S.current.records.length - 1];
  if (!last) { showToast('Nenhuma marcação para anotar'); return; }
  const text = prompt('Observação para "' + last.stageName + '" (ciclo ' + last.cycle + '):', last.note || '');
  if (text === null) return;
  const v = text.trim();
  if (v) last.note = v; else delete last.note;
  last.u = nowIso();
  persist();
  refresh();
  renderLastMark();
}

/* ---------- Desfazer ---------- */
export function pushUndo(op) {
  if (!S.current) return;
  const stack = undoStacks.get(S.current.id) || [];
  stack.push(op);
  if (stack.length > UNDO_LIMIT) stack.shift();
  undoStacks.set(S.current.id, stack);
}

function describeUndo(op) {
  if (!op) return 'Nada para desfazer';
  if (op.type === 'mark') {
    const r = S.current.records.find(x => x.id === op.recordId);
    return 'Desfazer marcação' + (r ? ' "' + r.stageName + '" (' + toBR(r.time) + ' s)' : '');
  }
  if (op.type === 'cycle') return 'Desfazer novo ciclo';
  if (op.type === 'reset') return 'Desfazer zerar cronômetro';
  if (op.type === 'delete-record') return 'Desfazer exclusão de registro';
  return 'Desfazer';
}

function tombstoneRecord(id) {
  S.current.deletedRecords = { ...(S.current.deletedRecords || {}), [id]: nowIso() };
}

export function undo() {
  if (!S.current || S.readonly) return;
  const stack = undoStacks.get(S.current.id) || [];
  const op = stack.pop();
  if (!op) return;
  let msg = 'Desfeito';
  if (op.type === 'mark') {
    S.current.records = S.current.records.filter(r => r.id !== op.recordId);
    tombstoneRecord(op.recordId);
    cur = { ...cur, lastMark: op.prevLastMark }; // o tempo volta para o elemento atual
    $('qty').value = op.prevQty;
    lastTap = { at: 0, stageId: null };
    msg = 'Marcação desfeita';
  } else if (op.type === 'cycle') {
    S.current.currentCycle = op.prevCycle;
    touchField('currentCycle');
    cur = { ...cur, lastMark: op.prevLastMark };
    msg = 'Novo ciclo desfeito';
  } else if (op.type === 'reset') {
    cur = op.prevTimer;
    msg = 'Cronômetro restaurado';
    if (cur.running) requestWakeLock();
  } else if (op.type === 'delete-record') {
    // a data de edição precisa ser posterior à exclusão para vencer na mesclagem
    const t = new Date(Math.max(Date.now(), Date.parse((S.current.deletedRecords || {})[op.record.id] || 0) + 1)).toISOString();
    S.current.records.splice(Math.min(op.index, S.current.records.length), 0, { ...op.record, u: t });
    if (S.current.deletedRecords) delete S.current.deletedRecords[op.record.id];
    msg = 'Registro restaurado';
  }
  save();
  persist();
  $('cycle').textContent = S.current.currentCycle;
  refresh();
  renderLastMark();
  updateUI();
  showToast(msg);
}

export function renderLastMark() {
  if (!S.current) return;
  const stack = undoStacks.get(S.current.id) || [];
  const top = stack[stack.length - 1];
  const btn = $('btnUndo');
  btn.disabled = !top || S.readonly;
  btn.title = describeUndo(top);
  btn.setAttribute('aria-label', describeUndo(top));
  const last = S.current.records[S.current.records.length - 1];
  $('btnNote').disabled = !last || S.readonly;
  $('btnPhoto').disabled = !last || S.readonly;
  $('lastMarkText').innerHTML = last
    ? 'Última: <b>' + escapeHtml(last.stageName) + '</b> — ' + toBR(last.time) + ' s · ciclo ' + last.cycle +
      (last.note ? ' · 📝 ' + escapeHtml(last.note) : '') + ((last.photos || []).length ? ' · 📷 ' + last.photos.length : '')
    : 'Nenhuma marcação ainda';
}
