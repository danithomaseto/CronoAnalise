/* Editor — relatório A3: formulário (problema, meta, causas, contramedidas,
   plano de ação, acompanhamento) e a folha A3 em paisagem para imprimir/PDF,
   com os indicadores e gráficos do próprio estudo. */

import * as storage from './storage.js';
import { computeStats } from './core/stats.js';
import { samplingStats } from './core/sampling.js';
import { yamazumiSVG, paretoSVG, samplingSVG, legendHTML, typesPresent } from './core/charts.js';
import { A3_TEXT_FIELDS, normalizeA3 } from './core/model.js';
import { toBR, escapeHtml, uid } from './core/format.js';
import { FIELD_LABELS } from './config.js';
import { $ } from './ui.js';
import { S, persist, touchField, getStats } from './editor.js';

const STATUS = [['aberta', 'Aberta'], ['andamento', 'Em andamento'], ['concluida', 'Concluída']];
let saveTimer = null;

export function init() {
  const box = $('editorA3');
  box.addEventListener('input', e => {
    const k = e.target.dataset.a3;
    if (k) { update(a3 => { a3[k] = e.target.value; }); return; }
    if (e.target.closest('#a3Actions')) readActions(false);
  });
  box.addEventListener('change', e => {
    if (e.target.id === 'a3After') update(a3 => { if (e.target.value) a3.afterStudyId = e.target.value; else delete a3.afterStudyId; }, true);
    else if (e.target.closest('#a3Actions')) readActions(true);
  });
  box.addEventListener('click', e => {
    if (e.target.closest('[data-action="a3-add-action"]')) addAction();
    const rm = e.target.closest('[data-a3-remove]');
    if (rm) { rm.closest('tr').remove(); readActions(true); }
  });
}

function update(fn, now) {
  if (!S.current || S.readonly) return;
  const a3 = { ...(S.current.a3 || {}) };
  fn(a3);
  const n = normalizeA3(a3); // tira só o que está vazio (o texto digitado fica como está)
  if (n) S.current.a3 = n; else delete S.current.a3;
  touchField('a3');
  clearTimeout(saveTimer);
  if (now) persist(); else saveTimer = setTimeout(() => persist(), 600);
}

function readActions(now) {
  const rows = [...$('a3Actions').querySelectorAll('tr[data-id]')].map(tr => ({
    id: tr.dataset.id,
    what: tr.querySelector('[data-f=what]').value,
    who: tr.querySelector('[data-f=who]').value,
    when: tr.querySelector('[data-f=when]').value,
    status: tr.querySelector('[data-f=status]').value
  }));
  update(a3 => { a3.actions = rows; }, now);
}

function addAction() {
  if (!S.current || S.readonly) return;
  const tb = $('a3Actions');
  const empty = tb.querySelector('.empty');
  if (empty) empty.closest('tr').remove();
  tb.insertAdjacentHTML('beforeend', actionRow({ id: uid('act'), what: '', who: '', when: '', status: 'aberta' }));
  tb.querySelector('tr:last-child [data-f=what]').focus();
}

function actionRow(a) {
  const ro = S.readonly ? ' disabled' : '';
  return '<tr data-id="' + escapeHtml(a.id) + '">' +
    '<td><input data-f="what" value="' + escapeHtml(a.what) + '" aria-label="O quê"' + ro + '></td>' +
    '<td><input data-f="who" value="' + escapeHtml(a.who) + '" aria-label="Quem"' + ro + '></td>' +
    '<td><input data-f="when" type="date" value="' + escapeHtml(a.when) + '" aria-label="Quando"' + ro + '></td>' +
    '<td><select data-f="status" aria-label="Status"' + ro + '>' + STATUS.map(([v, l]) => '<option value="' + v + '"' + (a.status === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></td>' +
    '<td class="no-print">' + (S.readonly ? '' : '<button type="button" class="danger" data-a3-remove aria-label="Remover ação">✕</button>') + '</td></tr>';
}

export function render() {
  if (!S.current) return;
  const a3 = S.current.a3 || {};
  document.querySelectorAll('#editorA3 [data-a3]').forEach(el => {
    if (document.activeElement !== el) el.value = a3[el.dataset.a3] || '';
    el.readOnly = S.readonly;
  });
  const others = storage.listStudies().filter(s => s.id !== S.current.id && (s.kind || 'time') === (S.current.kind || 'time'))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const sel = $('a3After');
  sel.innerHTML = '<option value="">— nenhum —</option>' + others.map(s => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>').join('');
  sel.value = a3.afterStudyId && others.some(s => s.id === a3.afterStudyId) ? a3.afterStudyId : '';
  sel.disabled = S.readonly;
  const tb = $('a3Actions');
  if (tb.contains(document.activeElement)) return; // não atrapalha a digitação
  tb.innerHTML = (a3.actions || []).length ? a3.actions.map(actionRow).join('') : '<tr><td colspan="5" class="empty">Nenhuma ação ainda.</td></tr>';
}

/* ---------- Folha A3 ---------- */
const box = (title, inner) => '<div class="a3-box"><h2>' + title + '</h2>' + inner + '</div>';
const text = v => '<p>' + (v ? escapeHtml(v) : '<span style="color:#888">—</span>') + '</p>';
const kpi = (l, v) => '<div class="kpi"><span class="kpi-label">' + l + '</span><span class="kpi-val">' + v + '</span></div>';

function timeKpis(st) {
  let h = kpi('Tempo médio de ciclo', toBR(st.avgCycle, 1) + ' s') + kpi('Produtividade', toBR(st.productivity, 1) + '/h') +
    kpi('% valor agregado', toBR(st.vaPct, 1) + '%') + kpi('Ciclos', String(st.cycleCount));
  if (st.takt > 0) h += kpi('Takt', toBR(st.takt, 1) + ' s/un') + kpi('Tempo por unidade', toBR(st.perUnitRef, 1) + ' s') + kpi('Operadores necessários', toBR(st.operatorsNeeded, 2));
  if (st.hasStdParams) h += kpi('Tempo padrão do ciclo', toBR(st.stdCycle, 1) + ' s');
  return '<div class="kpi-grid">' + h + '</div>';
}

function compareTable(before, after, prefs) {
  const sa = computeStats(before, prefs), sb = computeStats(after, prefs);
  const row = (l, a, b, f, better) => {
    const pct = a > 0 ? (b - a) / a * 100 : 0;
    const good = better === 'down' ? pct < 0 : pct > 0;
    return '<tr><td>' + l + '</td><td>' + f(a) + '</td><td>' + f(b) + '</td><td>' + (a > 0 ? (pct > 0 ? '+' : '') + toBR(pct, 1) + '% ' + (Math.abs(pct) < 0.05 ? '' : good ? '(melhor)' : '(pior)') : '—') + '</td></tr>';
  };
  return '<table><thead><tr><th>Indicador</th><th>Antes</th><th>Depois</th><th>Variação</th></tr></thead><tbody>' +
    row('Tempo médio de ciclo (s)', sa.avgCycle, sb.avgCycle, v => toBR(v, 1), 'down') +
    row('Produtividade (un/h)', sa.productivity, sb.productivity, v => toBR(v, 1), 'up') +
    row('% valor agregado', sa.vaPct, sb.vaPct, v => toBR(v, 1), 'up') +
    row('Tempo por unidade (s)', sa.perUnit, sb.perUnit, v => toBR(v, 1), 'down') +
    '</tbody></table><p style="font-size:8pt;color:#555">Depois: ' + escapeHtml(after.name) + '</p>';
}

function samplingCompare(before, after, prefs) {
  const a = samplingStats(before, prefs), b = samplingStats(after, prefs);
  return '<table><thead><tr><th>Indicador</th><th>Antes</th><th>Depois</th></tr></thead><tbody>' +
    '<tr><td>% produtivo</td><td>' + toBR(a.productivePct, 1) + '%</td><td>' + toBR(b.productivePct, 1) + '%</td></tr>' +
    '<tr><td>Observações</td><td>' + a.n + '</td><td>' + b.n + '</td></tr></tbody></table>' +
    '<p style="font-size:8pt;color:#555">Depois: ' + escapeHtml(after.name) + '</p>';
}

export function buildSheet() {
  const s = S.current;
  const a3 = s.a3 || {};
  const prefs = storage.getPrefs();
  const sampling = s.kind === 'sampling';
  const st = getStats();
  let current, analysis;
  if (sampling) {
    current = '<div class="kpi-grid">' + kpi('% produtivo', toBR(st.productivePct, 1) + '%') + kpi('IC', toBR(st.productiveLo, 1) + '–' + toBR(st.productiveHi, 1) + '%') +
      kpi('Observações', st.n + ' / ' + st.nRequired) + '</div>' + (st.n ? samplingSVG(st, { width: 640 }) : '');
    analysis = '<table><thead><tr><th>Categoria</th><th>%</th><th>Obs.</th></tr></thead><tbody>' +
      st.categories.slice().sort((x, y) => y.count - x.count).slice(0, 8).map(c => '<tr><td>' + escapeHtml(c.name) + '</td><td>' + toBR(c.p * 100, 1) + '</td><td>' + c.count + '</td></tr>').join('') + '</tbody></table>';
  } else {
    const types = typesPresent(st.cycles.map(c => c.byType));
    current = timeKpis(st) + (st.cycles.length ? '<div style="font-size:9pt">' + legendHTML(types) + '</div>' + yamazumiSVG(st, { width: 640, height: 220 }) : '');
    analysis = st.pareto.length ? paretoSVG({ ...st, pareto: st.pareto.slice(0, 6), vitalFew: Math.min(st.vitalFew, 6) }, { width: 640 }) : '';
  }
  const after = a3.afterStudyId && storage.getStudy(a3.afterStudyId);
  const actions = (a3.actions || []);
  const stName = Object.fromEntries(STATUS);
  const plan = actions.length
    ? '<table><thead><tr><th>O quê</th><th>Quem</th><th>Quando</th><th>Status</th></tr></thead><tbody>' +
      actions.map(a => '<tr><td>' + escapeHtml(a.what) + '</td><td>' + escapeHtml(a.who) + '</td><td>' + (a.when ? escapeHtml(a.when.split('-').reverse().join('/')) : '') + '</td><td>' + (stName[a.status] || 'Aberta') + '</td></tr>').join('') +
      '</tbody></table>'
    : text('');
  const done = actions.filter(a => a.status === 'concluida').length;
  return '<div class="a3-sheet">' +
    '<div class="a3-head"><div><h1>A3 — ' + escapeHtml(s.name) + '</h1>' +
      '<div style="font-size:9pt">' + [s.process && FIELD_LABELS.process + ': ' + escapeHtml(s.process), s.operator && FIELD_LABELS.operator + ': ' + escapeHtml(s.operator), s.observer && FIELD_LABELS.observer + ': ' + escapeHtml(s.observer)].filter(Boolean).join(' · ') + '</div></div>' +
      '<div class="meta">' + (sampling ? 'Amostragem do trabalho' : 'Cronoanálise') + '<br>Gerado em ' + escapeHtml(new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })) +
      (actions.length ? '<br>Plano: ' + done + '/' + actions.length + ' ações concluídas' : '') + '</div></div>' +
    '<div class="a3-cols"><div>' +
      box('1. Problema / contexto', text(a3.problem)) +
      box('2. Situação atual', current + (a3.current ? text(a3.current) : '')) +
      box('3. Meta', text(a3.goal)) +
    '</div><div>' +
      box('4. Análise de causa', text(a3.rootCause) + analysis) +
      box('5. Contramedidas', text(a3.countermeasures)) +
      box('6. Plano de ação', plan) +
      box('7. Acompanhamento / resultados', text(a3.followUp) + (after ? (sampling ? samplingCompare(s, after, prefs) : compareTable(s, after, prefs)) : '')) +
    '</div></div></div>';
}

export function print() {
  if (!S.current) return;
  const sheet = $('a3Print');
  sheet.innerHTML = buildSheet();
  const style = document.createElement('style');
  style.id = 'a3PageStyle';
  style.textContent = '@page{size:A3 landscape;margin:10mm}';
  document.head.appendChild(style);
  document.body.classList.add('print-a3');
  const cleanup = () => {
    document.body.classList.remove('print-a3');
    style.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => { window.print(); setTimeout(cleanup, 500); }, 50);
}

export { A3_TEXT_FIELDS };
