import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCSV, textCell } from '../js/core/csv.js';
import { computeStats } from '../js/core/stats.js';

test('textCell protege separador, aspas, quebras e fórmulas', () => {
  assert.equal(textCell('simples'), 'simples');
  assert.equal(textCell('a;b'), '"a;b"');
  assert.equal(textCell('diz "oi"'), '"diz ""oi"""');
  assert.equal(textCell('linha1\nlinha2'), '"linha1\nlinha2"');
  assert.equal(textCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(textCell('+1'), "'+1");
  assert.equal(textCell('@SUM'), "'@SUM");
  assert.equal(textCell(null), '');
});

test('buildCSV mantém o layout: cabeçalho, registros, resumo, totais e observações', () => {
  const study = {
    name: 'Separação; Linha A',
    process: 'Picking', operator: 'op1', observer: 'obs1',
    notes: 'Espera recorrente; falta de material\n=perigo',
    stages: [{ id: 's1', name: 'Pegar', type: 'VA' }],
    records: [
      { id: 'r1', cycle: 1, stageId: 's1', stageName: 'Pegar', type: 'VA', time: 1.5, qty: 2, ts: '2026-09-30T12:00:00.000Z' },
      { id: 'r2', cycle: 2, stageId: 's1', stageName: 'Pegar', type: 'VA', time: 2.5, qty: 1, excluded: true }
    ]
  };
  const csv = buildCSV(study, computeStats(study), new Date('2026-09-30T12:00:00Z'));
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Estudo;"Separação; Linha A"');
  assert.equal(lines[1], 'Processo;Picking');
  assert.equal(lines[2], 'Usuário LMS;op1');
  assert.equal(lines[3], 'Champion OMS;obs1');
  assert.ok(lines.includes('Ciclo;Etapa;Tipo;Tempo(s);Qtd;Horário;Considerado'));
  assert.ok(lines.some(l => l.startsWith('1;Pegar;VA;1,50;2;') && l.endsWith(';Sim')));
  assert.ok(lines.some(l => l.startsWith('2;Pegar;VA;2,50;1;') && l.endsWith(';Não')));
  assert.ok(lines.includes('Tempo Total(s);1,50'));
  assert.ok(lines.includes('Produtividade (un/h);4800,00'));
  assert.ok(lines.includes('"Espera recorrente; falta de material"'));
  assert.ok(lines.includes("'=perigo"));
  assert.ok(!csv.includes('Tempo Padrão'), 'sem ritmo/tolerância, não exporta colunas de tempo padrão');
});
