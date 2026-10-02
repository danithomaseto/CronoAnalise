/* Times (migração 003): criar time, adicionar pessoas, sair/excluir, e um
   cache local (times + quais estudos cada time recebeu) para o filtro e o
   painel do time no dashboard — funciona offline com o último cache. */

import * as storage from './storage.js';
import { listTeams, createTeam, deleteTeam, addTeamMember, removeTeamMember, listTeamShares, isMissing } from './cloud.js';
import { escapeHtml } from './core/format.js';
import { $, openModal, showToast } from './ui.js';

let me = { id: null, email: '' };
let teams = [];
let selected = null;
let onChange = () => {};

export function initTeams(opts) {
  onChange = opts.onChange || onChange;
  $('teamForm').addEventListener('submit', e => { e.preventDefault(); create(); });
  $('memberForm').addEventListener('submit', e => { e.preventDefault(); addMember(); });
  $('teamsList').addEventListener('click', e => {
    const b = e.target.closest('[data-team]');
    if (b) select(b.dataset.team);
  });
  $('membersList').addEventListener('click', e => {
    const b = e.target.closest('[data-member-remove]');
    if (b) removeMember(b.dataset.memberRemove);
  });
  $('membersList').addEventListener('change', e => {
    const s = e.target.closest('select[data-member-role]');
    if (s) changeRole(s.dataset.memberRole, s.value);
  });
}

export function setMe(id, email) {
  me = { id, email: String(email || '').toLowerCase() };
  teams = [];
  selected = null;
}

const roleOf = t => (t.owner_id === me.id ? 'owner' : ((t.members.find(m => m.email === me.email) || {}).role || null));
const roleName = r => ({ owner: 'Dono', manager: 'Gestor', member: 'Integrante' })[r] || '';

export function cachedTeams() {
  const c = storage.getSyncMeta().teamsCache;
  return (c && c.teams) || [];
}

export function teamsOfStudy(studyId) {
  const c = storage.getSyncMeta().teamsCache;
  return (c && c.studyTeams && c.studyTeams[studyId]) || [];
}

/* Atualiza o cache (chamado após sincronizar e ao mexer nos times). */
export async function refreshTeamsCache() {
  if (!me.id || storage.getSyncMeta().mode !== 'rows') return false;
  try {
    teams = await listTeams(me.id);
    const shares = await listTeamShares();
    const studyTeams = {};
    shares.forEach(s => { (studyTeams[s.study_id] = studyTeams[s.study_id] || []).push(s.team_id); });
    const cache = { teams: teams.map(t => ({ id: t.id, name: t.name, role: roleOf(t), members: t.members.length + 1 })), studyTeams };
    const changed = JSON.stringify(cache) !== JSON.stringify(storage.getSyncMeta().teamsCache);
    storage.setSyncMeta({ teamsCache: cache, teams: true });
    if (changed) onChange();
    return true;
  } catch (e) {
    if (isMissing(e)) storage.setSyncMeta({ teams: false, teamsCache: null });
    else console.warn('Times não atualizados:', e);
    return false;
  }
}

export async function openTeams() {
  $('teamsError').textContent = '';
  $('teamName').value = '';
  const rows = storage.getSyncMeta().mode === 'rows';
  openModal('teamsModal', { focus: 'teamName' });
  const ok = rows && await refreshTeamsCache();
  const available = ok || storage.getSyncMeta().teams;
  $('teamsUnavailable').hidden = !!available;
  $('teamForm').hidden = !available;
  renderList();
}

function renderList() {
  const el = $('teamsList');
  el.innerHTML = teams.length
    ? teams.map(t => '<div class="team-item' + (t.id === selected ? ' active' : '') + '"><span><b>' + escapeHtml(t.name) + '</b> <small>· ' + roleName(roleOf(t)) +
        ' · ' + (t.members.length + 1) + ' pessoa(s)</small></span><button type="button" data-team="' + escapeHtml(t.id) + '">Gerenciar</button></div>').join('')
    : '<p class="empty">Você ainda não participa de nenhum time.</p>';
  renderDetail();
}

function select(id) {
  selected = selected === id ? null : id;
  $('memberError').textContent = '';
  renderList();
}

function renderDetail() {
  const t = teams.find(x => x.id === selected);
  $('teamDetail').hidden = !t;
  if (!t) return;
  const role = roleOf(t);
  const manage = role === 'owner' || role === 'manager';
  $('teamDetailName').textContent = t.name;
  $('memberForm').hidden = !manage;
  $('btnTeamDelete').hidden = role !== 'owner';
  $('btnTeamLeave').hidden = role === 'owner';
  $('membersList').innerHTML = '<table class="summary-table"><thead><tr><th>Pessoa</th><th>Papel</th><th></th></tr></thead><tbody>' +
    '<tr><td>' + (t.owner_id === me.id ? escapeHtml(me.email) + ' (você)' : 'dono do time') + '</td><td>Dono</td><td></td></tr>' +
    t.members.map(m => '<tr><td>' + escapeHtml(m.email) + (m.email === me.email ? ' (você)' : '') + '</td><td>' +
      (manage ? '<select data-member-role="' + escapeHtml(m.email) + '" aria-label="Papel de ' + escapeHtml(m.email) + '">' +
        '<option value="member"' + (m.role === 'member' ? ' selected' : '') + '>Integrante</option>' +
        '<option value="manager"' + (m.role === 'manager' ? ' selected' : '') + '>Gestor</option></select>' : roleName(m.role)) +
      '</td><td>' + (manage ? '<button type="button" class="danger icon-btn" data-member-remove="' + escapeHtml(m.email) + '" title="Remover do time" aria-label="Remover ' + escapeHtml(m.email) + ' do time">✕<span class="rm-label" aria-hidden="true">Remover</span></button>' : '') + '</td></tr>').join('') +
    '</tbody></table>';
}

async function create() {
  const name = $('teamName').value.trim();
  const err = $('teamsError');
  err.textContent = '';
  if (!name) { $('teamName').focus(); return; }
  try {
    const t = await createTeam(name);
    $('teamName').value = '';
    selected = t ? t.id : null;
    await refreshTeamsCache();
    renderList();
    showToast('Time "' + name + '" criado — adicione as pessoas');
    if (selected) $('memberEmail').focus();
  } catch (e) {
    err.textContent = 'Não foi possível criar o time: ' + (e.message || e);
  }
}

async function addMember() {
  const t = teams.find(x => x.id === selected);
  const email = $('memberEmail').value.trim().toLowerCase();
  const err = $('memberError');
  err.textContent = '';
  if (!t) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Digite um e-mail válido.'; return; }
  try {
    await addTeamMember(t.id, email, $('memberRole').value);
    $('memberEmail').value = '';
    await refreshTeamsCache();
    renderList();
    showToast(email + ' adicionado(a) ao time');
  } catch (e) {
    err.textContent = 'Não foi possível adicionar: ' + (e.message || e);
  }
}

async function changeRole(email, role) {
  try {
    await addTeamMember(selected, email, role);
    await refreshTeamsCache();
    showToast('Papel de ' + email + ' atualizado');
  } catch (e) {
    showToast('Não foi possível alterar: ' + (e.message || e));
  }
  renderList();
}

async function removeMember(email) {
  if (!confirm('Remover ' + email + ' do time? A pessoa perde acesso aos estudos compartilhados com o time.')) return;
  try {
    await removeTeamMember(selected, email);
    await refreshTeamsCache();
    renderList();
  } catch (e) {
    showToast('Não foi possível remover: ' + (e.message || e));
  }
}

export async function leaveSelected() {
  const t = teams.find(x => x.id === selected);
  if (!t || !confirm('Sair do time "' + t.name + '"? Você perde acesso aos estudos compartilhados com ele.')) return;
  try {
    await removeTeamMember(t.id, me.email);
    selected = null;
    await refreshTeamsCache();
    renderList();
    showToast('Você saiu do time');
  } catch (e) {
    showToast('Não foi possível sair: ' + (e.message || e));
  }
}

export async function deleteSelected() {
  const t = teams.find(x => x.id === selected);
  if (!t || !confirm('Excluir o time "' + t.name + '"? Os estudos continuam com os donos; só o acesso pelo time acaba.')) return;
  try {
    await deleteTeam(t.id);
    selected = null;
    await refreshTeamsCache();
    renderList();
    showToast('Time excluído');
  } catch (e) {
    showToast('Não foi possível excluir: ' + (e.message || e));
  }
}
