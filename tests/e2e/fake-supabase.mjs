// Fake GoTrue + PostgREST para testar o app com a biblioteca real do supabase-js.
import crypto from 'node:crypto';

export const SB_URL = 'https://zwfnsknaxqnexeuzvvjn.supabase.co';

const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function createFakeSupabase({ rpcEnabled = false, v2 = false, versionThrottleMs = 600000, admins = ['daniel.thomaseto@dhl.com'] } = {}) {
  const users = new Map();   // email -> {id, email, password}
  const tokens = new Map();  // access_token -> userId
  const refresh = new Map(); // refresh_token -> userId
  const db = {
    crono_studies: new Map(),       // user_id -> {user_id, data, updated_at}
    crono_user_activity: new Map(), // user_id -> row
    crono_study: new Map(),         // id -> {id, owner_id, owner_email, data, created_at, updated_at, deleted_at}
    crono_study_share: [],          // {study_id, email, role}
    crono_study_version: []         // {id, study_id, data, saved_at, created_at}
  };
  let versionSeq = 1;
  const interfere = {};
  let lastServerTs = 0;
  const serverNow = () => { lastServerTs = Math.max(Date.now(), lastServerTs + 1); return new Date(lastServerTs).toISOString().replace('Z', '+00:00'); };
  const log = [];
  let offline = false;
  let failNext = 0;

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

  function userJson(u) {
    return {
      id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
      email_confirmed_at: '2026-01-01T00:00:00Z', app_metadata: { provider: 'email' }, user_metadata: {},
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', identities: []
    };
  }

  function session(u, expiresIn = 3600) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + expiresIn, session_id: crypto.randomUUID() };
    const access = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u(payload) + '.' + b64u('sig' + Math.random());
    const rt = crypto.randomUUID();
    tokens.set(access, u.id);
    refresh.set(rt, u.id);
    return { access_token: access, token_type: 'bearer', expires_in: expiresIn, expires_at: now + expiresIn, refresh_token: rt, user: userJson(u) };
  }

  function authUser(headers) {
    const h = headers['authorization'] || '';
    const tok = h.replace(/^Bearer\s+/i, '');
    const id = tokens.get(tok);
    return id ? userById(id) : null;
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
      if (op === 'gt') return Date.parse(cur) > Date.parse(val);
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

  function ownerOf(studyId) { const r = db.crono_study.get(studyId); return r ? r.owner_id : null; }
  function roleOf(u, studyId) {
    const sh = db.crono_study_share.find(x => x.study_id === studyId && x.email === u.email.toLowerCase());
    return sh ? sh.role : null;
  }
  function canSee(u, studyId) { return ownerOf(studyId) === u.id || !!roleOf(u, studyId); }

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
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors(origin) });
    if (offline) return route.abort('internetdisconnected');
    if (failNext > 0) { failNext--; return json(503, { message: 'Service unavailable' }); }

    const path = url.pathname;
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch (e) { body = null; }
    log.push({ method, path: path + url.search, body });

    // ---------- Auth ----------
    if (path === '/auth/v1/token') {
      const gt = url.searchParams.get('grant_type');
      if (gt === 'password') {
        const u = users.get(body.email);
        if (!u || u.password !== body.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return json(200, session(u));
      }
      if (gt === 'refresh_token') {
        const id = refresh.get(body.refresh_token);
        if (!id) return json(400, { error: 'invalid_grant', msg: 'Invalid Refresh Token' });
        refresh.delete(body.refresh_token);
        return json(200, session(userById(id)));
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
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204, headers: cors(origin) });
    if (path === '/auth/v1/recover') return json(200, {});

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
      return route.fulfill({ status: 204, headers: cors(origin) });
    }
    // ---------- Modo v2 (migração 002) ----------
    const v2m = path.match(/^\/rest\/v1\/(crono_study|crono_study_share|crono_study_version)$/);
    const v2rpc = path.match(/^\/rest\/v1\/rpc\/(crono_is_admin|crono_admin_stats|crono_study_versions|crono_delete_account)$/);
    if ((v2m || v2rpc) && !v2) {
      return json(404, v2m
        ? { code: 'PGRST205', details: null, hint: null, message: `Could not find the table 'public.${v2m[1]}' in the schema cache` }
        : { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.' + v2rpc[1] + ' without parameters in the schema cache' });
    }
    if (v2rpc) {
      if (!u) return json(401, { message: 'unauthorized' });
      const fn = v2rpc[1];
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
      if (fn === 'crono_delete_account') {
        [...db.crono_study.values()].filter(r => r.owner_id === u.id).forEach(r => {
          db.crono_study.delete(r.id);
          db.crono_study_share = db.crono_study_share.filter(sh => sh.study_id !== r.id);
          db.crono_study_version = db.crono_study_version.filter(v => v.study_id !== r.id);
        });
        db.crono_study_share = db.crono_study_share.filter(sh => sh.email !== u.email.toLowerCase());
        db.crono_studies.delete(u.id);
        db.crono_user_activity.delete(u.id);
        users.delete(u.email);
        return route.fulfill({ status: 204, headers: cors(origin) });
      }
    }
    if (v2m) {
      if (!u) return json(401, { message: 'JWT expired' });
      const filters = parseFilters(url);
      const select = url.searchParams.get('select');
      const prefer = headers['prefer'] || '';
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : Infinity;
      const email = u.email.toLowerCase();
      try {
        if (v2m[1] === 'crono_study') {
          if (method === 'GET') {
            let rows = [...db.crono_study.values()].filter(r => canSee(u, r.id)).filter(r => matches(r, filters));
            rows.sort((a, b) => (Date.parse(a.updated_at) - Date.parse(b.updated_at)) || (a.id < b.id ? -1 : 1));
            rows = rows.slice(offset, offset + limit);
            return json(200, rows.map(r => project(r, select)));
          }
          if (method === 'POST') {
            const rows = Array.isArray(body) ? body : [body];
            const out = [];
            for (const r of rows) {
              if (db.crono_study.has(r.id)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint "crono_study_pkey"' });
              const now = serverNow();
              const row = { id: r.id, owner_id: u.id, owner_email: email, data: r.data, created_at: now, updated_at: now, deleted_at: null };
              db.crono_study.set(r.id, row);
              out.push(row);
            }
            if (/return=representation/.test(prefer)) return json(201, out.map(r => project(r, select)));
            return route.fulfill({ status: 201, headers: cors(origin) });
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
            const rows = [...db.crono_study.values()].filter(r => canSee(u, r.id)).filter(r => matches(r, filters));
            const writable = rows.filter(r => r.owner_id === u.id || roleOf(u, r.id) === 'editor');
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
            });
            if (/return=representation/.test(prefer)) return json(200, writable.map(r => project(r, select)));
            return route.fulfill({ status: 204, headers: cors(origin) });
          }
        }
        if (v2m[1] === 'crono_study_share') {
          const visible = sh => ownerOf(sh.study_id) === u.id || sh.email === email;
          if (method === 'GET') return json(200, db.crono_study_share.filter(visible).filter(r => matches(r, filters)).map(r => project(r, select)));
          if (method === 'POST') {
            const rows = Array.isArray(body) ? body : [body];
            for (const r of rows) {
              if (ownerOf(r.study_id) !== u.id) return json(403, { code: '42501', message: 'new row violates row-level security policy for table "crono_study_share"' });
              const ex = db.crono_study_share.find(x => x.study_id === r.study_id && x.email === r.email);
              if (ex) { if (/merge-duplicates/.test(prefer)) ex.role = r.role; else return json(409, { code: '23505', message: 'duplicate' }); }
              else db.crono_study_share.push({ study_id: r.study_id, email: r.email, role: r.role, created_at: new Date().toISOString() });
            }
            return route.fulfill({ status: 201, headers: cors(origin) });
          }
          if (method === 'DELETE') {
            const del = db.crono_study_share.filter(visible).filter(r => matches(r, filters));
            db.crono_study_share = db.crono_study_share.filter(r => !del.includes(r));
            return route.fulfill({ status: 204, headers: cors(origin) });
          }
        }
        if (v2m[1] === 'crono_study_version' && method === 'GET') {
          return json(200, db.crono_study_version.filter(v => canSee(u, v.study_id)).filter(r => matches({ ...r, id: String(r.id) }, filters)).map(r => project(r, select)));
        }
      } catch (e) {
        return json(400, { code: e.pg || 'XX000', message: e.message });
      }
    }

    const m = path.match(/^\/rest\/v1\/(crono_studies|crono_user_activity)$/);
    if (m) {
      if (!u) return json(401, { message: 'JWT expired' });
      const table = db[m[1]];
      const filters = parseFilters(url);
      const select = url.searchParams.get('select');
      const prefer = headers['prefer'] || '';
      const isAdmin = u.email === 'daniel.thomaseto@dhl.com';
      const visible = row => row.user_id === u.id || (m[1] === 'crono_user_activity' && isAdmin && method === 'GET');
      try {
        if (method === 'GET') {
          const rows = [...table.values()].filter(visible).filter(r => matches(r, filters));
          const order = url.searchParams.get('order');
          if (order) { const [col, dir] = order.split('.'); rows.sort((a, b) => (a[col] < b[col] ? -1 : 1) * (dir === 'desc' ? -1 : 1)); }
          return json(200, rows.map(r => project(r, select)));
        }
        if (method === 'POST') {
          const rows = Array.isArray(body) ? body : [body];
          const out = [];
          for (const r of rows) {
            if (r.user_id !== u.id) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
            const existing = table.get(r.user_id);
            const upsert = /resolution=merge-duplicates/.test(prefer);
            if (existing && !upsert) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
            const now = pgTs(new Date().toISOString());
            const base = existing || (m[1] === 'crono_user_activity' ? { first_seen: now, login_count: 1 } : {});
            const row = { ...base, ...r };
            if (row.updated_at) row.updated_at = pgTs(row.updated_at);
            if (row.last_seen) row.last_seen = pgTs(row.last_seen);
            table.set(r.user_id, row);
            out.push(row);
          }
          if (/return=representation/.test(prefer)) return json(201, out.map(r => project(r, select)));
          return route.fulfill({ status: 201, headers: cors(origin) });
        }
        if (method === 'PATCH') {
          const rows = [...table.values()].filter(visible).filter(r => matches(r, filters));
          log[log.length - 1].matched = rows.length;
          rows.forEach(r => {
            Object.assign(r, body);
            if (r.updated_at) r.updated_at = pgTs(r.updated_at);
          });
          if (/return=representation/.test(prefer)) return json(200, rows.map(r => project(r, select)));
          return route.fulfill({ status: 204, headers: cors(origin) });
        }
      } catch (e) {
        return json(400, { code: e.pg || 'XX000', message: e.message });
      }
    }
    return json(404, { message: 'not found: ' + path });
  }

  return {
    addUser,
    session,
    db,
    log,
    handle,
    setOffline(v) { offline = v; },
    failNext(n) { failNext = n; },
    studiesOf(email) { const u = users.get(email); const row = u && db.crono_studies.get(u.id); return row ? row.data : null; },
    rowOf(email) { const u = users.get(email); return u ? db.crono_studies.get(u.id) : null; },
    userId(email) { return users.get(email).id; },
    setRow(email, data, updatedAt) { const id = users.get(email).id; db.crono_studies.set(id, { user_id: id, data, updated_at: pgTs(updatedAt) }); },
    enableV2() { v2 = true; },
    interfereNextPatch(id, fn) { interfere[id] = fn; },
    rows() { return [...db.crono_study.values()]; },
    rowById(id) { return db.crono_study.get(id); },
    shares() { return db.crono_study_share; },
    versions() { return db.crono_study_version; },
    hasUser(email) { return users.has(email); }
  };
}
