import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStore, normalizeStudy, normalizeStore, convertBeta5, convertLegacyMap,
  mergeStores, mergeFirstPull, pruneTombstones, sameStore, uniqueCopyName, FORMAT
} from '../js/core/model.js';
import { stableStringify } from '../js/core/format.js';

const NOW = '2026-09-30T12:00:00.000Z';

function study(id, updatedAt, extra = {}) {
  return normalizeStudy({ id, name: 'E ' + id, createdAt: '2026-01-01T00:00:00.000Z', updatedAt, ...extra }, { id, now: NOW });
}
function store(studies = [], deleted = {}) {
  const s = emptyStore();
  studies.forEach(x => { s.studies[x.id] = x; });
  s.deleted = { ...deleted };
  return s;
}

test('converte o mapa v2 (chave = nome) para v3 (chave = id), com o nome como campo', () => {
  const v2 = {
    'Linha A': { id: 'study_1', process: 'P', stages: [], records: [{ cycle: 2, stageName: 'X', type: 'VA', time: '1,5' }], cycleQty: { 2: 3 }, updatedAt: '2026-05-01T00:00:00.000Z', lastSync: 'x' }
  };
  const s = normalizeStore(v2, NOW);
  assert.equal(s.format, FORMAT);
  const st = s.studies.study_1;
  assert.equal(st.name, 'Linha A');
  assert.equal(st.process, 'P');
  assert.equal(st.records[0].time, 1.5);
  assert.equal(st.records[0].qty, 3, 'qty herdada do cycleQty (regra antiga)');
  assert.ok(st.records[0].id, 'registro ganha id determinístico');
  assert.equal(st.lastSync, undefined);
});

test('v2 com id duplicado (bug do renomear) não perde nenhuma cópia e é determinístico', () => {
  const v2 = {
    'Nome antigo': { id: 'study_1', updatedAt: '2026-05-01T00:00:00.000Z', records: [] },
    'Nome novo': { id: 'study_1', updatedAt: '2026-05-02T00:00:00.000Z', records: [] }
  };
  const a = convertLegacyMap(v2, NOW);
  const b = convertLegacyMap(JSON.parse(JSON.stringify(v2)), NOW);
  assert.equal(Object.keys(a.studies).length, 2);
  assert.equal(a.studies.study_1.name, 'Nome novo', 'o mais recente fica com o id original');
  assert.equal(stableStringify(a), stableStringify(b));
});

test('v2 sem id recebe id estável derivado do nome', () => {
  const a = normalizeStore({ 'Sem id': { records: [] } }, NOW);
  const b = normalizeStore({ 'Sem id': { records: [] } }, NOW);
  assert.deepEqual(Object.keys(a.studies), Object.keys(b.studies));
});

test('v3 descarta lixo que uma aba antiga possa ter misturado', () => {
  const raw = {
    format: 3,
    studies: {
      ok: { id: 'ok', name: 'Ok', updatedAt: NOW },
      cycleQty: { 1: 1 },
      history: [],
      id: 'study_x'
    },
    deleted: { gone: NOW, bad: 'not-a-date' }
  };
  const s = normalizeStore(raw, NOW);
  assert.deepEqual(Object.keys(s.studies), ['ok']);
  assert.deepEqual(s.deleted, { gone: NOW });
});

test('normalizeStore aceita entradas inválidas', () => {
  assert.deepEqual(normalizeStore(null), emptyStore());
  assert.deepEqual(normalizeStore([1, 2]), emptyStore());
  assert.deepEqual(normalizeStore('x'), emptyStore());
});

test('normalização é idempotente', () => {
  const once = normalizeStore({ 'A': { id: 'a', records: [{ stageName: 'x', time: 1 }] } }, NOW);
  const twice = normalizeStore(JSON.parse(JSON.stringify(once)), NOW);
  assert.ok(sameStore(once, twice));
});

test('convertBeta5 mantém a lógica original', () => {
  const old = { 'Velho': { stages: [{ name: 'A', type: 'VA' }], records: [{ cycle: 1, stage: 'A', type: 'VA', time: '2', qty: '4' }], currentCycle: 3 } };
  const v2 = convertBeta5(old);
  const s = v2['Velho (importado)'];
  assert.equal(s.stages[0].id, 'st_legacy_0');
  assert.equal(s.records[0].stageId, 'st_legacy_0');
  assert.equal(s.records[0].qty, 4);
  assert.equal(s.currentCycle, 3);
});

test('merge: estudo a estudo, vence o mais recente (não é mais "tudo ou nada")', () => {
  const local = store([study('a', '2026-09-01T00:00:00.000Z', { notes: 'local' }), study('b', '2026-09-05T00:00:00.000Z')]);
  const remote = store([study('a', '2026-09-02T00:00:00.000Z', { notes: 'remoto' }), study('c', '2026-09-03T00:00:00.000Z')]);
  const m = mergeStores(local, remote);
  assert.deepEqual(Object.keys(m.studies).sort(), ['a', 'b', 'c']);
  assert.equal(m.studies.a.notes, 'remoto');
});

test('merge é simétrico (mesmo resultado em qualquer aparelho)', () => {
  const x = store([study('a', NOW, { notes: 'x' })]);
  const y = store([study('a', NOW, { notes: 'y' })]);
  assert.ok(sameStore(mergeStores(x, y), mergeStores(y, x)));
});

test('merge: exclusão propaga e vence edições anteriores', () => {
  const local = store([study('a', '2026-09-01T00:00:00.000Z')]);
  const remote = store([], { a: '2026-09-02T00:00:00.000Z' });
  const m = mergeStores(local, remote);
  assert.equal(m.studies.a, undefined);
  assert.equal(m.deleted.a, '2026-09-02T00:00:00.000Z');
});

test('merge: edição posterior à exclusão mantém o estudo', () => {
  const local = store([study('a', '2026-09-03T00:00:00.000Z')]);
  const remote = store([], { a: '2026-09-02T00:00:00.000Z' });
  const m = mergeStores(local, remote);
  assert.ok(m.studies.a);
  assert.equal(m.deleted.a, undefined);
});

test('primeira sincronização: nuvem vazia importa tudo do local antigo', () => {
  const local = store([study('a', NOW)]);
  const m = mergeFirstPull(local, emptyStore(), { legacyIds: ['a'], remoteExists: false });
  assert.ok(m.studies.a);
});

test('primeira sincronização: dados locais de OUTRA conta não vazam', () => {
  const local = store([study('x', '2026-09-29T00:00:00.000Z')]);
  const remote = store([study('mine', '2026-09-01T00:00:00.000Z')]);
  const m = mergeFirstPull(local, remote, { legacyIds: ['x'], remoteExists: true, remoteUpdatedAt: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(Object.keys(m.studies), ['mine']);
});

test('primeira sincronização: recupera edição offline e estudo novo não enviados', () => {
  const local = store([
    study('a', '2026-09-10T00:00:00.000Z', { notes: 'editado offline' }),
    study('novo', '2026-09-11T00:00:00.000Z')
  ]);
  const remote = store([study('a', '2026-09-05T00:00:00.000Z', { notes: 'velho' })]);
  const m = mergeFirstPull(local, remote, { legacyIds: ['a', 'novo'], remoteExists: true, remoteUpdatedAt: '2026-09-05T00:00:00.000Z' });
  assert.equal(m.studies.a.notes, 'editado offline');
  assert.ok(m.studies.novo);
});

test('primeira sincronização: estudo antigo excluído em outro aparelho não ressuscita', () => {
  const local = store([study('a', '2026-09-01T00:00:00.000Z'), study('apagado', '2026-08-01T00:00:00.000Z')]);
  const remote = store([study('a', '2026-09-01T00:00:00.000Z')]);
  const m = mergeFirstPull(local, remote, { legacyIds: ['a', 'apagado'], remoteExists: true, remoteUpdatedAt: '2026-09-02T00:00:00.000Z' });
  assert.deepEqual(Object.keys(m.studies), ['a']);
});

test('primeira sincronização: estudos criados depois da migração são sempre mantidos', () => {
  const local = store([study('x', '2026-08-01T00:00:00.000Z'), study('criado-agora', '2026-08-01T00:00:00.000Z')]);
  const remote = store([study('mine', NOW)]);
  const m = mergeFirstPull(local, remote, { legacyIds: ['x'], remoteExists: true, remoteUpdatedAt: NOW });
  assert.ok(m.studies['criado-agora']);
  assert.equal(m.studies.x, undefined);
});

test('pruneTombstones remove lápides antigas', () => {
  const s = store([], { velho: '2020-01-01T00:00:00.000Z', novo: NOW });
  const p = pruneTombstones(s, Date.parse(NOW));
  assert.deepEqual(Object.keys(p.deleted), ['novo']);
});

test('uniqueCopyName', () => {
  assert.equal(uniqueCopyName('A', ['A']), 'A (cópia)');
  assert.equal(uniqueCopyName('A', ['A', 'A (cópia)', 'A (cópia 2)']), 'A (cópia 3)');
});
