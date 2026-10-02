/* Amostragem do trabalho (work sampling) — sem DOM, testável no Node.

   Em horários aleatórios o observador anota o que está acontecendo (uma
   categoria). A proporção de cada categoria estima a fração do tempo gasta nela.
     n necessário = z² · p · (1 − p) / e²     (e = erro absoluto, em pontos %)
   Intervalos de confiança pelo método de Wilson (melhor que o "p ± z·√…" com
   poucas observações). */

import { hashString } from './format.js';
import { zFor } from './stats.js';

export function wilson(k, n, z) {
  if (!(n > 0)) return [0, 0];
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function requiredObservations(p, errorPts, z) {
  const e = errorPts / 100;
  const pp = Math.min(0.95, Math.max(0.05, p)); // evita n = 0 com p = 0 ou 1
  return Math.ceil(z * z * pp * (1 - pp) / (e * e));
}

/**
 * @param {import('./types.js').Study} study  estudo do tipo "sampling"
 * @param {import('./types.js').Prefs} [prefs]
 */
export function samplingStats(study, prefs = {}) {
  const confidence = prefs.confidence || 95;
  const errorPts = prefs.error || 5;
  const z = zFor(confidence);
  const cats = study.categories || [];
  const obs = (study.observations || []).filter(o => !o.excluded);
  const n = obs.length;

  const byId = new Map(cats.map(c => [c.id, c]));
  const rows = new Map();
  cats.forEach(c => rows.set(c.id, { id: c.id, name: c.name, productive: !!c.productive, count: 0 }));
  obs.forEach(o => {
    let key = o.cat;
    if (!byId.has(key)) {
      // categoria removida: agrupa pelo nome gravado na observação
      key = '__' + (o.catName || '?');
      if (!rows.has(key)) rows.set(key, { id: null, name: o.catName || '?', productive: !!o.productive, count: 0, removed: true });
    }
    rows.get(key).count++;
  });

  const productiveOf = o => (byId.has(o.cat) ? !!byId.get(o.cat).productive : !!o.productive);
  const prodCount = obs.filter(productiveOf).length;
  const pProd = n ? prodCount / n : 0;
  const availableMin = Number(study.availableMin) || 0;

  const categories = [...rows.values()].map(r => {
    const p = n ? r.count / n : 0;
    const [lo, hi] = wilson(r.count, n, z);
    return { ...r, p, lo, hi, minutes: availableMin > 0 ? p * availableMin : null };
  });
  const nRequired = requiredObservations(n ? pProd : 0.5, errorPts, z);
  const [plo, phi] = wilson(prodCount, n, z);

  return {
    n,
    categories,
    productiveCount: prodCount,
    productivePct: pProd * 100,
    productiveLo: plo * 100,
    productiveHi: phi * 100,
    nRequired,
    enough: n >= nRequired,
    progress: nRequired ? Math.min(1, n / nRequired) : 0,
    halfWidth: n ? (phi - plo) / 2 * 100 : null,
    confidence,
    errorPts,
    availableMin
  };
}

/* Gerador pseudoaleatório determinístico (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toMin = hhmm => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v < 24 * 60 ? v : null;
};
export const fmtHHMM = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(Math.round(min % 60)).padStart(2, '0');

export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = toMin(raw.start), end = toMin(raw.end);
  const count = Math.round(Number(raw.count));
  if (start === null || end === null || end <= start || !(count >= 1 && count <= 300)) return null;
  return { start: fmtHHMM(start), end: fmtHHMM(end), count };
}

/* Horários aleatórios do dia (iguais em todos os aparelhos: a semente vem do
   estudo, da data e do plano). Intervalo mínimo entre observações: 2 min. */
export function randomSchedule(plan, seedText) {
  const p = normalizePlan(plan);
  if (!p) return [];
  const start = toMin(p.start), end = toMin(p.end);
  const span = end - start;
  const gap = Math.min(2, span / p.count);
  const rand = mulberry32(parseInt(hashString(seedText + '|' + p.start + '|' + p.end + '|' + p.count), 36));
  const picked = [];
  for (let tries = 0; picked.length < p.count && tries < p.count * 200; tries++) {
    const v = Math.floor(start + rand() * span);
    if (picked.every(x => Math.abs(x - v) >= gap)) picked.push(v);
  }
  if (picked.length < p.count) {
    // intervalo pequeno demais para tantos horários: distribui por igual
    picked.length = 0;
    for (let i = 0; i < p.count; i++) picked.push(Math.floor(start + (i + 0.5) * span / p.count));
  }
  return picked.sort((a, b) => a - b).map(fmtHHMM);
}
