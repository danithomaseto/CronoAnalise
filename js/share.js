/* Compartilhamento de estudos (depende da migração 002 no banco). */

import * as storage from './storage.js';
import { listShares, addShare, removeShare } from './cloud.js';
import { escapeHtml } from './core/format.js';
import { $, openModal, showToast } from './ui.js';

let studyId = null;
let pushStudyNow = async () => {};
let myEmail = '';

export function initShare(opts) {
  pushStudyNow = opts.pushStudyNow;
  $('shareForm').addEventListener('submit', e => { e.preventDefault(); add(); });
  $('shareList').addEventListener('click', e => {
    const btn = e.target.closest('[data-unshare]');
    if (btn) unshare(btn.dataset.unshare);
  });
  $('shareList').addEventListener('change', e => {
    const sel = e.target.closest('select[data-role-for]');
    if (sel) changeRole(sel.dataset.roleFor, sel.value);
  });
}

export function setMyEmail(email) {
  myEmail = String(email || '').toLowerCase();
}

export function canShare(id) {
  return storage.getSyncMeta().mode === 'rows' && storage.isOwner(id);
}

export async function openShare(study) {
  studyId = study.id;
  $('shareStudyName').textContent = study.name;
  $('shareError').textContent = '';
  $('shareEmail').value = '';
  const rows = storage.getSyncMeta().mode === 'rows';
  $('shareUnavailable').hidden = rows;
  $('shareForm').hidden = !rows;
  $('shareList').hidden = !rows;
  openModal('shareModal', { focus: rows ? 'shareEmail' : null });
  if (rows) await load();
}

async function load() {
  const list = $('shareList');
  list.innerHTML = '<p class="empty">Carregando…</p>';
  try {
    const shares = await listShares(studyId);
    list.innerHTML = shares.length
      ? '<table class="summary-table"><thead><tr><th>E-mail</th><th>Acesso</th><th></th></tr></thead><tbody>' +
        shares.map(s =>
          '<tr><td>' + escapeHtml(s.email) + '</td>' +
          '<td><select data-role-for="' + escapeHtml(s.email) + '" aria-label="Acesso de ' + escapeHtml(s.email) + '">' +
            '<option value="viewer"' + (s.role === 'viewer' ? ' selected' : '') + '>Ver</option>' +
            '<option value="editor"' + (s.role === 'editor' ? ' selected' : '') + '>Editar</option></select></td>' +
          '<td><button type="button" class="danger" data-unshare="' + escapeHtml(s.email) + '">Remover</button></td></tr>'
        ).join('') + '</tbody></table>'
      : '<p class="empty">Ainda não compartilhado com ninguém.</p>';
  } catch (e) {
    list.innerHTML = '<p class="empty">Não foi possível carregar: ' + escapeHtml(e.message || String(e)) + '</p>';
  }
}

async function add() {
  const email = $('shareEmail').value.trim().toLowerCase();
  const role = $('shareRole').value;
  const err = $('shareError');
  err.textContent = '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.textContent = 'Digite um e-mail válido.'; return; }
  if (email === myEmail) { err.textContent = 'Você já é o dono deste estudo.'; return; }
  const btn = $('shareForm').querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await pushStudyNow(studyId);    // garante que o estudo já está na nuvem
    await addShare(studyId, email, role);
    $('shareEmail').value = '';
    showToast('Compartilhado com ' + email + (role === 'editor' ? ' (pode editar)' : ' (somente leitura)'));
    await load();
  } catch (e) {
    err.textContent = 'Não foi possível compartilhar: ' + (e.message || e);
  } finally {
    btn.disabled = false;
  }
}

async function changeRole(email, role) {
  try {
    await addShare(studyId, email, role);
    showToast('Acesso de ' + email + ' atualizado');
  } catch (e) {
    showToast('Não foi possível alterar: ' + (e.message || e));
    await load();
  }
}

async function unshare(email) {
  if (!confirm('Remover o acesso de ' + email + ' a este estudo?')) return;
  try {
    await removeShare(studyId, email);
    showToast('Acesso removido');
    await load();
  } catch (e) {
    showToast('Não foi possível remover: ' + (e.message || e));
  }
}

/* Convidado sai de um estudo compartilhado com ele. */
export async function leaveShare(id, onDone) {
  const s = storage.getStudy(id);
  if (!s) return;
  if (!confirm('Sair do estudo compartilhado "' + s.name + '"? Ele some da sua lista (o dono continua com ele).')) return;
  try {
    await removeShare(id, myEmail);
  } catch (e) {
    showToast('Não foi possível sair agora: ' + (e.message || e));
    return;
  }
  storage.dropLocal(id);
  showToast('Você saiu do estudo compartilhado');
  if (onDone) onDone();
}
