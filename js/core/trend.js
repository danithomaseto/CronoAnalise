/* Tendência do tempo de ciclo ao longo do estudo e curva de aprendizado.
   Sem DOM, testável no Node.

   - Regressão linear do tempo de cada ciclo pela ordem do ciclo; a inclinação é
     "significativa" quando |t| supera o valor crítico de Student (95%).
   - Com tendência de queda, ajusta a curva de aprendizado de Wright
     (T = a · n^b) e informa a taxa de aprendizado: 2^b (ex.: 90% = cada vez que
     a quantidade dobra, o tempo cai para 90%). */

const T_CRIT = [[1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306],
  [9, 2.262], [10, 2.228], [12, 2.179], [15, 2.131], [20, 2.086], [25, 2.060], [30, 2.042], [40, 2.021], [60, 2.000], [120, 1.980]];

export function tCritical(df) {
  if (!(df >= 1)) return Infinity;
  let v = 1.96;
  for (let i = T_CRIT.length - 1; i >= 0; i--) {
    if (df >= T_CRIT[i][0]) { v = df > 120 ? 1.96 : T_CRIT[i][1]; break; }
  }
  return v;
}

function regress(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) { const r = ys[i] - (intercept + slope * xs[i]); sse += r * r; }
  const se = n > 2 && sxx > 0 ? Math.sqrt(sse / (n - 2) / sxx) : 0;
  return { slope, intercept, se, mean: my };
}

/**
 * @param {number[]} values  tempo de cada ciclo, na ordem
 * @returns {null | { n: number, slope: number, intercept: number, changePct: number, t: number,
 *   significant: boolean, direction: 'down'|'up'|'flat', first: number, last: number,
 *   learningRate: number|null, firstHalf: number, secondHalf: number }}
 */
export function cycleTrend(values) {
  const ys = (values || []).filter(v => isFinite(v));
  const n = ys.length;
  if (n < 4) return null;
  const xs = ys.map((_, i) => i);
  const { slope, intercept, se, mean } = regress(xs, ys);
  const t = se > 0 ? slope / se : (slope !== 0 ? Infinity * Math.sign(slope) : 0);
  const significant = n >= 5 && Math.abs(t) >= tCritical(n - 2) && Math.abs(slope) > 1e-12;
  const direction = significant ? (slope < 0 ? 'down' : 'up') : 'flat';
  const half = Math.floor(n / 2);
  const avg = arr => arr.reduce((a, v) => a + v, 0) / (arr.length || 1);

  let learningRate = null;
  if (direction === 'down' && ys.every(v => v > 0)) {
    const lx = ys.map((_, i) => Math.log(i + 1));
    const ly = ys.map(v => Math.log(v));
    const b = regress(lx, ly).slope;
    const rate = Math.pow(2, b) * 100;
    if (rate > 0 && rate < 100) learningRate = Math.round(rate * 10) / 10;
  }

  return {
    n,
    slope,
    intercept,
    changePct: mean > 0 ? slope * (n - 1) / mean * 100 : 0,
    t,
    significant,
    direction,
    first: intercept,
    last: intercept + slope * (n - 1),
    learningRate,
    firstHalf: avg(ys.slice(0, half)),
    secondHalf: avg(ys.slice(n - half))
  };
}
