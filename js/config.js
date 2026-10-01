/* Configuração central do CronoAnálise.
   A chave "publishable" do Supabase é pública por natureza: a segurança dos dados
   vem das políticas RLS (ver supabase/schema.sql). */

export const APP_VERSION = 'Beta 9';

export const SUPABASE_URL = 'https://zwfnsknaxqnexeuzvvjn.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_SSH2Hy1kaPLAdutcIR39WA_J6oieZ2v';

/* Só controla a visibilidade do botão no menu. Quem garante o acesso é a policy
   "admin ve toda atividade" no banco. */
export const ADMIN_EMAIL = 'daniel.thomaseto@dhl.com';

export const TYPES = ['VA', 'NVA', 'Espera', 'Transporte'];

export const TYPE_COLORS = {
  VA: '#2f7d4a',
  NVA: '#b03a2e',
  Espera: '#b8901f',
  Transporte: '#34618a'
};

/* Rótulos dos campos do estudo — usados no formulário, nos cards e no CSV. */
export const FIELD_LABELS = {
  name: 'Nome do estudo',
  process: 'Processo',
  operator: 'Usuário LMS',
  observer: 'Champion OMS'
};

/* Parâmetros estatísticos padrão (ajustáveis em Configurações). */
export const DEFAULT_PREFS = {
  confidence: 95, // %
  error: 5        // erro relativo aceitável, %
};
