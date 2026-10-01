/* Indicadores do estudo — sem DOM, testáveis no Node. */

import { TYPES } from '../config.js';

const Z = { 90: 1.645, 95: 1.96, 99: 2.576 };

export function zFor(confidence) {
  return Z[confidence] || Z[95];
}

export function hasStdParams(study) {
  return ratingOf(study) !== 100 || allowanceOf(study) !== 0;
}

export function ratingOf(study) {
  const r = Number(study && study.rating);
  return isFinite(r) && r > 0 ? r : 100;
}

export function allowanceOf(study) {
  const a = Number(study && study.allowance);
  return isFinite(a) && a >= 0 ? a : 0;
}

function sampleStdDev(values, mean) {
  if (values.length < 2) return 0;
  const ss = values.reduce((a, v) => a + (v - mean) * (v - mean), 0);
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * @param {import('./types.js').Study} study  estudo normalizado
 * @param {import('./types.js').Prefs} [prefs] nível de confiança (90/95/99) e erro relativo (%)
 */
export function computeStats(study, prefs = {}) {
  const confidence = prefs.confidence || 95;
  const errorPct = prefs.error || 5;
  const z = zFor(confidence);
  const e = errorPct / 100;

  const records = study.records || [];
  // Interrupções (elementos estranhos) e registros ignorados ficam fora dos cálculos
  const interruptions = records.filter(r => r.interruption);
  const active = records.filter(r => !r.excluded && !r.interruption);
  const total = active.reduce((a, r) => a + (Number(r.time) || 0), 0);

  // Quantidade: se alguma etapa estiver marcada como "conta para produção",
  // só ela entra na soma; senão soma todas (comportamento original).
  const outputIds = new Set((study.stages || []).filter(s => s.countsOutput).map(s => s.id));
  const usesOutputStages = outputIds.size > 0;
  const qtyRecords = usesOutputStages ? active.filter(r => outputIds.has(r.stageId)) : active;
  const qtyTotal = qtyRecords.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const hours = total / 3600;
  const productivity = qtyTotal > 0 && hours > 0 ? qtyTotal / hours : 0;

  const byType = {};
  TYPES.forEach(t => { byType[t] = 0; });
  active.forEach(r => { byType[r.type] = (byType[r.type] || 0) + (Number(r.time) || 0); });
  const vaPct = total > 0 ? (byType.VA || 0) / total * 100 : 0;

  const cycleSet = new Set(active.map(r => r.cycle));
  const cycleCount = cycleSet.size;
  const avgCycle = cycleCount ? total / cycleCount : 0;

  const rating = ratingOf(study);
  const allowance = allowanceOf(study);
  const factor = (rating / 100) * (1 + allowance / 100);
  const stdCycle = avgCycle * factor;

  // Resumo por etapa (agrupado por nome + tipo, como na versão original)
  const groups = new Map();
  active.forEach(r => {
    const key = r.stageName + '||' + r.type;
    if (!groups.has(key)) groups.set(key, { name: r.stageName, type: r.type, stageId: r.stageId, times: [], qty: 0, ids: [] });
    const g = groups.get(key);
    g.times.push(Number(r.time) || 0);
    g.qty += Number(r.qty) || 0;
    g.ids.push(r.id);
  });

  const outliers = new Set();
  const summary = [];
  groups.forEach(g => {
    const count = g.times.length;
    const sum = g.times.reduce((a, v) => a + v, 0);
    const avg = count ? sum / count : 0;
    const sd = sampleStdDev(g.times, avg);
    const cv = avg > 0 ? sd / avg * 100 : 0;
    const nRequired = count >= 2 && avg > 0 ? Math.ceil(Math.pow((z * sd) / (e * avg), 2)) : null;
    const normal = avg * rating / 100;
    if (count >= 5 && sd > 0) {
      g.times.forEach((t, i) => { if (Math.abs(t - avg) > 2 * sd) outliers.add(g.ids[i]); });
    }
    summary.push({
      name: g.name,
      type: g.type,
      stageId: g.stageId,
      count,
      total: sum,
      avg,
      min: count ? Math.min(...g.times) : 0,
      max: count ? Math.max(...g.times) : 0,
      sd,
      cv,
      nRequired,
      enough: nRequired !== null && count >= nRequired,
      qty: g.qty,
      productivity: g.qty > 0 && sum > 0 ? g.qty / (sum / 3600) : 0,
      normal,
      standard: normal * (1 + allowance / 100)
    });
  });

  // Série por ciclo (composição por tipo) e estatística do tempo de ciclo
  const cycleMap = new Map();
  active.forEach(r => {
    if (!cycleMap.has(r.cycle)) cycleMap.set(r.cycle, { cycle: r.cycle, total: 0, byType: {}, qty: 0 });
    const c = cycleMap.get(r.cycle);
    const t = Number(r.time) || 0;
    c.total += t;
    c.byType[r.type] = (c.byType[r.type] || 0) + t;
    if (!usesOutputStages || outputIds.has(r.stageId)) c.qty += Number(r.qty) || 0;
  });
  const cycles = [...cycleMap.values()].sort((a, b) => a.cycle - b.cycle);
  const cycleTotals = cycles.map(c => c.total);
  const cycleSd = sampleStdDev(cycleTotals, avgCycle);
  const outlierCycles = new Set();
  if (cycles.length >= 5 && cycleSd > 0) cycles.forEach(c => { if (Math.abs(c.total - avgCycle) > 2 * cycleSd) outlierCycles.add(c.cycle); });

  // Pareto: etapas por tempo total, com participação e acumulado
  let acc = 0;
  const pareto = summary.slice().sort((a, b) => b.total - a.total).map(s => {
    const share = total > 0 ? s.total / total * 100 : 0;
    acc += share;
    return { name: s.name, type: s.type, total: s.total, share, cumulative: Math.min(100, acc) };
  });
  const vitalFew = pareto.findIndex(p => p.cumulative >= 80 - 1e-9) + 1;

  // Takt time
  const demand = Number(study.demand) || 0;
  const availableMin = Number(study.availableMin) || 0;
  const takt = demand > 0 && availableMin > 0 ? availableMin * 60 / demand : 0;
  const perUnit = qtyTotal > 0 ? total / qtyTotal : 0;
  const perUnitStd = perUnit * factor;
  const unitsPerCycle = cycleCount ? qtyTotal / cycleCount : 0;
  const perUnitRef = rating !== 100 || allowance !== 0 ? perUnitStd : perUnit;

  return {
    total,
    qtyTotal,
    cycles,
    cycleSd,
    outlierCycles,
    pareto,
    vitalFew,
    takt,
    perUnit,
    perUnitStd,
    perUnitRef,
    unitsPerCycle,
    taktPerCycle: takt * unitsPerCycle,
    operatorsNeeded: takt > 0 ? perUnitRef / takt : 0,
    withinTakt: takt > 0 && perUnitRef > 0 ? perUnitRef <= takt : null,
    interruptionCount: interruptions.length,
    interruptionTime: interruptions.reduce((a, r) => a + (Number(r.time) || 0), 0),
    usesOutputStages,
    productivity,
    byType,
    vaPct,
    cycleCount,
    avgCycle,
    rating,
    allowance,
    stdCycle,
    hasStdParams: rating !== 100 || allowance !== 0,
    summary,
    outliers,
    excludedCount: records.filter(r => r.excluded && !r.interruption).length,
    confidence,
    errorPct
  };
}

export function countCycles(study) {
  return new Set((study.records || []).filter(r => !r.interruption).map(r => r.cycle)).size;
}

/* Ordem dos tipos nos gráficos empilhados: escolhida para que tipos vizinhos
   continuem distinguíveis para daltônicos (validado). */
export const CHART_TYPE_ORDER = ['VA', 'NVA', 'Transporte', 'Espera'];
