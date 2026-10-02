/* Editor — amostragem do trabalho (estudos com kind = 'sampling'):
   categorias, roteiro de horários aleatórios, registro das observações,
   resultados (% por categoria, IC, n necessário) e lista de observações. */

import * as storage from './storage.js';
import { randomSchedule, normalizePlan } from './core/sampling.js';
import { samplingSVG } from './core/charts.js';
import { toBR, escapeHtml, uid, fmtTimeOfDay } from './core/format.js';
import { nextStagePos } from './core/model.js';
import { $, showToast } from './ui.js';
import { bindTips } from './chart-tips.js';
import { S, persist, nowIso, touchField, getStats, invalidateStats } from './editor.js';

const DUE_WINDOW_MIN = 3;
let ticker = null;
let alerted = new Set();   // horários já avisados hoje
let resizeTimer = null;
const undoStacks = new Map();

export function init() {
  bindTips($('samplingStats'));
  $('catForm').addEventListener('submit', e => { e.preventDefault(); addCategory(); });
  $('samplingCats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (b) observe(b.dataset.cat);
  });
  $('catList').addEventListener('change', e => {
    const id = e.target.closest('tr') && e.target.closest('tr').dataset.id;
    if (!id) return;
    if (e.target.matches('input[data-cat-name]')) renameCategory(id, e.target.value);
    if (e.target.matches('input[data-cat-prod]')) setProductive(id, e.target.checked);
  });
  $('catList').addEventListener('click', e => {
    const b = e.target.closest('[data-cat-remove]');
    if (b) removeCategory(b.closest('tr').dataset.id);
  });
  ['planStart', 'planEnd', 'planCount'].forEach(id => $(id).addEventListener('change', savePlan));
  $('obsTable').addEventListener('click', e => {
    const b = e.target.closest('[data-obs-remove]');
    if (b) removeObservation(b.closest('tr').dataset.id);
  });
  $('obsTable').addEventListener('change', e => {
    if (e.target.matches('select[data-obs-cat]')) changeObservationCategory(e.target.closest('tr').dataset.id, e.target.value);
  });
  $('obsTable').addEventListener('focusout', e => {
    if (e.target.matches('td[data-obs-note]')) editNote(e.target.closest('tr').dataset.id, e.target.innerText);
  });
  $('obsTable').addEventListener('keydown', e => {
    if (e.target.matches('td[data-obs-note]') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.blur(); }
  });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(), 150);
  });
}

export function enter() {
  alerted = new Set();
  clearInterval(ticker);
  ticker = setInterval(tick, 15000);
}

export function leave() {
  clearInterval(ticker);
  ticker = null;
}

const today = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
const minutesNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; };
const toMin = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function schedule() {
  const plan = S.current && S.current.samplingPlan;
  return plan ? randomSchedule(plan, S.current.id + '|' + today()) : [];
}

/* Horário observado hoje depois do horário sorteado (até a próxima marcação)? */
function observedSince(min) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const t0 = start.getTime() + min * 60000;
  return (S.current.observations || []).some(o => { const t = Date.parse(o.ts); return t >= t0 - 30000 && t <= t0 + DUE_WINDOW_MIN * 60000 + 120000; });
}

function tick() {
  if (!S.current || S.current.kind !== 'sampling') return;
  renderNext();
}

function renderNext() {
  const el = $('samplingNext');
  const list = schedule();
  if (!list.length) { el.textContent = 'Defina o roteiro (início, fim e quantidade) para sortear os horários.'; el.classList.remove('due'); return; }
  const now = minutesNow();
  const due = list.find(h => now >= toMin(h) && now <= toMin(h) + DUE_WINDOW_MIN && !observedSince(toMin(h)));
  const next = list.find(h => toMin(h) > now);
  el.classList.toggle('due', !!due);
  if (due) {
    el.textContent = '⏰ Hora de observar (' + due + ')! Olhe agora e toque na categoria.';
    if (!alerted.has(due) && !S.readonly) {
      alerted.add(due);
      showToast('⏰ Hora da observação das ' + due, 5000);
      try { if (storage.getPrefs().vibrate !== false && navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* sem suporte */ }
    }
  } else if (next) {
    const mins = Math.max(1, Math.round(toMin(next) - now));
    el.textContent = 'Próxima observação às ' + next + ' (em ' + (mins >= 60 ? Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min' : mins + ' min') + ').';
  } else {
    el.textContent = 'Roteiro de hoje concluído (' + list.length + ' horários).';
  }
  renderPlanList(list, now);
}

function renderPlanList(list, now) {
  const next = list.find(h => toMin(h) + DUE_WINDOW_MIN >= now);
  $('planList').innerHTML = list.map(h =>
    '<span class="plan-chip' + (toMin(h) + DUE_WINDOW_MIN < now ? ' done' : '') + (h === next ? ' next' : '') + '">' + h + '</span>'
  ).join('');
}

/* ---------- Registro ---------- */
function categories() {
  return S.current.categories || [];
}

export function observe(catId) {
  if (!S.current || S.readonly) return;
  const cat = categories().find(c => c.id === catId);
  if (!cat) return;
  if (S.unsaved) persist();
  const o = { id: uid('ob'), ts: nowIso(), cat: cat.id, catName: cat.name, productive: !!cat.productive };
  S.current.observations = [...(S.current.observations || []), o];
  pushUndo({ type: 'obs', id: o.id });
  try { if (storage.getPrefs().vibrate !== false && navigator.vibrate) navigator.vibrate(25); } catch (e) { /* sem suporte */ }
  const btn = document.querySelector('#samplingCats [data-cat="' + CSS.escape(catId) + '"]');
  if (btn) { btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 350); }
  persist();
  render();
}

export function markByIndex(i) {
  const c = categories()[i];
  if (c) observe(c.id);
}

function pushUndo(op) {
  const st = undoStacks.get(S.current.id) || [];
  st.push(op);
  if (st.length > 50) st.shift();
  undoStacks.set(S.current.id, st);
}

export function undo() {
  if (!S.current || S.readonly) return;
  const st = undoStacks.get(S.current.id) || [];
  const op = st.pop();
  if (!op) return;
  if (op.type === 'obs') {
    tombstone(op.id);
    showToast('Observação desfeita');
  }
  persist();
  render();
}

export function noteLast() {
  if (!S.current || S.readonly) return;
  const obs = S.current.observations || [];
  const last = obs[obs.length - 1];
  if (!last) return;
  const text = prompt('Observação para "' + last.catName + '" (' + fmtTimeOfDay(last.ts) + '):', last.note || '');
  if (text === null) return;
  const v = text.trim();
  if (v) last.note = v; else delete last.note;
  last.u = nowIso();
  persist();
  render();
}

function tombstone(id) {
  S.current.observations = (S.current.observations || []).filter(o => o.id !== id);
  S.current.deletedObservations = { ...(S.current.deletedObservations || {}), [id]: nowIso() };
}

function removeObservation(id) {
  if (S.readonly) return;
  if (!confirm('Excluir esta observação?')) return;
  tombstone(id);
  persist('Observação excluída');
  render();
}

function changeObservationCategory(id, catId) {
  if (S.readonly) return;
  const o = (S.current.observations || []).find(x => x.id === id);
  const cat = categories().find(c => c.id === catId);
  if (!o || !cat) return;
  o.cat = cat.id; o.catName = cat.name; o.productive = !!cat.productive; o.u = nowIso();
  persist();
  render();
}

function editNote(id, text) {
  if (S.readonly) return;
  const o = (S.current.observations || []).find(x => x.id === id);
  if (!o) return;
  const v = String(text).trim();
  if (v === (o.note || '')) return;
  if (v) o.note = v; else delete o.note;
  o.u = nowIso();
  persist();
}

/* ---------- Categorias ---------- */
function addCategory() {
  if (S.readonly) return;
  const name = $('catName').value.trim();
  if (!name) { $('catName').focus(); return; }
  const list = categories();
  S.current.categories = [...list, { id: uid('cat'), name, productive: $('catProductive').checked, pos: nextStagePos(list), u: nowIso() }];
  $('catName').value = '';
  $('catProductive').checked = false;
  persist('Categoria "' + name + '" adicionada');
  renderAll();
}

function renameCategory(id, name) {
  const c = categories().find(x => x.id === id);
  const v = String(name).trim();
  if (!c || !v || v === c.name || S.readonly) { renderCategories(); return; }
  const t = nowIso();
  c.name = v; c.u = t;
  (S.current.observations || []).forEach(o => { if (o.cat === id) { o.catName = v; o.u = t; } });
  persist('Categoria renomeada para "' + v + '"');
  renderAll();
}

function setProductive(id, on) {
  const c = categories().find(x => x.id === id);
  if (!c || S.readonly) return;
  const t = nowIso();
  c.productive = !!on; c.u = t;
  (S.current.observations || []).forEach(o => { if (o.cat === id) { o.productive = !!on; o.u = t; } });
  persist();
  renderAll();
}

function removeCategory(id) {
  const c = categories().find(x => x.id === id);
  if (!c || S.readonly) return;
  if (!confirm('Remover a categoria "' + c.name + '"? As observações já feitas continuam contando com esse nome.')) return;
  S.current.categories = categories().filter(x => x.id !== id);
  S.current.deletedCategories = { ...(S.current.deletedCategories || {}), [id]: nowIso() };
  persist('Categoria "' + c.name + '" removida');
  renderAll();
}

function savePlan() {
  if (!S.current || S.readonly) return;
  const plan = normalizePlan({ start: $('planStart').value, end: $('planEnd').value, count: $('planCount').value });
  if (!plan) { showToast('Roteiro inválido: o fim precisa ser depois do início e a quantidade entre 1 e 300'); renderPlanInputs(); return; }
  S.current.samplingPlan = plan;
  touchField('samplingPlan');
  alerted = new Set();
  persist('Roteiro: ' + plan.count + ' observações entre ' + plan.start + ' e ' + plan.end);
  renderNext();
}

/* ---------- Desenho ---------- */
function renderPlanInputs() {
  const p = S.current.samplingPlan || {};
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v ?? ''; };
  set('planStart', p.start || '');
  set('planEnd', p.end || '');
  set('planCount', p.count || '');
  ['planStart', 'planEnd', 'planCount'].forEach(id => { $(id).disabled = S.readonly; });
}

function renderCapture() {
  const wrap = $('samplingCats');
  const cats = categories();
  wrap.innerHTML = cats.length ? cats.map((c, i) =>
    '<button type="button" class="stage ' + (c.productive ? 'cat-productive' : 'cat-other') + '" data-cat="' + escapeHtml(c.id) + '"' + (S.readonly ? ' disabled' : '') + '>' +
      '<span class="stage-name">' + escapeHtml(c.name) + '</span>' +
      '<span class="stage-type">' + (c.productive ? 'produtiva' : 'não produtiva') + '</span>' +
      (i < 9 ? '<span class="stage-key" aria-hidden="true">' + (i + 1) + '</span>' : '') +
    '</button>'
  ).join('') : '<p class="empty">Nenhuma categoria. Adicione as categorias abaixo.</p>';
  const obs = S.current.observations || [];
  const last = obs[obs.length - 1];
  $('samplingLast').innerHTML = last
    ? 'Última: <b>' + escapeHtml(last.catName) + '</b> às ' + escapeHtml(fmtTimeOfDay(last.ts)) + ' · ' + obs.length + ' observação(ões)' + (last.note ? ' · 📝 ' + escapeHtml(last.note) : '')
    : 'Nenhuma observação ainda';
  $('btnSampleNote').disabled = !last || S.readonly;
  $('btnSampleUndo').disabled = !(undoStacks.get(S.current.id) || []).length || S.readonly;
}

function renderCategories() {
  const cats = categories();
  const ro = S.readonly ? ' disabled' : '';
  $('catList').innerHTML = cats.length
    ? '<table class="records"><thead><tr><th>Categoria</th><th>Produtiva</th><th class="no-print"></th></tr></thead><tbody>' +
      cats.map(c => '<tr data-id="' + escapeHtml(c.id) + '">' +
        '<td><input data-cat-name value="' + escapeHtml(c.name) + '" aria-label="Nome da categoria"' + ro + '></td>' +
        '<td><input type="checkbox" data-cat-prod aria-label="Categoria produtiva"' + (c.productive ? ' checked' : '') + ro + '></td>' +
        '<td class="no-print">' + (S.readonly ? '' : '<button type="button" class="danger icon-btn" data-cat-remove title="Remover categoria">✕<span class="rm-label">Remover</span></button>') + '</td></tr>').join('') +
      '</tbody></table>'
    : '';
}

function renderObservations() {
  const obs = (S.current.observations || []).slice().reverse();
  const cats = categories();
  const ed = S.readonly ? '' : ' contenteditable="true"';
  $('obsTable').innerHTML = obs.length ? obs.map(o => {
    const d = new Date(o.ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    const when = (sameDay ? '' : d.toLocaleDateString('pt-BR') + ' ') + fmtTimeOfDay(o.ts);
    const known = cats.some(c => c.id === o.cat);
    const sel = S.readonly || !known
      ? escapeHtml(o.catName)
      : '<select data-obs-cat aria-label="Categoria">' + cats.map(c => '<option value="' + escapeHtml(c.id) + '"' + (c.id === o.cat ? ' selected' : '') + '>' + escapeHtml(c.name) + '</option>').join('') + '</select>';
    return '<tr data-id="' + escapeHtml(o.id) + '"><td class="muted">' + escapeHtml(when) + '</td><td>' + sel + '</td>' +
      '<td><span class="badge ' + (o.productive ? 'yes' : 'no') + '">' + (o.productive ? 'Sim' : 'Não') + '</span></td>' +
      '<td class="note-cell"' + ed + ' data-obs-note data-placeholder="—">' + escapeHtml(o.note || '') + '</td>' +
      '<td class="no-print">' + (S.readonly ? '' : '<button type="button" class="danger" data-obs-remove>Excluir</button>') + '</td></tr>';
  }).join('') : '<tr><td colspan="5" class="empty">Sem observações ainda</td></tr>';
}

function renderStats(forceWidth) {
  const st = getStats();
  const host = $('samplingStats');
  const tip = host.querySelector(':scope > .chart-tip');
  if (!st.n) {
    host.innerHTML = '<p class="empty">Registre as observações para ver os resultados. Com ' + st.errorPts + ' pontos de erro e ' + st.confidence +
      '% de confiança, são necessárias cerca de ' + st.nRequired + ' observações (para 50% produtivo).</p>';
    if (tip) host.appendChild(tip);
    return;
  }
  const width = Math.max(260, Math.min(1000, Math.floor(forceWidth || host.clientWidth || 600)));
  const pct = Math.round(st.progress * 100);
  host.innerHTML =
    '<div class="kpi-grid">' +
      '<div class="kpi"><span class="kpi-label">% Produtivo</span><span class="kpi-val">' + toBR(st.productivePct, 1) + '%</span><span class="kpi-note">IC ' + st.confidence + '%: ' + toBR(st.productiveLo, 1) + '–' + toBR(st.productiveHi, 1) + '%</span></div>' +
      '<div class="kpi"><span class="kpi-label">Observações</span><span class="kpi-val">' + st.n + '</span><span class="kpi-note">de ' + st.nRequired + ' necessárias</span></div>' +
      '<div class="kpi"><span class="kpi-label">Precisão atual</span><span class="kpi-val">±' + toBR(st.halfWidth, 1) + '</span><span class="kpi-note">pontos percentuais (meta ±' + st.errorPts + ')</span></div>' +
      '<div class="kpi"><span class="kpi-label">Amostra</span><span class="kpi-val small">' + (st.enough ? '<span class="status"><span class="ico good">✓</span> suficiente</span>' : '<span class="status"><span class="ico bad">⚠</span> faltam ' + (st.nRequired - st.n) + '</span>') + '</span>' +
        '<div class="progress" role="progressbar" aria-label="Observações feitas" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div></div>' +
    '</div>' +
    '<div class="table-wrap"><table class="summary-table"><thead><tr><th>Categoria</th><th>Produtiva</th><th>Obs.</th><th>%</th><th>IC ' + st.confidence + '%</th>' + (st.availableMin > 0 ? '<th>Min/dia</th>' : '') + '</tr></thead><tbody>' +
      st.categories.map(c => '<tr><td>' + escapeHtml(c.name) + (c.removed ? ' <small class="hint">(removida)</small>' : '') + '</td><td>' + (c.productive ? 'Sim' : 'Não') + '</td><td>' + c.count + '</td>' +
        '<td>' + toBR(c.p * 100, 1) + '</td><td>' + toBR(c.lo * 100, 1) + '–' + toBR(c.hi * 100, 1) + '</td>' +
        (st.availableMin > 0 ? '<td>' + toBR(c.minutes, 0) + '</td>' : '') + '</tr>').join('') +
    '</tbody></table></div>' +
    '<figure class="chart-card"><figcaption><b>Proporção de cada categoria</b><span class="chart-sub">traço: intervalo de confiança de ' + st.confidence + '%</span>' +
      '<div class="legend" aria-hidden="true"><span class="legend-item"><span class="swatch t-va"></span>produtiva</span><span class="legend-item"><span class="swatch t-nva"></span>não produtiva</span></div></figcaption>' +
      samplingSVG(st, { width }) + '</figure>' +
    '<p class="hint" style="margin:8px 0 0">n necessário = z²·p(1−p)/e² com p = % produtivo, ' + st.confidence + '% de confiança e erro de ±' + st.errorPts + ' pontos (ajuste em Configurações).</p>';
  if (tip) host.appendChild(tip);
}

export function render() {
  if (!S.current || S.current.kind !== 'sampling') return;
  invalidateStats();
  renderCapture();
  renderObservations();
  renderStats();
  renderNext();
}

export function renderAll() {
  if (!S.current || S.current.kind !== 'sampling') return;
  renderPlanInputs();
  renderCategories();
  render();
}

export function relayout(forceWidth) {
  if (!S.current || S.current.kind !== 'sampling' || $('editorMain').hidden) return;
  renderStats(forceWidth);
}
