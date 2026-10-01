/* Dashboard: visão geral e lista de estudos. */

import { FIELD_LABELS } from './config.js';
import * as storage from './storage.js';
import { countCycles } from './core/stats.js';
import { uniqueCopyName } from './core/model.js';
import { toBR, fmtDate, escapeHtml, uid } from './core/format.js';
import * as T from './core/timer.js';
import { $, showToast } from './ui.js';

let requestSync = () => {};
let onForget = () => {};

export function initDashboard(opts) {
  requestSync = opts.requestSync || requestSync;
  onForget = opts.onForget || onForget;
  $('dashSearch').addEventListener('input', renderDashboard);
  $('dashSort').addEventListener('change', renderDashboard);
}

const ts = iso => { const t = Date.parse(iso); return isNaN(t) ? 0 : t; };

export function renderDashboard() {
  if (!storage.getUser()) return;
  const studies = storage.listStudies();
  const timers = storage.getTimers();
  const q = ($('dashSearch').value || '').toLowerCase().trim();
  const sort = $('dashSort').value;

  let list = studies;
  if (q) {
    list = list.filter(s =>
      [s.name, s.process, s.operator, s.observer].some(v => (v || '').toLowerCase().includes(q)));
  }
  list = list.slice().sort((a, b) => {
    if (sort === 'az') return a.name.localeCompare(b.name, 'pt-BR');
    if (sort === 'oldest') return ts(a.createdAt) - ts(b.createdAt);
    if (sort === 'modified') return ts(b.updatedAt) - ts(a.updatedAt);
    return ts(b.createdAt) - ts(a.createdAt);
  });

  let totalRecords = 0, totalTime = 0, lastModified = null;
  studies.forEach(s => {
    totalRecords += s.records.length;
    totalTime += s.records.reduce((a, r) => a + (Number(r.time) || 0), 0);
    if (!lastModified || ts(s.updatedAt) > ts(lastModified.updatedAt)) lastModified = s;
  });
  $('dashKpis').innerHTML =
    kpi('Total de Estudos', String(studies.length)) +
    kpi('Total de Registros', String(totalRecords)) +
    kpi('Tempo Total Registrado', toBR(totalTime) + 's') +
    kpi('Último Estudo Modificado', lastModified ? escapeHtml(lastModified.name) : '—', true);

  const wrap = $('studyCards');
  if (!list.length) {
    wrap.innerHTML = '<p class="empty">' + (q ? 'Nenhum estudo encontrado para essa pesquisa.' : 'Nenhum estudo ainda. Crie um novo estudo para começar.') + '</p>';
    return;
  }
  wrap.innerHTML = list.map(s => {
    const t = timers[s.id];
    let badge = '';
    if (t && t.running) badge = '<span class="timer-badge" title="Cronômetro rodando">⏱ Em andamento</span>';
    else if (t && !T.isIdle(t)) badge = '<span class="timer-badge paused" title="Cronômetro pausado">⏸ Pausado</span>';
    return '<div class="study-card" data-id="' + escapeHtml(s.id) + '">' +
      '<div class="study-card-head"><b>' + escapeHtml(s.name) + '</b>' + badge + '</div>' +
      '<div class="study-card-meta">' +
        (s.process ? '<span>' + FIELD_LABELS.process + ': ' + escapeHtml(s.process) + '</span>' : '') +
        (s.operator ? '<span>' + FIELD_LABELS.operator + ': ' + escapeHtml(s.operator) + '</span>' : '') +
        (s.observer ? '<span>' + FIELD_LABELS.observer + ': ' + escapeHtml(s.observer) + '</span>' : '') +
        '<span>Criado: ' + fmtDate(s.createdAt) + '</span>' +
        '<span>Últ. edição: ' + fmtDate(s.updatedAt) + '</span>' +
        '<span>' + s.records.length + ' registros · ' + countCycles(s) + ' ciclos</span>' +
      '</div>' +
      '<div class="study-card-actions">' +
        '<button type="button" class="cta" data-action="open-study">Abrir</button>' +
        '<button type="button" data-action="duplicate-study">Duplicar</button>' +
        '<button type="button" class="danger" data-action="delete-study">Excluir</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function kpi(label, value, small) {
  return '<div class="kpi"><span class="kpi-label">' + label + '</span><span class="kpi-val' + (small ? ' small' : '') + '">' + value + '</span></div>';
}

export function duplicateStudy(id) {
  const s = storage.getStudy(id);
  if (!s) return;
  const clone = JSON.parse(JSON.stringify(s));
  const now = new Date().toISOString();
  clone.id = uid('study');
  clone.createdAt = now;
  clone.updatedAt = now;
  clone.history = [{ ts: now, text: 'Estudo duplicado de "' + s.name + '"' }];
  clone.name = uniqueCopyName(s.name, storage.listStudies().map(x => x.name));
  storage.putStudy(clone);
  requestSync();
  renderDashboard();
  showToast('Estudo duplicado');
}

export function deleteStudy(id) {
  const s = storage.getStudy(id);
  if (!s) return;
  if (!confirm('Excluir permanentemente o estudo "' + s.name + '"? Esta ação não pode ser desfeita.')) return;
  storage.removeStudy(id);
  onForget(id);
  requestSync();
  renderDashboard();
  showToast('Estudo excluído');
}
