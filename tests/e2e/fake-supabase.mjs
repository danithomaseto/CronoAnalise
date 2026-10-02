// Fake GoTrue + PostgREST + Storage + Realtime para testar o app com a biblioteca
// real do supabase-js (sem internet).
//   v2: migração 002 (um estudo por linha, compartilhamento, versões, admin, excluir conta)
//   v3: migração 003 (times, tempo real, fotos, erros do app, retenção) — implica v2
import crypto from 'node:crypto';

export const SB_URL = 'https://zwfnsknaxqnexeuzvvjn.supabase.co';

const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/* ---------- TOTP (RFC 6238) — o teste gera os códigos como o app autenticador ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

export function createFakeSupabase({
  rpcEnabled = false, v2 = false, v3 = false, realtime = null, azure = false, msEmail = 'ana.ms@dhl.com',
  versionThrottleMs = 600000, admins = ['daniel.thomaseto@dhl.com']
} = {}) {
  if (v3) v2 = true;
  const realtimeOn = () => (realtime === null ? v3 : realtime);
  const users = new Map();   // email -> {id, email, password}
  const tokens = new Map();  // access_token -> { userId, aal }
  const refresh = new Map(); // refresh_token -> { userId, aal }
  const factors = new Map(); // userId -> [{ id, secret, status, friendly_name }]
  const challenges = new Map();
  const db = {
    crono_studies: new Map(),       // user_id -> {user_id, data, updated_at}
    crono_user_activity: new Map(), // user_id -> row
    crono_study: new Map(),         // id -> {id, owner_id, owner_email, data, created_at, updated_at, deleted_at}
    crono_study_share: [],          // {study_id, email, role}
    crono_study_version: [],        // {id, study_id, data, saved_at, created_at}
    crono_team: new Map(),          // id -> {id, name, owner_id, created_at}
    crono_team_member: [],          // {team_id, email, role, created_at}
    crono_study_team_share: [],     // {study_id, team_id, role, created_at}
    crono_client_error: [],         // {id, user_id, email, created_at, message, ...}
    storage: new Map()              // path -> { bytes, contentType, owner }
  };
  let versionSeq = 1;
  let errorSeq = 1;
  const interfere = {};
  let lastServerTs = 0;
  const serverNow = () => { lastServerTs = Math.max(Date.now(), lastServerTs + 1); return new Date(lastServerTs).toISOString().replace('Z', '+00:00'); };
  const log = [];
  const authorizeLog = [];
  let offline = false;
  let failNext = 0;
  const subscribers = []; // realtime

  function pgTs(iso) {
    // imita o formato de saída do timestamptz do Postgres
    const d = new Date(iso);
    return d.toISOString().replace('Z', '+00:00');
  }

  function addUser(email, password) {
    const id = crypto.randomUUID();
    users.set(email, { id, email, password });
    return id;
  }

  function userById(id) {
    for (const u of users.values()) if (u.id === id) return u;
    return null;
  }

  function factorsJson(u) {
    return (factors.get(u.id) || []).map(f => ({ id: f.id, factor_type: 'totp', status: f.status, friendly_name: f.friendly_name, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }));
  }

  function userJson(u, provider = 'email') {
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
      email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider }, user_metadata: {},
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', identities: [], factors: factorsJson(u)
    };
  }

  function session(u, { expiresIn = 3600, aal = 'aal1', provider = 'email' } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const amr = [{ method: provider === 'email' ? 'password' : 'oauth', timestamp: now }];
    if (aal === 'aal2') amr.push({ method: 'totp', timestamp: now });
    const payload = { sub: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + expiresIn, session_id: crypto.randomUUID(), aal, amr };
    const access = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u(payload) + '.' + b64u('sig' + Math.random());
    const rt = crypto.randomUUID();
    tokens.set(access, { userId: u.id, aal });
    refresh.set(rt, { userId: u.id, aal });
    return { access_token: access, token_type: 'bearer', expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: rt, user: userJson(u, provider) };
  }

  function tokenInfo(headers) {
    const h = headers['authorization'] || '';
    return tokens.get(h.replace(/^Bearer\s+/i, '')) || null;
  }

  function authUser(headers) {
    const t = tokenInfo(headers);
    return t ? userById(t.userId) : null;
  }

  /* Com 2 etapas ativada, sessão aal1 não lê os dados (política restritiva da 003). */
  function aalOk(headers, u) {
    if (!v3 || !u) return true;
    const t = tokenInfo(headers);
    const verified = (factors.get(u.id) || []).some(f => f.status === 'verified');
    return !verified || (t && t.aal === 'aal2');
  }

  function parseFilters(url) {
    const f = [];
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'on_conflict', 'limit', 'offset', 'columns'].includes(k)) continue;
      const m = v.match(/^(eq|is|gt)\.(.*)$/);
      if (m) f.push({ col: k, op: m[1], val: m[2] });
    }
    return f;
  }

  function matches(row, filters) {
    return filters.every(({ col, op, val }) => {
      const cur = row[col];
      if (op === 'is') return val === 'null' ? cur == null : String(cur) === val;
      if (op === 'gt') return col === 'id' && !isNaN(Number(val)) ? Number(cur) > Number(val) : Date.parse(cur) > Date.parse(val);
      if (col === 'updated_at' || col === 'last_seen') {
        const a = Date.parse(cur), b = Date.parse(val);
        if (isNaN(b)) throw Object.assign(new Error('invalid input syntax for type timestamp with time zone'), { pg: '22007' });
        return a === b;
      }
      return String(cur) === val;
    });
  }

  function project(row, select) {
    if (!select || select === '*') return { ...row };
    const out = {};
    select.split(',').map(s => s.trim()).forEach(c => { out[c] = row[c]; });
    return out;
  }

  /* ---------- Regras de acesso (espelham as policies das migrações) ---------- */
  function ownerOf(studyId) { const r = db.crono_study.get(studyId); return r ? r.owner_id : null; }
  function teamRole(u, teamId) {
    const t = db.crono_team.get(teamId);
    if (!t) return null;
    if (t.owner_id === u.id) return 'owner';
    const m = db.crono_team_member.find(x => x.team_id === teamId && x.email === u.email.toLowerCase());
    return m ? m.role : null;
  }
  function roleOf(u, studyId) {
    const sh = db.crono_study_share.find(x => x.study_id === studyId && x.email === u.email.toLowerCase());
    let role = sh ? sh.role : null;
    if (v3 && role !== 'editor') {
      const ts = db.crono_study_team_share.filter(x => x.study_id === studyId && teamRole(u, x.team_id));
      if (ts.some(x => x.role === 'editor')) role = 'editor';
      else if (ts.length && !role) role = 'viewer';
    }
    return role;
  }
  function canSee(u, studyId) { return ownerOf(studyId) === u.id || !!roleOf(u, studyId); }
  function canEdit(u, studyId) { return ownerOf(studyId) === u.id || roleOf(u, studyId) === 'editor'; }

  /* ---------- Tempo real (Phoenix channels sobre WebSocket, vsn 2.0.0) ---------- */
  function rtSend(sub, arr) {
    try { sub.ws.send(JSON.stringify(arr)); } catch (e) { /* fechado */ }
  }

  function handleRealtime(ws) {
    ws.onMessage(raw => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { return; }
      const [joinRef, ref, topic, event, payload] = Array.isArray(msg) ? msg : [msg.join_ref, msg.ref, msg.topic, msg.event, msg.payload];
      if (topic === 'phoenix' && event === 'heartbeat') { ws.send(JSON.stringify([null, ref, 'phoenix', 'phx_reply', { status: 'ok', response: {} }])); return; }
      if (event === 'phx_join') {
        const t = tokens.get(payload && payload.access_token);
        const u = t ? userById(t.userId) : null;
        if (!realtimeOn() || !u) {
          ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'error', response: { reason: 'Unable to subscribe to changes with given parameters' } }]));
          return;
        }
        const bindings = ((payload.config && payload.config.postgres_changes) || []).map((b, i) => ({ ...b, id: 1000 + i }));
        subscribers.push({ ws, user: u, topic, joinRef, bindings });
        ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: bindings } }]));
        return;
      }
      if (event === 'phx_leave') {
        const i = subscribers.findIndex(s => s.ws === ws && s.topic === topic);
        if (i >= 0) subscribers.splice(i, 1);
        ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
        return;
      }
      if (ref) ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
    });
    ws.onClose(() => {
      for (let i = subscribers.length - 1; i >= 0; i--) if (subscribers[i].ws === ws) subscribers.splice(i, 1);
    });
  }

  function emit(table, type, record) {
    if (!realtimeOn()) return;
    subscribers.forEach(sub => {
      const visible = table === 'crono_study' ? canSee(sub.user, record.id) : true;
      if (!visible) return;
      sub.bindings.forEach(b => {
        if (b.table !== table || (b.event !== '*' && b.event !== type)) return;
        if (b.filter) {
          const m = /^(\w+)=eq\.(.*)$/.exec(b.filter);
          if (m && String(record[m[1]]) !== m[2]) return;
        }
        const columns = Object.keys(record).map(name => ({ name, type: 'text' }));
        rtSend(sub, [sub.joinRef, null, sub.topic, 'postgres_changes', {
          ids: [b.id],
          data: { schema: 'public', table, commit_timestamp: new Date().toISOString(), type, errors: null, columns, record: type === 'DELETE' ? {} : record, old_record: type === 'INSERT' ? {} : record }
        }]);
      });
    });
  }

  const cors = origin => ({
    'access-control-allow-origin': origin || '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
    'access-control-expose-headers': 'content-range, x-supabase-api-version',
    'access-control-allow-credentials': 'true'
  });

  async function handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const headers = req.headers();
    const origin = headers['origin'];
    const method = req.method();
    const json = (status, body, extra = {}) => route.fulfill({
      status, headers: { ...cors(origin), 'content-type': 'application/json', ...extra },
      body: body === undefined ? '' : JSON.stringify(body)
    });
    const noContent = (status = 204) => route.fulfill({ status, headers: cors(origin) });
    if (method === 'OPTIONS') return noContent();
    if (offline) return route.abort('internetdisconnected');
    if (failNext > 0) { failNext--; return json(503, { message: 'Service unavailable' }); }

    const path = url.pathname;
    const rawBody = req.postDataBuffer();
    let body = null;
    try { body = rawBody && !path.startsWith('/storage/v1/object/crono-photos/') ? JSON.parse(rawBody.toString('utf8')) : null; } catch (e) { body = null; }
    log.push({ method, path: path + url.search, body });

    // ---------- Auth ----------
    if (path === '/auth/v1/settings') return json(200, { external: { email: true, azure: !!azure }, disable_signup: false });
    if (path === '/auth/v1/authorize') {
      // login com provedor externo: devolve a sessão na URL (fluxo implícito)
      const provider = url.searchParams.get('provider');
      const redirectTo = url.searchParams.get('redirect_to');
      authorizeLog.push({ provider, scopes: url.searchParams.get('scopes'), redirectTo });
      if (provider !== 'azure' || !azure) return json(400, { code: 400, error_code: 'validation_failed', msg: 'Unsupported provider: provider is not enabled' });
      if (!users.has(msEmail)) addUser(msEmail, crypto.randomUUID());
      const u = users.get(msEmail);
      const s = session(u, { provider: 'azure' });
      const hash = new URLSearchParams({
        access_token: s.access_token, expires_in: String(s.expires_in), expires_at: String(s.expires_at), refresh_token: s.refresh_token,
        token_type: 'bearer', provider_token: 'graph-' + crypto.randomUUID(), provider_refresh_token: 'x', type: 'signin'
      });
      return route.fulfill({ status: 302, headers: { location: redirectTo + '#' + hash.toString() } });
    }
    if (path === '/auth/v1/token') {
      const gt = url.searchParams.get('grant_type');
      if (gt === 'password') {
        const u = users.get(body.email);
        if (!u || u.password !== body.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return json(200, session(u));
      }
      if (gt === 'refresh_token') {
        const r = refresh.get(body.refresh_token);
        if (!r) return json(400, { error: 'invalid_grant', msg: 'Invalid Refresh Token' });
        refresh.delete(body.refresh_token);
        return json(200, session(userById(r.userId), { aal: r.aal }));
      }
    }
    if (path === '/auth/v1/signup') {
      if (users.has(body.email)) return json(422, { code: 'user_already_exists', msg: 'User already registered' });
      addUser(body.email, body.password);
      const u = users.get(body.email);
      return json(200, { ...userJson(u), confirmation_sent_at: new Date().toISOString() });
    }
    if (path === '/auth/v1/user') {
      const u = authUser(headers);
      if (!u) return json(401, { msg: 'invalid JWT' });
      if (method === 'PUT') { if (body.password) u.password = body.password; }
      return json(200, userJson(u));
    }
    // MFA (TOTP)
    const fm = path.match(/^\/auth\/v1\/factors(?:\/([^/]+))?(?:\/(challenge|verify))?$/);
    if (fm) {
      const u = authUser(headers);
      if (!u) return json(401, { msg: 'invalid JWT' });
      const list = factors.get(u.id) || [];
      factors.set(u.id, list);
      if (!fm[1] && method === 'POST') {
        const secret = Array.from(crypto.randomBytes(20), b => B32[b % 32]).join('');
        const f = { id: crypto.randomUUID(), secret, status: 'unverified', friendly_name: body.friendly_name };
        list.push(f);
        return json(200, { id: f.id, type: 'totp', friendly_name: f.friendly_name, totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', secret, uri: 'otpauth://totp/x?secret=' + secret } });
      }
      const f = list.find(x => x.id === fm[1]);
      if (!f) return json(404, { msg: 'Factor not found' });
      if (method === 'DELETE') {
        const t = tokenInfo(headers);
        if (f.status === 'verified' && (!t || t.aal !== 'aal2')) return json(403, { code: 'insufficient_aal', msg: 'AAL2 required to unenroll verified factor' });
        factors.set(u.id, list.filter(x => x !== f));
        return json(200, { id: f.id });
      }
      if (fm[2] === 'challenge') {
        const id = crypto.randomUUID();
        challenges.set(id, f.id);
        return json(200, { id, type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 });
      }
      if (fm[2] === 'verify') {
        if (challenges.get(body.challenge_id) !== f.id) return json(400, { code: 'mfa_challenge_expired', msg: 'Challenge expired' });
        const ok = [0, -30000, 30000].some(d => totp(f.secret, Date.now() + d) === String(body.code));
        if (!ok) return json(422, { code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' });
        f.status = 'verified';
        return json(200, session(u, { aal: 'aal2' }));
      }
    }
    if (path === '/auth/v1/logout') return noContent();
    if (path === '/auth/v1/recover') return json(200, {});

    // ---------- Storage (fotos) ----------
    if (path.startsWith('/storage/v1/')) {
      if (!v3) return json(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
      const signGet = path.match(/^\/storage\/v1\/object\/sign\/crono-photos\/(.+)$/);
      if (signGet && method === 'GET') {
        const file = db.storage.get(decodeURIComponent(signGet[1]));
        if (!file || !url.searchParams.get('token')) return json(400, { message: 'Object not found' });
        return route.fulfill({ status: 200, headers: { ...cors(origin), 'content-type': file.contentType }, body: file.bytes });
      }
      const u = authUser(headers);
      if (!u) return json(401, { message: 'Invalid JWT' });
      const folder = p => p.split('/')[0];
      const deny = () => json(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (signGet && method === 'POST') {
        const p = decodeURIComponent(signGet[1]);
        if (!canSee(u, folder(p)) || !aalOk(headers, u) || !db.storage.has(p)) return json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        return json(200, { signedURL: '/object/sign/crono-photos/' + encodeURIComponent(p).replace(/%2F/g, '/') + '?token=t' + Math.random().toString(36).slice(2) });
      }
      const up = path.match(/^\/storage\/v1\/object\/crono-photos\/(.+)$/);
      if (up && (method === 'POST' || method === 'PUT')) {
        const p = decodeURIComponent(up[1]);
        if (!canEdit(u, folder(p)) || !aalOk(headers, u)) return deny();
        if (db.storage.has(p) && headers['x-upsert'] !== 'true' && method === 'POST') return json(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        db.storage.set(p, { bytes: rawBody, contentType: headers['content-type'] || 'image/jpeg', owner: u.id });
        return json(200, { Key: 'crono-photos/' + p, Id: crypto.randomUUID() });
      }
      if (path === '/storage/v1/object/crono-photos' && method === 'DELETE') {
        const out = [];
        (body.prefixes || []).forEach(p => { if (db.storage.has(p) && canEdit(u, folder(p))) { db.storage.delete(p); out.push({ name: p }); } });
        return json(200, out);
      }
      if (path === '/storage/v1/object/list/crono-photos' && method === 'POST') {
        const prefix = String(body.prefix || '').replace(/\/$/, '');
        if (!canSee(u, prefix)) return json(200, []);
        return json(200, [...db.storage.keys()].filter(k => k.startsWith(prefix + '/')).map(k => ({ name: k.slice(prefix.length + 1), id: k, metadata: {} })));
      }
      return json(404, { message: 'not found: ' + path });
    }

    // ---------- REST ----------
    const u = authUser(headers);
    if (path === '/rest/v1/rpc/crono_log_activity') {
      if (!rpcEnabled) return json(404, { code: 'PGRST202', message: 'Could not find the function public.crono_log_activity without parameters in the schema cache', details: null, hint: null });
      if (!u) return json(401, { message: 'unauthorized' });
      const t = db.crono_user_activity;
      const now = pgTs(new Date().toISOString());
      const row = t.get(u.id);
      if (row) { row.last_seen = now; row.login_count++; row.email = u.email; }
      else t.set(u.id, { user_id: u.id, email: u.email, first_seen: now, last_seen: now, login_count: 1 });
      return noContent();
    }
    const missingTable = name => json(404, { code: 'PGRST205', details: null, hint: null, message: `Could not find the table 'public.${name}' in the schema cache` });
    const missingFn = name => json(404, { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.' + name + ' without parameters in the schema cache' });

    // ---------- Funções (RPC) ----------
    const rpc = path.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpc) {
      const fn = rpc[1];
      const v2fns = ['crono_is_admin', 'crono_admin_stats', 'crono_study_versions', 'crono_delete_account'];
      const v3fns = ['crono_my_study_roles', 'crono_purge_old_data'];
      if (!(v2 && v2fns.includes(fn)) && !(v3 && v3fns.includes(fn))) return missingFn(fn);
      if (!u) return json(401, { message: 'unauthorized' });
      const isAdm = admins.includes(u.email.toLowerCase());
      if (fn === 'crono_is_admin') return json(200, isAdm);
      if (fn === 'crono_admin_stats') {
        if (!isAdm) return json(403, { code: '42501', message: 'Acesso restrito' });
        return json(200, [...db.crono_user_activity.values()].map(a => {
          const own = [...db.crono_study.values()].filter(r => r.owner_id === a.user_id && !r.deleted_at);
          return { ...a, studies: own.length, records: own.reduce((x, r) => x + ((r.data && r.data.records) || []).length, 0),
            shares: db.crono_study_share.filter(sh => own.some(r => r.id === sh.study_id)).length };
        }));
      }
      if (fn === 'crono_study_versions') {
        const sid = body && body.p_study_id;
        if (!canSee(u, sid)) return json(200, []);
        return json(200, db.crono_study_version.filter(v => v.study_id === sid).sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1))
          .map(v => ({ id: v.id, saved_at: v.saved_at, records: ((v.data && v.data.records) || []).length, name: v.data && v.data.name })));
      }
      if (fn === 'crono_my_study_roles') {
        const out = [];
        db.crono_study.forEach(r => { if (r.owner_id !== u.id) { const role = roleOf(u, r.id); if (role) out.push({ study_id: r.id, role }); } });
        return json(200, out);
      }
      if (fn === 'crono_purge_old_data') {
        if (!isAdm) return json(403, { code: '42501', message: 'Acesso restrito' });
        const before = db.crono_client_error.length;
        db.crono_client_error = db.crono_client_error.filter(e => Date.now() - Date.parse(e.created_at) < 90 * 86400000);
        return json(200, { erros: before - db.crono_client_error.length, versoes: 0, estudos_excluidos: 0, acessos: 0 });
      }
      if (fn === 'crono_delete_account') {
        const email = u.email.toLowerCase();
        [...db.crono_study.values()].filter(r => r.owner_id === u.id).forEach(r => {
          db.crono_study.delete(r.id);
          db.crono_study_share = db.crono_study_share.filter(sh => sh.study_id !== r.id);
          db.crono_study_team_share = db.crono_study_team_share.filter(sh => sh.study_id !== r.id);
          db.crono_study_version = db.crono_study_version.filter(v => v.study_id !== r.id);
        });
        db.crono_study_share = db.crono_study_share.filter(sh => sh.email !== email);
        [...db.crono_team.values()].filter(t => t.owner_id === u.id).forEach(t => {
          db.crono_team.delete(t.id);
          db.crono_team_member = db.crono_team_member.filter(m => m.team_id !== t.id);
          db.crono_study_team_share = db.crono_study_team_share.filter(s => s.team_id !== t.id);
        });
        db.crono_team_member = db.crono_team_member.filter(m => m.email !== email);
        db.crono_client_error = db.crono_client_error.filter(e => e.user_id !== u.id);
        db.crono_studies.delete(u.id);
        db.crono_user_activity.delete(u.id);
        users.delete(u.email);
        return noContent();
      }
    }

    const tm = path.match(/^\/rest\/v1\/(\w+)$/);
    if (!tm) return json(404, { message: 'not found: ' + path });
    const table = tm[1];
    const V2_TABLES = ['crono_study', 'crono_study_share', 'crono_study_version'];
    const V3_TABLES = ['crono_team', 'crono_team_member', 'crono_study_team_share', 'crono_client_error'];
    const BASE_TABLES = ['crono_studies', 'crono_user_activity'];
    if (!(BASE_TABLES.includes(table) || (v2 && V2_TABLES.includes(table)) || (v3 && V3_TABLES.includes(table)))) return missingTable(table);
    if (!u) return json(401, { message: 'JWT expired' });
    const filters = parseFilters(url);
    const select = url.searchParams.get('select');
    const prefer = headers['prefer'] || '';
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : Infinity;
    const email = u.email.toLowerCase();
    const rows = arr => (/return=representation/.test(prefer) ? json(201, arr.map(r => project(r, select))) : noContent(201));
    const aal = aalOk(headers, u);
    try {
      // ---------- Modo v2 (migração 002) ----------
      if (table === 'crono_study') {
        if (method === 'GET') {
          let list = aal ? [...db.crono_study.values()].filter(r => canSee(u, r.id)).filter(r => matches(r, filters)) : [];
          list.sort((a, b) => (Date.parse(a.updated_at) - Date.parse(b.updated_at)) || (a.id < b.id ? -1 : 1));
          list = list.slice(offset, offset + limit);
          return json(200, list.map(r => project(r, select)));
        }
        if (method === 'POST') {
          if (!aal) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "crono_study"' });
          const input = Array.isArray(body) ? body : [body];
          const out = [];
          for (const r of input) {
            if (db.crono_study.has(r.id)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "crono_study_pkey"' });
            const now = serverNow();
            const row = { id: r.id, owner_id: u.id, owner_email: email, data: r.data, created_at: now, updated_at: now, deleted_at: null };
            db.crono_study.set(r.id, row);
            out.push(row);
            emit('crono_study', 'INSERT', { id: row.id, owner_id: row.owner_id, updated_at: row.updated_at, deleted_at: null });
          }
          return rows(out);
        }
        if (method === 'PATCH') {
          const idf = filters.find(f => f.col === 'id');
          if (idf && interfere[idf.val]) {
            // outro aparelho gravou entre o pull e o push deste
            const row = db.crono_study.get(idf.val);
            const fn = interfere[idf.val];
            delete interfere[idf.val];
            if (row) { row.data = fn(JSON.parse(JSON.stringify(row.data))); row.updated_at = serverNow(); }
          }
          const list = aal ? [...db.crono_study.values()].filter(r => canSee(u, r.id)).filter(r => matches(r, filters)) : [];
          const writable = list.filter(r => canEdit(u, r.id));
          log[log.length - 1].matched = writable.length;
          for (const r of writable) {
            if ('deleted_at' in body && (body.deleted_at || null) !== (r.deleted_at || null) && r.owner_id !== u.id) {
              return json(403, { code: '42501', message: 'Só o dono pode excluir ou restaurar o estudo' });
            }
          }
          writable.forEach(r => {
            const now = serverNow();
            if (body.data !== undefined && JSON.stringify(body.data) !== JSON.stringify(r.data)) {
              const recent = db.crono_study_version.some(v => v.study_id === r.id && Date.now() - Date.parse(v.created_at) < versionThrottleMs);
              if (!recent) db.crono_study_version.push({ id: versionSeq++, study_id: r.id, data: r.data, saved_at: r.updated_at, created_at: new Date().toISOString() });
            }
            if (body.data !== undefined) r.data = body.data;
            if ('deleted_at' in body) r.deleted_at = body.deleted_at ? pgTs(body.deleted_at) : null;
            r.updated_at = now;
            emit('crono_study', 'UPDATE', { id: r.id, owner_id: r.owner_id, updated_at: r.updated_at, deleted_at: r.deleted_at });
          });
          if (/return=representation/.test(prefer)) return json(200, writable.map(r => project(r, select)));
          return noContent();
        }
      }
      if (table === 'crono_study_share') {
        const visible = sh => ownerOf(sh.study_id) === u.id || sh.email === email;
        if (method === 'GET') return json(200, db.crono_study_share.filter(visible).filter(r => matches(r, filters)).map(r => project(r, select)));
        if (method === 'POST') {
          const input = Array.isArray(body) ? body : [body];
          for (const r of input) {
            if (ownerOf(r.study_id) !== u.id) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "crono_study_share"' });
            const ex = db.crono_study_share.find(x => x.study_id === r.study_id && x.email === r.email);
            if (ex) { if (/merge-duplicates/.test(prefer)) ex.role = r.role; else return json(409, { code: '23505', message: 'duplicate' }); }
            else db.crono_study_share.push({ study_id: r.study_id, email: r.email, role: r.role, created_at: new Date().toISOString() });
            emit('crono_study_share', 'INSERT', { study_id: r.study_id, email: r.email, role: r.role });
          }
          return noContent(201);
        }
        if (method === 'DELETE') {
          const del = db.crono_study_share.filter(visible).filter(r => matches(r, filters));
          db.crono_study_share = db.crono_study_share.filter(r => !del.includes(r));
          del.forEach(r => emit('crono_study_share', 'DELETE', r));
          return noContent();
        }
      }
      if (table === 'crono_study_version' && method === 'GET') {
        return json(200, db.crono_study_version.filter(v => canSee(u, v.study_id)).filter(r => matches({ ...r, id: String(r.id) }, filters)).map(r => project(r, select)));
      }

      // ---------- Modo v3 (migração 003) ----------
      if (table === 'crono_team') {
        if (method === 'GET') {
          const list = [...db.crono_team.values()].filter(t => teamRole(u, t.id)).filter(r => matches(r, filters))
            .sort((a, b) => a.name.localeCompare(b.name));
          return json(200, list.map(r => project(r, select)));
        }
        if (method === 'POST') {
          const input = Array.isArray(body) ? body : [body];
          const out = input.map(r => {
            const row = { id: crypto.randomUUID(), name: String(r.name).trim(), owner_id: u.id, created_at: new Date().toISOString() };
            db.crono_team.set(row.id, row);
            return row;
          });
          return rows(out);
        }
        if (method === 'DELETE') {
          const del = [...db.crono_team.values()].filter(t => t.owner_id === u.id).filter(r => matches(r, filters));
          del.forEach(t => {
            db.crono_team.delete(t.id);
            db.crono_team_member.filter(m => m.team_id === t.id).forEach(m => emit('crono_team_member', 'DELETE', m));
            db.crono_team_member = db.crono_team_member.filter(m => m.team_id !== t.id);
            db.crono_study_team_share = db.crono_study_team_share.filter(s => s.team_id !== t.id);
          });
          return noContent();
        }
      }
      if (table === 'crono_team_member') {
        if (method === 'GET') return json(200, db.crono_team_member.filter(m => teamRole(u, m.team_id)).filter(r => matches(r, filters)).map(r => project(r, select)));
        if (method === 'POST') {
          const input = Array.isArray(body) ? body : [body];
          for (const r of input) {
            if (!['owner', 'manager'].includes(teamRole(u, r.team_id))) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "crono_team_member"' });
            const ex = db.crono_team_member.find(m => m.team_id === r.team_id && m.email === r.email);
            if (ex) { if (/merge-duplicates/.test(prefer)) ex.role = r.role; else return json(409, { code: '23505', message: 'duplicate' }); }
            else db.crono_team_member.push({ team_id: r.team_id, email: r.email, role: r.role || 'member', created_at: new Date().toISOString() });
            emit('crono_team_member', 'INSERT', { team_id: r.team_id, email: r.email, role: r.role });
          }
          return noContent(201);
        }
        if (method === 'DELETE') {
          const del = db.crono_team_member.filter(m => ['owner', 'manager'].includes(teamRole(u, m.team_id)) || m.email === email).filter(r => matches(r, filters));
          db.crono_team_member = db.crono_team_member.filter(m => !del.includes(m));
          del.forEach(m => emit('crono_team_member', 'DELETE', m));
          return noContent();
        }
      }
      if (table === 'crono_study_team_share') {
        if (method === 'GET') return json(200, db.crono_study_team_share.filter(s => ownerOf(s.study_id) === u.id || teamRole(u, s.team_id)).filter(r => matches(r, filters)).map(r => project(r, select)));
        if (method === 'POST') {
          const input = Array.isArray(body) ? body : [body];
          for (const r of input) {
            if (ownerOf(r.study_id) !== u.id || !teamRole(u, r.team_id)) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "crono_study_team_share"' });
            const ex = db.crono_study_team_share.find(s => s.study_id === r.study_id && s.team_id === r.team_id);
            if (ex) { if (/merge-duplicates/.test(prefer)) ex.role = r.role; else return json(409, { code: '23505', message: 'duplicate' }); }
            else db.crono_study_team_share.push({ study_id: r.study_id, team_id: r.team_id, role: r.role, created_at: new Date().toISOString() });
            emit('crono_study_team_share', 'INSERT', { study_id: r.study_id, team_id: r.team_id, role: r.role });
          }
          return noContent(201);
        }
        if (method === 'DELETE') {
          const del = db.crono_study_team_share.filter(s => ownerOf(s.study_id) === u.id || ['owner', 'manager'].includes(teamRole(u, s.team_id))).filter(r => matches(r, filters));
          db.crono_study_team_share = db.crono_study_team_share.filter(s => !del.includes(s));
          del.forEach(s => emit('crono_study_team_share', 'DELETE', s));
          return noContent();
        }
      }
      if (table === 'crono_client_error') {
        const isAdm = admins.includes(email);
        if (method === 'POST') {
          const input = Array.isArray(body) ? body : [body];
          input.forEach(r => db.crono_client_error.push({ ...r, id: errorSeq++, user_id: u.id, email, created_at: new Date().toISOString() }));
          return noContent(201);
        }
        if (method === 'GET') {
          if (!isAdm) return json(200, []);
          return json(200, db.crono_client_error.slice().sort((a, b) => b.id - a.id).slice(0, limit).map(r => project(r, select)));
        }
        if (method === 'DELETE') {
          if (isAdm) db.crono_client_error = db.crono_client_error.filter(r => !matches(r, filters));
          return noContent();
        }
      }

      // ---------- Tabelas originais ----------
      if (BASE_TABLES.includes(table)) {
        const t = db[table];
        const isAdmin = u.email === 'daniel.thomaseto@dhl.com';
        const visible = row => (row.user_id === u.id && (table !== 'crono_studies' || aal)) || (table === 'crono_user_activity' && isAdmin && method === 'GET');
        if (method === 'GET') {
          const list = [...t.values()].filter(visible).filter(r => matches(r, filters));
          const order = url.searchParams.get('order');
          if (order) { const [col, dir] = order.split('.'); list.sort((a, b) => (a[col] < b[col] ? -1 : 1) * (dir === 'desc' ? -1 : 1)); }
          return json(200, list.map(r => project(r, select)));
        }
        if (method === 'POST') {
          const input = Array.isArray(body) ? body : [body];
          const out = [];
          for (const r of input) {
            if (r.user_id !== u.id) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
            const existing = t.get(r.user_id);
            const upsert = /resolution=merge-duplicates/.test(prefer);
            if (existing && !upsert) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
            const now = pgTs(new Date().toISOString());
            const base = existing || (table === 'crono_user_activity' ? { first_seen: now, login_count: 1 } : {});
            const row = { ...base, ...r };
            if (row.updated_at) row.updated_at = pgTs(row.updated_at);
            if (row.last_seen) row.last_seen = pgTs(row.last_seen);
            t.set(r.user_id, row);
            out.push(row);
          }
          return rows(out);
        }
        if (method === 'PATCH') {
          const list = [...t.values()].filter(visible).filter(r => matches(r, filters));
          log[log.length - 1].matched = list.length;
          list.forEach(r => {
            Object.assign(r, body);
            if (r.updated_at) r.updated_at = pgTs(r.updated_at);
          });
          if (/return=representation/.test(prefer)) return json(200, list.map(r => project(r, select)));
          return noContent();
        }
      }
    } catch (e) {
      return json(400, { code: e.pg || 'XX000', message: e.message });
    }
    return json(404, { message: 'not found: ' + path });
  }

  /* Liga o Supabase simulado num contexto do Playwright (HTTP + WebSocket). */
  async function attach(ctx) {
    await ctx.route(SB_URL + '/**', r => handle(r));
    if (typeof ctx.routeWebSocket === 'function') await ctx.routeWebSocket(/\/realtime\/v1\/websocket/, ws => handleRealtime(ws));
  }

  return {
    addUser,
    session,
    db,
    log,
    authorizeLog,
    handle,
    attach,
    setOffline(v) { offline = v; },
    failNext(n) { failNext = n; },
    studiesOf(email) { const u = users.get(email); const row = u && db.crono_studies.get(u.id); return row ? row.data : null; },
    rowOf(email) { const u = users.get(email); return u ? db.crono_studies.get(u.id) : null; },
    userId(email) { return users.get(email).id; },
    setRow(email, data, updatedAt) { const id = users.get(email).id; db.crono_studies.set(id, { user_id: id, data, updated_at: pgTs(updatedAt) }); },
    enableV2() { v2 = true; },
    setAzure(v) { azure = v; },
    interfereNextPatch(id, fn) { interfere[id] = fn; },
    rows() { return [...db.crono_study.values()]; },
    rowById(id) { return db.crono_study.get(id); },
    shares() { return db.crono_study_share; },
    versions() { return db.crono_study_version; },
    hasUser(email) { return users.has(email); },
    factorsOf(email) { const u = users.get(email); return u ? (factors.get(u.id) || []) : []; },
    subscriberCount() { return subscribers.length; },
    /* Simula uma gravação feita por outro aparelho (aciona o tempo real). */
    serverUpdate(id, fn) {
      const row = db.crono_study.get(id);
      row.data = fn(JSON.parse(JSON.stringify(row.data)));
      row.updated_at = serverNow();
      emit('crono_study', 'UPDATE', { id: row.id, owner_id: row.owner_id, updated_at: row.updated_at, deleted_at: row.deleted_at });
    }
  };
}
