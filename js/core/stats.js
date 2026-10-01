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
 * @param study  estudo normalizado
 * @param prefs  { confidence: 90|95|99, error: % }
 */
export function computeStats(study, prefs = {}) {
  const confidence = prefs.confidence || 95;
  const errorPct = prefs.error || 5;
  const z = zFor(confidence);
  const e = errorPct / 100;

  const records = study.records || [];
  const active = records.filter(r => !r.excluded);
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

  return {
    total,
    qtyTotal,
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
    excludedCount: records.length - active.length,
    confidence,
    errorPct
  };
}

export function countCycles(study) {
  return new Set((study.records || []).map(r => r.cycle)).size;
}
