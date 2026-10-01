// Fake GoTrue + PostgREST para testar o app com a biblioteca real do supabase-js.
import crypto from 'node:crypto';

export const SB_URL = 'https://zwfnsknaxqnexeuzvvjn.supabase.co';

const b64u = o => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function createFakeSupabase({ rpcEnabled = false } = {}) {
  const users = new Map();   // email -> {id, email, password}
  const tokens = new Map();  // access_token -> userId
  const refresh = new Map(); // refresh_token -> userId
  const db = {
    crono_studies: new Map(),       // user_id -> {user_id, data, updated_at}
    crono_user_activity: new Map()  // user_id -> row
  };
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
      if (['select', 'order', 'on_conflict', 'limit', 'columns'].includes(k)) continue;
      const m = v.match(/^(eq|is)\.(.*)$/);
      if (m) f.push({ col: k, op: m[1], val: m[2] });
    }
    return f;
  }

  function matches(row, filters) {
    return filters.every(({ col, op, val }) => {
      const cur = row[col];
      if (op === 'is') return val === 'null' ? cur == null : String(cur) === val;
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
          let rows = [...table.values()].filter(visible).filter(r => matches(r, filters));
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
    setRow(email, data, updatedAt) { const id = users.get(email).id; db.crono_studies.set(id, { user_id: id, data, updated_at: pgTs(updatedAt) }); }
  };
}
