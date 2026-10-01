/* Persistência local, separada por usuário.

   Estudos: IndexedDB (um banco por usuário: "cronoanalise-<id>"), sem o limite
   de ~5 MB do localStorage e gravando só o estudo alterado. Tudo é carregado em
   memória ao entrar, então as leituras são síncronas; as gravações vão para o
   disco em fila, em segundo plano. Outras abas são avisadas por BroadcastChannel.
   Sem IndexedDB (navegadores muito antigos/restritos), usa o localStorage.

   Cronômetros, sessão de tela, metadados de sincronização e preferências ficam
   no localStorage (pequenos e síncronos). */

import { DEFAULT_PREFS } from './config.js';
import { normalizeStore, normalizeStudy, emptyStore, convertBeta5, mergeStudy } from './core/model.js';
import { normalizeTimer } from './core/timer.js';
import { stableStringify } from './core/format.js';

const LEGACY_V2_KEY = 'cronoanalise_studies_v2';
const LEGACY_BETA5_KEY = 'studies';
const THEME_KEY = 'crono_theme';
const PREFS_KEY = 'cronoanalise:prefs';

let userId = null;
let mem = emptyStore();      // estudos em memória (fonte das leituras)
let access = {};             // { studyId: { role: 'owner'|'editor'|'viewer', ownerEmail } }
let backend = null;          // 'idb' | 'ls'
let db = null;
let channel = null;
let writeChain = Promise.resolve();
let onWriteError = () => {};
const listeners = new Set();

const key = name => `cronoanalise:v3:${userId}:${name}`;
const clone = v => (v === undefined ? v : typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function getUser() { return userId; }
export function getBackend() { return backend; }
export function setWriteErrorHandler(fn) { onWriteError = fn; }

/* Avisa quando outra aba alterou os dados. */
export function onExternalChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function readJSON(k, fallback = null) {
  try {
    const raw = localStorage.getItem(k);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

function writeJSON(k, value) {
  try {
    localStorage.setItem(k, JSON.stringify(value));
    return true;
  } catch (e) {
    onWriteError(e);
    return false;
  }
}

/* ---------- IndexedDB ---------- */
function openDb(uid) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('sem IndexedDB')); return; }
    const req = indexedDB.open('cronoanalise-' + uid, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('studies')) d.createObjectStore('studies', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueado'));
  });
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbTx(stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const out = fn(t);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transação abortada'));
  });
}

async function idbLoadAll() {
  const t = db.transaction(['studies', 'kv'], 'readonly');
  const studies = await idbRequest(t.objectStore('studies').getAll());
  const kv = t.objectStore('kv');
  const [deleted, acc, initialized] = await Promise.all([
    idbRequest(kv.get('deleted')), idbRequest(kv.get('access')), idbRequest(kv.get('initialized'))
  ]);
  return { studies, deleted: deleted || {}, access: acc || {}, initialized: !!initialized };
}

/* Fila de gravação: mantém a ordem e não trava a interface. */
function enqueue(fn) {
  writeChain = writeChain.then(fn).catch(e => {
    console.warn('Falha ao gravar no aparelho:', e);
    onWriteError(e);
  });
  return writeChain;
}

/* Espera as gravações pendentes (usado nos testes e antes de sair). */
export function flushWrites() {
  return writeChain;
}

function persistStudy(study) {
  if (backend === 'idb') {
    const copy = clone(study);
    return enqueue(() => idbTx(['studies'], 'readwrite', t => t.objectStore('studies').put(copy)));
  }
  return enqueue(async () => lsPersistAll());
}

function persistDelete(id) {
  if (backend === 'idb') {
    const deleted = clone(mem.deleted);
    return enqueue(() => idbTx(['studies', 'kv'], 'readwrite', t => {
      t.objectStore('studies').delete(id);
      t.objectStore('kv').put(deleted, 'deleted');
    }));
  }
  return enqueue(async () => lsPersistAll());
}

function persistAll() {
  if (backend === 'idb') {
    const studies = clone(Object.values(mem.studies));
    const deleted = clone(mem.deleted);
    const acc = clone(access);
    return enqueue(() => idbTx(['studies', 'kv'], 'readwrite', t => {
      const os = t.objectStore('studies');
      os.clear();
      studies.forEach(s => os.put(s));
      t.objectStore('kv').put(deleted, 'deleted');
      t.objectStore('kv').put(acc, 'access');
      t.objectStore('kv').put(new Date().toISOString(), 'initialized');
    }));
  }
  return enqueue(async () => lsPersistAll());
}

function persistAccess() {
  if (backend === 'idb') {
    const acc = clone(access);
    return enqueue(() => idbTx(['kv'], 'readwrite', t => t.objectStore('kv').put(acc, 'access')));
  }
  return enqueue(async () => lsPersistAll());
}

function lsPersistAll() {
  const ok = writeJSON(key('store'), { ...mem, access });
  if (!ok) throw new Error('localStorage cheio');
}

function broadcast(msg) {
  try { if (channel) channel.postMessage(msg); } catch (e) { /* aba fechando */ }
}

async function onBroadcast(ev) {
  const msg = ev.data || {};
  if (!userId || !db) return;
  try {
    if (msg.t === 'put' || msg.t === 'del') {
      const t = db.transaction(['studies', 'kv'], 'readonly');
      const [s, deleted] = await Promise.all([
        idbRequest(t.objectStore('studies').get(msg.id)), idbRequest(t.objectStore('kv').get('deleted'))
      ]);
      if (s) mem.studies[msg.id] = normalizeStudy(s, { id: msg.id }); else delete mem.studies[msg.id];
      mem.deleted = deleted || {};
    } else if (msg.t === 'reload' || msg.t === 'access') {
      const all = await idbLoadAll();
      applyLoaded(all);
    }
    listeners.forEach(fn => fn(msg));
  } catch (e) {
    console.warn('Não foi possível atualizar a partir de outra aba:', e);
  }
}

function applyLoaded(loaded) {
  const raw = { format: 3, studies: {}, deleted: loaded.deleted || {} };
  (loaded.studies || []).forEach(s => { if (s && s.id) raw.studies[s.id] = s; });
  mem = normalizeStore(raw);
  access = loaded.access || {};
}

/* Outra aba no modo localStorage: recarrega tudo. */
export function handleStorageEvent(e) {
  if (!userId || backend !== 'ls' || e.key !== key('store')) return false;
  const raw = readJSON(key('store'));
  applyLoaded({ studies: raw ? Object.values(raw.studies || {}) : [], deleted: raw ? raw.deleted : {}, access: raw ? raw.access : {} });
  listeners.forEach(fn => fn({ t: 'reload' }));
  return true;
}

export function isTimerKey(k) {
  return !!userId && k === key('timers');
}

/* ---------- Entrar / sair ---------- */
/* Carrega os dados do usuário. Na primeira vez neste aparelho, migra os dados
   locais anteriores: o store da v3 em localStorage (versão de testes) ou os
   dados da versão antiga (chave v2 / Beta 5, que NÃO são apagados). Os ids
   vindos da versão antiga ficam "pendentes" até a primeira sincronização decidir
   se pertencem mesmo a esta conta (ver mergeFirstPull). */
export async function setUser(id) {
  if (channel) { try { channel.close(); } catch (e) { /* já fechado */ } channel = null; }
  if (db) { await writeChain.catch(() => {}); db.close(); db = null; }
  userId = id;
  mem = emptyStore();
  access = {};
  backend = null;
  if (!id) return { migrated: 0 };

  let loaded = null;
  try {
    db = await openDb(id);
    backend = 'idb';
    loaded = await idbLoadAll();
  } catch (e) {
    console.warn('IndexedDB indisponível, usando localStorage:', e);
    db = null;
    backend = 'ls';
    const raw = readJSON(key('store'));
    loaded = raw
      ? { studies: Object.values(raw.studies || {}), deleted: raw.deleted || {}, access: raw.access || {}, initialized: true }
      : { studies: [], deleted: {}, access: {}, initialized: false };
  }

  let migrated = 0;
  if (!loaded.initialized) {
    const v3 = backend === 'idb' ? readJSON(key('store')) : null;
    if (v3) {
      const st = normalizeStore(v3);
      loaded = { studies: Object.values(st.studies), deleted: st.deleted, access: v3.access || {}, initialized: true };
    } else {
      let legacy = readJSON(LEGACY_V2_KEY);
      if (!legacy) {
        const beta5 = readJSON(LEGACY_BETA5_KEY);
        if (beta5 && typeof beta5 === 'object') legacy = convertBeta5(beta5);
      }
      const st = legacy ? normalizeStore(legacy) : emptyStore();
      const ids = Object.keys(st.studies);
      migrated = ids.length;
      loaded = { studies: Object.values(st.studies), deleted: st.deleted, access: {}, initialized: true };
      setSyncMeta({ localRev: 0, syncedRev: 0, legacyIds: ids.length ? ids : null });
    }
    applyLoaded(loaded);
    await persistAll();
    if (v3 && backend === 'idb') {
      try { localStorage.removeItem(key('store')); } catch (e) { /* ok */ }
    }
  } else {
    applyLoaded(loaded);
  }

  if (backend === 'idb' && typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel('cronoanalise-' + id);
    channel.onmessage = onBroadcast;
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* opcional */ }
  return { migrated };
}

/* ---------- Leitura ---------- */
/* Cópia independente do store (pode ser alterada por quem chamou). */
export function loadStore() {
  return clone(mem);
}

/* Somente leitura (objetos compartilhados). */
export function listStudies() {
  return Object.values(mem.studies);
}

export function getStudy(id) {
  return mem.studies[id] ? clone(mem.studies[id]) : null;
}

export function getDeleted() {
  return mem.deleted;
}

/* ---------- Gravação (alterações do usuário) ---------- */
/* Mescla com a versão gravada (registro a registro) e devolve o resultado:
   se a sincronização trouxe registros de outro aparelho enquanto o estudo estava
   aberto, eles não se perdem. */
export function putStudy(study) {
  const merged = mergeStudy(mem.studies[study.id] || null, clone(study));
  mem.studies[study.id] = merged;
  delete mem.deleted[study.id];
  markDirty(study.id);
  persistStudy(merged).then(() => broadcast({ t: 'put', id: study.id }));
  return clone(merged);
}

export function removeStudy(id, at = new Date().toISOString()) {
  delete mem.studies[id];
  mem.deleted[id] = at;
  removeTimer(id);
  markDirty(id);
  persistDelete(id).then(() => broadcast({ t: 'del', id }));
  return true;
}

/* Substitui o store inteiro (restaurar backup). */
export function saveStore(store) {
  mem = normalizeStore(clone(store));
  Object.keys(mem.studies).forEach(markDirty);
  Object.keys(mem.deleted).forEach(markDirty);
  persistAll().then(() => broadcast({ t: 'reload' }));
  return true;
}

/* ---------- Gravação vinda da sincronização ---------- */
/* Grava só o que mudou em relação à memória. */
export function replaceStoreFromSync(store) {
  const next = normalizeStore(clone(store));
  const changed = {};
  Object.keys(next.studies).forEach(id => {
    const cur = mem.studies[id];
    if (!cur || stableStringify(cur) !== stableStringify(next.studies[id])) changed[id] = next.studies[id];
  });
  const removed = Object.keys(mem.studies).filter(id => !next.studies[id]);
  mem.deleted = next.deleted;
  removed.forEach(id => { delete mem.studies[id]; if (backend === 'idb') enqueue(() => idbTx(['studies'], 'readwrite', t => t.objectStore('studies').delete(id))); });
  Object.keys(changed).forEach(id => { mem.studies[id] = changed[id]; persistStudy(changed[id]); });
  if (backend === 'idb') {
    const deleted = clone(mem.deleted);
    enqueue(() => idbTx(['kv'], 'readwrite', t => t.objectStore('kv').put(deleted, 'deleted')));
  } else {
    enqueue(async () => lsPersistAll());
  }
  if (removed.length || Object.keys(changed).length) writeChain.then(() => broadcast({ t: 'reload' }));
  return true;
}

/* Aplica estudos/exclusões vindos da nuvem (já mesclados por quem chamou). */
export function applyFromSync(studies, deleted = {}) {
  Object.keys(studies).forEach(id => {
    mem.studies[id] = normalizeStudy(clone(studies[id]), { id });
    delete mem.deleted[id];
    persistStudy(mem.studies[id]);
  });
  Object.keys(deleted).forEach(id => {
    delete mem.studies[id];
    mem.deleted[id] = deleted[id];
    persistDelete(id);
  });
  if (Object.keys(studies).length || Object.keys(deleted).length) writeChain.then(() => broadcast({ t: 'reload' }));
}

/* Remove a cópia local sem gerar exclusão na nuvem (compartilhamento revogado). */
export function dropLocal(id) {
  delete mem.studies[id];
  delete access[id];
  removeTimer(id);
  if (backend === 'idb') enqueue(() => idbTx(['studies'], 'readwrite', t => t.objectStore('studies').delete(id)));
  persistAccess().then(() => broadcast({ t: 'reload' }));
}

/* ---------- Acesso (estudos compartilhados) ---------- */
export function getAccess(id) {
  return access[id] || { role: 'owner' };
}

export function canEdit(id) {
  return getAccess(id).role !== 'viewer';
}

export function isOwner(id) {
  return getAccess(id).role === 'owner';
}

export function getAccessMap() {
  return clone(access);
}

export function setAccessMap(map) {
  access = clone(map);
  persistAccess().then(() => broadcast({ t: 'access' }));
}

/* ---------- Metadados de sincronização ---------- */
export function getSyncMeta() {
  const m = readJSON(key('sync'), {}) || {};
  return {
    localRev: m.localRev || 0,
    syncedRev: m.syncedRev || 0,
    legacyIds: Array.isArray(m.legacyIds) ? m.legacyIds : null,
    lastSyncAt: m.lastSyncAt || null,
    mode: m.mode || null,           // 'blob' | 'rows'
    dirty: m.dirty || {},           // { studyId: localRev } — modo rows
    versions: m.versions || {},     // { studyId: updated_at no servidor }
    lastPullAt: m.lastPullAt || null,
    blobVersion: m.blobVersion || null,
    rowsReady: !!m.rowsReady
  };
}

export function setSyncMeta(patch) {
  const cur = readJSON(key('sync'), {}) || {};
  writeJSON(key('sync'), { ...cur, ...patch });
}

function markDirty(id) {
  const m = getSyncMeta();
  const rev = m.localRev + 1;
  setSyncMeta({ localRev: rev, dirty: { ...m.dirty, [id]: rev } });
}

export function clearDirty(id, rev) {
  const m = getSyncMeta();
  if (m.dirty[id] !== undefined && m.dirty[id] <= rev) {
    const d = { ...m.dirty };
    delete d[id];
    setSyncMeta({ dirty: d });
  }
}

export function markAllDirty() {
  const m = getSyncMeta();
  const rev = m.localRev + 1;
  const d = { ...m.dirty };
  Object.keys(mem.studies).forEach(id => { if (isOwner(id)) d[id] = rev; });
  Object.keys(mem.deleted).forEach(id => { d[id] = rev; });
  setSyncMeta({ localRev: rev, dirty: d });
}

export function isDirty() {
  const m = getSyncMeta();
  return m.mode === 'rows' ? Object.keys(m.dirty).length > 0 : m.localRev > m.syncedRev;
}

/* ---------- Cronômetros (por estudo, só neste aparelho) ---------- */
export function getTimers() {
  const raw = readJSON(key('timers'), {}) || {};
  const out = {};
  Object.keys(raw).forEach(id => { out[id] = normalizeTimer(raw[id]); });
  return out;
}

export function getTimer(studyId) {
  return getTimers()[studyId] || null;
}

export function setTimer(studyId, timer) {
  const all = readJSON(key('timers'), {}) || {};
  all[studyId] = timer;
  writeJSON(key('timers'), all);
}

export function removeTimer(studyId) {
  const all = readJSON(key('timers'), {}) || {};
  if (studyId in all) {
    delete all[studyId];
    writeJSON(key('timers'), all);
  }
}

export function anyTimerRunning() {
  return Object.values(getTimers()).some(t => t.running);
}

/* ---------- Sessão de tela (reabrir o estudo depois de recarregar) ---------- */
export function getSession() {
  return readJSON(key('session'), null);
}

export function setSession(s) {
  writeJSON(key('session'), s);
}

/* ---------- Apagar dados locais (excluir conta) ---------- */
export async function wipeUserData(id) {
  const uidToWipe = id || userId;
  try {
    Object.keys(localStorage).filter(k => k.startsWith('cronoanalise:v3:' + uidToWipe + ':')).forEach(k => localStorage.removeItem(k));
  } catch (e) { /* ok */ }
  if (db) { db.close(); db = null; }
  await new Promise(resolve => {
    try {
      const req = indexedDB.deleteDatabase('cronoanalise-' + uidToWipe);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch (e) { resolve(); }
  });
}

/* ---------- Preferências do aparelho ---------- */
export function getPrefs() {
  return { ...DEFAULT_PREFS, ...(readJSON(PREFS_KEY, {}) || {}) };
}

export function setPrefs(patch) {
  writeJSON(PREFS_KEY, { ...getPrefs(), ...patch });
}

export function getTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}

export function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* sem espaço: ignora */ }
}
