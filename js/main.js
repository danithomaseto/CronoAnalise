/* Ponto de entrada: autenticação, navegação, ações da interface e atalhos. */

import { ADMIN_EMAIL, APP_VERSION } from './config.js';
import * as storage from './storage.js';
import { sb, createSync, logActivity, listActivity } from './cloud.js';
import * as auth from './auth.js';
import * as editor from './editor.js';
import { initDashboard, renderDashboard, duplicateStudy, deleteStudy } from './dashboard.js';
import { normalizeStore, mergeStores } from './core/model.js';
import { escapeHtml, fmtDate } from './core/format.js';
import * as T from './core/timer.js';
import {
  $, showToast, openModal, closeModal, isModalOpen, initModals, initMenu, toggleMenu, closeMenu,
  applyThemeUI, toggleTheme, downloadFile, setSyncStatus, setSyncTime
} from './ui.js';

let currentUser = null;
let activeUserId = null;
let activityLoggedFor = null;
let lastFocusPull = 0;

const sync = createSync({
  onStatus: status => { setSyncStatus(status); renderSyncTime(); },
  onMerged: () => {
    if (isEditorView()) editor.applyExternalUpdate();
    else renderDashboard();
  }
});

function isEditorView() {
  return document.body.classList.contains('view-editor');
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

function showDashboard() {
  editor.close();
  setView('dashboard');
  setFieldMode(false);
  renderDashboard();
  renderSyncTime();
  saveSession();
}

function openStudyView(id) {
  if (!editor.openStudy(id)) return false;
  setView('editor');
  renderSyncTime();
  saveSession();
  return true;
}

function newStudyView() {
  editor.newStudy();
  setView('editor');
  renderSyncTime();
  saveSession();
}

function setFieldMode(on) {
  document.body.classList.toggle('field', on);
  const btn = $('btnField');
  btn.textContent = on ? 'Sair do Modo Campo' : 'Modo Campo';
  btn.classList.toggle('active', on);
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

async function doSignOut() {
  editor.flush();
  if (storage.isDirty()) {
    // tenta enviar o que falta antes de sair (os dados continuam salvos neste aparelho de qualquer forma)
    await Promise.race([sync.syncNow(), new Promise(r => setTimeout(r, 3000))]);
  }
  await auth.signOut();
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
   ~1h. Antes isso reiniciava o app (voltava ao Dashboard e zerava o cronômetro).
   Agora só reage quando o usuário realmente muda. O trabalho é despachado para fora
   do callback, como recomenda a documentação do Supabase. */
function handleAuthEvent(event, session) {
  document.body.classList.remove('booting');
  const user = session && session.user;
  if (user) {
    currentUser = user;
    if (activeUserId !== user.id) {
      activeUserId = user.id;
      enterApp(user)
        .then(() => { if (event === 'PASSWORD_RECOVERY') openModal('recoveryModal', { focus: 'newPass' }); })
        .catch(e => { console.error(e); showToast('Erro ao abrir seus estudos: ' + (e && e.message ? e.message : e), 6000); });
    } else if (event === 'PASSWORD_RECOVERY') {
      openModal('recoveryModal', { focus: 'newPass' });
    }
  } else if (activeUserId !== null) {
    exitApp();
  }
}

async function enterApp(user) {
  storage.setUser(user.id);
  const { migrated } = storage.initUserStore();
  $('userEmail').textContent = user.email;
  $('btnAdmin').hidden = user.email !== ADMIN_EMAIL;
  document.body.classList.add('authed');
  setAuthError(''); setAuthMsg('');
  $('authPass').value = '';
  sync.reset(user.id);

  if (activityLoggedFor !== user.id) {
    activityLoggedFor = user.id;
    logActivity(user);
  }

  // Dados migrados da versão anterior: espera a 1ª sincronização (até 8 s) para
  // não mostrar, nem por um instante, estudos de outra conta deste navegador.
  const firstPull = !!storage.getSyncMeta().legacyIds;
  if (firstPull && navigator.onLine !== false) {
    $('bootScreen').textContent = 'Sincronizando seus estudos…';
    document.body.classList.add('booting');
    await Promise.race([sync.syncNow({ pull: true }), new Promise(r => setTimeout(r, 8000))]);
    document.body.classList.remove('booting');
    if (activeUserId !== user.id) return;
  }
  restoreView();
  if (!firstPull) sync.syncNow({ pull: true });
  else if (migrated) showToast('Estudos da versão anterior importados ✓');
}

function exitApp() {
  editor.close();
  sync.reset(null);
  activeUserId = null;
  currentUser = null;
  storage.setUser(null);
  closeModal();
  closeMenu();
  setFieldMode(false);
  document.body.classList.remove('authed');
  setView('dashboard');
  $('authPass').value = '';
  $('userEmail').textContent = '';
  $('btnAdmin').hidden = true;
  setSyncTime('');
}

/* ---------- Configurações / backup / admin ---------- */
function openSettings() {
  applyThemeUI();
  const p = storage.getPrefs();
  $('prefConfidence').value = String(p.confidence);
  $('prefError').value = String(p.error);
  $('appVersion').textContent = 'CronoAnálise — ' + APP_VERSION;
  openModal('settingsModal');
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
  const merged = mergeStores(local, imported);
  storage.saveStore(merged);
  sync.request(200);
  if (isEditorView()) editor.applyExternalUpdate(); else renderDashboard();
  showToast(restored + ' estudo(s) restaurado(s); os demais foram mesclados pela edição mais recente');
}

async function openAdmin() {
  if (!currentUser || currentUser.email !== ADMIN_EMAIL) { showToast('Acesso restrito'); return; }
  openModal('adminModal');
  await loadAdmin();
}

async function loadAdmin() {
  const summary = $('adminSummary');
  const tbody = $('adminUsersTable');
  summary.textContent = 'Carregando…';
  tbody.innerHTML = '';
  const { data, error } = await listActivity();
  if (error) {
    summary.textContent = 'Erro ao carregar (verifique se a tabela crono_user_activity foi criada no Supabase): ' + error.message;
    return;
  }
  const rows = data || [];
  summary.textContent = 'Total de usuários registrados: ' + rows.length;
  tbody.innerHTML = rows.length ? rows.map(r =>
    '<tr><td>' + escapeHtml(r.email) + '</td>' +
    '<td>' + fmtDate(r.first_seen) + '</td>' +
    '<td>' + fmtDate(r.last_seen) + '</td>' +
    '<td>' + (Number(r.login_count) || 0) + '</td></tr>'
  ).join('') : '<tr><td colspan="4" class="empty">Nenhum usuário registrado ainda.</td></tr>';
}

/* ---------- Ações (delegação de eventos) ---------- */
const idOf = btn => {
  const el = btn.closest('[data-id]');
  return el ? el.dataset.id : null;
};

const actions = {
  'toggle-menu': () => toggleMenu(),
  'back-dashboard': () => showDashboard(),
  'toggle-field': () => { setFieldMode(!document.body.classList.contains('field')); saveSession(); },
  'manual-save': () => {
    editor.saveNow();
    sync.syncNow();
    showToast('Estudo salvo ✓');
  },
  'new-study': () => newStudyView(),
  'export-csv': () => editor.exportCSV(),
  'print': () => editor.printStudy(),
  'toggle-theme': () => toggleTheme(),
  'open-settings': () => openSettings(),
  'open-admin': () => openAdmin(),
  'reload-admin': () => loadAdmin(),
  'sign-out': () => doSignOut(),
  'sign-up': btn => doSignUp(btn),
  'forgot-password': btn => doForgotPassword(btn),
  'close-modal': () => closeModal(),
  'export-backup': () => exportBackup(),
  'import-backup': () => $('backupFile').click(),

  'tab': btn => editor.showTab(btn.dataset.tab),
  'delete-current': () => editor.deleteCurrent(),
  'start': () => editor.startTimer(),
  'pause': () => editor.pauseTimer(),
  'reset': () => editor.resetTimer(),
  'new-cycle': () => editor.newCycle(),
  'undo': () => editor.undo(),
  'qty': btn => editor.changeQty(Number(btn.dataset.delta)),
  'mark': btn => editor.markStage(btn.dataset.id),
  'remove-stage': btn => editor.removeStage(btn.dataset.id),
  'edit-stage': btn => editor.openStageEdit(btn.dataset.id),
  'toggle-exclude': btn => editor.toggleExclude(idOf(btn)),
  'delete-record': btn => editor.deleteRecord(idOf(btn)),

  'open-study': btn => openStudyView(idOf(btn)),
  'duplicate-study': btn => duplicateStudy(idOf(btn)),
  'delete-study': btn => deleteStudy(idOf(btn))
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
  if (!isEditorView() || isModalOpen() || !editor.getCurrent() || e.defaultPrevented) return;
  if (!$('editorHistory').hidden) return;
  const t = e.target;
  if (t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    editor.undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault(); // evita também o "clique" do botão em foco
    if (!e.repeat) editor.toggleTimer();
  } else if (/^[1-9]$/.test(e.key)) {
    if (!e.repeat) editor.markStageByIndex(Number(e.key) - 1);
  } else if (e.key === 'n' || e.key === 'N') {
    if (!e.repeat) editor.newCycle();
  }
}

/* ---------- Inicialização ---------- */
function boot() {
  initModals();
  initMenu();
  applyThemeUI();
  editor.labels();
  storage.setWriteErrorHandler(() => showToast('⚠ Armazenamento do navegador cheio — baixe um backup em Configurações', 5000));

  editor.initEditor({
    requestSync: () => { sync.request(); },
    onDeleted: () => showDashboard()
  });
  initDashboard({
    requestSync: () => sync.request(),
    onForget: id => editor.forgetStudy(id)
  });

  document.addEventListener('click', onClick);
  document.addEventListener('keydown', onKeydown);

  // trocar de estudo pela lista do editor também atualiza a sessão salva
  $('studyList').addEventListener('change', () => setTimeout(saveSession, 0));

  $('authForm').addEventListener('submit', e => { e.preventDefault(); doSignIn(e.submitter || null); });
  $('recoveryForm').addEventListener('submit', e => { e.preventDefault(); saveNewPassword(); });
  $('settingsThemeToggle').addEventListener('change', () => toggleTheme());
  $('prefConfidence').addEventListener('change', e => { storage.setPrefs({ confidence: Number(e.target.value) }); editor.refresh(); });
  $('prefError').addEventListener('change', e => { storage.setPrefs({ error: Number(e.target.value) }); editor.refresh(); });
  $('backupFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importBackup(f);
  });

  // Salva o que estiver sendo digitado antes de sair/esconder a página
  window.addEventListener('pagehide', () => editor.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { editor.flush(); return; }
    // voltou para a aba: busca alterações feitas em outros aparelhos
    if (activeUserId && Date.now() - lastFocusPull > 15000) {
      lastFocusPull = Date.now();
      sync.syncNow({ pull: true });
    }
  });
  window.addEventListener('online', () => { if (activeUserId) sync.syncNow({ pull: true }); });
  window.addEventListener('offline', () => { if (activeUserId) setSyncStatus('offline'); });

  // Outra aba do app alterou os dados
  window.addEventListener('storage', e => {
    if (!activeUserId || !storage.isStoreKey(e.key)) return;
    if (isEditorView()) editor.applyExternalUpdate(); else renderDashboard();
  });

  if (!sb) {
    $('bootScreen').textContent = 'Não foi possível carregar o CronoAnálise. Verifique sua conexão e recarregue a página.';
    return;
  }
  sb.auth.onAuthStateChange((event, session) => {
    setTimeout(() => handleAuthEvent(event, session), 0);
  });
  // Rede de segurança: nunca deixar a tela de carregamento presa
  setTimeout(() => document.body.classList.remove('booting'), 10000);

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker não registrado:', e));
    });
  }
}

boot();
