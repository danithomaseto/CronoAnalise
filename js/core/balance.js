/* Balanceamento de linha — sem DOM, testável no Node.

   Cada etapa pode pertencer a um posto (campo `station` da etapa). A carga de
   uma etapa é o tempo que ela consome por ciclo (tempo padrão, se houver ritmo
   ou tolerâncias). A carga do posto é a soma das cargas das suas etapas e é
   comparada ao takt do ciclo (takt × unidades por ciclo).

   A sugestão divide as etapas, na ordem do processo, em k postos consecutivos
   minimizando a carga do posto mais carregado (partição linear, programação
   dinâmica) — a ordem das etapas faz o papel da precedência. */

export const NO_STATION = 'Sem posto';

/**
 * @param {import('./types.js').Study} study
 * @param {ReturnType<typeof import('./stats.js').computeStats>} stats
 */
export function computeBalance(study, stats) {
  const cycles = stats.cycleCount || 0;
  const stages = study.stages || [];
  const order = new Map(stages.map((s, i) => [s.id, i]));
  const byId = new Map(stages.map(s => [s.id, s]));

  // etapas com registros, na ordem do processo (etapas removidas vão ao fim)
  const items = stats.summary.map((s, i) => ({
    stageId: s.stageId,
    name: s.name,
    type: s.type,
    load: cycles ? s.stdTotal / cycles : 0,
    station: ((byId.get(s.stageId) || {}).station || '').trim() || NO_STATION,
    _o: order.has(s.stageId) ? order.get(s.stageId) : stages.length + i
  })).filter(x => x.load > 0).sort((a, b) => a._o - b._o);
  items.forEach(x => { delete x._o; });

  const map = new Map();
  items.forEach(it => {
    if (!map.has(it.station)) map.set(it.station, { name: it.station, load: 0, items: [] });
    const st = map.get(it.station);
    st.load += it.load;
    st.items.push(it);
  });
  const stations = [...map.values()];
  const total = items.reduce((a, x) => a + x.load, 0);
  const maxLoad = stations.reduce((m, s) => Math.max(m, s.load), 0);
  const bottleneck = stations.find(s => s.load === maxLoad) || null;
  const taktCycle = stats.taktPerCycle > 0 ? stats.taktPerCycle : 0;

  return {
    items,
    stations,
    total,
    maxLoad,
    bottleneck: bottleneck ? bottleneck.name : null,
    efficiency: stations.length && maxLoad > 0 ? total / (stations.length * maxLoad) * 100 : 0,
    taktCycle,
    minStations: taktCycle > 0 && total > 0 ? Math.max(1, Math.ceil(total / taktCycle - 1e-9)) : null,
    overTakt: taktCycle > 0 ? stations.filter(s => s.load > taktCycle + 1e-9).map(s => s.name) : [],
    unitsPerHour: maxLoad > 0 ? 3600 * (stats.unitsPerCycle || 0) / maxLoad : 0,
    hasStations: stages.some(s => (s.station || '').trim()),
    unassigned: stages.filter(s => !(s.station || '').trim()).length
  };
}

/* Partição linear: divide `loads` (na ordem) em até k grupos consecutivos
   minimizando a maior soma. Devolve os índices de início de cada grupo. */
export function linearPartition(loads, k) {
  const n = loads.length;
  if (!n) return [];
  k = Math.max(1, Math.min(k, n));
  const pre = [0];
  loads.forEach(v => pre.push(pre[pre.length - 1] + v));
  const sum = (i, j) => pre[j] - pre[i]; // itens [i, j)
  // dp[g][j] = menor "maior soma" usando g grupos para os j primeiros itens
  const dp = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
  const cut = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
  dp[0][0] = 0;
  for (let g = 1; g <= k; g++) {
    for (let j = g; j <= n; j++) {
      for (let i = g - 1; i < j; i++) {
        const v = Math.max(dp[g - 1][i], sum(i, j));
        if (v < dp[g][j] - 1e-12) { dp[g][j] = v; cut[g][j] = i; }
      }
    }
  }
  const starts = [];
  let j = n;
  for (let g = k; g >= 1; g--) { const i = cut[g][j]; starts.unshift(i); j = i; }
  return starts;
}

/* Sugestão com k postos: { stations: [{ name, load, items }], maxLoad, efficiency, assignment: {stageId: nome} } */
export function suggestBalance(balance, k) {
  const items = balance.items;
  if (!items.length) return null;
  const starts = linearPartition(items.map(x => x.load), k);
  const stations = starts.map((s, g) => {
    const end = g + 1 < starts.length ? starts[g + 1] : items.length;
    const its = items.slice(s, end);
    return { name: 'Posto ' + (g + 1), load: its.reduce((a, x) => a + x.load, 0), items: its };
  });
  const maxLoad = Math.max(...stations.map(s => s.load));
  const assignment = {};
  stations.forEach(st => st.items.forEach(it => { if (it.stageId) assignment[it.stageId] = st.name; }));
  return {
    stations,
    maxLoad,
    efficiency: maxLoad > 0 ? balance.total / (stations.length * maxLoad) * 100 : 0,
    withinTakt: balance.taktCycle > 0 ? maxLoad <= balance.taktCycle + 1e-9 : null,
    assignment
  };
}
