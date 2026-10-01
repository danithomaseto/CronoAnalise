/* Editor — linha do tempo e versões anteriores salvas no servidor. */

import * as storage from './storage.js';
import { listVersions, getVersion } from './cloud.js';
import { normalizeStudy, MERGE_FIELDS } from './core/model.js';
import { fmtDate, escapeHtml } from './core/format.js';
import { $, showToast } from './ui.js';
import { S, persist, renderAll, nowIso } from './editor.js';

export function init() {
  $('versionsList').addEventListener('click', e => {
    const btn = e.target.closest('[data-version]');
    if (btn) restore(Number(btn.dataset.version), btn.dataset.date);
  });
}

export function render() {
  if (!S.current) return;
  const el = $('historyTimeline');
  const hist = S.current.history || [];
  el.innerHTML = hist.length
    ? hist.slice().reverse().map(h =>
      '<div class="history-item"><div class="history-time">' + fmtDate(h.ts) + '</div><div class="history-text">' + escapeHtml(h.text) + '</div></div>'
    ).join('')
    : '<p class="empty">Sem eventos registrados ainda.</p>';
  const rows = storage.getSyncMeta().mode === 'rows';
  $('versionsPanel').hidden = !rows || S.unsaved;
  if (!rows) $('versionsList').innerHTML = '';
}

export async function loadVersions() {
  if (!S.current) return;
  const list = $('versionsList');
  list.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    const versions = await listVersions(S.current.id);
    if (!versions.length) {
      list.innerHTML = '<p class="empty">Nenhuma versão anterior ainda. O servidor guarda uma versão a cada 10 minutos de edição (por 90 dias).</p>';
      return;
    }
    list.innerHTML = versions.map(v =>
      '<div class="history-item"><div class="history-time">' + fmtDate(v.saved_at) + '</div>' +
      '<div class="history-text">' + escapeHtml(v.name || '') + ' · ' + (v.records || 0) + ' registros</div>' +
      (S.readonly ? '' : '<button type="button" class="version-btn" data-version="' + Number(v.id) + '" data-date="' + escapeHtml(fmtDate(v.saved_at)) + '">Restaurar</button>') +
      '</div>'
    ).join('');
  } catch (e) {
    list.innerHTML = '<p class="empty">Não foi possível carregar as versões: ' + escapeHtml(e.message || String(e)) + '</p>';
  }
}

/* Restaura uma versão: ela vira a versão atual (com datas novas, para vencer a
   mesclagem em todos os aparelhos); o que não existia nela é marcado como excluído. */
async function restore(versionId, dateLabel) {
  if (!S.current || S.readonly) return;
  if (!confirm('Restaurar o estudo para a versão de ' + dateLabel + '? O estado atual continua guardado nas versões do servidor.')) return;
  try {
    const v = await getVersion(versionId);
    if (!v) { showToast('Versão não encontrada'); return; }
    const t = nowIso();
    const old = S.current;
    const data = normalizeStudy({ ...v.data, id: old.id }, { id: old.id });
    const keepIds = new Set(data.records.map(r => r.id));
    const keepStages = new Set(data.stages.map(s => s.id));
    const restored = {
      ...data,
      id: old.id,
      createdAt: old.createdAt,
      fieldTs: Object.fromEntries(MERGE_FIELDS.map(f => [f, t])),
      stages: data.stages.map(s => ({ ...s, u: t })),
      records: data.records.map(r => ({ ...r, u: t })),
      deletedStages: { ...(data.deletedStages || {}) },
      deletedRecords: { ...(data.deletedRecords || {}) },
      history: [...old.history, { ts: t, text: 'Restaurado para a versão de ' + dateLabel }]
    };
    old.records.forEach(r => { if (!keepIds.has(r.id)) restored.deletedRecords[r.id] = t; });
    old.stages.forEach(s => { if (!keepStages.has(s.id)) restored.deletedStages[s.id] = t; });
    keepIds.forEach(id => { delete restored.deletedRecords[id]; });
    keepStages.forEach(id => { delete restored.deletedStages[id]; });
    S.current = restored;
    persist();
    renderAll();
    showToast('Versão restaurada');
  } catch (e) {
    showToast('Não foi possível restaurar: ' + (e.message || e));
  }
}
