-- ============================================================
-- CronoAnálise — migração 002
--   * um estudo por linha (sincronização incremental, sem limite de tamanho)
--   * compartilhamento de estudos (leitura ou edição) por e-mail
--   * versões anteriores dos estudos no servidor (backup automático, 90 dias)
--   * administradores em tabela (em vez de e-mail fixo no código)
--   * estatísticas para o painel de administração
--   * "excluir minha conta e meus dados" (LGPD)
--
-- Como rodar: Supabase > SQL Editor > New query > colar tudo > Run.
-- É idempotente (pode rodar de novo). Pré-requisito: supabase/schema.sql
-- (tabelas crono_studies e crono_user_activity, que já existem).
--
-- O app detecta sozinho quando esta migração foi aplicada: na próxima
-- sincronização, cada aparelho copia os estudos da tabela antiga
-- (crono_studies, que é mantida intacta como backup) para crono_study.
-- ============================================================


-- ------------------------------------------------------------
-- 1) Administradores
-- ------------------------------------------------------------
create table if not exists public.crono_admins (
  email      text primary key check (email = lower(email)),
  created_at timestamptz not null default now()
);
alter table public.crono_admins enable row level security;

drop policy if exists "admin ve propria linha" on public.crono_admins;
create policy "admin ve propria linha" on public.crono_admins
  for select using (email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- admin inicial (troque/adicione e-mails aqui ou pela tabela no painel do Supabase)
insert into public.crono_admins (email) values ('daniel.thomaseto@dhl.com') on conflict do nothing;

create or replace function public.crono_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.crono_admins
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.crono_is_admin() from public, anon;
grant execute on function public.crono_is_admin() to authenticated;

-- admins da tabela também veem a atividade de todos
drop policy if exists "admins veem toda atividade" on public.crono_user_activity;
create policy "admins veem toda atividade" on public.crono_user_activity
  for select using (public.crono_is_admin());


-- ------------------------------------------------------------
-- 2) Estudos: uma linha por estudo
--    data = o estudo em JSON (mesmo formato usado pelo app)
--    deleted_at = exclusão (a linha é mantida para propagar a exclusão)
--    updated_at é definido pelo servidor a cada gravação
-- ------------------------------------------------------------
create table if not exists public.crono_study (
  id          text primary key,
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_email text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists crono_study_owner_idx on public.crono_study (owner_id);
create index if not exists crono_study_updated_idx on public.crono_study (updated_at);

create table if not exists public.crono_study_share (
  study_id   text not null references public.crono_study(id) on delete cascade,
  email      text not null check (email = lower(email)),
  role       text not null check (role in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (study_id, email)
);
create index if not exists crono_study_share_email_idx on public.crono_study_share (email);

create table if not exists public.crono_study_version (
  id         bigserial primary key,
  study_id   text not null references public.crono_study(id) on delete cascade,
  data       jsonb not null,
  saved_at   timestamptz not null,           -- quando aquela versão foi gravada
  created_at timestamptz not null default now(),
  saved_by   uuid
);
create index if not exists crono_study_version_idx on public.crono_study_version (study_id, created_at desc);

-- Funções auxiliares (security definer evitam recursão entre as policies)
create or replace function public.crono_shared_role(p_study_id text)
returns text language sql stable security definer set search_path = public as $$
  select role from public.crono_study_share
  where study_id = p_study_id and email = lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.crono_owns_study(p_study_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.crono_study where id = p_study_id and owner_id = auth.uid());
$$;

revoke all on function public.crono_shared_role(text) from public, anon;
revoke all on function public.crono_owns_study(text) from public, anon;
grant execute on function public.crono_shared_role(text) to authenticated;
grant execute on function public.crono_owns_study(text) to authenticated;

-- RLS: estudos
alter table public.crono_study enable row level security;

drop policy if exists "dono ou compartilhado le" on public.crono_study;
create policy "dono ou compartilhado le" on public.crono_study
  for select using (owner_id = auth.uid() or public.crono_shared_role(id) is not null);

drop policy if exists "dono cria" on public.crono_study;
create policy "dono cria" on public.crono_study
  for insert with check (owner_id = auth.uid());

drop policy if exists "dono ou editor atualiza" on public.crono_study;
create policy "dono ou editor atualiza" on public.crono_study
  for update using (owner_id = auth.uid() or public.crono_shared_role(id) = 'editor')
  with check (owner_id = auth.uid() or public.crono_shared_role(id) = 'editor');
-- (sem DELETE: exclusão é por deleted_at, permitida só ao dono — ver gatilho)

-- RLS: compartilhamentos
alter table public.crono_study_share enable row level security;

drop policy if exists "dono ou convidado ve" on public.crono_study_share;
create policy "dono ou convidado ve" on public.crono_study_share
  for select using (public.crono_owns_study(study_id) or email = lower(coalesce(auth.jwt() ->> 'email', '')));

drop policy if exists "dono compartilha" on public.crono_study_share;
create policy "dono compartilha" on public.crono_study_share
  for insert with check (public.crono_owns_study(study_id));

drop policy if exists "dono altera papel" on public.crono_study_share;
create policy "dono altera papel" on public.crono_study_share
  for update using (public.crono_owns_study(study_id)) with check (public.crono_owns_study(study_id));

drop policy if exists "dono remove ou convidado sai" on public.crono_study_share;
create policy "dono remove ou convidado sai" on public.crono_study_share
  for delete using (public.crono_owns_study(study_id) or email = lower(coalesce(auth.jwt() ->> 'email', '')));

-- RLS: versões (leitura para quem pode ver o estudo; gravação só pelo gatilho)
alter table public.crono_study_version enable row level security;

drop policy if exists "quem ve o estudo ve as versoes" on public.crono_study_version;
create policy "quem ve o estudo ve as versoes" on public.crono_study_version
  for select using (public.crono_owns_study(study_id) or public.crono_shared_role(study_id) is not null);

-- Gatilhos: servidor controla datas e dono; guarda versões anteriores
create or replace function public.crono_study_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.owner_id := auth.uid();
  new.owner_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  new.created_at := now();
  new.updated_at := now();
  return new;
end $$;

create or replace function public.crono_study_before_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.owner_id := old.owner_id;
  new.owner_email := old.owner_email;
  new.created_at := old.created_at;
  if new.deleted_at is distinct from old.deleted_at and old.owner_id is distinct from auth.uid() then
    raise exception 'Só o dono pode excluir ou restaurar o estudo' using errcode = '42501';
  end if;
  new.updated_at := now();
  -- versão anterior: no máximo uma a cada 10 minutos por estudo
  if old.data is distinct from new.data and not exists (
    select 1 from public.crono_study_version v
    where v.study_id = old.id and v.created_at > now() - interval '10 minutes'
  ) then
    insert into public.crono_study_version (study_id, data, saved_at, saved_by)
    values (old.id, old.data, old.updated_at, auth.uid());
  end if;
  delete from public.crono_study_version
  where study_id = old.id and created_at < now() - interval '90 days';
  return new;
end $$;

drop trigger if exists crono_study_before_insert on public.crono_study;
create trigger crono_study_before_insert before insert on public.crono_study
  for each row execute function public.crono_study_before_insert();

drop trigger if exists crono_study_before_update on public.crono_study;
create trigger crono_study_before_update before update on public.crono_study
  for each row execute function public.crono_study_before_update();

-- Lista de versões de um estudo (sem trafegar o conteúdo)
create or replace function public.crono_study_versions(p_study_id text)
returns table (id bigint, saved_at timestamptz, records integer, name text)
language sql stable security invoker set search_path = public as $$
  select v.id, v.saved_at,
         coalesce(jsonb_array_length(v.data -> 'records'), 0),
         v.data ->> 'name'
  from public.crono_study_version v
  where v.study_id = p_study_id
  order by v.saved_at desc
  limit 50;
$$;
revoke all on function public.crono_study_versions(text) from public, anon;
grant execute on function public.crono_study_versions(text) to authenticated;


-- ------------------------------------------------------------
-- 3) Estatísticas para o painel de administração (sem conteúdo dos estudos)
-- ------------------------------------------------------------
create or replace function public.crono_admin_stats()
returns table (
  user_id uuid, email text, first_seen timestamptz, last_seen timestamptz,
  login_count integer, studies integer, records integer, shares integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.crono_is_admin() then
    raise exception 'Acesso restrito' using errcode = '42501';
  end if;
  return query
  select a.user_id, a.email, a.first_seen, a.last_seen, a.login_count,
         (case when st.n > 0 then st.n else coalesce(bl.n, 0) end)::integer,
         (case when st.n > 0 then st.r else coalesce(bl.r, 0) end)::integer,
         coalesce(sh.n, 0)::integer
  from public.crono_user_activity a
  left join lateral (
    select count(*) as n, coalesce(sum(coalesce(jsonb_array_length(s.data -> 'records'), 0)), 0) as r
    from public.crono_study s
    where s.owner_id = a.user_id and s.deleted_at is null
  ) st on true
  left join lateral (
    select count(*) as n, coalesce(sum(coalesce(jsonb_array_length(e.value -> 'records'), 0)), 0) as r
    from public.crono_studies b,
         jsonb_each(case when b.data ? 'format' then coalesce(b.data -> 'studies', '{}'::jsonb) else b.data end) e
    where b.user_id = a.user_id and jsonb_typeof(e.value) = 'object'
  ) bl on true
  left join lateral (
    select count(*) as n
    from public.crono_study_share x join public.crono_study s on s.id = x.study_id
    where s.owner_id = a.user_id
  ) sh on true
  order by a.last_seen desc;
end $$;
revoke all on function public.crono_admin_stats() from public, anon;
grant execute on function public.crono_admin_stats() to authenticated;


-- ------------------------------------------------------------
-- 4) Excluir minha conta e meus dados (LGPD)
-- ------------------------------------------------------------
create or replace function public.crono_delete_account()
returns void language plpgsql security definer set search_path = public, auth as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Não autenticado' using errcode = '42501';
  end if;
  delete from public.crono_study where owner_id = uid;          -- leva compartilhamentos e versões (cascade)
  delete from public.crono_study_share where email = lower(coalesce(auth.jwt() ->> 'email', ''));
  delete from public.crono_studies where user_id = uid;
  delete from public.crono_user_activity where user_id = uid;
  delete from auth.users where id = uid;
end $$;
revoke all on function public.crono_delete_account() from public, anon;
grant execute on function public.crono_delete_account() to authenticated;
