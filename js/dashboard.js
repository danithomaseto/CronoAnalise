/* Dashboard: visão geral e lista de estudos. */

import { FIELD_LABELS } from './config.js';
import * as storage from './storage.js';
import { countCycles, computeStats } from './core/stats.js';
import { samplingStats } from './core/sampling.js';
import { cachedTeams, teamsOfStudy } from './teams.js';
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
  $('dashFilter').addEventListener('change', renderDashboard);
}

/* Filtro: todos, meus, compartilhados comigo ou um time (painel do time). */
function renderFilterOptions() {
  const sel = $('dashFilter');
  const cur = sel.value || 'all';
  const teams = cachedTeams();
  sel.innerHTML = '<option value="all">Todos os estudos</option><option value="mine">Meus estudos</option><option value="shared">Compartilhados comigo</option>' +
    (teams.length ? '<optgroup label="Painel do time">' + teams.map(t => '<option value="team:' + escapeHtml(t.id) + '">🏢 ' + escapeHtml(t.name) + '</option>').join('') + '</optgroup>' : '');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : 'all';
  return sel.value;
}

const ts = iso => { const t = Date.parse(iso); return isNaN(t) ? 0 : t; };

export function renderDashboard() {
  if (!storage.getUser()) return;
  const all = storage.listStudies();
  const timers = storage.getTimers();
  const q = ($('dashSearch').value || '').toLowerCase().trim();
  const sort = $('dashSort').value;
  const filter = renderFilterOptions();
  const teamId = filter.startsWith('team:') ? filter.slice(5) : null;
  const team = teamId ? cachedTeams().find(t => t.id === teamId) : null;
  const studies = all.filter(s => {
    const owner = storage.getAccess(s.id).role === 'owner';
    if (filter === 'mine') return owner;
    if (filter === 'shared') return !owner;
    if (teamId) return teamsOfStudy(s.id).includes(teamId);
    return true;
  });

  let list = studies;
  if (q) {
    list = list.filter(s =>
      [s.name, s.process, s.operator, s.observer, storage.getAccess(s.id).ownerEmail].some(v => (v || '').toLowerCase().includes(q)));
  }
  list = list.slice().sort((a, b) => {
    if (sort === 'az') return a.name.localeCompare(b.name, 'pt-BR');
    if (sort === 'oldest') return ts(a.createdAt) - ts(b.createdAt);
    if (sort === 'modified') return ts(b.updatedAt) - ts(a.updatedAt);
    return ts(b.createdAt) - ts(a.createdAt);
  });

  let totalRecords = 0, totalTime = 0, lastModified = null, totalObs = 0;
  studies.forEach(s => {
    totalRecords += s.records.length;
    totalObs += (s.observations || []).length;
    totalTime += s.records.reduce((a, r) => a + (r.interruption ? 0 : Number(r.time) || 0), 0);
    if (!lastModified || ts(s.updatedAt) > ts(lastModified.updatedAt)) lastModified = s;
  });
  let kpis =
    kpi('Total de Estudos', String(studies.length)) +
    kpi('Total de Registros', String(totalRecords)) +
    kpi('Tempo Total Registrado', toBR(totalTime) + 's') +
    kpi('Último Estudo Modificado', lastModified ? escapeHtml(lastModified.name) : '—', true);
  if (totalObs) kpis += kpi('Observações (amostragem)', String(totalObs));
  if (team) {
    // painel do time: médias dos estudos do time
    const prefs = storage.getPrefs();
    const time = studies.filter(s => s.kind !== 'sampling' && s.records.length).map(s => computeStats(s, prefs));
    const samp = studies.filter(s => s.kind === 'sampling' && (s.observations || []).length).map(s => samplingStats(s, prefs));
    const avg = arr => arr.reduce((a, v) => a + v, 0) / (arr.length || 1);
    if (time.length) kpis += kpi('% Valor Agregado médio', toBR(avg(time.map(x => x.vaPct)), 1) + '%');
    if (samp.length) kpis += kpi('% Produtivo médio', toBR(avg(samp.map(x => x.productivePct)), 1) + '%');
    kpis += kpi('Pessoas no time', String(team.members || 1));
  }
  $('dashKpisTitle').textContent = team ? 'Painel do time — ' + team.name : filter === 'mine' ? 'Visão Geral — meus estudos' : filter === 'shared' ? 'Visão Geral — compartilhados comigo' : 'Visão Geral';
  $('dashKpis').innerHTML = kpis;
  $('btnCompare').disabled = all.filter(s => s.kind !== 'sampling').length < 2;

  const wrap = $('studyCards');
  if (!list.length) {
    wrap.innerHTML = '<p class="empty">' + (q ? 'Nenhum estudo encontrado para essa pesquisa.' : team ? 'Nenhum estudo compartilhado com este time ainda (👥 Compartilhar, no menu do estudo).' : filter !== 'all' ? 'Nenhum estudo neste filtro.' : 'Nenhum estudo ainda. Crie um novo estudo para começar.') + '</p>';
    return;
  }
  wrap.innerHTML = list.map(s => {
    const t = timers[s.id];
    const acc = storage.getAccess(s.id);
    const owner = acc.role === 'owner';
    let badge = '';
    if (t && t.running) badge = '<span class="timer-badge" title="Cronômetro rodando">⏱ Em andamento</span>';
    else if (t && !T.isIdle(t)) badge = '<span class="timer-badge paused" title="Cronômetro pausado">⏸ Pausado</span>';
    const shared = owner ? '' :
      '<span class="share-badge">👥 ' + (acc.role === 'viewer' ? 'Somente leitura' : 'Pode editar') + ' · ' + escapeHtml(acc.ownerEmail || 'compartilhado') + '</span>';
    const teamNames = teamsOfStudy(s.id).map(id => (cachedTeams().find(t => t.id === id) || {}).name).filter(Boolean);
    const teamBadge = teamNames.length ? '<span class="share-badge">🏢 ' + escapeHtml(teamNames.join(', ')) + '</span>' : '';
    const sampling = s.kind === 'sampling';
    const count = sampling
      ? (s.observations || []).length + ' observações'
      : s.records.length + ' registros · ' + countCycles(s) + ' ciclos';
    return '<div class="study-card' + (sampling ? ' kind-sampling' : '') + '" data-id="' + escapeHtml(s.id) + '">' +
      '<div class="study-card-head"><b>' + escapeHtml(s.name) + '</b>' + badge + '</div>' +
      (sampling ? '<span class="kind-badge">🎲 Amostragem do trabalho</span>' : '') +
      shared + teamBadge +
      '<div class="study-card-meta">' +
        (s.process ? '<span>' + FIELD_LABELS.process + ': ' + escapeHtml(s.process) + '</span>' : '') +
        (s.operator ? '<span>' + FIELD_LABELS.operator + ': ' + escapeHtml(s.operator) + '</span>' : '') +
        (s.observer ? '<span>' + FIELD_LABELS.observer + ': ' + escapeHtml(s.observer) + '</span>' : '') +
        '<span>Criado: ' + fmtDate(s.createdAt) + '</span>' +
        '<span>Últ. edição: ' + fmtDate(s.updatedAt) + '</span>' +
        '<span>' + count + '</span>' +
      '</div>' +
      '<div class="study-card-actions">' +
        '<button type="button" class="cta" data-action="open-study">Abrir</button>' +
        '<button type="button" data-action="template-study" title="Novo estudo com as mesmas etapas e parâmetros, sem os registros">Modelo</button>' +
        '<button type="button" data-action="duplicate-study" title="Cópia completa, com os registros">Duplicar</button>' +
        (owner
          ? '<button type="button" class="danger" data-action="delete-study">Excluir</button>'
          : '<button type="button" class="danger" data-action="leave-study">Sair</button>') +
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
  delete clone.fieldTs;
  delete clone.deletedRecords;
  delete clone.deletedStages;
  delete clone.deletedCategories;
  delete clone.deletedObservations;
  // as fotos ficam no estudo original (o acesso a elas segue o estudo)
  clone.records.forEach(r => { delete r.photos; });
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
