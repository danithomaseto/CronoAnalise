-- ============================================================
-- CronoAnálise — migração 003
--   * times: compartilhar estudos com um grupo inteiro (e painel por time)
--   * sincronização em tempo real (Supabase Realtime)
--   * fotos dos registros (Supabase Storage, bucket privado "crono-photos")
--   * registro de erros do aplicativo (painel de administração)
--   * verificação em duas etapas obrigatória para quem ativou (MFA/TOTP)
--   * política de retenção de dados (LGPD) com limpeza automática
--   * excluir conta também apaga times e erros
--
-- Como rodar: Supabase > SQL Editor > New query > colar tudo > Run.
-- É idempotente (pode rodar de novo). Pré-requisitos: supabase/schema.sql e
-- a migração 002. Pode rodar a 002 de novo depois desta sem perder nada.
--
-- Para a limpeza automática diária, ative a extensão pg_cron
-- (Database > Extensions > pg_cron) e rode este arquivo de novo.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Times
-- ------------------------------------------------------------
create table if not exists public.crono_team (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists crono_team_owner_idx on public.crono_team (owner_id);

create table if not exists public.crono_team_member (
  team_id    uuid not null references public.crono_team(id) on delete cascade,
  email      text not null check (email = lower(email) and position('@' in email) > 1),
  role       text not null default 'member' check (role in ('member', 'manager')),
  created_at timestamptz not null default now(),
  primary key (team_id, email)
);
create index if not exists crono_team_member_email_idx on public.crono_team_member (email);

create table if not exists public.crono_study_team_share (
  study_id   text not null references public.crono_study(id) on delete cascade,
  team_id    uuid not null references public.crono_team(id) on delete cascade,
  role       text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (study_id, team_id)
);
create index if not exists crono_study_team_share_team_idx on public.crono_study_team_share (team_id);

-- Papel do usuário atual num time: 'owner' | 'manager' | 'member' | null
create or replace function public.crono_team_role(p_team_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.crono_team t where t.id = p_team_id and t.owner_id = auth.uid()) then 'owner'
    else (select m.role from public.crono_team_member m
          where m.team_id = p_team_id and m.email = lower(coalesce(auth.jwt() ->> 'email', '')))
  end;
$$;
revoke all on function public.crono_team_role(uuid) from public, anon;
grant execute on function public.crono_team_role(uuid) to authenticated;

-- Papel no estudo vindo de compartilhamento direto (e-mail) OU de um time.
-- (mesma definição da migração 002 — as duas ficam iguais de propósito)
create or replace function public.crono_shared_role(p_study_id text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  me text := lower(coalesce(auth.jwt() ->> 'email', ''));
  r text;
  t text;
begin
  select s.role into r from public.crono_study_share s where s.study_id = p_study_id and s.email = me;
  if r = 'editor' then return r; end if;
  -- times (migração 003): o papel mais forte entre os times de que a pessoa participa
  if to_regclass('public.crono_study_team_share') is not null then
    select case when bool_or(ts.role = 'editor') then 'editor' when count(*) > 0 then 'viewer' end into t
    from public.crono_study_team_share ts
    where ts.study_id = p_study_id
      and (exists (select 1 from public.crono_team_member m where m.team_id = ts.team_id and m.email = me)
           or exists (select 1 from public.crono_team t2 where t2.id = ts.team_id and t2.owner_id = auth.uid()));
    if t = 'editor' then return t; end if;
    r := coalesce(r, t);
  end if;
  return r;
end $$;
revoke all on function public.crono_shared_role(text) from public, anon;
grant execute on function public.crono_shared_role(text) to authenticated;

create or replace function public.crono_can_read_study(p_study_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.crono_owns_study(p_study_id) or public.crono_shared_role(p_study_id) is not null;
$$;
create or replace function public.crono_can_edit_study(p_study_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.crono_owns_study(p_study_id) or public.crono_shared_role(p_study_id) = 'editor';
$$;
revoke all on function public.crono_can_read_study(text) from public, anon;
revoke all on function public.crono_can_edit_study(text) from public, anon;
grant execute on function public.crono_can_read_study(text) to authenticated;
grant execute on function public.crono_can_edit_study(text) to authenticated;

-- Servidor define dono e data do time
create or replace function public.crono_team_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.owner_id := auth.uid();
  new.created_at := now();
  return new;
end $$;
drop trigger if exists crono_team_before_insert on public.crono_team;
create trigger crono_team_before_insert before insert on public.crono_team
  for each row execute function public.crono_team_before_insert();

create or replace function public.crono_team_before_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.owner_id := old.owner_id;
  new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists crono_team_before_update on public.crono_team;
create trigger crono_team_before_update before update on public.crono_team
  for each row execute function public.crono_team_before_update();

alter table public.crono_team enable row level security;
drop policy if exists "membros veem o time" on public.crono_team;
create policy "membros veem o time" on public.crono_team
  for select using (owner_id = auth.uid() or public.crono_team_role(id) is not null);
drop policy if exists "usuario cria time" on public.crono_team;
create policy "usuario cria time" on public.crono_team
  for insert with check (owner_id = auth.uid());
drop policy if exists "dono altera time" on public.crono_team;
create policy "dono altera time" on public.crono_team
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
drop policy if exists "dono exclui time" on public.crono_team;
create policy "dono exclui time" on public.crono_team
  for delete using (owner_id = auth.uid());

alter table public.crono_team_member enable row level security;
drop policy if exists "membros veem membros" on public.crono_team_member;
create policy "membros veem membros" on public.crono_team_member
  for select using (public.crono_team_role(team_id) is not null);
drop policy if exists "gestor adiciona membro" on public.crono_team_member;
create policy "gestor adiciona membro" on public.crono_team_member
  for insert with check (public.crono_team_role(team_id) in ('owner', 'manager'));
drop policy if exists "gestor altera membro" on public.crono_team_member;
create policy "gestor altera membro" on public.crono_team_member
  for update using (public.crono_team_role(team_id) in ('owner', 'manager'))
  with check (public.crono_team_role(team_id) in ('owner', 'manager'));
drop policy if exists "gestor remove ou membro sai" on public.crono_team_member;
create policy "gestor remove ou membro sai" on public.crono_team_member
  for delete using (public.crono_team_role(team_id) in ('owner', 'manager')
                    or email = lower(coalesce(auth.jwt() ->> 'email', '')));

alter table public.crono_study_team_share enable row level security;
drop policy if exists "dono do estudo ou time ve" on public.crono_study_team_share;
create policy "dono do estudo ou time ve" on public.crono_study_team_share
  for select using (public.crono_owns_study(study_id) or public.crono_team_role(team_id) is not null);
drop policy if exists "dono compartilha com seu time" on public.crono_study_team_share;
create policy "dono compartilha com seu time" on public.crono_study_team_share
  for insert with check (public.crono_owns_study(study_id) and public.crono_team_role(team_id) is not null);
drop policy if exists "dono altera papel do time" on public.crono_study_team_share;
create policy "dono altera papel do time" on public.crono_study_team_share
  for update using (public.crono_owns_study(study_id)) with check (public.crono_owns_study(study_id) and public.crono_team_role(team_id) is not null);
drop policy if exists "dono ou gestor remove do time" on public.crono_study_team_share;
create policy "dono ou gestor remove do time" on public.crono_study_team_share
  for delete using (public.crono_owns_study(study_id) or public.crono_team_role(team_id) in ('owner', 'manager'));

-- Papel em cada estudo compartilhado comigo (direto ou por time)
create or replace function public.crono_my_study_roles()
returns table (study_id text, role text)
language sql stable security definer set search_path = public as $$
  with me as (select lower(coalesce(auth.jwt() ->> 'email', '')) as email, auth.uid() as uid),
  roles as (
    select s.study_id, s.role from public.crono_study_share s, me where s.email = me.email
    union all
    select ts.study_id, ts.role from public.crono_study_team_share ts, me
    where exists (select 1 from public.crono_team_member m where m.team_id = ts.team_id and m.email = me.email)
       or exists (select 1 from public.crono_team t where t.id = ts.team_id and t.owner_id = me.uid)
  )
  select r.study_id, case when bool_or(r.role = 'editor') then 'editor' else 'viewer' end
  from roles r join public.crono_study st on st.id = r.study_id, me
  where st.owner_id is distinct from me.uid
  group by r.study_id;
$$;
revoke all on function public.crono_my_study_roles() from public, anon;
grant execute on function public.crono_my_study_roles() to authenticated;


-- ------------------------------------------------------------
-- 2) Tempo real: o app recebe um aviso quando um estudo visível muda
--    (as regras de acesso acima continuam valendo para os avisos)
-- ------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['crono_study', 'crono_study_share', 'crono_study_team_share', 'crono_team_member'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;
-- avisos de remoção precisam da linha inteira (para filtrar por e-mail)
alter table public.crono_study_share replica identity full;
alter table public.crono_study_team_share replica identity full;
alter table public.crono_team_member replica identity full;


-- ------------------------------------------------------------
-- 3) Erros do aplicativo (somente administradores leem)
-- ------------------------------------------------------------
create table if not exists public.crono_client_error (
  id          bigserial primary key,
  user_id     uuid default auth.uid() references auth.users(id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now(),
  message     text not null check (char_length(message) <= 1000),
  stack       text check (char_length(stack) <= 8000),
  url         text check (char_length(url) <= 500),
  app_version text check (char_length(app_version) <= 40),
  user_agent  text check (char_length(user_agent) <= 400),
  context     jsonb check (pg_column_size(context) <= 4000)
);
create index if not exists crono_client_error_created_idx on public.crono_client_error (created_at desc);

create or replace function public.crono_client_error_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.user_id := auth.uid();
  new.email := lower(coalesce(auth.jwt() ->> 'email', ''));
  new.created_at := now();
  -- no máximo 100 erros por usuário por hora (o excesso é descartado em silêncio)
  if (select count(*) from public.crono_client_error
      where user_id = new.user_id and created_at > now() - interval '1 hour') >= 100 then
    return null;
  end if;
  return new;
end $$;
drop trigger if exists crono_client_error_before_insert on public.crono_client_error;
create trigger crono_client_error_before_insert before insert on public.crono_client_error
  for each row execute function public.crono_client_error_before_insert();

alter table public.crono_client_error enable row level security;
drop policy if exists "usuario registra erro" on public.crono_client_error;
create policy "usuario registra erro" on public.crono_client_error
  for insert to authenticated with check (auth.uid() is not null);
drop policy if exists "admins leem erros" on public.crono_client_error;
create policy "admins leem erros" on public.crono_client_error
  for select using (public.crono_is_admin());
drop policy if exists "admins apagam erros" on public.crono_client_error;
create policy "admins apagam erros" on public.crono_client_error
  for delete using (public.crono_is_admin());


-- ------------------------------------------------------------
-- 4) Verificação em duas etapas: quem ativou só acessa os dados com a sessão
--    verificada (aal2). Quem não ativou continua como antes.
-- ------------------------------------------------------------
create or replace function public.crono_aal_ok()
returns boolean language plpgsql stable security definer set search_path = public, auth as $$
begin
  if coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then return true; end if;
  if to_regclass('auth.mfa_factors') is null then return true; end if;
  return not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified');
end $$;
revoke all on function public.crono_aal_ok() from public, anon;
grant execute on function public.crono_aal_ok() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['crono_studies', 'crono_study', 'crono_study_share', 'crono_study_version',
                           'crono_team', 'crono_team_member', 'crono_study_team_share'] loop
    execute format('drop policy if exists "exige duas etapas quando ativada" on public.%I', t);
    execute format('create policy "exige duas etapas quando ativada" on public.%I as restrictive for all to authenticated
                    using (public.crono_aal_ok()) with check (public.crono_aal_ok())', t);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 5) Fotos dos registros: bucket privado; o caminho começa pelo id do estudo
--    ("<estudo>/<foto>.jpg") e o acesso segue o acesso ao estudo.
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('crono-photos', 'crono-photos', false, 5242880, array['image/jpeg', 'image/webp', 'image/png'])
    on conflict (id) do update set public = false,
      file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists "crono fotos: ler" on storage.objects';
    execute $p$create policy "crono fotos: ler" on storage.objects for select to authenticated
      using (bucket_id = 'crono-photos' and public.crono_aal_ok()
             and public.crono_can_read_study((storage.foldername(name))[1]))$p$;
    execute 'drop policy if exists "crono fotos: enviar" on storage.objects';
    execute $p$create policy "crono fotos: enviar" on storage.objects for insert to authenticated
      with check (bucket_id = 'crono-photos' and public.crono_aal_ok()
                  and public.crono_can_edit_study((storage.foldername(name))[1]))$p$;
    execute 'drop policy if exists "crono fotos: substituir" on storage.objects';
    execute $p$create policy "crono fotos: substituir" on storage.objects for update to authenticated
      using (bucket_id = 'crono-photos' and public.crono_aal_ok()
             and public.crono_can_edit_study((storage.foldername(name))[1]))$p$;
    execute 'drop policy if exists "crono fotos: apagar" on storage.objects';
    execute $p$create policy "crono fotos: apagar" on storage.objects for delete to authenticated
      using (bucket_id = 'crono-photos' and public.crono_aal_ok()
             and public.crono_can_edit_study((storage.foldername(name))[1]))$p$;
  end if;
end $$;


-- ------------------------------------------------------------
-- 6) Retenção de dados (LGPD)
--    erros: 90 dias · versões anteriores: 90 dias · estudos excluídos: 180 dias
--    (mesmo prazo das "lápides" no aparelho) · registro de acessos de quem não
--    entra há 24 meses.
-- ------------------------------------------------------------
create or replace function public.crono_purge_old_data()
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_err int; n_ver int; n_del int; n_act int;
begin
  -- sem usuário = agendador (pg_cron); com usuário, só administradores
  if auth.uid() is not null and not public.crono_is_admin() then
    raise exception 'Acesso restrito' using errcode = '42501';
  end if;
  delete from public.crono_client_error where created_at < now() - interval '90 days';
  get diagnostics n_err = row_count;
  delete from public.crono_study_version where created_at < now() - interval '90 days';
  get diagnostics n_ver = row_count;
  delete from public.crono_study where deleted_at is not null and deleted_at < now() - interval '180 days';
  get diagnostics n_del = row_count;
  delete from public.crono_user_activity where last_seen < now() - interval '24 months';
  get diagnostics n_act = row_count;
  return jsonb_build_object('erros', n_err, 'versoes', n_ver, 'estudos_excluidos', n_del, 'acessos', n_act);
end $$;
revoke all on function public.crono_purge_old_data() from public, anon;
grant execute on function public.crono_purge_old_data() to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crono-purge-old-data', '17 3 * * *', 'select public.crono_purge_old_data()');
  end if;
exception when others then
  raise notice 'Limpeza automática não agendada (pg_cron): %', sqlerrm;
end $$;


-- ------------------------------------------------------------
-- 7) Excluir minha conta: também times, participações e erros
--    (mesma definição da migração 002 — as duas ficam iguais de propósito;
--    as fotos são apagadas pelo app, pela API do Storage, antes de chamar)
-- ------------------------------------------------------------
create or replace function public.crono_delete_account()
returns void language plpgsql security definer set search_path = public, auth as $$
declare
  uid uuid := auth.uid();
  me text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if uid is null then
    raise exception 'Não autenticado' using errcode = '42501';
  end if;
  delete from public.crono_study where owner_id = uid;          -- leva compartilhamentos e versões (cascade)
  delete from public.crono_study_share where email = me;
  if to_regclass('public.crono_team') is not null then
    delete from public.crono_team where owner_id = uid;         -- leva membros e compartilhamentos do time
    delete from public.crono_team_member where email = me;
  end if;
  if to_regclass('public.crono_client_error') is not null then
    delete from public.crono_client_error where user_id = uid;
  end if;
  delete from public.crono_studies where user_id = uid;
  delete from public.crono_user_activity where user_id = uid;
  delete from auth.users where id = uid;
end $$;
revoke all on function public.crono_delete_account() from public, anon;
grant execute on function public.crono_delete_account() to authenticated;
