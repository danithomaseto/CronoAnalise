/* Nuvem (Supabase): cliente, sincronização de estudos e registro de acesso.

   Sincronização:
   - Continua usando 1 linha por usuário em crono_studies (sem mudar o banco).
   - Antes de sobrescrever, mescla estudo a estudo com o que está na nuvem
     (mergeStores), então dois aparelhos não apagam o trabalho um do outro.
   - Grava com "controle otimista": o UPDATE só acontece se updated_at ainda for
     o que lemos; se outro aparelho gravou no meio, relê, mescla e tenta de novo.
   - Falhou (offline)? Tenta de novo com espera crescente e quando a conexão volta. */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { normalizeStore, mergeStores, mergeFirstPull, pruneTombstones, emptyStore } from './core/model.js';
import { stableStringify } from './core/format.js';
import * as storage from './storage.js';

export const sb = (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function')
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

const TABLE = 'crono_studies';
const RPC_MISSING_KEY = 'cronoanalise:rpcMissingAt';

async function pullRemote(userId) {
  const { data, error } = await sb.from(TABLE).select('data, updated_at').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!data) return { exists: false, store: emptyStore(), version: null, legacyFormat: false };
  const raw = data.data;
  return {
    exists: true,
    store: normalizeStore(raw),
    version: data.updated_at,
    legacyFormat: !(raw && raw.format === 3)
  };
}

/* Erros que indicam que o filtro por updated_at não funcionou neste banco:
   nesse caso volta ao upsert simples (comportamento anterior). */
const FILTER_ERRORS = new Set(['22007', '22008', '42883', '42703', 'PGRST100']);

async function pushRemote(userId, store, version, exists) {
  const now = new Date().toISOString();
  if (!exists) {
    const { data, error } = await sb.from(TABLE)
      .insert({ user_id: userId, data: store, updated_at: now })
      .select('updated_at');
    if (error) {
      if (error.code === '23505') return { ok: false }; // outro aparelho criou a linha agora
      throw error;
    }
    return { ok: true, version: data && data[0] ? data[0].updated_at : now };
  }
  let q = sb.from(TABLE).update({ data: store, updated_at: now }).eq('user_id', userId);
  q = version ? q.eq('updated_at', version) : q.is('updated_at', null);
  const { data, error } = await q.select('updated_at');
  if (error) {
    if (!FILTER_ERRORS.has(error.code)) throw error;
    const up = await sb.from(TABLE).upsert({ user_id: userId, data: store, updated_at: now });
    if (up.error) throw up.error;
    return { ok: true, version: now };
  }
  if (!data || !data.length) return { ok: false }; // conflito: alguém gravou antes
  return { ok: true, version: data[0].updated_at };
}

/**
 * Motor de sincronização.
 * @param onStatus  (status, detail) — 'syncing' | 'saved' | 'pending' | 'offline' | 'error'
 * @param onMerged  (before, after)  — o store local mudou por causa da nuvem
 */
export function createSync({ onStatus = () => {}, onMerged = () => {} } = {}) {
  let userId = null;
  let running = false;
  let again = false;
  let againPull = false;
  let debounce = null;
  let retryTimer = null;
  let retryDelay = 0;
  let known = null; // { version, exists, snapshot }

  function clearRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function reset(newUserId) {
    userId = newUserId;
    known = null;
    running = false;
    again = againPull = false;
    clearTimeout(debounce);
    clearRetry();
    retryDelay = 0;
  }

  function scheduleRetry() {
    clearRetry();
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 5000, 60000);
    retryTimer = setTimeout(() => { retryTimer = null; syncNow({ pull: true }); }, retryDelay);
  }

  function applyPull(remote) {
    const meta = storage.getSyncMeta();
    const local = storage.loadStore();
    let merged = meta.legacyIds
      ? mergeFirstPull(local, remote.store, { legacyIds: meta.legacyIds, remoteExists: remote.exists, remoteUpdatedAt: remote.version })
      : mergeStores(local, remote.store);
    merged = pruneTombstones(merged);
    if (stableStringify(merged) !== stableStringify(local)) {
      storage.replaceStoreFromSync(merged);
      onMerged(local, merged);
    }
    if (meta.legacyIds) storage.setSyncMeta({ legacyIds: null });
    known = {
      version: remote.version,
      exists: remote.exists,
      // formato antigo na nuvem: força regravar no formato novo
      snapshot: remote.legacyFormat ? null : stableStringify(remote.store)
    };
  }

  async function syncNow({ pull = false } = {}) {
    if (!sb || !userId) return;
    if (running) { again = true; againPull = againPull || pull; return; }
    running = true;
    clearTimeout(debounce);
    clearRetry();
    const uidAtStart = userId;
    onStatus('syncing');
    try {
      let needPull = pull || !known;
      for (let attempt = 0; attempt < 5; attempt++) {
        if (needPull) {
          const remote = await pullRemote(uidAtStart);
          if (userId !== uidAtStart) return; // trocou de usuário no meio
          applyPull(remote);
          needPull = false;
        }
        const rev = storage.getSyncMeta().localRev;
        const store = storage.loadStore();
        const snap = stableStringify(store);
        if (known.snapshot === snap) {
          storage.setSyncMeta({ syncedRev: rev, lastSyncAt: new Date().toISOString() });
          break;
        }
        const res = await pushRemote(uidAtStart, store, known.version, known.exists);
        if (userId !== uidAtStart) return;
        if (res.ok) {
          known = { version: res.version, exists: true, snapshot: snap };
          storage.setSyncMeta({ syncedRev: rev, lastSyncAt: new Date().toISOString() });
          break;
        }
        needPull = true; // conflito
        if (attempt === 4) throw new Error('Conflito de sincronização persistente');
      }
      retryDelay = 0;
      onStatus(storage.isDirty() ? 'pending' : 'saved');
    } catch (e) {
      console.warn('Sincronização falhou:', e);
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      onStatus(offline || isNetworkError(e) ? 'offline' : 'error', e);
      known = null; // na próxima tentativa, relê a nuvem antes de gravar
      scheduleRetry();
    } finally {
      running = false;
      if (userId === uidAtStart && again) {
        const p = againPull;
        again = againPull = false;
        syncNow({ pull: p });
      } else if (userId === uidAtStart && storage.isDirty() && !retryTimer) {
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

  return { reset, syncNow, request };
}

function isNetworkError(e) {
  const msg = String((e && (e.message || e.details)) || '');
  return /Failed to fetch|NetworkError|Load failed|network|fetch/i.test(msg);
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

export async function listActivity() {
  return sb.from('crono_user_activity').select('*').order('last_seen', { ascending: false });
}
