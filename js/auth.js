/* Autenticação (Supabase Auth): entrar, criar conta, recuperar senha. */

import { sb } from './cloud.js';

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
  await sb.auth.signOut();
}
