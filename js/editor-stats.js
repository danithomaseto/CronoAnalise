/* Editor — indicadores, takt time, resumo por etapa e gráficos. */

import { CHART_TYPE_ORDER } from './core/stats.js';
import { yamazumiSVG, paretoSVG, cycleTimeSVG, legendHTML, typesPresent, MAX_BARS } from './core/charts.js';
import { toBR, escapeHtml } from './core/format.js';
import { $ } from './ui.js';
import { bindTips } from './chart-tips.js';
import { S, getStats } from './editor.js';

let lastStats = null;
let resizeTimer = null;
let chartsFrame = 0;

export function init() {
  bindTips($('stats'));
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(), 150);
  });
}

function kpi(label, value, note, small) {
  return '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-val' + (small ? ' small' : '') + '">' + value + '</span>' +
    (note ? '<span class="kpi-note">' + note + '</span>' : '') + '</div>';
}

export function render(st) {
  lastStats = st;
  let kpis =
    kpi('Tempo Total', toBR(st.total) + 's') +
    kpi('Quantidade Total', toBR(st.qtyTotal, 0), st.usesOutputStages ? 'só etapas 📦 de produção' : '') +
    kpi('Produtividade', toBR(st.productivity) + '/h') +
    kpi('% Valor Agregado', toBR(st.vaPct, 1) + '%') +
    kpi('Ciclos', String(st.cycleCount)) +
    kpi('Tempo Médio de Ciclo', toBR(st.avgCycle) + 's', st.cycleCount > 1 ? 'desvio ' + toBR(st.cycleSd) + ' s' : '');
  if (st.hasStdParams) kpis += kpi('Tempo Padrão de Ciclo', toBR(st.stdCycle) + 's', 'ritmo ' + toBR(st.rating, 0) + '% · tol. ' + toBR(st.allowance, 0) + '%');
  if (st.takt > 0) {
    kpis += kpi('Takt Time', toBR(st.takt, 1) + ' s/un');
    const status = st.withinTakt === null ? ''
      : st.withinTakt ? '<span class="status"><span class="ico good">✓</span> dentro do takt</span>' : '<span class="status"><span class="ico bad">⚠</span> acima do takt</span>';
    kpis += kpi(st.hasStdParams ? 'Tempo Padrão / Unidade' : 'Tempo por Unidade', toBR(st.perUnitRef, 1) + ' s/un', status);
    kpis += kpi('Operadores Necessários', toBR(st.operatorsNeeded, 2), 'tempo por unidade ÷ takt');
  }
  if (st.interruptionCount) kpis += kpi('Interrupções', String(st.interruptionCount), toBR(st.interruptionTime) + ' s fora dos cálculos');
  if (st.trend) kpis += trendKpi(st.trend);

  const bars = CHART_TYPE_ORDER.map(t => {
    const v = st.byType[t] || 0;
    const pct = st.total > 0 ? v / st.total * 100 : 0;
    return '<div class="typebar-row">' +
      '<span class="typebar-label"><span class="swatch t-' + t.toLowerCase() + '"></span>' + t + '</span>' +
      '<div class="typebar-track"><div class="typebar-fill fill-' + t.toLowerCase() + '" style="width:' + pct.toFixed(2) + '%"></div></div>' +
      '<span class="typebar-val">' + toBR(v) + 's (' + toBR(pct, 1) + '%)</span>' +
    '</div>';
  }).join('');

  const std = st.hasStdParams;
  const rows = st.summary.map(s => {
    let nCell = '—';
    if (s.nRequired !== null) {
      nCell = s.enough
        ? '<span class="nreq" title="Amostra suficiente">' + s.nRequired + ' <span class="ico good">✓</span></span>'
        : '<span class="nreq" title="Faltam ' + (s.nRequired - s.count) + ' ocorrência(s)">' + s.nRequired + ' <span class="ico bad">⚠</span></span>';
    }
    return '<tr><td>' + escapeHtml(s.name) + '</td>' +
      '<td><span class="badge type-' + escapeHtml(String(s.type).toLowerCase()) + '">' + escapeHtml(s.type) + '</span></td>' +
      '<td>' + s.count + '</td><td>' + toBR(s.total) + '</td><td>' + toBR(s.avg) + '</td>' +
      '<td>' + toBR(s.min) + '</td><td>' + toBR(s.max) + '</td><td>' + toBR(s.sd) + '</td>' +
      '<td>' + toBR(s.cv, 1) + '</td><td>' + nCell + '</td><td>' + toBR(s.qty, 0) + '</td>' +
      '<td>' + toBR(s.productivity) + '</td>' +
      (std ? '<td>' + toBR(s.rating, 0) + (s.stageRating ? ' <span title="Avaliação Westinghouse da etapa">W</span>' : '') + '</td><td>' + toBR(s.normal) + '</td><td>' + toBR(s.standard) + '</td>' : '') +
      '</tr>';
  }).join('');
  const cols = std ? 15 : 12;

  const notes = [
    'n nec. = ciclos necessários para ' + st.confidence + '% de confiança e erro de ±' + st.errorPct + '% (ajuste em Configurações). ✓ = amostra suficiente; ⚠ = faltam ciclos.'
  ];
  if (st.outliers.size) notes.push(st.outliers.size + ' registro(s) marcado(s) com ⚠ estão fora de ±2σ da média da etapa.');
  if (st.excludedCount) notes.push(st.excludedCount + ' registro(s) ignorado(s) nos cálculos.');

  $('stats').innerHTML =
    '<div class="kpi-grid">' + kpis + '</div>' +
    '<div class="typebar-wrap">' + bars + '</div>' +
    '<div class="table-wrap"><table class="summary-table"><thead><tr>' +
      '<th>Etapa</th><th>Tipo</th><th>Ocorr.</th><th>Total(s)</th><th>Média(s)</th><th>Mín(s)</th><th>Máx(s)</th>' +
      '<th title="Desvio padrão">DP(s)</th><th title="Coeficiente de variação">CV%</th><th title="Ciclos necessários">n nec.</th>' +
      '<th>Qtd</th><th>un/h</th>' + (std ? '<th title="Fator de ritmo (W = avaliação Westinghouse da etapa)">Ritmo%</th><th>T. Normal(s)</th><th>T. Padrão(s)</th>' : '') +
    '</tr></thead><tbody>' + (rows || '<tr><td colspan="' + cols + '" class="empty">Sem registros ainda</td></tr>') + '</tbody></table></div>' +
    '<p class="hint" style="margin:10px 0 0">' + notes.join('<br>') + '</p>' +
    '<div id="charts" class="charts"></div>';
  // gráficos no próximo quadro: o toque na etapa responde antes (marcações rápidas
  // em sequência desenham os gráficos uma vez só)
  cancelAnimationFrame(chartsFrame);
  chartsFrame = requestAnimationFrame(() => { chartsFrame = 0; renderCharts(); });
}

/* Tendência do tempo de ciclo: direção em texto (não só cor), com a curva de
   aprendizado quando há queda. */
function trendKpi(tr) {
  if (tr.direction === 'flat') return kpi('Tendência do Ciclo', 'estável', 'sem queda ou alta significativa (' + tr.n + ' ciclos)', true);
  const down = tr.direction === 'down';
  const val = (down ? '▼ ' : '▲ ') + toBR(Math.abs(tr.slope), 1) + ' s/ciclo';
  const note = (down ? 'queda de ' : 'alta de ') + toBR(Math.abs(tr.changePct), 0) + '% no estudo' +
    (tr.learningRate ? ' · curva de aprendizado ≈ ' + toBR(tr.learningRate, 0) + '%' : down ? '' : ' · possível fadiga');
  return kpi('Tendência do Ciclo', '<span class="status"><span class="ico ' + (down ? 'good' : 'bad') + '">' + (down ? '▼' : '▲') + '</span> ' + val.slice(2) + '</span>', note, true);
}

/* ---------- Gráficos ---------- */
function chartCard(title, subtitle, legend, svg) {
  return '<figure class="chart-card"><figcaption><b>' + title + '</b>' +
    (subtitle ? '<span class="chart-sub">' + subtitle + '</span>' : '') + legend + '</figcaption>' + svg + '</figure>';
}

function renderCharts(forceWidth) {
  const host = $('charts');
  if (!host || !lastStats) return;
  const st = lastStats;
  if (!st.cycles.length) { host.innerHTML = ''; return; }
  const width = Math.max(260, Math.min(1000, Math.floor(forceWidth || host.clientWidth || 600)));
  const types = typesPresent(st.cycles.map(c => c.byType));
  const parts = [];
  const lastN = st.cycles.length > MAX_BARS ? ' · últimos ' + MAX_BARS + ' de ' + st.cycles.length + ' ciclos' : '';
  parts.push(chartCard('Composição do tempo por ciclo (Yamazumi)',
    (st.taktPerCycle > 0 ? 'linha: takt × unidades por ciclo' : 'tempo de cada ciclo por tipo de atividade') + lastN,
    legendHTML(types), yamazumiSVG(st, { width, height: 260 })));
  parts.push(chartCard('Pareto das etapas',
    st.vitalFew > 0 && st.vitalFew < st.pareto.length ? 'as ' + st.vitalFew + ' primeiras etapas somam 80% do tempo (linha)' : 'etapas por tempo total',
    legendHTML(typesPresent([st.byType])), paretoSVG(st, { width })));
  if (st.cycles.length >= 2) {
    parts.push(chartCard('Tempo de ciclo',
      'faixa: média ± 2 desvios-padrão' + (st.outlierCycles.size ? ' · ' + st.outlierCycles.size + ' ciclo(s) fora da faixa' : '') +
        (st.trend && st.trend.significant ? ' · tracejado: tendência' : ''),
      '', cycleTimeSVG(st, { width, height: 240 })));
  }
  host.innerHTML = parts.join('');
}

/* Redesenha os gráficos na largura atual (ou numa largura fixa, para imprimir). */
export function relayout(forceWidth) {
  if (!S.current || $('editorMain').hidden) return;
  cancelAnimationFrame(chartsFrame);
  chartsFrame = 0;
  renderCharts(forceWidth);
}

export function currentStats() {
  return lastStats || (S.current ? getStats() : null);
}
