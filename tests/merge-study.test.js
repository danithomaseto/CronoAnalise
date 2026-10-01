import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStudy, normalizeStudy, pruneStudyTombstones, mergeStores, emptyStore } from '../js/core/model.js';
import { stableStringify } from '../js/core/format.js';

const T = n => new Date(Date.UTC(2026, 8, 1, 12, 0, n)).toISOString(); // T(5) = 12:00:05
const clone = x => JSON.parse(JSON.stringify(x));

function base() {
  return normalizeStudy({
    id: 's1', name: 'Linha A', createdAt: T(0), updatedAt: T(1), notes: '',
    stages: [{ id: 'st1', name: 'Pegar', type: 'VA' }, { id: 'st2', name: 'Andar', type: 'Transporte' }],
    records: [{ id: 'r1', cycle: 1, stageId: 'st1', stageName: 'Pegar', type: 'VA', time: 1, qty: 1, ts: T(1) }]
  });
}
const rec = (id, ts, extra = {}) => ({ id, cycle: 1, stageId: 'st1', stageName: 'Pegar', type: 'VA', time: 2, qty: 1, ts, ...extra });

test('aparelho A marca etapas enquanto B edita observações: as duas coisas ficam', () => {
  const a = clone(base()), b = clone(base());
  a.records.push(rec('r2', T(10)));
  a.updatedAt = T(10);
  b.notes = 'nota do B';
  b.fieldTs = { notes: T(5) };
  b.updatedAt = T(5);
  const m = mergeStudy(a, b);
  assert.deepEqual(m.records.map(r => r.id), ['r1', 'r2']);
  assert.equal(m.notes, 'nota do B');
  assert.equal(m.updatedAt, T(10));
});

test('registros novos dos dois lados são unidos em ordem cronológica', () => {
  const a = clone(base()), b = clone(base());
  a.records.push(rec('ra', T(20)));
  b.records.push(rec('rb', T(15)));
  a.updatedAt = T(20); b.updatedAt = T(15);
  assert.deepEqual(mergeStudy(a, b).records.map(r => r.id), ['r1', 'rb', 'ra']);
});

test('exclusão vence edição anterior; edição posterior vence exclusão', () => {
  const a = clone(base()), b = clone(base());
  a.records = []; a.deletedRecords = { r1: T(10) }; a.updatedAt = T(10);
  b.records[0].time = 9; b.records[0].u = T(5); b.updatedAt = T(5);
  let m = mergeStudy(a, b);
  assert.equal(m.records.length, 0);
  assert.equal(m.deletedRecords.r1, T(10));

  b.records[0].u = T(12); b.updatedAt = T(12);
  m = mergeStudy(a, b);
  assert.equal(m.records.length, 1);
  assert.equal(m.records[0].time, 9);
  assert.equal(m.deletedRecords, undefined, 'lápide superada é descartada');
});

test('edição de registro: vence a mais recente', () => {
  const a = clone(base()), b = clone(base());
  a.records[0].time = 5; a.records[0].u = T(8);
  b.records[0].qty = 3; b.records[0].u = T(9);
  const m = mergeStudy(a, b);
  assert.equal(m.records[0].qty, 3);
  assert.equal(m.records[0].time, 1);
});

function swapPos(s, i, j, t) {
  const pi = s.stages[i].pos; s.stages[i].pos = s.stages[j].pos; s.stages[j].pos = pi;
  s.stages[i].u = t; s.stages[j].u = t;
  s.stages.sort((x, y) => x.pos - y.pos);
}

test('etapas: reordenação de A + etapa nova de B + exclusão', () => {
  const a = clone(base()), b = clone(base());
  swapPos(a, 0, 1, T(10)); a.updatedAt = T(10);
  b.stages.push({ id: 'st3', name: 'Conferir', type: 'NVA', u: T(11), pos: 2 });
  b.stages = b.stages.filter(s => s.id !== 'st1'); b.deletedStages = { st1: T(11) }; b.updatedAt = T(11);
  const m = mergeStudy(a, b);
  assert.deepEqual(m.stages.map(s => s.id), ['st2', 'st3']);
});

test('dados antigos sem datas por campo: vence o estudo editado por último (comportamento anterior)', () => {
  const a = clone(base()), b = clone(base());
  a.notes = 'A'; a.updatedAt = T(5);
  b.notes = 'B'; b.updatedAt = T(9);
  assert.equal(mergeStudy(a, b).notes, 'B');
  assert.equal(mergeStudy(b, a).notes, 'B');
});

test('campo com data explícita vence campo sem data mesmo em estudo mais novo', () => {
  const a = clone(base()), b = clone(base());
  a.notes = 'editada'; a.fieldTs = { notes: T(5) }; a.updatedAt = T(5);
  b.records.push(rec('r9', T(30))); b.updatedAt = T(30); // B só marcou etapas
  assert.equal(mergeStudy(a, b).notes, 'editada');
});

test('ciclo atual e histórico', () => {
  const a = clone(base()), b = clone(base());
  a.currentCycle = 4; a.fieldTs = { currentCycle: T(10) };
  a.history.push({ ts: T(10), text: 'A' });
  b.currentCycle = 3; b.fieldTs = { currentCycle: T(12) }; // B desfez um ciclo depois
  b.history.push({ ts: T(11), text: 'B' });
  const m = mergeStudy(a, b);
  assert.equal(m.currentCycle, 3);
  assert.deepEqual(m.history.map(h => h.text).slice(-2), ['A', 'B']);
});

test('lápides internas antigas são podadas', () => {
  const s = { ...base(), deletedRecords: { old: '2020-01-01T00:00:00.000Z', recent: T(1) } };
  const p = pruneStudyTombstones(s, Date.parse(T(2)));
  assert.deepEqual(Object.keys(p.deletedRecords), ['recent']);
});

/* ---------- Propriedades: convergência ----------
   Gera edições aleatórias em 3 aparelhos e verifica que a mesclagem é
   comutativa, associativa e idempotente (todos chegam ao mesmo resultado). */
function rng(seed) {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

function randomEdits(study, rand, clock) {
  const s = clone(study);
  const n = 1 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const t = T(clock.n++);
    const op = Math.floor(rand() * 7);
    if (op === 0) { s.records.push(rec('r' + clock.n + '_' + Math.floor(rand() * 1e6), t)); }
    else if (op === 1 && s.records.length) { const r = s.records[Math.floor(rand() * s.records.length)]; r.time = Math.round(rand() * 100) / 10; r.u = t; }
    else if (op === 2 && s.records.length) { const k = Math.floor(rand() * s.records.length); const [r] = s.records.splice(k, 1); s.deletedRecords = { ...(s.deletedRecords || {}), [r.id]: t }; }
    else if (op === 3) { s.notes = 'nota ' + clock.n; s.fieldTs = { ...(s.fieldTs || {}), notes: t }; }
    else if (op === 4) { s.stages.push({ id: 'st' + clock.n, name: 'E' + clock.n, type: 'VA', u: t, pos: Math.max(-1, ...s.stages.map(x => x.pos)) + 1 }); }
    else if (op === 5 && s.stages.length > 1) { const i = Math.floor(rand() * (s.stages.length - 1)); swapPos(s, i, i + 1, t); }
    else if (op === 6) { s.currentCycle = 1 + Math.floor(rand() * 9); s.fieldTs = { ...(s.fieldTs || {}), currentCycle: t }; }
    s.updatedAt = t;
  }
  return s;
}

test('mesclagem converge: comutativa, associativa e idempotente (200 cenários aleatórios)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rand = rng(seed);
    const clock = { n: 10 };
    const a = randomEdits(base(), rand, clock);
    const b = randomEdits(base(), rand, clock);
    const c = randomEdits(base(), rand, clock);
    const ab = mergeStudy(a, b), ba = mergeStudy(b, a);
    assert.equal(stableStringify(ab), stableStringify(ba), 'comutativa, seed ' + seed);
    assert.equal(stableStringify(mergeStudy(ab, c)), stableStringify(mergeStudy(a, mergeStudy(b, c))), 'associativa, seed ' + seed);
    assert.equal(stableStringify(mergeStudy(ab, ab)), stableStringify(ab), 'idempotente, seed ' + seed);
    assert.equal(stableStringify(mergeStudy(ab, a)), stableStringify(ab), 'absorve versão antiga, seed ' + seed);
  }
});

test('mergeStores usa a mesclagem por registro', () => {
  const a = emptyStore(), b = emptyStore();
  const sa = clone(base()), sb = clone(base());
  sa.records.push(rec('ra', T(20))); sa.updatedAt = T(20);
  sb.records.push(rec('rb', T(21))); sb.updatedAt = T(21);
  a.studies.s1 = sa; b.studies.s1 = sb;
  assert.deepEqual(mergeStores(a, b).studies.s1.records.map(r => r.id), ['r1', 'ra', 'rb']);
});
