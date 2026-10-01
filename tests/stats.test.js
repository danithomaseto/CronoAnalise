import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, countCycles } from '../js/core/stats.js';

function rec(id, cycle, stageId, stageName, type, time, qty = 1, extra = {}) {
  return { id, cycle, stageId, stageName, type, time, qty, ...extra };
}

const baseStudy = () => ({
  stages: [
    { id: 's1', name: 'Pegar', type: 'VA' },
    { id: 's2', name: 'Andar', type: 'Transporte' }
  ],
  records: [
    rec('r1', 1, 's1', 'Pegar', 'VA', 10, 5),
    rec('r2', 1, 's2', 'Andar', 'Transporte', 20),
    rec('r3', 2, 's1', 'Pegar', 'VA', 12, 5),
    rec('r4', 2, 's2', 'Andar', 'Transporte', 18)
  ]
});

test('totais, % VA, ciclos e produtividade (soma todas as etapas por padrão)', () => {
  const st = computeStats(baseStudy());
  assert.equal(st.total, 60);
  assert.equal(st.qtyTotal, 12);
  assert.equal(st.usesOutputStages, false);
  assert.ok(Math.abs(st.productivity - 12 / (60 / 3600)) < 1e-9);
  assert.ok(Math.abs(st.vaPct - 22 / 60 * 100) < 1e-9);
  assert.equal(st.cycleCount, 2);
  assert.equal(st.avgCycle, 30);
  assert.equal(st.hasStdParams, false);
});

test('etapas "conta para produção" restringem a quantidade', () => {
  const s = baseStudy();
  s.stages[0].countsOutput = true;
  const st = computeStats(s);
  assert.equal(st.usesOutputStages, true);
  assert.equal(st.qtyTotal, 10);
});

test('resumo por etapa com desvio padrão, CV e ciclos necessários', () => {
  const st = computeStats(baseStudy(), { confidence: 95, error: 5 });
  const pegar = st.summary.find(x => x.name === 'Pegar');
  assert.equal(pegar.count, 2);
  assert.equal(pegar.avg, 11);
  assert.equal(pegar.min, 10);
  assert.equal(pegar.max, 12);
  const sd = Math.sqrt(2); // amostral: ((1)^2 + (1)^2) / (2-1)
  assert.ok(Math.abs(pegar.sd - sd) < 1e-9);
  assert.ok(Math.abs(pegar.cv - sd / 11 * 100) < 1e-9);
  assert.equal(pegar.nRequired, Math.ceil(Math.pow(1.96 * sd / (0.05 * 11), 2)));
  assert.equal(pegar.qty, 10);
});

test('registros ignorados ficam fora dos cálculos', () => {
  const s = baseStudy();
  s.records[1].excluded = true;
  const st = computeStats(s);
  assert.equal(st.total, 40);
  assert.equal(st.excludedCount, 1);
});

test('tempo normal e padrão com ritmo e tolerâncias', () => {
  const s = baseStudy();
  s.rating = 110;
  s.allowance = 10;
  const st = computeStats(s);
  assert.equal(st.hasStdParams, true);
  const pegar = st.summary.find(x => x.name === 'Pegar');
  assert.ok(Math.abs(pegar.normal - 12.1) < 1e-9);
  assert.ok(Math.abs(pegar.standard - 13.31) < 1e-9);
  assert.ok(Math.abs(st.stdCycle - 30 * 1.1 * 1.1) < 1e-9);
});

test('outliers: fora de ±2σ com pelo menos 5 ocorrências', () => {
  const s = { stages: [], records: [] };
  [10, 10, 10, 10, 10, 10, 10, 10, 10, 30].forEach((t, i) => s.records.push(rec('x' + i, i + 1, 's', 'E', 'VA', t)));
  const st = computeStats(s);
  assert.ok(st.outliers.has('x9'));
  assert.equal(st.outliers.size, 1);
});

test('estudo vazio não quebra', () => {
  const st = computeStats({ stages: [], records: [] });
  assert.equal(st.total, 0);
  assert.equal(st.productivity, 0);
  assert.equal(st.summary.length, 0);
});

test('countCycles conta ciclos distintos (antes mostrava sempre 1)', () => {
  assert.equal(countCycles(baseStudy()), 2);
  assert.equal(countCycles({ records: [] }), 0);
});
