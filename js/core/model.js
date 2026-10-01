/* Modelo de dados, migração e mesclagem (merge) entre aparelhos.

   Formato atual (v3), salvo no localStorage e na coluna `data` de crono_studies:
     { format: 3,
       studies: { [id]: Study },
       deleted: { [id]: ISO da exclusão } }   // "lápides" para propagar exclusões

   Formatos antigos aceitos na leitura:
     - v2 (Beta 6–8): { [nomeDoEstudo]: Study-sem-nome }
     - Beta 5 (chave "studies" do localStorage): convertBeta5()
*/

import { TYPES } from '../config.js';
import { hashString, parseNumber, stableStringify } from './format.js';

export const FORMAT = 3;
export const TOMBSTONE_MAX_AGE_DAYS = 180;

const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const tsOf = iso => { const t = Date.parse(iso); return isNaN(t) ? 0 : t; };
const validIso = v => typeof v === 'string' && !isNaN(Date.parse(v));

export function emptyStore() {
  return { format: FORMAT, studies: {}, deleted: {} };
}

export function createStudy({ id, name = '', now = new Date().toISOString() } = {}) {
  return {
    id,
    name,
    process: '',
    operator: '',
    observer: '',
    notes: '',
    stages: [],
    records: [],
    cycleQty: { 1: 1 },
    currentCycle: 1,
    createdAt: now,
    updatedAt: now,
    history: [{ ts: now, text: 'Estudo criado' }]
  };
}

/* Normaliza um estudo preenchendo campos ausentes. Determinística: a mesma entrada
   gera a mesma saída em qualquer aparelho (IDs faltantes vêm de hash). Campos
   desconhecidos são preservados. */
export function normalizeStudy(raw, { id, name, now = new Date().toISOString() } = {}) {
  const s = isPlainObject(raw) ? { ...raw } : {};
  delete s.lastSync; // metadado da v2, substituído pelo status global de sincronização

  s.id = str(s.id || id);
  if (!s.id) s.id = 'study_' + hashString(stableStringify(raw));
  const nm = typeof s.name === 'string' && s.name.trim() ? s.name : name;
  s.name = str(nm).trim() ? str(nm) : 'Estudo sem nome';

  s.process = str(s.process);
  s.operator = str(s.operator);
  s.observer = str(s.observer);
  s.notes = str(s.notes);

  s.createdAt = validIso(s.createdAt) ? s.createdAt : now;
  s.updatedAt = validIso(s.updatedAt) ? s.updatedAt : s.createdAt;

  s.cycleQty = isPlainObject(s.cycleQty) ? s.cycleQty : { 1: 1 };

  s.stages = (Array.isArray(s.stages) ? s.stages : []).filter(isPlainObject).map((st, i) => {
    const out = { ...st };
    out.name = str(st.name);
    out.type = TYPES.includes(st.type) ? st.type : 'VA';
    out.id = str(st.id) || 'st_' + hashString(s.id + '|' + out.name + '|' + i);
    if (out.countsOutput !== undefined) out.countsOutput = out.countsOutput === true;
    return out;
  });

  s.records = (Array.isArray(s.records) ? s.records : []).filter(isPlainObject).map((r, i) => {
    const out = { ...r };
    out.id = str(r.id) || 'r_' + hashString(s.id + '|' + i + '|' + str(r.stageName) + '|' + str(r.time));
    const c = parseInt(r.cycle, 10);
    out.cycle = isFinite(c) && c >= 1 ? c : 1;
    out.stageId = r.stageId ? str(r.stageId) : null;
    out.stageName = str(r.stageName);
    out.type = str(r.type) || 'VA';
    out.time = Math.max(0, parseNumber(r.time));
    if (r.qty === undefined || r.qty === null || r.qty === '') {
      // Mesma regra do ensureStudyMeta original: herda a quantidade do ciclo (legado)
      out.qty = s.cycleQty[out.cycle] !== undefined ? (Number(s.cycleQty[out.cycle]) || 1) : 1;
    } else {
      out.qty = Math.max(0, parseNumber(r.qty));
    }
    if (out.excluded !== undefined) out.excluded = out.excluded === true;
    return out;
  });

  const cc = parseInt(s.currentCycle, 10);
  s.currentCycle = isFinite(cc) && cc >= 1 ? cc : 1;

  s.history = (Array.isArray(s.history) ? s.history : [])
    .filter(h => isPlainObject(h) && typeof h.text === 'string');
  if (!s.history.length) s.history = [{ ts: s.createdAt, text: 'Estudo criado' }];

  if (s.rating !== undefined) {
    const r = Number(s.rating);
    if (isFinite(r) && r > 0) s.rating = r; else delete s.rating;
  }
  if (s.allowance !== undefined) {
    const a = Number(s.allowance);
    if (isFinite(a) && a >= 0) s.allowance = a; else delete s.allowance;
  }
  return s;
}

/* Beta 5 → mapa v2 (mesma lógica do migrateOldData original). */
export function convertBeta5(oldStudies) {
  const migrated = {};
  if (!isPlainObject(oldStudies)) return migrated;
  Object.keys(oldStudies).forEach(name => {
    const s = oldStudies[name] || {};
    const oldStages = Array.isArray(s.stages) ? s.stages : [];
    const stageWithIds = oldStages.map((st, i) => ({ id: 'st_legacy_' + i, name: st.name, type: st.type }));
    const cycleQty = {};
    (s.records || []).forEach(r => {
      const c = r.cycle, q = Number(r.qty) || 0;
      if (!(c in cycleQty) || q > cycleQty[c]) cycleQty[c] = q;
    });
    const records = (s.records || []).map((r, i) => {
      const idx = oldStages.findIndex(st => st.name === r.stage);
      return {
        id: 'r_legacy_' + i,
        cycle: r.cycle,
        stageId: idx >= 0 ? stageWithIds[idx].id : null,
        stageName: r.stage,
        type: r.type,
        time: Number(r.time) || 0,
        qty: Number(r.qty) || 1
      };
    });
    migrated[name + ' (importado)'] = {
      process: '', operator: '', observer: '',
      stages: stageWithIds,
      records,
      cycleQty: Object.keys(cycleQty).length ? cycleQty : { 1: 1 },
      currentCycle: s.currentCycle || 1
    };
  });
  return migrated;
}

/* Mapa v2 (chaveado por nome) → store v3 (chaveado por id).
   Na v2, renomear um estudo gerava uma cópia com o mesmo id; aqui nada é
   descartado: o mais recente fica com o id e as cópias ganham um id derivado
   (determinístico) para que todos os aparelhos cheguem ao mesmo resultado. */
export function convertLegacyMap(map, now) {
  const store = emptyStore();
  if (!isPlainObject(map)) return store;
  const entries = Object.keys(map)
    .filter(name => isPlainObject(map[name]))
    .map(name => ({ name, raw: map[name] }));

  const byId = new Map();
  entries.forEach(e => {
    const id = str(e.raw.id) || 'study_legacy_' + hashString(e.name);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(e);
  });

  byId.forEach((list, id) => {
    list.sort((a, b) => (tsOf(b.raw.updatedAt) - tsOf(a.raw.updatedAt)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    list.forEach((e, i) => {
      const finalId = i === 0 ? id : id + '_' + hashString(e.name);
      store.studies[finalId] = normalizeStudy({ ...e.raw, id: finalId, name: e.name }, { id: finalId, name: e.name, now });
    });
  });
  return store;
}

/* Aceita qualquer formato (v3, v2 ou lixo) e devolve um store v3 válido. */
export function normalizeStore(raw, now = new Date().toISOString()) {
  if (!isPlainObject(raw)) return emptyStore();
  if (raw.format !== FORMAT) return convertLegacyMap(raw, now);
  const store = emptyStore();
  const studies = isPlainObject(raw.studies) ? raw.studies : {};
  Object.keys(studies).forEach(id => {
    const v = studies[id];
    // Exige id === chave: descarta lixo que uma aba antiga (v2) possa ter gravado aqui
    if (!isPlainObject(v) || v.id !== id) return;
    store.studies[id] = normalizeStudy(v, { id, now });
  });
  const deleted = isPlainObject(raw.deleted) ? raw.deleted : {};
  Object.keys(deleted).forEach(id => {
    if (validIso(deleted[id]) && !store.studies[id]) store.deleted[id] = deleted[id];
  });
  return store;
}

function newer(a, b) {
  const d = tsOf(a.updatedAt) - tsOf(b.updatedAt);
  if (d !== 0) return d > 0 ? a : b;
  // Empate: escolha determinística, independente da ordem dos argumentos
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

/* Mescla dois stores estudo a estudo: vence a versão com updatedAt mais recente;
   uma exclusão vence se for posterior à última edição do estudo. */
export function mergeStores(a, b) {
  const out = emptyStore();
  const ids = new Set([
    ...Object.keys(a.studies), ...Object.keys(b.studies),
    ...Object.keys(a.deleted), ...Object.keys(b.deleted)
  ]);
  ids.forEach(id => {
    const sa = a.studies[id], sb = b.studies[id];
    const da = a.deleted[id], db = b.deleted[id];
    const del = da && db ? (tsOf(da) >= tsOf(db) ? da : db) : (da || db);
    let win = sa && sb ? newer(sa, sb) : (sa || sb);
    if (win && del && tsOf(del) >= tsOf(win.updatedAt)) win = null;
    if (win) out.studies[id] = win;
    else if (del) out.deleted[id] = del;
  });
  return out;
}

/* Primeira sincronização depois de migrar dados locais da versão anterior.
   Na v2 o localStorage não era separado por conta: pode conter dados de outro
   usuário que usou o mesmo navegador. Regras (espelham o comportamento antigo,
   sem perder edições offline):
     - nuvem vazia                → importa tudo (como antes);
     - nenhum id em comum         → dados de outra conta: não importa;
     - estudo existe na nuvem     → vence o mais recente;
     - estudo só existe no local  → importa se foi editado depois do último
                                    salvamento na nuvem (edição offline não enviada);
                                    senão foi excluído em outro aparelho. */
export function mergeFirstPull(local, remote, { legacyIds = [], remoteExists = false, remoteUpdatedAt = null } = {}) {
  const legacy = new Set(legacyIds);
  const remoteIds = new Set([...Object.keys(remote.studies), ...Object.keys(remote.deleted)]);
  const remoteEmpty = !remoteExists || remoteIds.size === 0;
  const owned = remoteEmpty || [...legacy].some(id => remoteIds.has(id));
  const cutoff = tsOf(remoteUpdatedAt);

  const filtered = emptyStore();
  filtered.deleted = { ...local.deleted };
  Object.keys(local.studies).forEach(id => {
    const s = local.studies[id];
    if (!legacy.has(id)) { filtered.studies[id] = s; return; }
    if (!owned) return;
    if (remoteEmpty || remoteIds.has(id) || tsOf(s.updatedAt) > cutoff) filtered.studies[id] = s;
  });
  return mergeStores(filtered, remote);
}

export function pruneTombstones(store, now = Date.now(), maxAgeDays = TOMBSTONE_MAX_AGE_DAYS) {
  const limit = now - maxAgeDays * 86400000;
  const out = { ...store, deleted: {} };
  Object.keys(store.deleted).forEach(id => {
    if (tsOf(store.deleted[id]) >= limit) out.deleted[id] = store.deleted[id];
  });
  return out;
}

export function sameStore(a, b) {
  return stableStringify(a) === stableStringify(b);
}

export function uniqueCopyName(base, existingNames) {
  const names = new Set(existingNames);
  let name = base + ' (cópia)';
  let i = 2;
  while (names.has(name)) { name = base + ' (cópia ' + i + ')'; i++; }
  return name;
}
