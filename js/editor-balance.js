/* Editor — balanceamento de linha: carga por posto × takt, gargalo, eficiência e
   sugestão de redistribuição das etapas (na ordem do processo). */

import { computeBalance, suggestBalance } from './core/balance.js';
import { stationSVG, legendHTML, typesPresent } from './core/charts.js';
import { toBR, escapeHtml } from './core/format.js';
import { $, showToast } from './ui.js';
import { bindTips } from './chart-tips.js';
import { S, persist, refresh, nowIso } from './editor.js';
import * as stages from './editor-stages.js';

let last = null;       // { balance, stats }
let chosenK = null;    // nº de postos escolhido para a sugestão
let resizeTimer = null;

export function init() {
  const host = $('balance');
  bindTips(host);
  host.addEventListener('change', e => {
    if (e.target.id === 'balanceK') { chosenK = Number(e.target.value); renderSuggestion(); }
  });
  host.addEventListener('click', e => {
    if (e.target.closest('[data-balance-apply]')) apply();
  });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(), 150);
  });
}

function kpi(label, value, note) {
  return '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-val">' + value + '</span>' +
    (note ? '<span class="kpi-note">' + note + '</span>' : '') + '</div>';
}

export function render(stats) {
  const host = $('balance');
  if (!S.current || !host) return;
  const balance = computeBalance(S.current, stats);
  last = { balance, stats };
  if (!balance.items.length) {
    host.innerHTML = '<p class="empty">Marque alguns ciclos para ver a carga de cada posto.</p>';
    return;
  }
  const b = balance;
  let kpis = kpi('Postos', String(b.stations.length), b.hasStations ? (b.unassigned ? b.unassigned + ' etapa(s) sem posto' : '') : 'defina o posto no ✎ da etapa');
  kpis += kpi('Gargalo', escapeHtml(b.bottleneck || '—'), toBR(b.maxLoad, 1) + ' s por ciclo');
  kpis += kpi('Eficiência do balanceamento', toBR(b.efficiency, 0) + '%', 'trabalho total ÷ (postos × gargalo)');
  if (b.taktCycle > 0) {
    kpis += kpi('Mínimo de postos', String(b.minStations), 'trabalho ' + toBR(b.total, 1) + ' s ÷ takt ' + toBR(b.taktCycle, 1) + ' s');
    const over = b.overTakt.length;
    kpis += kpi('Postos acima do takt', String(over), over ? '<span class="status"><span class="ico bad">⚠</span> ' + escapeHtml(b.overTakt.join(', ')) + '</span>' : '<span class="status"><span class="ico good">✓</span> todos dentro do takt</span>');
  }
  if (b.unitsPerHour > 0) kpis += kpi('Capacidade da linha', toBR(b.unitsPerHour, 1) + ' un/h', 'limitada pelo gargalo');

  const rows = b.stations.map(st =>
    '<tr><td>' + escapeHtml(st.name) + '</td><td class="wrap">' + st.items.map(it => escapeHtml(it.name)).join(', ') + '</td>' +
    '<td>' + toBR(st.load) + '</td>' +
    (b.taktCycle > 0 ? '<td>' + toBR(st.load / b.taktCycle * 100, 0) + '%' + (st.load > b.taktCycle + 1e-9 ? ' <span class="ico bad">⚠</span>' : '') + '</td>' : '') +
    '</tr>'
  ).join('');

  const maxK = Math.max(1, b.items.length);
  // padrão: o número de postos de hoje (ou o mínimo pelo takt, se ainda não há postos)
  if (!chosenK || chosenK > maxK) chosenK = Math.min(maxK, b.hasStations ? b.stations.length : Math.max(2, b.minStations || 2));
  const opts = Array.from({ length: maxK }, (_, i) => i + 1)
    .map(k => '<option value="' + k + '"' + (k === chosenK ? ' selected' : '') + '>' + k + ' posto' + (k > 1 ? 's' : '') + '</option>').join('');

  host.innerHTML =
    '<div class="kpi-grid">' + kpis + '</div>' +
    '<div class="table-wrap"><table class="summary-table"><thead><tr><th>Posto</th><th>Etapas</th><th>Carga (s/ciclo)</th>' +
      (b.taktCycle > 0 ? '<th>% do takt</th>' : '') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
    (b.taktCycle > 0 ? '' : '<p class="hint" style="margin:8px 0 0">Informe demanda e tempo disponível (Parâmetros) para comparar com o takt.</p>') +
    '<figure class="chart-card"><figcaption><b>Carga por posto</b><span class="chart-sub">' +
      (b.taktCycle > 0 ? 'linha: takt do ciclo' : 'segundos por ciclo') + '</span>' +
      legendHTML(typesPresent(b.items.map(it => ({ [it.type]: it.load })))) + '</figcaption><div id="balanceChart"></div></figure>' +
    '<div class="balance-suggest">' +
      '<div class="row-line"><b>Sugestão de balanceamento</b><label class="inline-label">Postos <select id="balanceK" aria-label="Número de postos da sugestão">' + opts + '</select></label></div>' +
      '<div id="balanceSuggestion"></div>' +
    '</div>';
  renderChart();
  renderSuggestion();
}

function renderChart(forceWidth) {
  const el = $('balanceChart');
  if (!el || !last) return;
  const width = Math.max(260, Math.min(1000, Math.floor(forceWidth || el.clientWidth || $('balance').clientWidth || 600)));
  el.innerHTML = stationSVG(last.balance, { width, height: 260 });
}

function renderSuggestion() {
  const el = $('balanceSuggestion');
  if (!el || !last) return;
  const sug = suggestBalance(last.balance, chosenK);
  if (!sug) { el.innerHTML = ''; return; }
  const b = last.balance;
  el.innerHTML =
    '<div class="table-wrap"><table class="summary-table"><thead><tr><th>Posto</th><th>Etapas</th><th>Carga (s/ciclo)</th></tr></thead><tbody>' +
    sug.stations.map(st => '<tr><td>' + escapeHtml(st.name) + '</td><td class="wrap">' + st.items.map(it => escapeHtml(it.name)).join(', ') + '</td><td>' + toBR(st.load) +
      (b.taktCycle > 0 && st.load > b.taktCycle + 1e-9 ? ' <span class="ico bad">⚠</span>' : '') + '</td></tr>').join('') +
    '</tbody></table></div>' +
    '<p class="hint" style="margin:0">Gargalo: ' + toBR(sug.maxLoad, 1) + ' s · eficiência ' + toBR(sug.efficiency, 0) + '%' +
      (sug.withinTakt === null ? '' : sug.withinTakt ? ' · <span class="status"><span class="ico good">✓</span> todos dentro do takt</span>' : ' · <span class="status"><span class="ico bad">⚠</span> ainda acima do takt</span>') +
      (b.efficiency ? ' (hoje: ' + toBR(b.efficiency, 0) + '%)' : '') + '.</p>' +
    '<div><button type="button" class="cta" data-balance-apply data-edit-only>Aplicar sugestão nas etapas</button></div>';
}

/* Grava o posto sugerido em cada etapa (as etapas sem registros mantêm o posto). */
function apply() {
  if (!S.current || S.readonly || !last) return;
  const sug = suggestBalance(last.balance, chosenK);
  if (!sug) return;
  if (!confirm('Atribuir os postos sugeridos (' + sug.stations.length + ') às etapas?')) return;
  const t = nowIso();
  let n = 0;
  S.current.stages.forEach(st => {
    const name = sug.assignment[st.id];
    if (name && st.station !== name) { st.station = name; st.u = t; n++; }
  });
  persist('Balanceamento aplicado: ' + sug.stations.length + ' posto(s)');
  stages.render();
  refresh();
  showToast(n ? n + ' etapa(s) com novo posto' : 'As etapas já estavam nesses postos');
}

export function relayout(forceWidth) {
  if (!S.current || $('editorMain').hidden) return;
  renderChart(forceWidth);
}
