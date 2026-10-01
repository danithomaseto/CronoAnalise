/* Nuvem (Supabase): sincronização, compartilhamento, versões, admin e conta.

   Dois modos de sincronização, escolhidos automaticamente:

   - "blob" (banco atual): 1 linha por usuário em crono_studies com todos os
     estudos. Antes de gravar, mescla com a nuvem (registro a registro) e grava
     com controle otimista em updated_at.

   - "rows" (depois de rodar supabase/migrations/002_estudos_por_linha.sql):
     1 linha por estudo em crono_study. Busca só o que mudou desde a última
     sincronização e envia só os estudos alterados, cada um com controle otimista.
     Permite compartilhar estudos e guarda versões anteriores no servidor.
     Na transição, copia os estudos de crono_studies (que fica intacta) e continua
     lendo essa tabela se alguma aba antiga ainda gravar nela.

   Falhou (offline)? Tenta de novo com espera crescente e quando a conexão volta. */

import { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_EMAIL } from './config.js';
import {
  normalizeStore, normalizeStudy, mergeStores, mergeFirstPull, pruneTombstones, emptyStore
} from './core/model.js';
import { stableStringify } from './core/format.js';
import * as storage from './storage.js';

export const sb = (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function')
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const BLOB = 'crono_studies';
const ROWS = 'crono_study';
const SHARES = 'crono_study_share';
const RPC_MISSING_KEY = 'cronoanalise:rpcMissingAt';
const PULL_OVERLAP_MS = 60000;   // relê 1 min antes do último pull (transações que confirmaram fora de ordem)
const MODE_RECHECK_MS = 10 * 60000;

export function isMissing(error) {
  if (!error) return false;
  return ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(error.code) ||
    /does not exist|schema cache|Could not find the (table|function)/i.test(error.message || '');
}

function isNetworkError(e) {
  const msg = String((e && (e.message || e.details)) || '');
  return /Failed to fetch|NetworkError|Load failed|network|fetch/i.test(msg);
}

const tsOf = iso => { const t = Date.parse(iso); return isNaN(t) ? 0 : t; };
const maxIso = (a, b) => (!a ? b : !b ? a : tsOf(a) >= tsOf(b) ? a : b);

/* ================= Modo blob (1 linha por usuário) ================= */
async function pullBlob(userId) {
  const { data, error } = await sb.from(BLOB).select('data, updated_at').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) return { exists: false, store: emptyStore(), version: null, legacyFormat: false };
  const raw = data.data;
  return { exists: true, store: normalizeStore(raw), version: data.updated_at, legacyFormat: !(raw && raw.format === 3) };
}

/* Erros que indicam que o filtro por updated_at não funcionou neste banco:
   nesse caso volta ao upsert simples (comportamento anterior). */
const FILTER_ERRORS = new Set(['22007', '22008', '42883', '42703', 'PGRST100']);

async function pushBlob(userId, store, version, exists) {
  const now = new Date().toISOString();
  if (!exists) {
    const { data, error } = await sb.from(BLOB).insert({ user_id: userId, data: store, updated_at: now }).select('updated_at');
    if (error) {
      if (error.code === '23505') return { ok: false };
      throw error;
    }
    return { ok: true, version: data && data[0] ? data[0].updated_at : now };
  }
  let q = sb.from(BLOB).update({ data: store, updated_at: now }).eq('user_id', userId);
  q = version ? q.eq('updated_at', version) : q.is('updated_at', null);
  const { data, error } = await q.select('updated_at');
  if (error) {
    if (!FILTER_ERRORS.has(error.code)) throw error;
    const up = await sb.from(BLOB).upsert({ user_id: userId, data: store, updated_at: now });
    if (up.error) throw up.error;
    return { ok: true, version: now };
  }
  if (!data || !data.length) return { ok: false };
  return { ok: true, version: data[0].updated_at };
}

/* ================= Modo rows (1 linha por estudo) ================= */
export async function detectMode() {
  const { error } = await sb.from(ROWS).select('id').limit(1);
  if (!error) return 'rows';
  if (isMissing(error)) return 'blob';
  throw error;
}

async function fetchRows(since) {
  const out = [];
  const page = 500;
  for (let from = 0; ; from += page) {
    let q = sb.from(ROWS).select('id, owner_id, owner_email, data, updated_at, deleted_at')
      .order('updated_at', { ascending: true }).order('id', { ascending: true })
      .range(from, from + page - 1);
    if (since) q = q.gt('updated_at', since);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < page) break;
  }
  return out;
}

async function fetchRow(id) {
  const { data, error } = await sb.from(ROWS).select('id, owner_id, owner_email, data, updated_at, deleted_at').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function fetchMyShares(email) {
  if (!email) return [];
  const { data, error } = await sb.from(SHARES).select('study_id, role').eq('email', email);
  if (error) throw error;
  return data || [];
}

function rowToStore(row) {
  const st = emptyStore();
  if (row.deleted_at) st.deleted[row.id] = row.deleted_at;
  else st.studies[row.id] = normalizeStudy({ ...(row.data || {}), id: row.id }, { id: row.id });
  return st;
}

/* Mescla um store parcial vindo da nuvem com os estudos locais correspondentes.
   Devolve { studies, deleted } a gravar localmente e os ids que precisam subir. */
function mergeIntoLocal(remote) {
  const ids = new Set([...Object.keys(remote.studies), ...Object.keys(remote.deleted)]);
  const localDel = storage.getDeleted();
  const toWrite = { studies: {}, deleted: {} };
  const needPush = [];
  ids.forEach(id => {
    const local = { format: 3, studies: {}, deleted: {} };
    const ls = storage.getStudy(id);
    if (ls) local.studies[id] = ls;
    if (localDel[id]) local.deleted[id] = localDel[id];
    const part = { format: 3, studies: {}, deleted: {} };
    if (remote.studies[id]) part.studies[id] = remote.studies[id];
    if (remote.deleted[id]) part.deleted[id] = remote.deleted[id];
    const merged = mergeStores(local, part);
    const m = merged.studies[id], d = merged.deleted[id];
    if (m) {
      if (!ls || stableStringify(ls) !== stableStringify(m)) toWrite.studies[id] = m;
      if (!part.studies[id] || stableStringify(part.studies[id]) !== stableStringify(m)) needPush.push(id);
    } else if (d) {
      if (ls || localDel[id] !== d) toWrite.deleted[id] = d;
      if (!part.deleted[id]) needPush.push(id);
    }
  });
  return { toWrite, needPush };
}

/**
 * Motor de sincronização.
 * @param onStatus  (status, detail) — 'syncing' | 'saved' | 'pending' | 'offline' | 'error'
 * @param onMerged  (changedIds)     — o store local mudou por causa da nuvem
 * @param onMode    (mode)           — 'blob' | 'rows'
 */
export function createSync({ onStatus = () => {}, onMerged = () => {}, onMode = () => {} } = {}) {
  let userId = null;
  let userEmail = '';
  let running = false;
  let again = false;
  let againOpts = {};
  let debounce = null;
  let retryTimer = null;
  let retryDelay = 0;
  let known = null;      // blob: { version, exists, snapshot }
  let lastModeCheck = 0;

  function clearRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function reset(newUserId, email = '') {
    userId = newUserId;
    userEmail = String(email || '').toLowerCase();
    known = null;
    running = false;
    again = false;
    againOpts = {};
    lastModeCheck = 0;
    clearTimeout(debounce);
    clearRetry();
    retryDelay = 0;
  }

  function scheduleRetry() {
    clearRetry();
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 5000, 60000);
    retryTimer = setTimeout(() => { retryTimer = null; syncNow({ pull: true }); }, retryDelay);
  }

  async function ensureMode(force) {
    const meta = storage.getSyncMeta();
    if (meta.mode === 'rows' && !force) return 'rows';
    if (!force && meta.mode === 'blob' && Date.now() - lastModeCheck < MODE_RECHECK_MS) return 'blob';
    lastModeCheck = Date.now();
    const mode = await detectMode();
    if (mode !== meta.mode) {
      storage.setSyncMeta({ mode });
      onMode(mode);
    }
    return mode;
  }

  /* ---------- blob ---------- */
  function applyBlobPull(remote) {
    const meta = storage.getSyncMeta();
    const local = storage.loadStore();
    let merged = meta.legacyIds
      ? mergeFirstPull(local, remote.store, { legacyIds: meta.legacyIds, remoteExists: remote.exists, remoteUpdatedAt: remote.version })
      : mergeStores(local, remote.store);
    merged = pruneTombstones(merged);
    if (stableStringify(merged) !== stableStringify(local)) {
      storage.replaceStoreFromSync(merged);
      onMerged(null);
    }
    if (meta.legacyIds) storage.setSyncMeta({ legacyIds: null });
    known = { version: remote.version, exists: remote.exists, snapshot: remote.legacyFormat ? null : stableStringify(remote.store) };
  }

  async function syncBlob(uid, pull) {
    let needPull = pull || !known;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (needPull) {
        const remote = await pullBlob(uid);
        if (userId !== uid) return;
        applyBlobPull(remote);
        needPull = false;
      }
      const rev = storage.getSyncMeta().localRev;
      const store = storage.loadStore();
      const snap = stableStringify(store);
      if (known.snapshot === snap) { markSynced(rev); return; }
      const res = await pushBlob(uid, store, known.version, known.exists);
      if (userId !== uid) return;
      if (res.ok) {
        known = { version: res.version, exists: true, snapshot: snap };
        markSynced(rev);
        return;
      }
      needPull = true;
    }
    throw new Error('Conflito de sincronização persistente');
  }

  function markSynced(rev) {
    const m = storage.getSyncMeta();
    const dirty = {};
    Object.keys(m.dirty).forEach(id => { if (m.dirty[id] > rev) dirty[id] = m.dirty[id]; });
    storage.setSyncMeta({ syncedRev: rev, dirty, lastSyncAt: new Date().toISOString() });
  }

  /* ---------- rows ---------- */
  async function syncRows(uid, { full = false } = {}) {
    let meta = storage.getSyncMeta();
    const first = !meta.rowsReady;
    const doFull = full || first || !meta.lastPullAt || !!meta.legacyIds;
    const since = doFull ? null : new Date(tsOf(meta.lastPullAt) - PULL_OVERLAP_MS).toISOString();

    const [rows, myShares, blobHead] = await Promise.all([
      fetchRows(since),
      fetchMyShares(userEmail),
      sb.from(BLOB).select('updated_at').eq('user_id', uid).maybeSingle()
    ]);
    if (userId !== uid) return;
    if (blobHead.error) throw blobHead.error;

    // Estudos da tabela antiga: na transição e se alguma aba antiga gravou lá
    let blob = null;
    const blobVersion = blobHead.data ? blobHead.data.updated_at : null;
    if (blobVersion && blobVersion !== meta.blobVersion) {
      blob = await pullBlob(uid);
      if (userId !== uid) return;
    }

    const roles = {};
    myShares.forEach(s => { roles[s.study_id] = s.role; });
    const versions = { ...meta.versions };
    const accessMap = {};
    if (!doFull) Object.assign(accessMap, Object.fromEntries(storage.listStudies().map(s => [s.id, storage.getAccess(s.id)])));
    let lastPullAt = meta.lastPullAt;
    const remote = emptyStore();
    const visible = new Set();
    rows.forEach(r => {
      visible.add(r.id);
      versions[r.id] = r.updated_at;
      lastPullAt = maxIso(lastPullAt, r.updated_at);
      accessMap[r.id] = r.owner_id === uid
        ? { role: 'owner' }
        : { role: roles[r.id] || 'viewer', ownerEmail: r.owner_email };
      const part = rowToStore(r);
      Object.assign(remote.studies, part.studies);
      Object.assign(remote.deleted, part.deleted);
    });
    Object.keys(roles).forEach(id => { if (accessMap[id] && accessMap[id].role !== 'owner') accessMap[id].role = roles[id]; });

    let combined = remote;
    if (blob) combined = mergeStores(remote, blob.store); // só estudos do próprio usuário

    let changedIds = [];
    let markAll = first;
    if (meta.legacyIds) {
      // 1ª sincronização após migrar dados locais da versão antiga
      const local = storage.loadStore();
      const remoteUpdatedAt = maxIso(blob && blob.version, lastPullAt);
      const merged = pruneTombstones(mergeFirstPull(local, combined, {
        legacyIds: meta.legacyIds, remoteExists: rows.length > 0 || !!(blob && blob.exists), remoteUpdatedAt
      }));
      if (stableStringify(merged) !== stableStringify(local)) {
        storage.replaceStoreFromSync(merged);
        changedIds = null;
      }
      storage.setSyncMeta({ legacyIds: null });
      markAll = true;
    } else {
      const { toWrite, needPush } = mergeIntoLocal(combined);
      if (Object.keys(toWrite.studies).length || Object.keys(toWrite.deleted).length) {
        storage.applyFromSync(toWrite.studies, toWrite.deleted);
        changedIds = [...Object.keys(toWrite.studies), ...Object.keys(toWrite.deleted)];
      }
      if (needPush.length) {
        const m = storage.getSyncMeta();
        const d = { ...m.dirty };
        needPush.forEach(id => { if (d[id] === undefined) d[id] = m.localRev; });
        storage.setSyncMeta({ dirty: d });
      }
    }

    // Compartilhamentos revogados: some do aparelho (sem excluir na nuvem)
    if (doFull) {
      storage.listStudies().forEach(s => {
        const acc = storage.getAccess(s.id);
        if (acc.role !== 'owner' && !visible.has(s.id)) { storage.dropLocal(s.id); changedIds = null; }
      });
      storage.listStudies().forEach(s => { if (!accessMap[s.id]) accessMap[s.id] = { role: 'owner' }; });
    }
    storage.setAccessMap(accessMap);
    storage.setSyncMeta({ versions, lastPullAt, blobVersion: blobVersion || meta.blobVersion });

    if (markAll) storage.markAllDirty(); // depois do mapa de acesso: só estudos próprios
    if (first) storage.setSyncMeta({ rowsReady: true });
    if (changedIds === null || changedIds.length) onMerged(changedIds);

    // Envia os estudos alterados
    meta = storage.getSyncMeta();
    for (const id of Object.keys(meta.dirty)) {
      if (userId !== uid) return;
      await pushOne(uid, id);
    }
    storage.setSyncMeta({ lastSyncAt: new Date().toISOString(), syncedRev: storage.getSyncMeta().localRev });
  }

  async function pushOne(uid, id) {
    const rev = storage.getSyncMeta().dirty[id];
    if (rev === undefined) return;
    const acc = storage.getAccess(id);
    if (acc.role === 'viewer') { storage.clearDirty(id, rev); return; }
    for (let attempt = 0; attempt < 4; attempt++) {
      const meta = storage.getSyncMeta();
      const version = meta.versions[id];
      const local = storage.getStudy(id);
      const delAt = storage.getDeleted()[id];
      let res;
      if (!local) {
        if (!delAt) { storage.clearDirty(id, rev); return; }
        if (acc.role !== 'owner') { storage.clearDirty(id, rev); return; } // convidado "saiu": tratado em leaveShare
        let q = sb.from(ROWS).update({ deleted_at: delAt }).eq('id', id);
        if (version) q = q.eq('updated_at', version);
        res = await q.select('updated_at');
        if (!res.error && res.data && !res.data.length && !version) { storage.clearDirty(id, rev); return; } // nunca subiu
      } else if (!version) {
        res = await sb.from(ROWS).insert({ id, data: local }).select('updated_at');
        if (res.error && res.error.code === '23505') res = { data: [] }; // já existe: trata como conflito
      } else {
        const patch = { data: local };
        if (acc.role === 'owner') patch.deleted_at = null;
        res = await sb.from(ROWS).update(patch).eq('id', id).eq('updated_at', version).select('updated_at');
      }
      if (userId !== uid) return;
      if (res.error) {
        if (res.error.code === '42501' && acc.role !== 'owner') {
          // estudo excluído pelo dono ou acesso de edição removido
          storage.dropLocal(id);
          storage.clearDirty(id, rev);
          onMerged(null);
          return;
        }
        throw res.error;
      }
      if (res.data && res.data.length) {
        storage.setSyncMeta({ versions: { ...storage.getSyncMeta().versions, [id]: res.data[0].updated_at } });
        storage.clearDirty(id, rev);
        return;
      }
      // Conflito: relê a linha, mescla e tenta de novo
      const row = await fetchRow(id);
      if (userId !== uid) return;
      const versions = { ...storage.getSyncMeta().versions };
      if (!row) { delete versions[id]; storage.setSyncMeta({ versions }); continue; }
      versions[id] = row.updated_at;
      storage.setSyncMeta({ versions });
      const { toWrite } = mergeIntoLocal(rowToStore(row));
      if (Object.keys(toWrite.studies).length || Object.keys(toWrite.deleted).length) {
        storage.applyFromSync(toWrite.studies, toWrite.deleted);
        onMerged([id]);
      }
    }
    throw new Error('Conflito de sincronização persistente (' + id + ')');
  }

  /* ---------- ciclo ---------- */
  async function runLocked(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request('cronoanalise-sync-' + userId, fn);
    }
    return fn();
  }

  async function syncNow(opts = {}) {
    if (!sb || !userId) return;
    if (running) { again = true; againOpts = { pull: againOpts.pull || opts.pull, full: againOpts.full || opts.full }; return; }
    running = true;
    clearTimeout(debounce);
    clearRetry();
    const uid = userId;
    onStatus('syncing');
    try {
      await runLocked(async () => {
        const mode = await ensureMode(opts.full);
        if (userId !== uid) return;
        if (mode === 'rows') await syncRows(uid, opts);
        else await syncBlob(uid, opts.pull);
      });
      retryDelay = 0;
      if (userId === uid) onStatus(storage.isDirty() ? 'pending' : 'saved');
    } catch (e) {
      console.warn('Sincronização falhou:', e);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      if (userId === uid) onStatus(offline || isNetworkError(e) ? 'offline' : 'error', e);
      known = null;
      scheduleRetry();
    } finally {
      running = false;
      if (userId === uid && again) {
        const o = againOpts;
        again = false;
        againOpts = {};
        syncNow(o);
      } else if (userId === uid && storage.isDirty() && !retryTimer) {
        request();
      }
    }
  }

  /* Pede uma sincronização após alterações locais (agrupa cliques rápidos). */
  function request(delay = 800) {
    if (!userId) return;
    onStatus('pending');
    clearTimeout(debounce);
    debounce = setTimeout(() => syncNow(), delay);
  }

  /* Garante que o estudo já existe na nuvem (antes de compartilhar). */
  async function pushStudyNow(id) {
    if (!userId) throw new Error('Não autenticado');
    const meta = storage.getSyncMeta();
    if (meta.dirty[id] === undefined && meta.versions[id]) return;
    if (meta.dirty[id] === undefined) storage.setSyncMeta({ dirty: { ...meta.dirty, [id]: meta.localRev } });
    await runLocked(() => pushOne(userId, id));
  }

  return { reset, syncNow, request, pushStudyNow, getMode: () => storage.getSyncMeta().mode };
}

/* ================= Compartilhamento (modo rows) ================= */
export async function listShares(studyId) {
  const { data, error } = await sb.from(SHARES).select('email, role, created_at').eq('study_id', studyId).order('created_at');
  if (error) throw error;
  return data || [];
}

export async function addShare(studyId, email, role) {
  const { error } = await sb.from(SHARES).upsert({ study_id: studyId, email: String(email).trim().toLowerCase(), role }, { onConflict: 'study_id,email' });
  if (error) throw error;
}

export async function removeShare(studyId, email) {
  const { error } = await sb.from(SHARES).delete().eq('study_id', studyId).eq('email', String(email).toLowerCase());
  if (error) throw error;
}

/* ================= Versões no servidor (modo rows) ================= */
export async function listVersions(studyId) {
  const { data, error } = await sb.rpc('crono_study_versions', { p_study_id: studyId });
  if (error) throw error;
  return data || [];
}

export async function getVersion(versionId) {
  const { data, error } = await sb.from('crono_study_version').select('data, saved_at').eq('id', versionId).maybeSingle();
  if (error) throw error;
  return data;
}

/* ================= Administração ================= */
export async function checkIsAdmin(user) {
  if (!sb || !user) return false;
  try {
    const { data, error } = await sb.rpc('crono_is_admin');
    if (!error) return data === true;
  } catch (e) { /* cai no e-mail fixo */ }
  return user.email === ADMIN_EMAIL;
}

/* Estatísticas por usuário (com a migração 002) ou só a tabela de acessos. */
export async function adminStats() {
  const r = await sb.rpc('crono_admin_stats');
  if (!r.error) return { rows: r.data || [], detailed: true };
  if (!isMissing(r.error)) return { error: r.error };
  const { data, error } = await sb.from('crono_user_activity').select('*').order('last_seen', { ascending: false });
  return error ? { error } : { rows: data || [], detailed: false };
}

/* ================= Conta ================= */
export async function deleteAccount() {
  const { error } = await sb.rpc('crono_delete_account');
  if (error) {
    if (isMissing(error)) throw new Error('A exclusão de conta precisa da migração 002 no banco. Peça ao administrador.');
    throw error;
  }
}

/* ---------- Registro de acesso (painel de administração) ----------
   Usa a função crono_log_activity() se ela existir no banco (contagem atômica,
   ver supabase/schema.sql); senão, faz como antes (lê e grava pelo cliente). */
export async function logActivity(user) {
  if (!sb || !user) return;
  try {
    const missingAt = Number(localStorage.getItem(RPC_MISSING_KEY) || 0);
    if (Date.now() - missingAt > 86400000) {
      const { error } = await sb.rpc('crono_log_activity');
      if (!error) return;
      if (error.code === 'PGRST202' || error.code === '42883') localStorage.setItem(RPC_MISSING_KEY, String(Date.now()));
    }
    const { data: existing } = await sb.from('crono_user_activity')
      .select('login_count').eq('user_id', user.id).maybeSingle();
    await sb.from('crono_user_activity').upsert({
      user_id: user.id,
      email: user.email,
      last_seen: new Date().toISOString(),
      login_count: ((existing && existing.login_count) || 0) + 1
    }, { onConflict: 'user_id' });
  } catch (e) {
    console.warn('Não foi possível registrar atividade do usuário:', e);
  }
}
