-- ============================================================
-- CronoAnálise — estrutura do banco no Supabase
--
-- Seções 1 e 2: o que já existe no projeto (documentado aqui para ficar
-- versionado junto com o código). O script é idempotente: pode ser rodado de
-- novo sem duplicar nada (as policies são recriadas com os mesmos nomes).
--
-- Seção 3: OPCIONAL. Conta os acessos direto no banco (atômico e sem o cliente
-- poder alterar o número). O app detecta sozinho se a função existe; sem ela,
-- continua registrando os acessos como antes.
--
-- Como rodar: Supabase > SQL Editor > New query > colar > Run.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Estudos: 1 linha por usuário com todos os estudos em JSON
--    Formato de `data` (v3): { "format": 3, "studies": { "<id>": {...} }, "deleted": { "<id>": "<ISO>" } }
--    `updated_at` é usado pelo app para detectar gravações simultâneas de
--    aparelhos diferentes (controle otimista) antes de mesclar.
-- ------------------------------------------------------------
create table if not exists public.crono_studies (
  user_id    uuid references auth.users primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz default now()
);

alter table public.crono_studies enable row level security;

drop policy if exists "select own" on public.crono_studies;
create policy "select own" on public.crono_studies
  for select using (auth.uid() = user_id);

drop policy if exists "insert own" on public.crono_studies;
create policy "insert own" on public.crono_studies
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own" on public.crono_studies;
create policy "update own" on public.crono_studies
  for update using (auth.uid() = user_id);


-- ------------------------------------------------------------
-- 2) Rastreamento de acesso de usuários (painel de Administração)
-- ------------------------------------------------------------
create table if not exists public.crono_user_activity (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  login_count  integer not null default 1
);

alter table public.crono_user_activity enable row level security;

-- Cada usuário pode CRIAR só a própria linha (no primeiro login)
drop policy if exists "usuario cria propria atividade" on public.crono_user_activity;
create policy "usuario cria propria atividade"
on public.crono_user_activity
for insert
with check (auth.uid() = user_id);

-- Cada usuário pode ATUALIZAR só a própria linha (nos logins seguintes)
drop policy if exists "usuario atualiza propria atividade" on public.crono_user_activity;
create policy "usuario atualiza propria atividade"
on public.crono_user_activity
for update
using (auth.uid() = user_id);

-- Cada usuário pode VER só a própria linha...
drop policy if exists "usuario ve propria atividade" on public.crono_user_activity;
create policy "usuario ve propria atividade"
on public.crono_user_activity
for select
using (auth.uid() = user_id);

-- ...MAS o e-mail admin pode ver TODAS as linhas
-- (troque o e-mail abaixo — e ADMIN_EMAIL em js/config.js — se um dia precisar mudar o admin)
drop policy if exists "admin ve toda atividade" on public.crono_user_activity;
create policy "admin ve toda atividade"
on public.crono_user_activity
for select
using (auth.jwt() ->> 'email' = 'daniel.thomaseto@dhl.com');


-- ------------------------------------------------------------
-- 3) OPCIONAL — contagem de acessos atômica no servidor
--    Antes o app lia login_count, somava 1 e gravava: dois logins simultâneos
--    podiam contar como um, e o próprio usuário conseguia gravar qualquer valor.
--    Com esta função o banco faz a conta. Roda com as permissões do usuário
--    (security invoker), então as policies acima continuam valendo.
-- ------------------------------------------------------------
create or replace function public.crono_log_activity()
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.crono_user_activity (user_id, email, first_seen, last_seen, login_count)
  values (auth.uid(), coalesce(auth.jwt() ->> 'email', ''), now(), now(), 1)
  on conflict (user_id) do update
    set last_seen   = now(),
        email       = excluded.email,
        login_count = public.crono_user_activity.login_count + 1;
$$;

revoke all on function public.crono_log_activity() from public, anon;
grant execute on function public.crono_log_activity() to authenticated;
