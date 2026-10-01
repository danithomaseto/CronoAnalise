import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats } from '../js/core/stats.js';
import { yamazumiSVG, paretoSVG, cycleTimeSVG, typesPresent, legendHTML } from '../js/core/charts.js';
import { createWorkbook, colName, sheetName, xmlEscape } from '../js/core/xlsx.js';
import { crc32, createZip } from '../js/core/zip.js';
import { buildReportSheets } from '../js/core/report.js';

function study(extra = {}) {
  const records = [];
  let n = 0;
  for (let c = 1; c <= 6; c++) {
    records.push({ id: 'a' + n++, cycle: c, stageId: 's1', stageName: 'Pegar', type: 'VA', time: 10 + c % 2, qty: 2, ts: '2026-09-30T12:00:0' + (c % 10) + '.000Z' });
    records.push({ id: 'b' + n++, cycle: c, stageId: 's2', stageName: 'Andar', type: 'Transporte', time: 5, qty: 1 });
    records.push({ id: 'c' + n++, cycle: c, stageId: 's3', stageName: 'Esperar', type: 'Espera', time: c === 6 ? 40 : 2, qty: 1 });
  }
  records.push({ id: 'int1', cycle: 3, stageId: null, stageName: 'Interrupção', type: 'Interrupção', time: 99, qty: 0, interruption: true, note: 'falta de caixa' });
  return { name: 'Linha <A> & "B"', process: 'P', operator: 'o', observer: 'x', notes: 'linha 1\nlinha 2',
    stages: [{ id: 's1', name: 'Pegar', type: 'VA', countsOutput: true }, { id: 's2', name: 'Andar', type: 'Transporte' }, { id: 's3', name: 'Esperar', type: 'Espera' }],
    records, ...extra };
}

test('interrupções ficam fora dos cálculos, mas são contadas', () => {
  const st = computeStats(study());
  assert.equal(st.interruptionCount, 1);
  assert.equal(st.interruptionTime, 99);
  assert.equal(st.cycleCount, 6);
  assert.ok(!st.summary.some(s => s.name === 'Interrupção'));
});

test('série por ciclo, ciclo fora da faixa e Pareto', () => {
  const st = computeStats(study());
  assert.equal(st.cycles.length, 6);
  assert.equal(st.cycles[0].byType.VA, 11);
  assert.ok(st.outlierCycles.has(6), 'ciclo 6 (espera de 40 s) fora de ±2σ');
  assert.equal(st.pareto[0].name, 'Pegar');
  assert.ok(Math.abs(st.pareto[st.pareto.length - 1].cumulative - 100) < 1e-9);
  assert.ok(st.vitalFew >= 1);
});

test('takt time, tempo por unidade e operadores necessários', () => {
  const st = computeStats(study({ demand: 480, availableMin: 480 })); // 60 s/un
  assert.equal(st.takt, 60);
  assert.equal(st.qtyTotal, 12);                       // só a etapa de produção (2 por ciclo)
  assert.ok(Math.abs(st.perUnit - st.total / 12) < 1e-9);
  assert.ok(Math.abs(st.operatorsNeeded - st.perUnit / 60) < 1e-9);
  assert.equal(st.unitsPerCycle, 2);
  assert.equal(st.taktPerCycle, 120);
  assert.equal(st.withinTakt, true);
  const sem = computeStats(study());
  assert.equal(sem.takt, 0);
  assert.equal(sem.withinTakt, null);
});

test('gráficos SVG: marcas, legenda, rótulos escapados e linha de takt', () => {
  const st = computeStats(study({ demand: 480, availableMin: 480 }));
  const y = yamazumiSVG(st, { width: 600, height: 260 });
  assert.match(y, /^<svg/);
  assert.equal((y.match(/class="mark t-va"/g) || []).length, 6);
  assert.ok(y.includes('Takt do ciclo'));
  assert.ok(y.includes('tabindex="0"'), 'marcas focáveis');
  const p = paretoSVG(st, { width: 600 });
  assert.equal((p.match(/class="mark /g) || []).length, 3);
  const c = cycleTimeSVG(st, { width: 600, height: 240 });
  assert.equal((c.match(/class="dot/g) || []).length, 6);
  assert.ok(c.includes('class="dot out"'), 'ciclo fora da faixa destacado');
  assert.equal((c.match(/class="hit"/g) || []).length, 6);
  const evil = computeStats({ stages: [], records: [{ id: 'x', cycle: 1, stageName: '<script>"', type: 'VA', time: 1, qty: 1 }] });
  assert.ok(!paretoSVG(evil).includes('<script>'));
  assert.equal(yamazumiSVG(computeStats({ stages: [], records: [] })), '');
  assert.equal(cycleTimeSVG(computeStats({ stages: [], records: [{ id: 'x', cycle: 1, stageName: 'a', type: 'VA', time: 1, qty: 1 }] })), '', 'linha precisa de 2+ ciclos');
});

test('ordem dos tipos nos gráficos (vizinhos distinguíveis) e legenda', () => {
  assert.deepEqual(typesPresent([{ Espera: 1, VA: 2 }, { Transporte: 1, NVA: 1 }]), ['VA', 'NVA', 'Transporte', 'Espera']);
  assert.equal(legendHTML(['VA']), '', 'uma série não precisa de legenda');
  assert.ok(legendHTML(['VA', 'NVA']).includes('legend-item'));
});

test('zip: CRC32 conhecido e estrutura', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const z = createZip([{ name: 'a.txt', data: 'olá' }]);
  const dv = new DataView(z.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(z.length - 22, true), 0x06054b50);
});

test('xlsx: utilitários', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(701), 'ZZ');
  const used = new Set();
  assert.equal(sheetName('Resumo', used), 'Resumo');
  assert.equal(sheetName('resumo', used), 'resumo 2');
  assert.equal(sheetName('a/b:c*d?[e]', new Set()), 'a b c d  e');
  assert.equal(xmlEscape('a<b>&"\u0001'), 'a&lt;b&gt;&amp;&quot;');
});

test('relatório Excel: abas e conteúdo', () => {
  const s = study({ demand: 480, availableMin: 480 });
  const sheets = buildReportSheets(s, computeStats(s), new Date('2026-09-30T12:00:00Z'));
  assert.deepEqual(sheets.map(x => x.name), ['Resumo', 'Registros', 'Por etapa', 'Por ciclo', 'Pareto', 'Observações']);
  const reg = sheets[1].rows;
  assert.equal(reg.length, 1 + s.records.length);
  const intRow = reg.find(r => r[2] === 'Interrupção');
  assert.equal(intRow[6], 'Não');
  assert.equal(intRow[7].v, 'falta de caixa');
  const wb = createWorkbook(sheets);
  assert.ok(wb.length > 1000);
});
