/* Configuração central do CronoAnálise.
   A chave "publishable" do Supabase é pública por natureza: a segurança dos dados
   vem das políticas RLS (ver supabase/schema.sql). */

export const APP_VERSION = 'Beta 11';

/* Os testes contra o Supabase de homologação (tests/staging) injetam outro projeto
   em window.__CRONO_CONFIG__ antes de o app carregar. Em produção isso não existe. */
const override = (typeof globalThis !== 'undefined' && globalThis.__CRONO_CONFIG__) || {};

export const SUPABASE_URL = override.supabaseUrl || 'https://zwfnsknaxqnexeuzvvjn.supabase.co';
export const SUPABASE_ANON_KEY = override.supabaseAnonKey || 'sb_publishable_SSH2Hy1kaPLAdutcIR39WA_J6oieZ2v';

/* Só controla a visibilidade do botão no menu. Quem garante o acesso é a policy
   "admin ve toda atividade" no banco. */
export const ADMIN_EMAIL = 'daniel.thomaseto@dhl.com';

export const TYPES = ['VA', 'NVA', 'Espera', 'Transporte'];

/* Rótulos dos campos do estudo — usados no formulário, nos cards e no CSV. */
export const FIELD_LABELS = {
  name: 'Nome do estudo',
  process: 'Processo',
  operator: 'Usuário LMS',
  observer: 'Champion OMS'
};

/* Tela de login e marca.
   - title: título abaixo da marca.
   - logo: caminho de uma imagem (ex.: 'icons/logo-empresa.svg') para mostrar no
     lugar da marca padrão do app — use o arquivo oficial do portal de marca.
   - microsoftLogin: botão de entrar com a conta Microsoft da empresa (Entra ID).
     Precisa do provedor "Azure" ativado no Supabase (ver README).
   - author: autor da ferramenta — assinatura no login, no rodapé do app, nos
     relatórios (PDF e A3) e nas propriedades do Excel. */
export const BRAND = {
  title: 'CronoAnalise System',
  logo: null,
  microsoftLogin: true,
  microsoftLabel: 'Acesso com e-mail DHL',
  footer: '© 2026 CronoAnalise System',
  author: 'Daniel Thomaseto'
};

export const CREDIT = 'Desenvolvido por ' + BRAND.author;

/* Fotos dos registros (Supabase Storage, criado pela migração 003). */
export const PHOTO_BUCKET = 'crono-photos';

/* OneDrive (Microsoft Graph): pasta onde os relatórios são salvos. */
export const ONEDRIVE_FOLDER = 'CronoAnalise';

/* Parâmetros estatísticos padrão (ajustáveis em Configurações). */
export const DEFAULT_PREFS = {
  confidence: 95, // %
  error: 5,       // erro relativo aceitável, %
  vibrate: true,  // vibrar ao marcar etapa (celular)
  autoLogoutMin: 0 // sair sozinho após X min sem uso (0 = nunca)
};
