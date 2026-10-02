/* Autenticação (Supabase Auth): entrar (e-mail/senha ou conta Microsoft), criar
   conta, recuperar senha e verificação em duas etapas (TOTP). */

import { sb } from './cloud.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const GRAPH_TOKEN_KEY = 'cronoanalise:graphToken';

export function translateAuthError(msg) {
  msg = String(msg || '');
  if (/Invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/already registered|User already registered/i.test(msg)) return 'Este e-mail já tem conta. Tente entrar.';
  if (/Password should be|at least 6/i.test(msg)) return 'Senha muito curta (mínimo 6 caracteres).';
  if (/Unable to validate email|invalid email/i.test(msg)) return 'E-mail inválido.';
  if (/Email not confirmed/i.test(msg)) return 'Confirme seu e-mail antes de entrar (verifique a caixa de entrada).';
  if (/rate limit|too many/i.test(msg)) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão com o servidor. Verifique a internet.';
  if (/same.*password|different from the old/i.test(msg)) return 'A nova senha precisa ser diferente da atual.';
  if (/provider is not enabled|Unsupported provider/i.test(msg)) return 'O acesso com a conta Microsoft ainda não foi ativado pelo administrador.';
  if (/Invalid TOTP|invalid.*code|Invalid MFA/i.test(msg)) return 'Código inválido ou expirado. Confira o relógio do celular e tente o código atual.';
  if (/AAL2 required|aal2/i.test(msg)) return 'Confirme a verificação em duas etapas antes de fazer isso.';
  return msg;
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  return error ? translateAuthError(error.message) : null;
}

/* Devolve { error } ou { needsConfirmation } */
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) return { error: translateAuthError(error.message) };
  return { needsConfirmation: !!(data.user && !data.session) };
}

export async function sendPasswordReset(email) {
  const redirectTo = location.origin + location.pathname;
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
  return error ? translateAuthError(error.message) : null;
}

export async function updatePassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  return error ? translateAuthError(error.message) : null;
}

export async function signOut() {
  try { sessionStorage.removeItem(GRAPH_TOKEN_KEY); } catch (e) { /* ok */ }
  await sb.auth.signOut();
}

/* ---------- Conta Microsoft (Entra ID / provedor "azure" do Supabase) ---------- */

/* O provedor está ativado no Supabase? (endpoint público de configurações) */
export async function microsoftEnabled() {
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/settings', { headers: { apikey: SUPABASE_ANON_KEY } });
    if (!res.ok) return null;
    const s = await res.json();
    return !!(s && s.external && s.external.azure);
  } catch (e) {
    return null; // sem rede: tenta mesmo assim
  }
}

/* Redireciona para o login da Microsoft. `scopes` extra (ex.: OneDrive) pedem
   consentimento só quando necessários. */
export async function signInWithMicrosoft({ scopes = '' } = {}) {
  const enabled = await microsoftEnabled();
  if (enabled === false) return translateAuthError('provider is not enabled');
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'azure',
    options: {
      redirectTo: location.origin + location.pathname,
      scopes: ['email', 'openid', 'profile', scopes].filter(Boolean).join(' ')
    }
  });
  return error ? translateAuthError(error.message) : null;
}

/* Erro devolvido pelo provedor na volta do login (?error_description=… ou #…). */
export function oauthErrorFromUrl() {
  const read = s => new URLSearchParams(s.replace(/^[?#]/, ''));
  const q = read(location.search), h = read(location.hash);
  const msg = q.get('error_description') || h.get('error_description');
  if (!msg) return null;
  try { history.replaceState(history.state, '', location.pathname); } catch (e) { /* ok */ }
  return translateAuthError(msg.replace(/\+/g, ' '));
}

/* Token do Microsoft Graph (OneDrive) — vem junto com a sessão logo após o login
   pela Microsoft e vale ~1 h. Guardado só nesta aba. */
export function rememberProviderToken(session) {
  if (!session || !session.provider_token) return;
  try {
    sessionStorage.setItem(GRAPH_TOKEN_KEY, JSON.stringify({ token: session.provider_token, exp: Date.now() + 55 * 60000 }));
  } catch (e) { /* sem sessionStorage */ }
}

export function getGraphToken() {
  try {
    const v = JSON.parse(sessionStorage.getItem(GRAPH_TOKEN_KEY) || 'null');
    return v && v.token && v.exp > Date.now() ? v.token : null;
  } catch (e) {
    return null;
  }
}

export function forgetGraphToken() {
  try { sessionStorage.removeItem(GRAPH_TOKEN_KEY); } catch (e) { /* ok */ }
}

/* ---------- Verificação em duas etapas (TOTP) ---------- */

/* { needsCode, enabled } — needsCode: a conta tem 2 etapas e esta sessão ainda não verificou */
export async function mfaState() {
  const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return { needsCode: false, enabled: false };
  return { needsCode: data.nextLevel === 'aal2' && data.currentLevel !== 'aal2', enabled: data.nextLevel === 'aal2' };
}

async function verifiedTotp() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  return (data && data.totp) || [];
}

export async function mfaVerifyLogin(code) {
  const factors = await verifiedTotp();
  if (!factors.length) return null;
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factors[0].id, code: String(code).trim() });
  return error ? translateAuthError(error.message) : null;
}

/* Começa a ativação: { id, qr, secret } */
export async function mfaEnroll() {
  // remove tentativas anteriores não concluídas
  const { data: list } = await sb.auth.mfa.listFactors();
  for (const f of (list && list.all) || []) {
    if (f.status !== 'verified' && f.factor_type === 'totp') await sb.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'CronoAnálise ' + new Date().toLocaleDateString('pt-BR'), issuer: 'CronoAnálise' });
  if (error) throw new Error(translateAuthError(error.message));
  return { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

export async function mfaConfirmEnroll(factorId, code) {
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code: String(code).trim() });
  return error ? translateAuthError(error.message) : null;
}

export async function mfaDisable() {
  const factors = await verifiedTotp();
  for (const f of factors) {
    const { error } = await sb.auth.mfa.unenroll({ factorId: f.id });
    if (error) return translateAuthError(error.message);
  }
  await sb.auth.refreshSession().catch(() => {});
  return null;
}
