/* Ponto de entrada: autenticação, navegação, ações da interface e atalhos. */

import { APP_VERSION, BRAND, CREDIT } from './config.js';
import * as storage from './storage.js';
import {
  sb, createSync, logActivity, checkIsAdmin, adminStats, deleteAccount, insertClientErrors,
  listClientErrors, clearClientErrors, purgeOldData, removeStudyPhotos, isMissing
} from './cloud.js';
import * as auth from './auth.js';
import * as editor from './editor.js';
import * as timer from './editor-timer.js';
import * as stagesUI from './editor-stages.js';
import * as recordsUI from './editor-records.js';
import * as samplingUI from './editor-sampling.js';
import * as historyUI from './editor-history.js';
import * as photos from './photos.js';
import * as teams from './teams.js';
import { initMonitor, setSender, reportError } from './monitor.js';
import { uploadToOneDrive, canShareFiles, shareFile, GRAPH_SCOPE } from './integrations.js';
import { initDashboard, renderDashboard, duplicateStudy, deleteStudy } from './dashboard.js';
import { initShare, openShare, canShare, leaveShare, setMyEmail } from './share.js';
import { initCompare, openCompare } from './compare.js';
import { normalizeStore, mergeStores } from './core/model.js';
import { escapeHtml, fmtDate } from './core/format.js';
import * as T from './core/timer.js';
import {
  $, showToast, openModal, closeModal, isModalOpen, initModals, initMenu, toggleMenu, closeMenu,
  applyThemeUI, toggleTheme, downloadFile, setSyncStatus, setSyncTime
} from './ui.js';

const LAST_ACTIVE_KEY = 'cronoanalise:lastActive';
const PENDING_ONEDRIVE_KEY = 'cronoanalise:pendingOneDrive';
const IDLE_WARN_S = 60;

let currentUser = null;
let activeUserId = null;
let activityLoggedFor = null;
let lastFocusPull = 0;
let isAdmin = false;
let mfaPending = false;
let mfaEnrollId = null;
let idleTimer = null;
let idleCountdown = null;
let photoTimer = null;
let teamsRefreshedAt = 0;

const sync = createSync({
  onStatus: status => {
    setSyncStatus(status);
    renderSyncTime();
    if (status === 'saved') schedulePhotoUpload();
  },
  onMerged: () => refreshViews(),
  onMode: () => updateShareButton(),
  onLive: live => { $('liveBadge').hidden = !live; }
});

function isEditorView() {
  return document.body.classList.contains('view-editor');
}

function refreshViews() {
  if (isEditorView()) editor.applyExternalUpdate();
  else renderDashboard();
  updateShareButton();
}

function renderSyncTime() {
  const cur = editor.getCurrent();
  if (isEditorView() && cur && !editor.isUnsaved()) {
    setSyncTime('Última edição: ' + fmtDate(cur.updatedAt));
  } else {
    const m = storage.getUser() ? storage.getSyncMeta() : null;
    setSyncTime(m && m.lastSyncAt ? 'Sincronizado: ' + fmtDate(m.lastSyncAt) : '');
  }
}

function updateShareButton() {
  const cur = editor.getCurrent();
  $('btnShare').hidden = !(cur && !editor.isUnsaved() && canShare(cur.id));
}

const cloudReady = () => !!activeUserId && storage.getSyncMeta().mode === 'rows' && navigator.onLine !== false;

function schedulePhotoUpload() {
  clearTimeout(photoTimer);
  photoTimer = setTimeout(() => photos.uploadPending(), 500);
}

/* ---------- Navegação ---------- */
function setView(view) {
  document.body.classList.toggle('view-editor', view === 'editor');
  document.body.classList.toggle('view-dashboard', view !== 'editor');
  window.scrollTo(0, 0);
}

function saveSession() {
  const cur = editor.getCurrent();
  storage.setSession({
    view: isEditorView() ? 'editor' : 'dashboard',
    studyId: cur ? cur.id : null,
    field: document.body.classList.contains('field')
  });
}

function maybeRefreshTeams() {
  if (!activeUserId || Date.now() - teamsRefreshedAt < 120000) return;
  teamsRefreshedAt = Date.now();
  teams.refreshTeamsCache();
}

function showDashboard() {
  editor.close();
  setView('dashboard');
  setFieldMode(false);
  maybeRefreshTeams();
  renderDashboard();
  renderSyncTime();
  updateShareButton();
  saveSession();
}

function openStudyView(id) {
  if (!editor.openStudy(id)) return false;
  setView('editor');
  editor.showTab('crono');
  renderSyncTime();
  updateShareButton();
  saveSession();
  return true;
}

function newStudyView(templateId, kind) {
  const tpl = templateId ? storage.getStudy(templateId) : null;
  editor.newStudy(tpl, kind);
  setView('editor');
  editor.showTab('crono');
  renderSyncTime();
  updateShareButton();
  saveSession();
  if (tpl) showToast('Novo estudo criado a partir de "' + tpl.name + '"');
}

function setFieldMode(on) {
  document.body.classList.toggle('field', on);
  const btn = $('btnField');
  btn.textContent = on ? 'Sair do Modo Campo' : 'Modo Campo';
  btn.classList.toggle('active', on);
  editor.fieldModeChanged(on);
}

function restoreView() {
  const sess = storage.getSession();
  if (sess && sess.view === 'editor' && sess.studyId && storage.getStudy(sess.studyId)) {
    openStudyView(sess.studyId);
    if (sess.field) setFieldMode(true);
    const t = storage.getTimer(sess.studyId);
    if (t && !T.isIdle(t)) showToast(t.running ? 'Cronometragem em andamento restaurada ⏱' : 'Cronometragem pausada restaurada');
    return;
  }
  showDashboard();
}

/* ---------- Tela de login (marca configurável) ---------- */
function applyBrand() {
  $('loginTitle').textContent = BRAND.title;
  $('msLabel').textContent = BRAND.microsoftLabel;
  $('btnMicrosoft').hidden = !BRAND.microsoftLogin;
  $('loginFooter').textContent = BRAND.footer;
  $('loginCredit').textContent = CREDIT;
  $('appCredit').textContent = CREDIT;
  if (BRAND.logo) {
    const img = document.createElement('img');
    img.src = BRAND.logo;
    img.alt = BRAND.title;
    $('loginBrand').replaceChildren(img);
  }
}

/* ---------- Autenticação ---------- */
function setAuthError(msg) { $('authError').textContent = msg || ''; }
function setAuthMsg(msg) { $('authMsg').textContent = msg || ''; }

function authCredentials() {
  const email = $('authEmail').value.trim();
  const pass = $('authPass').value;
  if (!email || !pass) { setAuthError('Preencha e-mail e senha.'); return null; }
  return { email, pass };
}

async function withBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } finally { if (btn) btn.disabled = false; }
}

async function doSignIn(btn) {
  setAuthError(''); setAuthMsg('');
  const c = authCredentials();
  if (!c) return;
  const err = await withBusy(btn, () => auth.signIn(c.email, c.pass));
  if (err) setAuthError(err);
}

async function doSignUp(btn) {
  setAuthError(''); setAuthMsg('');
  const c = authCredentials();
  if (!c) return;
  if (c.pass.length < 6) { setAuthError('A senha precisa ter pelo menos 6 caracteres.'); return; }
  const res = await withBusy(btn, () => auth.signUp(c.email, c.pass));
  if (res.error) setAuthError(res.error);
  else if (res.needsConfirmation) setAuthMsg('Conta criada! Verifique seu e-mail para confirmar antes de entrar.');
}

async function doForgotPassword(btn) {
  setAuthError(''); setAuthMsg('');
  const email = $('authEmail').value.trim();
  if (!email) { setAuthError('Digite seu e-mail acima para receber o link de redefinição.'); $('authEmail').focus(); return; }
  const err = await withBusy(btn, () => auth.sendPasswordReset(email));
  if (err) setAuthError(err);
  else setAuthMsg('Se o e-mail estiver cadastrado, você vai receber um link para definir uma nova senha.');
}

async function doMicrosoft(btn) {
  setAuthError(''); setAuthMsg('');
  const err = await withBusy(btn, () => auth.signInWithMicrosoft());
  if (err) setAuthError(err);
}

function togglePassword() {
  const input = $('authPass');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('btnShowPass').setAttribute('aria-pressed', String(show));
  $('btnShowPass').setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
}

async function doSignOut() {
  editor.flush();
  if (storage.isDirty()) {
    // tenta enviar o que falta antes de sair (os dados continuam salvos neste aparelho de qualquer forma)
    await Promise.race([sync.syncNow(), new Promise(r => setTimeout(r, 3000))]);
  }
  await storage.flushWrites();
  await auth.signOut();
  if (mfaPending) exitApp(); // ainda na tela do código: sem SIGNED_OUT de usuário ativo
}

async function saveNewPassword() {
  const p1 = $('newPass').value, p2 = $('newPass2').value;
  const errEl = $('recoveryError');
  errEl.textContent = '';
  if (p1.length < 6) { errEl.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
  if (p1 !== p2) { errEl.textContent = 'As senhas não conferem.'; return; }
  const err = await auth.updatePassword(p1);
  if (err) { errEl.textContent = err; return; }
  $('newPass').value = $('newPass2').value = '';
  closeModal();
  showToast('Senha atualizada ✓');
}

/* O Supabase dispara SIGNED_IN também ao voltar para a aba e TOKEN_REFRESHED a cada
   ~1h. Só reage quando o usuário realmente muda. O trabalho é despachado para fora
   do callback, como recomenda a documentação do Supabase. */
function handleAuthEvent(event, session) {
  document.body.classList.remove('booting');
  auth.rememberProviderToken(session);
  const user = session && session.user;
  if (user) {
    currentUser = user;
    if (activeUserId !== user.id) {
      activeUserId = user.id;
      startSession(user, event);
    } else if (event === 'MFA_CHALLENGE_VERIFIED' && mfaPending) {
      finishMfa(user);
    } else if (event === 'PASSWORD_RECOVERY') {
      openModal('recoveryModal', { focus: 'newPass' });
    }
  } else if (activeUserId !== null) {
    exitApp();
  }
}

async function startSession(user, event) {
  // Sessão salva de quem usou o app pela última vez há muito tempo (computador compartilhado)
  if (event === 'INITIAL_SESSION' && idleExpired()) {
    showToast('Sessão encerrada por inatividade. Entre de novo.', 5000);
    await auth.signOut();
    return;
  }
  const mfa = await auth.mfaState().catch(() => ({ needsCode: false }));
  if (activeUserId !== user.id) return;
  if (mfa.needsCode) {
    mfaPending = true;
    $('mfaCode').value = '';
    $('mfaError').textContent = '';
    $('mfaOverlay').hidden = false;
    $('authOverlay').hidden = true;
    setTimeout(() => $('mfaCode').focus(), 0);
    return;
  }
  runEnterApp(user, event);
}

function runEnterApp(user, event) {
  enterApp(user)
    .then(() => {
      if (event === 'PASSWORD_RECOVERY') openModal('recoveryModal', { focus: 'newPass' });
      resumePendingOneDrive();
    })
    .catch(e => { console.error(e); reportError(e, { where: 'enterApp' }); showToast('Erro ao abrir seus estudos: ' + (e && e.message ? e.message : e), 6000); });
}

async function submitMfa() {
  const code = $('mfaCode').value.replace(/\D/g, '');
  if (code.length !== 6) { $('mfaError').textContent = 'Digite os 6 dígitos.'; return; }
  const err = await auth.mfaVerifyLogin(code);
  if (err) { $('mfaError').textContent = err; return; }
  // o evento MFA_CHALLENGE_VERIFIED continua o login (finishMfa)
}

function finishMfa(user) {
  if (!mfaPending) return;
  mfaPending = false;
  $('mfaOverlay').hidden = true;
  $('authOverlay').hidden = false;
  runEnterApp(user, 'SIGNED_IN');
}

async function enterApp(user) {
  $('bootScreen').textContent = 'Carregando seus estudos…';
  document.body.classList.add('booting');
  const { migrated } = await storage.setUser(user.id);
  if (activeUserId !== user.id) return;
  $('userEmail').textContent = user.email;
  setMyEmail(user.email);
  teams.setMe(user.id, user.email);
  document.body.classList.add('authed');
  setAuthError(''); setAuthMsg('');
  $('authPass').value = '';
  touchActivity();
  sync.reset(user.id, user.email);
  photos.resetPhotos();
  setSender(rows => insertClientErrors(rows));
  checkIsAdmin(user).then(v => { isAdmin = v; $('btnAdmin').hidden = !v; });

  if (activityLoggedFor !== user.id) {
    activityLoggedFor = user.id;
    logActivity(user);
  }

  // Dados migrados da versão anterior: espera a 1ª sincronização (até 8 s) para
  // não mostrar, nem por um instante, estudos de outra conta deste navegador.
  const firstPull = !!storage.getSyncMeta().legacyIds;
  if (firstPull && navigator.onLine !== false) {
    $('bootScreen').textContent = 'Sincronizando seus estudos…';
    await Promise.race([sync.syncNow({ pull: true, full: true }), new Promise(r => setTimeout(r, 8000))]);
    if (activeUserId !== user.id) return;
  }
  document.body.classList.remove('booting');
  restoreView();
  const after = () => { if (activeUserId === user.id) { teamsRefreshedAt = Date.now(); teams.refreshTeamsCache(); photos.uploadPending(); } };
  if (!firstPull) sync.syncNow({ pull: true, full: true }).then(after);
  else { after(); if (migrated) showToast('Estudos da versão anterior importados ✓'); }
}

function exitApp() {
  editor.close();
  sync.reset(null);
  setSender(null);
  activeUserId = null;
  currentUser = null;
  isAdmin = false;
  mfaPending = false;
  teamsRefreshedAt = 0;
  storage.setUser(null);
  closeModal();
  closeMenu();
  setFieldMode(false);
  stopIdle();
  document.body.classList.remove('authed');
  $('mfaOverlay').hidden = true;
  $('authOverlay').hidden = false;
  $('liveBadge').hidden = true;
  setView('dashboard');
  $('authPass').value = '';
  $('userEmail').textContent = '';
  $('btnAdmin').hidden = true;
  setSyncTime('');
}

/* ---------- Saída automática por inatividade ---------- */
function idleLimitMs() {
  return (Number(storage.getPrefs().autoLogoutMin) || 0) * 60000;
}

function touchActivity() {
  try { localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now())); } catch (e) { /* ok */ }
  if (!$('idleModal').hidden) cancelIdleWarning();
}

function lastActivity() {
  return Number(localStorage.getItem(LAST_ACTIVE_KEY) || 0);
}

function idleExpired() {
  const limit = idleLimitMs();
  const last = lastActivity();
  return !!limit && !!last && Date.now() - last > limit + IDLE_WARN_S * 1000 && !storage.anyTimerRunning();
}

function checkIdle() {
  const limit = idleLimitMs();
  if (!activeUserId || !limit) return;
  // não sai durante uma cronometragem em andamento (o celular pode ficar parado na mão)
  if (storage.anyTimerRunning()) { touchActivity(); return; }
  if (Date.now() - lastActivity() > limit && $('idleModal').hidden) startIdleWarning();
}

function startIdleWarning() {
  let left = IDLE_WARN_S;
  $('idleCount').textContent = String(left);
  openModal('idleModal', { onClose: () => clearInterval(idleCountdown) });
  clearInterval(idleCountdown);
  idleCountdown = setInterval(() => {
    left--;
    $('idleCount').textContent = String(left);
    if (left <= 0) {
      clearInterval(idleCountdown);
      closeModal();
      showToast('Sessão encerrada por inatividade', 5000);
      doSignOut();
    }
  }, 1000);
}

function cancelIdleWarning() {
  clearInterval(idleCountdown);
  if (!$('idleModal').hidden) closeModal();
}

function startIdle() {
  stopIdle();
  idleTimer = setInterval(checkIdle, 15000);
}

function stopIdle() {
  clearInterval(idleTimer);
  clearInterval(idleCountdown);
  idleTimer = null;
}

/* ---------- Configurações / backup / conta ---------- */
async function openSettings() {
  applyThemeUI();
  const p = storage.getPrefs();
  $('prefConfidence').value = String(p.confidence);
  $('prefError').value = String(p.error);
  $('prefVibrate').checked = p.vibrate !== false;
  $('prefAutoLogout').value = String(p.autoLogoutMin || 0);
  $('appVersion').textContent = 'CronoAnálise — ' + APP_VERSION + ' · banco: ' +
    (storage.getSyncMeta().mode === 'rows' ? 'um estudo por linha' : 'formato atual') +
    (storage.getSyncMeta().teams ? ' + times' : '') +
    ' · armazenamento: ' + (storage.getBackend() === 'idb' ? 'IndexedDB' : 'localStorage') +
    (sync.isLive() ? ' · tempo real ativo' : '') + ' · ' + CREDIT;
  openModal('settingsModal');
  $('mfaStatus').textContent = '…';
  $('btnMfaToggle').disabled = true;
  try {
    const st = await auth.mfaState();
    $('mfaStatus').textContent = st.enabled ? 'ativada' : 'desativada';
    $('btnMfaToggle').textContent = st.enabled ? 'Desativar' : 'Ativar';
    $('btnMfaToggle').dataset.enabled = st.enabled ? '1' : '';
    $('btnMfaToggle').disabled = false;
  } catch (e) {
    $('mfaStatus').textContent = 'indisponível';
  }
}

async function toggleMfa() {
  if ($('btnMfaToggle').dataset.enabled) {
    if (!confirm('Desativar a verificação em duas etapas? A conta volta a pedir só a senha.')) return;
    const err = await auth.mfaDisable();
    if (err) { showToast(err, 5000); return; }
    showToast('Verificação em duas etapas desativada');
    openSettings();
    return;
  }
  try {
    const f = await auth.mfaEnroll();
    mfaEnrollId = f.id;
    $('mfaQr').src = f.qr;
    $('mfaSecret').textContent = f.secret;
    $('mfaEnrollCode').value = '';
    $('mfaEnrollError').textContent = '';
    openModal('mfaEnrollModal', { focus: 'mfaEnrollCode' });
  } catch (e) {
    showToast('Não foi possível iniciar: ' + (e.message || e), 5000);
  }
}

async function confirmMfaEnroll() {
  const code = $('mfaEnrollCode').value.replace(/\D/g, '');
  if (code.length !== 6) { $('mfaEnrollError').textContent = 'Digite os 6 dígitos do aplicativo.'; return; }
  const err = await auth.mfaConfirmEnroll(mfaEnrollId, code);
  if (err) { $('mfaEnrollError').textContent = err; return; }
  closeModal();
  showToast('Verificação em duas etapas ativada ✓ — o próximo login vai pedir o código', 5000);
}

function exportBackup() {
  editor.flush();
  const store = storage.loadStore();
  const payload = {
    app: 'CronoAnálise',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    account: currentUser ? currentUser.email : '',
    ...store
  };
  const date = new Date().toISOString().slice(0, 10);
  downloadFile('CronoAnalise-backup-' + date + '.json', JSON.stringify(payload, null, 2), 'application/json');
  showToast(Object.keys(store.studies).length + ' estudo(s) no backup');
}

async function importBackup(file) {
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch (e) { showToast('Arquivo inválido (não é um backup JSON)'); return; }
  const imported = normalizeStore(parsed);
  imported.deleted = {};
  const ids = Object.keys(imported.studies);
  if (!ids.length) { showToast('Nenhum estudo encontrado no arquivo'); return; }
  editor.flush();
  const local = storage.loadStore();
  const now = new Date().toISOString();
  let restored = 0;
  ids.forEach(id => {
    if (!local.studies[id]) {
      // estudo ausente (ou excluído): volta com data atual para vencer a exclusão em todos os aparelhos
      const s = imported.studies[id];
      s.updatedAt = now;
      s.history = [...(s.history || []), { ts: now, text: 'Restaurado de backup' }];
      delete local.deleted[id];
      restored++;
    }
  });
  storage.saveStore(mergeStores(local, imported));
  sync.request(200);
  refreshViews();
  showToast(restored + ' estudo(s) restaurado(s); os demais foram mesclados registro a registro');
}

async function confirmDeleteAccount() {
  const typed = $('deleteConfirm').value.trim().toUpperCase();
  const err = $('deleteError');
  err.textContent = '';
  if (typed !== 'EXCLUIR') { err.textContent = 'Digite EXCLUIR para confirmar.'; return; }
  const btn = $('btnConfirmDelete');
  btn.disabled = true;
  try {
    // fotos dos meus estudos (o banco não apaga arquivos do Storage)
    if (storage.getSyncMeta().mode === 'rows') {
      for (const s of storage.listStudies()) {
        if (storage.isOwner(s.id) && s.records.some(r => r.photos && r.photos.length)) {
          await removeStudyPhotos(s.id).catch(e => console.warn('Fotos não removidas:', e));
        }
      }
    }
    await deleteAccount();
    const uid = activeUserId;
    editor.close();
    await storage.wipeUserData(uid);
    closeModal();
    showToast('Conta e dados excluídos', 4000);
    await auth.signOut().catch(() => {});
    exitApp();
  } catch (e) {
    err.textContent = e.message || String(e);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- Administração ---------- */
let adminTab = 'users';

async function openAdmin() {
  if (!isAdmin) { showToast('Acesso restrito'); return; }
  openModal('adminModal');
  showAdminTab('users');
}

function showAdminTab(tab) {
  adminTab = tab;
  [['users', 'adminTabUsers', 'adminUsers'], ['errors', 'adminTabErrors', 'adminErrors'], ['data', 'adminTabData', 'adminData']].forEach(([k, btn, box]) => {
    $(btn).classList.toggle('active', k === tab);
    $(btn).setAttribute('aria-selected', String(k === tab));
    $(box).hidden = k !== tab;
  });
  if (tab === 'users') loadAdmin();
  else if (tab === 'errors') loadErrors();
}

async function loadAdmin() {
  const summary = $('adminSummary');
  const thead = $('adminUsersHead');
  const tbody = $('adminUsersTable');
  summary.textContent = 'Carregando…';
  tbody.innerHTML = '';
  const res = await adminStats();
  if (res.error) {
    summary.textContent = 'Erro ao carregar (verifique se a tabela crono_user_activity foi criada no Supabase): ' + res.error.message;
    return;
  }
  const rows = res.rows;
  const d = res.detailed;
  thead.innerHTML = '<tr><th>E-mail</th><th>1º acesso</th><th>Último acesso</th><th>Acessos</th>' +
    (d ? '<th>Estudos</th><th>Registros</th><th>Compart.</th>' : '') + '</tr>';
  const totals = rows.reduce((a, r) => ({ s: a.s + (Number(r.studies) || 0), r: a.r + (Number(r.records) || 0) }), { s: 0, r: 0 });
  summary.textContent = 'Total de usuários registrados: ' + rows.length +
    (d ? ' · ' + totals.s + ' estudos · ' + totals.r + ' registros' : ' · rode a migração 002 para ver estudos por usuário');
  tbody.innerHTML = rows.length ? rows.map(r =>
    '<tr><td>' + escapeHtml(r.email) + '</td>' +
    '<td>' + fmtDate(r.first_seen) + '</td>' +
    '<td>' + fmtDate(r.last_seen) + '</td>' +
    '<td>' + (Number(r.login_count) || 0) + '</td>' +
    (d ? '<td>' + (Number(r.studies) || 0) + '</td><td>' + (Number(r.records) || 0) + '</td><td>' + (Number(r.shares) || 0) + '</td>' : '') +
    '</tr>'
  ).join('') : '<tr><td colspan="7" class="empty">Nenhum usuário registrado ainda.</td></tr>';
}

async function loadErrors() {
  const sum = $('adminErrorsSummary');
  const list = $('adminErrorsList');
  sum.textContent = 'Carregando…';
  list.innerHTML = '';
  try {
    const rows = await listClientErrors();
    const byMsg = new Map();
    rows.forEach(r => byMsg.set(r.message, (byMsg.get(r.message) || 0) + 1));
    sum.textContent = rows.length ? rows.length + ' erro(s) recente(s) · ' + byMsg.size + ' tipo(s) diferente(s). Os erros ficam guardados por 90 dias.' : 'Nenhum erro registrado. 🎉';
    list.innerHTML = rows.map(r =>
      '<details class="error-item"><summary><b>' + escapeHtml(r.message) + '</b><span class="hint">' + fmtDate(r.created_at) + ' · ' + escapeHtml(r.email || '') +
      ' · ' + escapeHtml(r.app_version || '') + '</span></summary>' +
      '<pre>' + escapeHtml([r.stack, 'Página: ' + (r.url || ''), 'Navegador: ' + (r.user_agent || ''), 'Contexto: ' + JSON.stringify(r.context || {})].filter(Boolean).join('\n')) + '</pre></details>'
    ).join('');
  } catch (e) {
    sum.textContent = isMissing(e) ? 'O registro de erros fica disponível depois da migração 003.' : 'Não foi possível carregar: ' + (e.message || e);
  }
}

async function clearErrors() {
  if (!confirm('Apagar todos os erros registrados?')) return;
  try { await clearClientErrors(); showToast('Erros apagados'); } catch (e) { showToast('Não foi possível apagar: ' + (e.message || e)); }
  loadErrors();
}

async function runPurge() {
  const out = $('adminPurgeResult');
  out.textContent = 'Aplicando…';
  try {
    const r = await purgeOldData();
    out.textContent = 'Removidos: ' + (r.erros || 0) + ' erro(s), ' + (r.versoes || 0) + ' versão(ões), ' + (r.estudos_excluidos || 0) + ' estudo(s) excluído(s) e ' + (r.acessos || 0) + ' registro(s) de acesso.';
  } catch (e) {
    out.textContent = isMissing(e) ? 'A política de retenção fica disponível depois da migração 003.' : 'Não foi possível aplicar: ' + (e.message || e);
  }
}

/* ---------- Exportações: OneDrive e compartilhar arquivo ---------- */
function infoModal(title, html) {
  $('infoTitle').textContent = title;
  $('infoBody').innerHTML = html;
  openModal('infoModal');
}

async function exportOneDrive() {
  const cur = editor.getCurrent();
  if (!cur) return;
  editor.flush();
  const token = auth.getGraphToken();
  if (!token) {
    const ok = confirm('Para salvar no OneDrive, entre com a sua conta Microsoft (o app vai abrir o login da Microsoft e voltar para este estudo). Continuar?');
    if (!ok) return;
    try { sessionStorage.setItem(PENDING_ONEDRIVE_KEY, cur.id); } catch (e) { /* ok */ }
    editor.flush();
    await storage.flushWrites();
    const err = await auth.signInWithMicrosoft({ scopes: GRAPH_SCOPE });
    if (err) { sessionStorage.removeItem(PENDING_ONEDRIVE_KEY); showToast(err, 5000); }
    return;
  }
  const { filename, bytes } = editor.buildXLSX();
  showToast('Enviando para o OneDrive…');
  try {
    const item = await uploadToOneDrive(token, filename, bytes, editor.XLSX_MIME);
    editor.persist('Salvo no OneDrive');
    infoModal('Salvo no OneDrive ✓', '<p>A planilha <b>' + escapeHtml(item.name || filename) + '</b> está na pasta <b>CronoAnalise</b> do seu OneDrive.</p>' +
      (item.webUrl && /^https:\/\//.test(item.webUrl) ? '<p><a href="' + escapeHtml(item.webUrl) + '" target="_blank" rel="noopener">Abrir no Excel Online ↗</a></p>' : '') +
      '<p class="hint">Dica: compartilhe a pasta com o time no OneDrive/SharePoint para todos verem os relatórios.</p>');
  } catch (e) {
    if (e.code === 'auth') { auth.forgetGraphToken(); showToast('Autorização do OneDrive expirada — tente de novo para entrar com a Microsoft', 5000); return; }
    showToast('Não foi possível salvar no OneDrive: ' + (e.message || e), 5000);
  }
}

/* Volta do login da Microsoft pedido para salvar no OneDrive. */
function resumePendingOneDrive() {
  let id = null;
  try { id = sessionStorage.getItem(PENDING_ONEDRIVE_KEY); sessionStorage.removeItem(PENDING_ONEDRIVE_KEY); } catch (e) { /* ok */ }
  if (!id || !auth.getGraphToken()) return;
  const cur = editor.getCurrent();
  if (!cur || cur.id !== id) { if (!openStudyView(id)) return; }
  exportOneDrive();
}

async function shareCurrentFile() {
  const cur = editor.getCurrent();
  if (!cur) return;
  editor.flush();
  const { filename, bytes } = editor.buildXLSX();
  if (!canShareFiles()) {
    downloadFile(filename, bytes, editor.XLSX_MIME);
    showToast('Este navegador não envia arquivos direto — a planilha foi baixada para você anexar', 5000);
    return;
  }
  try {
    await shareFile(filename, bytes, editor.XLSX_MIME, cur.name);
  } catch (e) {
    if (e && e.name !== 'AbortError') showToast('Não foi possível compartilhar: ' + (e.message || e));
  }
}

/* ---------- Ações (delegação de eventos) ---------- */
const idOf = btn => {
  const el = btn.closest('[data-id]');
  return el ? el.dataset.id : null;
};

const afterLeave = () => { if (isEditorView()) showDashboard(); else renderDashboard(); };

const actions = {
  'toggle-menu': () => { updateShareButton(); toggleMenu(); },
  'back-dashboard': () => showDashboard(),
  'toggle-field': () => { setFieldMode(!document.body.classList.contains('field')); saveSession(); },
  'manual-save': () => {
    editor.saveNow();
    sync.syncNow();
    showToast('Estudo salvo ✓');
  },
  'new-study': () => newStudyView(),
  'new-sampling': () => newStudyView(null, 'sampling'),
  'export-csv': () => editor.exportCSV(),
  'export-xlsx': () => editor.exportXLSX(),
  'export-onedrive': () => exportOneDrive(),
  'share-file': () => shareCurrentFile(),
  'print': () => editor.printStudy(),
  'print-a3': () => editor.printA3(),
  'share': () => { const c = editor.getCurrent(); if (c) openShare(c); },
  'compare': () => openCompare(),
  'open-teams': () => teams.openTeams(),
  'team-leave': () => teams.leaveSelected(),
  'team-delete': () => teams.deleteSelected(),
  'toggle-theme': () => toggleTheme(),
  'open-settings': () => openSettings(),
  'open-privacy': () => openModal('privacyModal'),
  'open-admin': () => openAdmin(),
  'admin-tab': btn => showAdminTab(btn.dataset.tab),
  'reload-admin': () => showAdminTab(adminTab),
  'admin-clear-errors': () => clearErrors(),
  'admin-purge': () => runPurge(),
  'sign-out': () => doSignOut(),
  'sign-up': btn => doSignUp(btn),
  'sign-in-microsoft': btn => doMicrosoft(btn),
  'toggle-password': () => togglePassword(),
  'forgot-password': btn => doForgotPassword(btn),
  'close-modal': () => closeModal(),
  'export-backup': () => exportBackup(),
  'import-backup': () => $('backupFile').click(),
  'delete-account': () => { $('deleteConfirm').value = ''; $('deleteError').textContent = ''; openModal('deleteAccountModal', { focus: 'deleteConfirm' }); },
  'confirm-delete-account': () => confirmDeleteAccount(),
  'mfa-toggle': () => toggleMfa(),
  'idle-stay': () => { touchActivity(); cancelIdleWarning(); },

  'tab': btn => editor.showTab(btn.dataset.tab),
  'load-versions': () => historyUI.loadVersions(),
  'delete-current': () => editor.deleteCurrent(id => leaveShare(id, afterLeave)),
  'start': () => timer.start(),
  'pause': () => timer.pause(),
  'reset': () => timer.reset(),
  'new-cycle': () => timer.newCycle(),
  'undo': () => timer.undo(),
  'note-last': () => timer.noteLast(),
  'photo-last': () => { const c = editor.getCurrent(); if (c) photos.capture(c.id, timer.lastRecordId()); },
  'record-photo': btn => { const c = editor.getCurrent(); if (c) photos.capture(c.id, idOf(btn)); },
  'record-photos': btn => { const c = editor.getCurrent(); if (c) photos.openGallery(c, idOf(btn)); },
  'open-photos': () => { const c = editor.getCurrent(); if (c) photos.openGallery(c); },
  'qty': btn => timer.changeQty(Number(btn.dataset.delta)),
  'mark': btn => timer.markStage(btn.dataset.id),
  'interruption': () => timer.markInterruption(),
  'remove-stage': btn => stagesUI.remove(btn.dataset.id),
  'edit-stage': btn => stagesUI.openEdit(btn.dataset.id),
  'stage-back': () => stagesUI.move(-1),
  'stage-fwd': () => stagesUI.move(1),
  'toggle-exclude': btn => recordsUI.toggleExclude(idOf(btn)),
  'delete-record': btn => recordsUI.remove(idOf(btn)),
  'sample-note': () => samplingUI.noteLast(),
  'sample-undo': () => samplingUI.undo(),

  'open-study': btn => openStudyView(idOf(btn)),
  'template-study': btn => newStudyView(idOf(btn)),
  'duplicate-study': btn => duplicateStudy(idOf(btn)),
  'delete-study': btn => deleteStudy(idOf(btn)),
  'leave-study': btn => leaveShare(idOf(btn), afterLeave)
};

function onClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn || btn.disabled) return;
  const fn = actions[btn.dataset.action];
  if (!fn) return;
  const inMenu = !!btn.closest('#menuDropdown');
  fn(btn, e);
  if (inMenu) closeMenu();
}

/* ---------- Atalhos de teclado (editor) ---------- */
function onKeydown(e) {
  if (!isEditorView() || isModalOpen() || !editor.getCurrent() || e.defaultPrevented || editor.isReadonly()) return;
  if (editor.currentTab() !== 'crono') return;
  const t = e.target;
  if (t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (editor.isSampling()) {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); samplingUI.undo(); }
      return;
    }
    if (/^[1-9]$/.test(e.key) && !e.repeat) samplingUI.markByIndex(Number(e.key) - 1);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    timer.undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault(); // evita também o "clique" do botão em foco
    if (!e.repeat) timer.toggle();
  } else if (/^[1-9]$/.test(e.key)) {
    if (!e.repeat) timer.markStageByIndex(Number(e.key) - 1);
  } else if (e.key === '0') {
    if (!e.repeat) timer.markInterruption();
  } else if (e.key === 'n' || e.key === 'N') {
    if (!e.repeat) timer.newCycle();
  }
}

/* ---------- Inicialização ---------- */
function boot() {
  console.info(BRAND.title + ' ' + APP_VERSION + ' — ' + CREDIT);
  initMonitor({
    context: () => ({
      view: isEditorView() ? 'editor' : 'dashboard',
      kind: editor.isSampling() ? 'sampling' : 'time',
      mode: storage.getUser() ? storage.getSyncMeta().mode : null,
      online: navigator.onLine !== false
    })
  });
  initModals();
  initMenu();
  applyThemeUI();
  applyBrand();
  editor.labels();
  storage.setWriteErrorHandler(() => showToast('⚠ Não foi possível gravar neste aparelho (armazenamento cheio?) — baixe um backup em Configurações', 6000));

  editor.initEditor({
    requestSync: () => { sync.request(); },
    onDeleted: () => showDashboard(),
    onStudyDeleted: (id, study) => { if (study.records.some(r => r.photos)) photos.forgetStudyPhotos(id); }
  });
  initDashboard({
    requestSync: () => sync.request(),
    onForget: id => { editor.forgetStudy(id); photos.forgetStudyPhotos(id); }
  });
  initShare({ pushStudyNow: id => sync.pushStudyNow(id) });
  initCompare();
  teams.initTeams({ onChange: () => { if (!isEditorView()) renderDashboard(); } });
  photos.initPhotos({
    attach: (recordId, photo) => recordsUI.attachPhoto(recordId, photo),
    detach: (recordId, photoId) => recordsUI.detachPhoto(recordId, photoId),
    canUpload: cloudReady,
    pushStudyNow: id => sync.pushStudyNow(id),
    isReadonly: () => editor.isReadonly()
  });

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);

  // atividade do usuário (saída automática por inatividade)
  let lastTouch = 0;
  const activity = () => { const n = Date.now(); if (n - lastTouch > 5000) { lastTouch = n; touchActivity(); } };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, activity, { passive: true }));
  startIdle();

  // trocar de estudo pela lista do editor também atualiza a sessão salva
  $('studyList').addEventListener('change', () => setTimeout(() => { saveSession(); updateShareButton(); }, 0));

  $('authForm').addEventListener('submit', e => { e.preventDefault(); doSignIn(e.submitter || null); });
  $('mfaForm').addEventListener('submit', e => { e.preventDefault(); submitMfa(); });
  $('mfaEnrollForm').addEventListener('submit', e => { e.preventDefault(); confirmMfaEnroll(); });
  $('recoveryForm').addEventListener('submit', e => { e.preventDefault(); saveNewPassword(); });
  $('settingsThemeToggle').addEventListener('change', () => toggleTheme());
  $('prefConfidence').addEventListener('change', e => { storage.setPrefs({ confidence: Number(e.target.value) }); editor.refresh(); });
  $('prefError').addEventListener('change', e => { storage.setPrefs({ error: Number(e.target.value) }); editor.refresh(); });
  $('prefVibrate').addEventListener('change', e => storage.setPrefs({ vibrate: e.target.checked }));
  $('prefAutoLogout').addEventListener('change', e => { storage.setPrefs({ autoLogoutMin: Number(e.target.value) }); touchActivity(); });
  $('backupFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  });

  // Salva o que estiver sendo digitado antes de sair/esconder a página
  window.addEventListener('pagehide', () => editor.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { editor.flush(); return; }
    // voltou para a aba: verifica a inatividade e busca alterações de outros aparelhos
    if (activeUserId && idleExpired()) { showToast('Sessão encerrada por inatividade', 5000); doSignOut(); return; }
    if (activeUserId && Date.now() - lastFocusPull > 15000) {
      lastFocusPull = Date.now();
      sync.syncNow({ pull: true });
    }
  });
  window.addEventListener('online', () => { if (activeUserId) { sync.syncNow({ pull: true }); schedulePhotoUpload(); } });
  window.addEventListener('offline', () => { if (activeUserId) setSyncStatus('offline'); });

  // Outra aba do app alterou os dados
  storage.onExternalChange(() => { if (activeUserId) refreshViews(); });
  window.addEventListener('storage', e => {
    if (!activeUserId) return;
    if (storage.handleStorageEvent(e) || storage.isTimerKey(e.key)) refreshViews();
  });

  if (!sb) {
    $('bootScreen').textContent = 'Não foi possível carregar o CronoAnálise. Verifique sua conexão e recarregue a página.';
    return;
  }
  // erro devolvido pelo login da Microsoft (ex.: provedor não ativado)
  const oauthErr = auth.oauthErrorFromUrl();
  if (oauthErr) setAuthError(oauthErr);

  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(() => handleAuthEvent(event, session), 0);
  });
  // Rede de segurança: nunca deixar a tela de carregamento presa
  setTimeout(() => document.body.classList.remove('booting'), 12000);

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker não registrado:', e));
    });
  }
}

boot();
