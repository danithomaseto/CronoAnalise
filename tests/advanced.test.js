import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whRating, normalizeWh } from '../js/core/westinghouse.js';
import { cycleTrend, tCritical } from '../js/core/trend.js';
import { computeBalance, suggestBalance, linearPartition } from '../js/core/balance.js';
import { samplingStats, wilson, requiredObservations, randomSchedule, normalizePlan } from '../js/core/sampling.js';
import { computeStats } from '../js/core/stats.js';
import { normalizeStudy, createStudy, normalizeA3, mergeStudy } from '../js/core/model.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/* ---------- Westinghouse ---------- */
test('Westinghouse: soma dos fatores vira o ritmo da etapa', () => {
  assert.equal(whRating({ skill: 'C1', effort: 'C2', conditions: 'D', consistency: 'D' }), 108);
  assert.equal(whRating({ skill: 'A1', effort: 'A1', conditions: 'A', consistency: 'A' }), 138);
  assert.equal(whRating({ skill: 'F2', effort: 'F2', conditions: 'F', consistency: 'F' }), 50);
  assert.equal(whRating({ skill: 'B2' }), 108, 'fator não avaliado conta como médio');
  assert.equal(whRating(null), null);
  assert.equal(whRating({ skill: 'Z9' }), null, 'nível inválido é ignorado');
  assert.deepEqual(normalizeWh({ skill: 'C1', foo: 'x', effort: 'nope' }), { skill: 'C1' });
});

test('ritmo por etapa substitui o ritmo do estudo só naquela etapa', () => {
  const s = normalizeStudy({
    id: 's', name: 'x', rating: 100, allowance: 10,
    stages: [{ id: 'a', name: 'A', type: 'VA', wh: { skill: 'C1', effort: 'C2' } }, { id: 'b', name: 'B', type: 'NVA' }],
    records: [
      { id: '1', cycle: 1, stageId: 'a', stageName: 'A', type: 'VA', time: 10, qty: 1 },
      { id: '2', cycle: 1, stageId: 'b', stageName: 'B', type: 'NVA', time: 5, qty: 1 },
      { id: '3', cycle: 2, stageId: 'a', stageName: 'A', type: 'VA', time: 10, qty: 1 },
      { id: '4', cycle: 2, stageId: 'b', stageName: 'B', type: 'NVA', time: 5, qty: 1 }
    ]
  });
  const st = computeStats(s);
  const a = st.summary.find(x => x.name === 'A'), b = st.summary.find(x => x.name === 'B');
  assert.equal(a.rating, 108);
  assert.equal(b.rating, 100);
  near(a.normal, 10.8);
  near(a.standard, 10.8 * 1.1);
  near(b.standard, 5 * 1.1);
  near(st.stdCycle, (10.8 + 5) * 1.1);
  assert.equal(st.hasStdParams, true);
});

test('sem ritmo por etapa, o tempo padrão continua igual ao cálculo anterior', () => {
  const s = normalizeStudy({
    id: 's', name: 'x', rating: 110, allowance: 10,
    stages: [{ id: 'a', name: 'A', type: 'VA' }],
    records: [1, 2, 3].map(i => ({ id: 'r' + i, cycle: i, stageId: 'a', stageName: 'A', type: 'VA', time: 30, qty: 2 }))
  });
  const st = computeStats(s);
  near(st.stdCycle, 30 * 1.1 * 1.1);
  near(st.perUnitStd, 15 * 1.1 * 1.1);
});

/* ---------- Tendência ---------- */
test('tendência: queda consistente é significativa e tem curva de aprendizado', () => {
  const ys = [60, 55, 52, 50, 48, 47, 46, 45, 44.5, 44];
  const t = cycleTrend(ys);
  assert.equal(t.direction, 'down');
  assert.ok(t.significant);
  assert.ok(t.changePct < -10, 'queda percentual: ' + t.changePct);
  assert.ok(t.learningRate > 80 && t.learningRate < 100, 'taxa de aprendizado: ' + t.learningRate);
  assert.ok(t.secondHalf < t.firstHalf);
});

test('tendência: ruído sem direção é "estável"; poucos ciclos não calculam', () => {
  assert.equal(cycleTrend([50, 52, 49, 51, 50, 52, 49, 51]).direction, 'flat');
  assert.equal(cycleTrend([1, 2, 3]), null);
  const up = cycleTrend([40, 41, 43, 44, 46, 47, 49, 50]);
  assert.equal(up.direction, 'up');
  assert.equal(up.learningRate, null);
  assert.ok(tCritical(3) > tCritical(30));
});

test('indicadores trazem a tendência do tempo de ciclo', () => {
  const recs = [60, 55, 52, 50, 48, 47].map((t, i) => ({ id: 'r' + i, cycle: i + 1, stageId: 'a', stageName: 'A', type: 'VA', time: t, qty: 1 }));
  const st = computeStats(normalizeStudy({ id: 's', name: 'x', stages: [{ id: 'a', name: 'A', type: 'VA' }], records: recs }));
  assert.equal(st.trend.direction, 'down');
});

/* ---------- Balanceamento ---------- */
function lineStudy(stations = {}) {
  const stages = [['a', 'Pegar', 'VA', 20], ['b', 'Montar', 'VA', 40], ['c', 'Conferir', 'NVA', 10], ['d', 'Embalar', 'VA', 30]];
  const records = [];
  [1, 2].forEach(cyc => stages.forEach(([id, name, type, t]) => records.push({ id: id + cyc, cycle: cyc, stageId: id, stageName: name, type, time: t, qty: id === 'd' ? 1 : 0 })));
  return normalizeStudy({
    id: 'L', name: 'Linha', demand: 480, availableMin: 400, // takt = 50 s/un
    stages: stages.map(([id, name, type], i) => ({ id, name, type, pos: i, ...(stations[id] ? { station: stations[id] } : {}), ...(id === 'd' ? { countsOutput: true } : {}) })),
    records
  });
}

test('balanceamento: carga por posto, gargalo, eficiência e mínimo de postos', () => {
  const s = lineStudy({ a: 'P1', b: 'P1', c: 'P2', d: 'P2' });
  const st = computeStats(s);
  const bal = computeBalance(s, st);
  assert.deepEqual(bal.stations.map(x => x.name), ['P1', 'P2']);
  near(bal.stations[0].load, 60);
  near(bal.stations[1].load, 40);
  assert.equal(bal.bottleneck, 'P1');
  near(bal.efficiency, 100 / (2 * 60) * 100);
  near(bal.taktCycle, 50);
  assert.equal(bal.minStations, 2); // 100 s de trabalho / 50 s de takt
  assert.deepEqual(bal.overTakt, ['P1']);
  near(bal.unitsPerHour, 3600 / 60);
});

test('balanceamento: etapas sem posto vão para "Sem posto"', () => {
  const bal = computeBalance(lineStudy({ a: 'P1' }), computeStats(lineStudy({ a: 'P1' })));
  assert.deepEqual(bal.stations.map(x => x.name), ['P1', 'Sem posto']);
  assert.equal(bal.unassigned, 3);
});

test('partição linear minimiza o posto mais carregado mantendo a ordem', () => {
  assert.deepEqual(linearPartition([20, 40, 10, 30], 2), [0, 2]); // [20,40] [10,30] → 60
  assert.deepEqual(linearPartition([20, 40, 10, 30], 3), [0, 1, 2]); // [20] [40] [10,30] → 40
  assert.deepEqual(linearPartition([5], 3), [0]);
  const s = lineStudy();
  const sug = suggestBalance(computeBalance(s, computeStats(s)), 3);
  assert.deepEqual(sug.stations.map(x => x.load), [20, 40, 40]);
  assert.equal(sug.withinTakt, true);
  assert.equal(sug.assignment.b, 'Posto 2');
  assert.equal(sug.assignment.c, 'Posto 3');
  near(sug.efficiency, 100 / (3 * 40) * 100);
});

/* ---------- Amostragem ---------- */
test('Wilson e observações necessárias', () => {
  const [lo, hi] = wilson(80, 100, 1.96);
  near(lo, 0.7112, 1e-3);
  near(hi, 0.8666, 1e-3);
  assert.equal(requiredObservations(0.8, 5, 1.96), 246);
  assert.equal(requiredObservations(0.5, 5, 1.96), 385);
  assert.equal(requiredObservations(1, 5, 1.96), requiredObservations(0.95, 5, 1.96), 'p extremo não zera n');
});

test('amostragem: proporções, % produtivo, IC e minutos estimados', () => {
  const s = normalizeStudy(createStudy({ id: 'w', name: 'Amostra', kind: 'sampling', now: '2026-09-01T10:00:00.000Z' }));
  const [prod, idle] = s.categories;
  s.availableMin = 480;
  s.observations = [];
  for (let i = 0; i < 30; i++) s.observations.push({ id: 'o' + i, ts: '2026-09-01T10:' + String(i).padStart(2, '0') + ':00.000Z', cat: i < 24 ? prod.id : idle.id, catName: '', productive: i < 24 });
  const st = samplingStats(normalizeStudy(s), { confidence: 95, error: 5 });
  assert.equal(st.n, 30);
  near(st.productivePct, 80);
  assert.equal(st.categories[0].count, 24);
  near(st.categories[0].minutes, 0.8 * 480);
  assert.ok(st.productiveLo < 80 && st.productiveHi > 80);
  assert.equal(st.nRequired, 246);
  assert.equal(st.enough, false);
});

test('amostragem: categoria removida continua contada pelo nome', () => {
  const s = normalizeStudy({
    id: 'w', name: 'x', kind: 'sampling', categories: [{ id: 'c1', name: 'Produtivo', productive: true }],
    observations: [{ id: 'o1', ts: '2026-09-01T10:00:00.000Z', cat: 'c1' }, { id: 'o2', ts: '2026-09-01T10:01:00.000Z', cat: 'gone', catName: 'Antiga', productive: false }]
  });
  const st = samplingStats(s);
  assert.deepEqual(st.categories.map(c => [c.name, c.count]), [['Produtivo', 1], ['Antiga', 1]]);
});

test('roteiro aleatório: determinístico, ordenado, dentro do horário e com intervalo mínimo', () => {
  const plan = { start: '08:00', end: '12:00', count: 20 };
  const a = randomSchedule(plan, 'estudo|2026-09-01');
  assert.deepEqual(a, randomSchedule(plan, 'estudo|2026-09-01'));
  assert.notDeepEqual(a, randomSchedule(plan, 'estudo|2026-09-02'));
  assert.equal(a.length, 20);
  assert.deepEqual([...a].sort(), a);
  assert.ok(a[0] >= '08:00' && a[a.length - 1] < '12:00');
  const mins = a.map(h => Number(h.slice(0, 2)) * 60 + Number(h.slice(3)));
  for (let i = 1; i < mins.length; i++) assert.ok(mins[i] - mins[i - 1] >= 2);
  assert.equal(randomSchedule({ start: '08:00', end: '08:10', count: 30 }, 'x').length, 30, 'intervalo curto: distribui por igual');
  assert.equal(normalizePlan({ start: '10:00', end: '09:00', count: 5 }), null);
});

/* ---------- Modelo: novos campos ---------- */
test('modelo: posto, avaliação, fotos e A3 são normalizados', () => {
  const s = normalizeStudy({
    id: 's', name: 'x',
    stages: [{ id: 'a', name: 'A', type: 'VA', station: '  P1 ', wh: { skill: 'C1', bad: 1 } }, { id: 'b', name: 'B', type: 'VA', station: '   ', wh: {} }],
    records: [{ id: 'r', cycle: 1, stageName: 'A', time: 1, photos: [{ id: 'p1', path: 's/p1.jpg' }, { id: 'p1', path: 'dup' }, { bad: true }] }],
    a3: { problem: 'Fila', actions: [{ what: 'Kanban', who: 'Ana', when: '2026-10-10', status: 'x' }, { what: '' }] }
  });
  assert.equal(s.stages[0].station, 'P1');
  assert.deepEqual(s.stages[0].wh, { skill: 'C1' });
  assert.equal(s.stages[1].station, undefined);
  assert.equal(s.stages[1].wh, undefined);
  assert.deepEqual(s.records[0].photos, [{ id: 'p1', path: 's/p1.jpg' }]);
  assert.equal(s.a3.problem, 'Fila');
  assert.equal(s.a3.actions.length, 1);
  assert.equal(s.a3.actions[0].status, 'aberta');
  assert.equal(normalizeA3({ problem: '  ' }), null);
});

test('amostragem: observações de dois aparelhos se somam; exclusão propaga', () => {
  const base = normalizeStudy(createStudy({ id: 'w', name: 'Amostra', kind: 'sampling', now: '2026-09-01T10:00:00.000Z' }));
  const cat = base.categories[0].id;
  const a = JSON.parse(JSON.stringify(base)), b = JSON.parse(JSON.stringify(base));
  a.observations.push({ id: 'oa', ts: '2026-09-01T10:05:00.000Z', cat, catName: 'Produtivo', productive: true });
  a.updatedAt = '2026-09-01T10:05:00.000Z';
  b.observations.push({ id: 'ob', ts: '2026-09-01T10:03:00.000Z', cat, catName: 'Produtivo', productive: true });
  b.categories = b.categories.filter(c => c.name !== 'Ausente');
  b.deletedCategories = { [base.categories.find(c => c.name === 'Ausente').id]: '2026-09-01T10:03:00.000Z' };
  b.updatedAt = '2026-09-01T10:03:00.000Z';
  const m = mergeStudy(a, b);
  assert.deepEqual(m.observations.map(o => o.id), ['ob', 'oa']);
  assert.ok(!m.categories.some(c => c.name === 'Ausente'));
  assert.equal(JSON.stringify(mergeStudy(a, b)), JSON.stringify(mergeStudy(a, b)));
});
