/* Gráficos em SVG (sem bibliotecas), gerados como texto a partir das
   estatísticas — sem DOM, testáveis no Node. As cores vêm do CSS (classes
   t-va, t-nva…), então o tema escuro troca os tons sozinho.

   Especificações (guia de visualização): barras ≤ 24px com topo arredondado de
   4px, 2px de espaço entre segmentos empilhados, linhas de 2px, pontos ≥ 8px
   com anel na cor da superfície, grade em linhas finas sólidas, legenda sempre
   que houver 2+ séries e rótulos só onde ajudam. Cada marca tem `data-tip`
   (texto do tooltip) e é focável pelo teclado. */

import { escapeHtml, toBR } from './format.js';
import { CHART_TYPE_ORDER } from './stats.js';

const typeClass = t => 't-' + String(t || '').toLowerCase().replace(/[^a-z]/g, '');
const attr = v => escapeHtml(String(v));

const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return NICE.find(m => n <= m + 1e-9) * p;
}

function fmtTick(v) {
  const r = Math.round(v * 100) / 100;
  if (Number.isInteger(r)) return toBR(r, 0);
  return toBR(r, Number.isInteger(r * 10) ? 1 : 2);
}

/* Retângulo com só o topo arredondado (a base fica reta, ancorada no eixo). */
function topRoundedRect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, h, w / 2));
  if (r === 0) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function rightRoundedRect(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w, h / 2));
  if (r === 0) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function yGrid(maxY, m, w, h, suffix = 's') {
  const out = [];
  for (let i = 0; i <= 4; i++) {
    const v = maxY * i / 4;
    const y = m.top + h - h * i / 4;
    out.push(`<line class="grid" x1="${m.left}" x2="${m.left + w}" y1="${y}" y2="${y}"/>`);
    out.push(`<text class="tick" x="${m.left - 6}" y="${y + 4}" text-anchor="end">${fmtTick(v)}${i === 4 ? ' ' + suffix : ''}</text>`);
  }
  return out.join('');
}

/* Tipos presentes, na ordem dos gráficos (tipos fora da lista vão ao fim). */
export function typesPresent(byTypeList) {
  const present = new Set();
  byTypeList.forEach(bt => Object.keys(bt).forEach(t => { if (bt[t] > 0) present.add(t); }));
  const ordered = CHART_TYPE_ORDER.filter(t => present.has(t));
  [...present].forEach(t => { if (!ordered.includes(t)) ordered.push(t); });
  return ordered;
}

export function legendHTML(types) {
  if (types.length < 2) return '';
  return '<div class="legend" aria-hidden="true">' + types.map(t =>
    `<span class="legend-item"><svg width="12" height="12" viewBox="0 0 12 12"><rect class="${typeClass(t)}" x="0" y="0" width="12" height="12" rx="3"/></svg>${escapeHtml(t)}</span>`
  ).join('') + '</div>';
}

/* Composição do tempo de cada ciclo por tipo (Yamazumi por ciclo). */
export function yamazumiSVG(stats, { width = 640, height = 260 } = {}) {
  const cycles = stats.cycles || [];
  if (!cycles.length) return '';
  const types = typesPresent(cycles.map(c => c.byType));
  const m = { top: 18, right: 14, bottom: 30, left: 52 };
  const w = Math.max(60, width - m.left - m.right);
  const h = Math.max(60, height - m.top - m.bottom);
  const refLine = stats.taktPerCycle > 0 ? stats.taktPerCycle : 0;
  const maxData = Math.max(...cycles.map(c => c.total));
  // takt muito acima dos ciclos achataria as barras: nesse caso vira só um aviso
  const refInScale = refLine > 0 && refLine <= maxData * 3;
  const maxY = niceMax(Math.max(maxData, refInScale ? refLine : 0) * 1.05);
  const slot = w / cycles.length;
  const bw = Math.max(2, Math.min(24, slot * 0.66));
  const y = v => m.top + h - (v / maxY) * h;
  const parts = [yGrid(maxY, m, w, h)];

  const labelEvery = Math.max(1, Math.ceil(cycles.length / Math.max(1, Math.floor(w / 28))));
  cycles.forEach((c, i) => {
    const x = m.left + slot * i + (slot - bw) / 2;
    let acc = 0;
    const segs = types.filter(t => (c.byType[t] || 0) > 0);
    segs.forEach((t, k) => {
      const v = c.byType[t];
      const top = y(acc + v), bottom = y(acc);
      const isTop = k === segs.length - 1;
      // 2px de superfície entre segmentos; segmento minúsculo ainda fica visível (1px)
      const segH = Math.max(1, bottom - top - (isTop ? 0 : 2));
      acc += v;
      const tip = `Ciclo ${c.cycle} · ${t}: ${toBR(v)} s (total ${toBR(c.total)} s)`;
      const y0 = isTop ? bottom - segH : Math.min(top + 2, bottom - segH);
      const d = isTop ? topRoundedRect(x, y0, bw, segH, 4) : `M${x},${y0}H${x + bw}V${y0 + segH}H${x}Z`;
      parts.push(`<path class="mark ${typeClass(t)}" d="${d}" data-tip="${attr(tip)}" tabindex="0" role="img" aria-label="${attr(tip)}"/>`);
    });
    if (i % labelEvery === 0) parts.push(`<text class="tick" x="${m.left + slot * i + slot / 2}" y="${m.top + h + 18}" text-anchor="middle">${c.cycle}</text>`);
  });

  parts.push(`<line class="axis" x1="${m.left}" x2="${m.left + w}" y1="${m.top + h}" y2="${m.top + h}"/>`);
  if (refInScale) {
    const ty = y(refLine);
    parts.push(`<line class="ref" x1="${m.left}" x2="${m.left + w}" y1="${ty}" y2="${ty}"/>`);
    parts.push(`<text class="ref-label" x="${m.left + w}" y="${ty - 5}" text-anchor="end">Takt do ciclo ${toBR(refLine, 1)} s</text>`);
  } else if (refLine) {
    parts.push(`<text class="ref-label" x="${m.left + w}" y="${m.top - 4}" text-anchor="end">Takt do ciclo ${toBR(refLine, 1)} s (acima da escala)</text>`);
  }
  parts.push(`<text class="tick" x="${m.left + w / 2}" y="${height - 2}" text-anchor="middle">Ciclo</text>`);
  return `<svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Composição do tempo por ciclo">${parts.join('')}</svg>`;
}

/* Etapas ordenadas pelo tempo total (Pareto), em barras horizontais. A
   participação e o acumulado vão no rótulo e no tooltip — sem segundo eixo. */
export function paretoSVG(stats, { width = 640 } = {}) {
  const rows = stats.pareto || [];
  if (!rows.length) return '';
  const rowH = 30;
  const m = { top: 6, right: 12, bottom: 6, left: Math.min(200, Math.max(90, width * 0.3)) };
  const height = m.top + m.bottom + rows.length * rowH;
  const labelW = 130; // espaço reservado para o rótulo na ponta
  const w = Math.max(40, width - m.left - m.right - labelW);
  const maxV = Math.max(...rows.map(r => r.total)) || 1;
  const maxChars = Math.max(6, Math.floor((m.left - 10) / 7));
  const parts = [];
  rows.forEach((r, i) => {
    const cy = m.top + i * rowH + rowH / 2;
    const bh = Math.min(20, rowH - 8);
    const bwid = Math.max(2, (r.total / maxV) * w);
    const name = r.name.length > maxChars ? r.name.slice(0, maxChars - 1) + '…' : r.name;
    const tip = `${r.name} (${r.type}): ${toBR(r.total)} s · ${toBR(r.share, 1)}% do tempo · acumulado ${toBR(r.cumulative, 1)}%`;
    parts.push(`<text class="cat" x="${m.left - 8}" y="${cy + 4}" text-anchor="end"><title>${escapeHtml(r.name)}</title>${escapeHtml(name)}</text>`);
    parts.push(`<path class="mark ${typeClass(r.type)}" d="${rightRoundedRect(m.left, cy - bh / 2, bwid, bh, 4)}" data-tip="${attr(tip)}" tabindex="0" role="img" aria-label="${attr(tip)}"/>`);
    parts.push(`<text class="val" x="${m.left + bwid + 6}" y="${cy + 4}">${toBR(r.total, 1)} s · ${toBR(r.share, 0)}%</text>`);
  });
  if (stats.vitalFew > 0 && stats.vitalFew < rows.length) {
    const ly = m.top + stats.vitalFew * rowH;
    parts.push(`<line class="ref" x1="${m.left - 4}" x2="${width - m.right}" y1="${ly}" y2="${ly}"/>`);
  }
  parts.push(`<line class="axis" x1="${m.left}" x2="${m.left}" y1="${m.top}" y2="${height - m.bottom}"/>`);
  return `<svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Pareto das etapas">${parts.join('')}</svg>`;
}

/* Tempo de cada ciclo, com a média e a faixa de ±2 desvios-padrão. */
export function cycleTimeSVG(stats, { width = 640, height = 240 } = {}) {
  const cycles = stats.cycles || [];
  if (cycles.length < 2) return '';
  const m = { top: 18, right: 16, bottom: 30, left: 52 };
  const w = Math.max(60, width - m.left - m.right);
  const h = Math.max(60, height - m.top - m.bottom);
  const mean = stats.avgCycle, sd = stats.cycleSd || 0;
  const maxY = niceMax(Math.max(...cycles.map(c => c.total), mean + 2 * sd) * 1.05);
  const x = i => m.left + (cycles.length === 1 ? w / 2 : (w * i) / (cycles.length - 1));
  const y = v => m.top + h - (Math.max(0, v) / maxY) * h;
  const parts = [yGrid(maxY, m, w, h)];

  if (sd > 0) {
    const y1 = y(mean + 2 * sd), y2 = y(Math.max(0, mean - 2 * sd));
    parts.push(`<rect class="band" x="${m.left}" y="${y1}" width="${w}" height="${Math.max(0, y2 - y1)}"/>`);
  }
  const my = y(mean);
  parts.push(`<line class="ref" x1="${m.left}" x2="${m.left + w}" y1="${my}" y2="${my}"/>`);
  parts.push(`<text class="ref-label" x="${m.left + w}" y="${my - 5}" text-anchor="end">média ${toBR(mean, 1)} s</text>`);

  const d = cycles.map((c, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(c.total).toFixed(1)).join('');
  parts.push(`<path class="line" d="${d}"/>`);

  const slot = cycles.length > 1 ? w / (cycles.length - 1) : w;
  const labelEvery = Math.max(1, Math.ceil(cycles.length / Math.max(1, Math.floor(w / 28))));
  cycles.forEach((c, i) => {
    const out = stats.outlierCycles && stats.outlierCycles.has(c.cycle);
    const tip = `Ciclo ${c.cycle}: ${toBR(c.total)} s` + (out ? ' — fora da faixa de ±2σ' : '');
    parts.push(`<circle class="dot${out ? ' out' : ''}" cx="${x(i)}" cy="${y(c.total)}" r="${out ? 5 : 4}"/>`);
    // área de toque maior que o ponto (≥ 24px), cobrindo a altura toda
    parts.push(`<rect class="hit" x="${x(i) - Math.max(12, slot / 2)}" y="${m.top}" width="${Math.max(24, slot)}" height="${h}" data-tip="${attr(tip)}" data-x="${x(i)}" tabindex="0" role="img" aria-label="${attr(tip)}"/>`);
    if (i % labelEvery === 0) parts.push(`<text class="tick" x="${x(i)}" y="${m.top + h + 18}" text-anchor="middle">${c.cycle}</text>`);
  });
  parts.push(`<line class="axis" x1="${m.left}" x2="${m.left + w}" y1="${m.top + h}" y2="${m.top + h}"/>`);
  parts.push(`<line class="crosshair" x1="0" x2="0" y1="${m.top}" y2="${m.top + h}" visibility="hidden"/>`);
  return `<svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="group" aria-label="Tempo de ciclo">${parts.join('')}</svg>`;
}
