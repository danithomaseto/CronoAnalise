/* Monitoramento de erros: captura erros não tratados do app e envia para a
   tabela crono_client_error (migração 003), visível no painel de administração.

   - Sem dados pessoais: e-mails e tokens são mascarados; a URL vai sem query/hash
     (onde ficam os tokens do login).
   - Erros repetidos são agrupados (mesmo erro no máximo 1x a cada 10 min) e há um
     limite por sessão; o servidor também limita (100 por hora por usuário).
   - Offline (ou antes do login): fica numa fila no aparelho e sobe depois. */

import { APP_VERSION } from './config.js';

const QUEUE_KEY = 'cronoanalise:errq';
const MISSING_KEY = 'cronoanalise:errTableMissingAt';
const MAX_QUEUE = 30;
const MAX_PER_SESSION = 25;
const DEDUP_MS = 10 * 60000;

let send = null;          // async rows => { error }
let getContext = () => ({});
let sentThisSession = 0;
const recent = new Map(); // assinatura → quando
let flushing = false;

const IGNORE = [
  /ResizeObserver loop/i,
  /Script error\.?$/i,                       // erro de script de outro domínio, sem detalhes
  /^(Failed to fetch|NetworkError|Load failed)/i,
  /AbortError|The operation was aborted/i,
  /chrome-extension:|moz-extension:|safari-extension:/i
];

export function scrub(s, max) {
  return String(s || '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<e-mail>')
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<token>')
    .replace(/[A-Za-z0-9_-]{40,}/g, '<token>')
    .slice(0, max);
}

function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') || []; } catch (e) { return []; }
}

function writeQueue(q) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))); } catch (e) { /* sem espaço */ }
}

export function buildReport(err, extra = {}) {
  const e = err instanceof Error ? err : null;
  const message = scrub(e ? (e.name && !String(e.message).startsWith(e.name) ? e.name + ': ' : '') + e.message : String(err), 1000) || 'Erro desconhecido';
  let ctx = {};
  try { ctx = { ...getContext(), ...extra }; } catch (x) { ctx = { ...extra }; }
  const context = JSON.parse(scrub(JSON.stringify(ctx), 3000) || '{}');
  return {
    message,
    stack: e && e.stack ? scrub(e.stack, 8000) : null,
    url: scrub(location.origin + location.pathname, 500),
    app_version: APP_VERSION,
    user_agent: scrub(navigator.userAgent, 400),
    context,
    at: new Date().toISOString()
  };
}

/* Registra um erro (capturado ou não). Devolve true se entrou na fila. */
export function reportError(err, extra) {
  try {
    const r = buildReport(err, extra);
    const text = r.message + ' ' + (r.stack || '');
    if (IGNORE.some(re => re.test(text))) return false;
    const sig = r.message + '|' + ((r.stack || '').split('\n')[1] || '');
    const last = recent.get(sig);
    if (last && Date.now() - last < DEDUP_MS) return false;
    if (sentThisSession >= MAX_PER_SESSION) return false;
    recent.set(sig, Date.now());
    sentThisSession++;
    const q = readQueue();
    q.push(r);
    writeQueue(q);
    flush();
    return true;
  } catch (e) {
    return false;
  }
}

/* Envia a fila (quando houver sessão e a tabela existir). */
export async function flush() {
  if (!send || flushing) return;
  const missingAt = Number(localStorage.getItem(MISSING_KEY) || 0);
  if (Date.now() - missingAt < 86400000) return;
  const q = readQueue();
  if (!q.length || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  flushing = true;
  try {
    const rows = q.map(r => ({ message: r.message, stack: r.stack, url: r.url, app_version: r.app_version, user_agent: r.user_agent, context: { ...r.context, at: r.at } }));
    const { error } = await send(rows);
    if (!error) { writeQueue(readQueue().slice(q.length)); return; }
    if (['42P01', 'PGRST205'].includes(error.code)) {
      // tabela ainda não criada (migração 003): para de tentar por um dia
      localStorage.setItem(MISSING_KEY, String(Date.now()));
      writeQueue([]);
    }
  } catch (e) {
    /* offline: tenta depois */
  } finally {
    flushing = false;
  }
}

/* Liga a captura global. `sender` é chamado só com usuário autenticado. */
export function initMonitor({ context } = {}) {
  if (context) getContext = context;
  window.addEventListener('error', ev => {
    if (ev.error || ev.message) reportError(ev.error || ev.message, { kind: 'error' });
  });
  window.addEventListener('unhandledrejection', ev => {
    reportError(ev.reason || 'Promise rejeitada', { kind: 'promise' });
  });
  window.addEventListener('online', () => flush());
}

export function setSender(fn) {
  send = fn;
  if (fn) flush();
}
