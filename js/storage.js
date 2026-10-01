/* Persistência local (localStorage), separada por usuário.
   Cada gravação relê o localStorage antes de escrever (read-modify-write),
   então duas abas abertas não apagam as alterações uma da outra. */

import { DEFAULT_PREFS } from './config.js';
import { normalizeStore, emptyStore, convertBeta5 } from './core/model.js';
import { normalizeTimer } from './core/timer.js';

const LEGACY_V2_KEY = 'cronoanalise_studies_v2';
const LEGACY_BETA5_KEY = 'studies';
const THEME_KEY = 'crono_theme';
const PREFS_KEY = 'cronoanalise:prefs';

let userId = null;
let onWriteError = () => {};

const key = name => `cronoanalise:v3:${userId}:${name}`;

export function setUser(id) { userId = id; }
export function getUser() { return userId; }
export function setWriteErrorHandler(fn) { onWriteError = fn; }

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

/* ---------- Store (estudos) ----------
   Mantém em memória a última versão lida/gravada (comparando o texto bruto do
   localStorage), para não reprocessar tudo a cada toque numa etapa. Se outra aba
   gravar, o texto muda e a leitura é refeita. */
let memo = { k: null, raw: null, store: null };

const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function readStore() { // objeto compartilhado: não alterar fora deste módulo
  const k = key('store');
  let raw = null;
  try { raw = localStorage.getItem(k); } catch (e) { raw = null; }
  if (memo.k === k && memo.raw === raw && memo.store) return memo.store;
  let parsed = null;
  try { parsed = raw === null ? null : JSON.parse(raw); } catch (e) { parsed = null; }
  const store = normalizeStore(parsed);
  memo = { k, raw, store };
  return store;
}

function writeStore(store) {
  const k = key('store');
  try {
    const raw = JSON.stringify(store);
    localStorage.setItem(k, raw);
    memo = { k, raw, store };
    return true;
  } catch (e) {
    memo = { k: null, raw: null, store: null };
    onWriteError(e);
    return false;
  }
}

export function hasStore() {
  return localStorage.getItem(key('store')) !== null;
}

/* Cópia independente (pode ser alterada por quem chamou). */
export function loadStore() {
  return clone(readStore());
}

/* Gravação vinda de uma alteração do usuário: marca como pendente de envio. */
export function saveStore(store) {
  const ok = writeStore(clone(store));
  if (ok) bumpLocalRev();
  return ok;
}

/* Gravação vinda da sincronização (conteúdo já está na nuvem ou é resultado de merge). */
export function replaceStoreFromSync(store) {
  return writeStore(clone(store));
}

/* Somente leitura (objetos compartilhados). */
export function listStudies() {
  return Object.values(readStore().studies);
}

export function getStudy(id) {
  const s = readStore().studies[id];
  return s ? clone(s) : null;
}

/* putStudy/removeStudy alteram o objeto em memória e gravam em seguida; se a
   gravação falhar, writeStore descarta a memória e a próxima leitura vem do disco. */
export function putStudy(study) {
  const s = readStore();
  s.studies[study.id] = clone(study);
  delete s.deleted[study.id];
  const ok = writeStore(s);
  if (ok) bumpLocalRev();
  return ok;
}

export function removeStudy(id, at = new Date().toISOString()) {
  const s = readStore();
  delete s.studies[id];
  s.deleted[id] = at;
  removeTimer(id);
  const ok = writeStore(s);
  if (ok) bumpLocalRev();
  return ok;
}

export function isStoreKey(k) {
  return !!userId && (k === key('store') || k === key('timers'));
}

/* ---------- Metadados de sincronização ---------- */
export function getSyncMeta() {
  const m = readJSON(key('sync'), {}) || {};
  return {
    localRev: m.localRev || 0,
    syncedRev: m.syncedRev || 0,
    legacyIds: Array.isArray(m.legacyIds) ? m.legacyIds : null,
    lastSyncAt: m.lastSyncAt || null
  };
}

export function setSyncMeta(patch) {
  writeJSON(key('sync'), { ...getSyncMeta(), ...patch });
}

function bumpLocalRev() {
  const m = getSyncMeta();
  setSyncMeta({ localRev: m.localRev + 1 });
}

export function isDirty() {
  const m = getSyncMeta();
  return m.localRev > m.syncedRev;
}

/* ---------- Migração dos dados locais da versão anterior ----------
   Na primeira vez que o usuário entra nesta versão neste aparelho, copia os
   dados antigos (chave v2 ou Beta 5) para o espaço dele. A chave antiga NÃO é
   apagada (fica como backup). Os ids importados ficam "pendentes" até a primeira
   sincronização decidir se pertencem mesmo a esta conta (ver mergeFirstPull). */
export function initUserStore() {
  if (hasStore()) return { migrated: 0 };
  let legacy = readJSON(LEGACY_V2_KEY);
  if (!legacy) {
    const beta5 = readJSON(LEGACY_BETA5_KEY);
    if (beta5 && typeof beta5 === 'object') legacy = convertBeta5(beta5);
  }
  const store = legacy ? normalizeStore(legacy) : emptyStore();
  const ids = Object.keys(store.studies);
  writeStore(store);
  setSyncMeta({ localRev: 0, syncedRev: 0, legacyIds: ids.length ? ids : null });
  return { migrated: ids.length };
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
