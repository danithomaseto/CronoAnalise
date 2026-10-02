/* Comparação de dois estudos (antes × depois de uma melhoria). */

import * as storage from './storage.js';
import { computeStats, CHART_TYPE_ORDER } from './core/stats.js';
import { toBR, escapeHtml } from './core/format.js';
import { $, openModal, showToast } from './ui.js';

export function initCompare() {
  $('compareA').addEventListener('change', render);
  $('compareB').addEventListener('change', render);
}

export function openCompare(preselectId) {
  // comparação de cronoanálises (a amostragem tem os próprios indicadores)
  // mais recentes primeiro (pela criação): o último estudo criado é o "depois"
  const list = storage.listStudies().filter(s => s.kind !== 'sampling').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (list.length < 2) { showToast('Crie pelo menos dois estudos de cronoanálise para comparar'); return; }
  const opts = list.map(s => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + '</option>').join('');
  $('compareA').innerHTML = opts;
  $('compareB').innerHTML = opts;
  // padrão: o mais antigo dos dois mais recentes como "antes"
  const b = preselectId && list.find(s => s.id === preselectId) ? preselectId : list[0].id;
  const a = list.find(s => s.id !== b).id;
  $('compareA').value = a;
  $('compareB').value = b;
  render();
  openModal('compareModal', { focus: 'compareA' });
}

/* better: 'down' (menor é melhor), 'up' (maior é melhor) ou null.
   A direção vai em texto ("melhor"/"pior"), não só na cor. */
function delta(a, b, better) {
  if (!(a > 0) && !(b > 0)) return '<td class="muted">—</td>';
  if (!(a > 0)) return '<td class="muted">novo</td>';
  const pct = (b - a) / a * 100;
  if (Math.abs(pct) < 0.05) return '<td class="muted">0%</td>';
  const arrow = pct < 0 ? '▼' : '▲';
  const txt = (pct > 0 ? '+' : '') + toBR(pct, 1).replace('-', '−') + '%';
  if (!better) return '<td class="muted">' + arrow + ' ' + txt + '</td>';
  const good = better === 'down' ? pct < 0 : pct > 0;
  return '<td class="delta"><span class="ico ' + (good ? 'good' : 'bad') + '">' + arrow + '</span> ' + txt +
    ' <span class="delta-word">' + (good ? 'melhor' : 'pior') + '</span></td>';
}

function compositionBar(st) {
  if (!(st.total > 0)) return '<div class="comp-bar empty">sem dados</div>';
  return '<div class="comp-bar">' + CHART_TYPE_ORDER.map(t => {
    const v = st.byType[t] || 0;
    if (!v) return '';
    const pct = v / st.total * 100;
    return '<span class="comp-seg fill-' + t.toLowerCase() + '" style="width:' + pct.toFixed(2) + '%" title="' + t + ': ' + toBR(pct, 1) + '%"></span>';
  }).join('') + '</div>';
}

function render() {
  const a = storage.getStudy($('compareA').value);
  const b = storage.getStudy($('compareB').value);
  const out = $('compareResult');
  if (!a || !b) { out.innerHTML = ''; return; }
  if (a.id === b.id) { out.innerHTML = '<p class="empty">Escolha dois estudos diferentes.</p>'; return; }
  const prefs = storage.getPrefs();
  const sa = computeStats(a, prefs), sb = computeStats(b, prefs);
  const row = (label, va, vb, fmt, better) => '<tr><td>' + label + '</td><td>' + fmt(va) + '</td><td>' + fmt(vb) + '</td>' + delta(va, vb, better) + '</tr>';
  const s2 = v => toBR(v) + ' s';
  let kpis =
    row('Tempo médio de ciclo', sa.avgCycle, sb.avgCycle, s2, 'down') +
    row('Produtividade (un/h)', sa.productivity, sb.productivity, v => toBR(v), 'up') +
    row('% Valor Agregado', sa.vaPct, sb.vaPct, v => toBR(v, 1) + '%', 'up') +
    row('Tempo por unidade', sa.perUnit, sb.perUnit, s2, 'down') +
    row('Desvio do tempo de ciclo', sa.cycleSd, sb.cycleSd, s2, 'down') +
    row('Ciclos medidos', sa.cycleCount, sb.cycleCount, v => String(v), null) +
    row('Interrupções', sa.interruptionCount, sb.interruptionCount, v => String(v), 'down');
  if (sa.takt > 0 || sb.takt > 0) kpis += row('Operadores necessários', sa.operatorsNeeded, sb.operatorsNeeded, v => toBR(v, 2), 'down');

  // Etapas casadas pelo nome (sem diferenciar maiúsculas)
  const key = s => s.name.trim().toLowerCase();
  const map = new Map();
  sa.summary.forEach(s => map.set(key(s), { name: s.name, type: s.type, a: s, b: null }));
  sb.summary.forEach(s => { const k = key(s); if (map.has(k)) map.get(k).b = s; else map.set(k, { name: s.name, type: s.type, a: null, b: s }); });
  const stages = [...map.values()].map(x =>
    '<tr><td>' + escapeHtml(x.name) + '</td><td><span class="badge type-' + escapeHtml(String(x.type).toLowerCase()) + '">' + escapeHtml(x.type) + '</span></td>' +
    '<td>' + (x.a ? toBR(x.a.avg) : '—') + '</td><td>' + (x.b ? toBR(x.b.avg) : '—') + '</td>' +
    (x.a && x.b ? delta(x.a.avg, x.b.avg, 'down') : '<td class="muted">' + (x.a ? 'removida' : 'nova') + '</td>') + '</tr>'
  ).join('');

  out.innerHTML =
    '<div class="comp-bars">' +
      '<div><span class="comp-label">Antes — ' + escapeHtml(a.name) + '</span>' + compositionBar(sa) + '</div>' +
      '<div><span class="comp-label">Depois — ' + escapeHtml(b.name) + '</span>' + compositionBar(sb) + '</div>' +
      '<div class="legend">' + CHART_TYPE_ORDER.map(t => '<span class="legend-item"><span class="swatch t-' + t.toLowerCase() + '"></span>' + t + '</span>').join('') + '</div>' +
    '</div>' +
    '<div class="table-wrap"><table class="summary-table"><thead><tr><th>Indicador</th><th>Antes</th><th>Depois</th><th>Variação</th></tr></thead><tbody>' + kpis + '</tbody></table></div>' +
    '<h3 class="sub-h">Tempo médio por etapa (s)</h3>' +
    '<div class="table-wrap"><table class="summary-table"><thead><tr><th>Etapa</th><th>Tipo</th><th>Antes</th><th>Depois</th><th>Variação</th></tr></thead><tbody>' +
      (stages || '<tr><td colspan="5" class="empty">Sem etapas</td></tr>') + '</tbody></table></div>' +
    '<p class="hint" style="margin:8px 0 0">▼/▲ indicam a direção da mudança. Etapas são casadas pelo nome.</p>';
}
