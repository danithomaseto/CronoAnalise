/* Utilitários de formatação e texto — sem DOM, testáveis no Node. */

export function parseNumber(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = parseFloat(String(v).trim().replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

export function toBR(n, dec = 2) {
  if (!isFinite(n)) n = 0;
  return Number(n).toFixed(dec).replace('.', ',');
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/* HH:MM:SS.d */
export function fmtClock(ms) {
  ms = Math.max(0, ms || 0);
  const deci = Math.floor(ms / 100) % 10;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + deci;
}

export function fmtDate(iso, now = new Date()) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'Hoje às ' + time;
  return d.toLocaleDateString('pt-BR') + ' ' + time;
}

export function fmtTimeOfDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* Escapa para conteúdo E atributos HTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/* JSON com chaves ordenadas: permite comparar conteúdos independente da ordem
   (o jsonb do Postgres reordena as chaves). */
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(x => stableStringify(x === undefined ? null : x)).join(',') + ']';
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

/* Hash curto e determinístico (FNV-1a 32 bits) — usado para gerar IDs estáveis
   na migração de dados antigos, iguais em todos os aparelhos. */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function uid(prefix) {
  const c = globalThis.crypto;
  let id;
  if (c && typeof c.randomUUID === 'function') {
    id = c.randomUUID();
  } else if (c && typeof c.getRandomValues === 'function') {
    // randomUUID só existe em contexto seguro (https/localhost)
    const b = c.getRandomValues(new Uint8Array(16));
    id = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  } else {
    id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  return prefix ? prefix + '_' + id : id;
}

/* Nome de arquivo seguro, preservando acentos. */
export function safeFilename(name, fallback = 'CronoAnalise') {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return s || fallback;
}

export function autoStudyName(date = new Date()) {
  return 'Estudo_' + date.toLocaleString('pt-BR').replace(/[/,: ]/g, '-');
}
