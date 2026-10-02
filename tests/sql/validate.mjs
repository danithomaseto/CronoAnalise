/* Valida supabase/schema.sql e as migrações 002 e 003 num Postgres de verdade,
   com esquemas "auth" e "storage" parecidos com os do Supabase (papéis,
   auth.uid(), auth.jwt(), fatores de MFA, buckets e objetos).
   Testa regras de acesso (RLS), gatilhos, times, fotos, MFA, retenção,
   funções de admin e excluir conta.
   Uso:  npm i --no-save embedded-postgres pg && npm run test:sql */
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pgDir = path.join(os.tmpdir(), 'cronoanalise-pg-' + process.pid + '-' + Date.now());
const server = new EmbeddedPostgres({
  databaseDir: pgDir, user: 'postgres', password: 'pw', port: 54329, persistent: false,
  createPostgresUser: typeof process.getuid === 'function' && process.getuid() === 0, // Postgres não roda como root
  onLog: () => {}
});
await server.initialise();
await server.start();
const db = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'pw', database: 'postgres' });
await db.connect();

let ok = 0, fail = 0;
const check = (c, m) => { if (c) { ok++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FALHOU: ' + m); } };
const q = (sql, params) => db.query(sql, params);

// ---- Ambiente parecido com o Supabase ----
await q(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users(id) on delete cascade, status text);
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid default auth.uid());
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema storage to anon, authenticated;
  grant all on all tables in schema storage to anon, authenticated;
  grant execute on all functions in schema storage to anon, authenticated;
  create publication supabase_realtime;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);
const ANA = '11111111-1111-1111-1111-111111111111', BIA = '22222222-2222-2222-2222-222222222222', ADM = '33333333-3333-3333-3333-333333333333';
await q(`insert into auth.users values ($1,'ana@x.com'),($2,'bia@x.com'),($3,'daniel.thomaseto@dhl.com')`, [ANA, BIA, ADM]);

const M2 = fs.readFileSync(REPO + '/supabase/migrations/002_estudos_por_linha.sql', 'utf8');
const M3 = fs.readFileSync(REPO + '/supabase/migrations/003_equipe_seguranca.sql', 'utf8');
console.log('▶ aplicando schema.sql e as migrações 002 e 003 (2x, para testar idempotência)');
for (let i = 0; i < 2; i++) {
  try { await q(fs.readFileSync(REPO + '/supabase/schema.sql', 'utf8')); check(true, `schema.sql aplicado (${i + 1}ª vez)`); }
  catch (e) { check(false, 'schema.sql: ' + e.message); }
  try { await q(M2); check(true, `002 aplicada (${i + 1}ª vez)`); }
  catch (e) { check(false, '002: ' + e.message + (e.position ? ' @' + e.position : '')); }
  try { await q(M3); check(true, `003 aplicada (${i + 1}ª vez)`); }
  catch (e) { check(false, '003: ' + e.message + (e.position ? ' @' + e.position : '')); }
}
try { await q(M2); check(true, '002 aplicada de novo depois da 003'); }
catch (e) { check(false, '002 depois da 003: ' + e.message); }

// executa como usuário autenticado (como o PostgREST faz)
async function as(uid, email, fn) {
  await q('begin');
  try {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, email, role: 'authenticated' })]);
    await q('set local role authenticated');
    return await fn();
  } finally { await q('rollback').catch(() => {}); }
}
async function asCommit(uid, email, fn) {
  await q('begin');
  try {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, email, role: 'authenticated' })]);
    await q('set local role authenticated');
    const r = await fn();
    await q('commit');
    return r;
  } catch (e) { await q('rollback').catch(() => {}); throw e; }
}
const errCode = async p => { try { await p; return null; } catch (e) { return e.code || e.message; } };

console.log('▶ estudos (uma linha por estudo)');
const ins = await asCommit(ANA, 'ana@x.com', () => q(`insert into crono_study (id, data, owner_id) values ('s1', '{"name":"Estudo da Ana","records":[]}', $1) returning owner_id, owner_email, updated_at::text`, [BIA]));
check(ins.rows[0].owner_id === ANA && ins.rows[0].owner_email === 'ana@x.com', 'dono definido pelo servidor (não dá para criar em nome de outro)');
const v0 = ins.rows[0].updated_at;
check((await as(BIA, 'bia@x.com', () => q('select * from crono_study'))).rowCount === 0, 'Bia não vê o estudo da Ana');
check((await as(BIA, 'bia@x.com', () => q(`update crono_study set data='{}' where id='s1'`))).rowCount === 0, 'Bia não consegue alterar');
check(await errCode(as(BIA, 'bia@x.com', () => q(`insert into crono_study_share values ('s1','bia@x.com','editor')`))) === '42501', 'Bia não consegue se auto-compartilhar');

await new Promise(r => setTimeout(r, 20));
const upd = await asCommit(ANA, 'ana@x.com', () => q(`update crono_study set data='{"name":"Estudo da Ana","records":[{"id":"r1"}]}', owner_id=$1, updated_at='2000-01-01' where id='s1' and updated_at=$2 returning owner_id, updated_at::text`, [BIA, v0]));
check(upd.rowCount === 1, 'UPDATE condicional com o updated_at lido funciona');
check(upd.rows[0].owner_id === ANA, 'dono não muda num UPDATE');
check(Date.parse(upd.rows[0].updated_at) > Date.parse(v0) && !upd.rows[0].updated_at.startsWith('2000'), 'updated_at definido pelo servidor (ignora o enviado): ' + upd.rows[0].updated_at);
const stale = await asCommit(ANA, 'ana@x.com', () => q(`update crono_study set data='{}' where id='s1' and updated_at=$1`, [v0]));
check(stale.rowCount === 0, 'UPDATE com versão antiga não grava (detecta conflito)');
check((await q(`select count(*)::int n from crono_study_version where study_id='s1'`)).rows[0].n === 1, 'versão anterior guardada pelo gatilho');
await asCommit(ANA, 'ana@x.com', () => q(`update crono_study set data='{"name":"x","records":[]}' where id='s1'`));
check((await q(`select count(*)::int n from crono_study_version where study_id='s1'`)).rows[0].n === 1, 'no máximo 1 versão a cada 10 min');

console.log('▶ compartilhamento');
await asCommit(ANA, 'ana@x.com', () => q(`insert into crono_study_share values ('s1','bia@x.com','viewer')`));
check((await as(BIA, 'bia@x.com', () => q('select id from crono_study'))).rowCount === 1, 'Bia (viewer) vê o estudo');
check((await as(BIA, 'bia@x.com', () => q(`update crono_study set data='{}' where id='s1'`))).rowCount === 0, 'viewer não altera');
check((await as(BIA, 'bia@x.com', () => q(`select * from crono_study_versions('s1')`))).rowCount === 1, 'viewer vê as versões (RPC)');
await asCommit(ANA, 'ana@x.com', () => q(`update crono_study_share set role='editor' where study_id='s1' and email='bia@x.com'`));
check((await as(BIA, 'bia@x.com', () => q(`update crono_study set data='{"name":"editado pela Bia"}' where id='s1'`))).rowCount === 1, 'editor altera');
check(await errCode(as(BIA, 'bia@x.com', () => q(`update crono_study set deleted_at=now() where id='s1'`))) === '42501', 'editor não exclui (só o dono)');
check((await as(BIA, 'bia@x.com', () => q(`select * from crono_study_share`))).rowCount === 1, 'convidado vê o próprio convite');
check((await as(BIA, 'bia@x.com', () => q(`delete from crono_study_share where study_id='s1' and email='bia@x.com'`))).rowCount === 1, 'convidado pode sair');
check((await as(ANA, 'ana@x.com', () => q(`update crono_study set deleted_at=now() where id='s1'`))).rowCount === 1, 'dono exclui (deleted_at)');
check(await errCode(as(ANA, 'ana@x.com', () => q(`insert into crono_study_share values ('s1','Maiuscula@X.com','viewer')`))) === '23514', 'e-mail do convite precisa estar em minúsculas');

console.log('▶ administração e acessos');
check((await as(ADM, 'daniel.thomaseto@dhl.com', () => q('select crono_is_admin() a'))).rows[0].a === true, 'crono_is_admin() verdadeiro para o admin');
check((await as(ANA, 'ana@x.com', () => q('select crono_is_admin() a'))).rows[0].a === false, 'crono_is_admin() falso para os outros');
await asCommit(ANA, 'ana@x.com', () => q('select crono_log_activity()'));
await asCommit(ANA, 'ana@x.com', () => q('select crono_log_activity()'));
await asCommit(BIA, 'bia@x.com', () => q('select crono_log_activity()'));
check((await q(`select login_count from crono_user_activity where user_id=$1`, [ANA])).rows[0].login_count === 2, 'crono_log_activity() conta os acessos no servidor');
await asCommit(BIA, 'bia@x.com', () => q(`insert into crono_studies (user_id, data) values ($1, '{"Antigo":{"records":[{"a":1},{"b":2}]}}')`, [BIA]));
const st = await as(ADM, 'daniel.thomaseto@dhl.com', () => q('select * from crono_admin_stats()'));
const ana = st.rows.find(r => r.email === 'ana@x.com'), bia = st.rows.find(r => r.email === 'bia@x.com');
check(st.rowCount === 2 && ana.login_count === 2, 'crono_admin_stats() lista os usuários');
check(bia.studies === 1 && bia.records === 2, 'estatísticas contam estudos da tabela antiga (formato v2)');
check(await errCode(as(ANA, 'ana@x.com', () => q('select * from crono_admin_stats()'))) === '42501', 'crono_admin_stats() bloqueado para não-admin');
check((await as(ADM, 'daniel.thomaseto@dhl.com', () => q('select * from crono_user_activity'))).rowCount === 2, 'admin vê toda a atividade');
check((await as(ANA, 'ana@x.com', () => q('select * from crono_user_activity'))).rowCount === 1, 'usuário vê só a própria atividade');

console.log('▶ times');
const CAR = '44444444-4444-4444-4444-444444444444';
await q(`insert into auth.users values ($1,'carla@x.com')`, [CAR]);
await asCommit(ANA, 'ana@x.com', () => q(`insert into crono_study (id, data) values ('s3', '{"name":"Linha do time"}')`));
const team = (await asCommit(ANA, 'ana@x.com', () => q(`insert into crono_team (name, owner_id) values ('Site Cajamar', $1) returning id, owner_id`, [BIA]))).rows[0];
check(team && team.owner_id === ANA, 'time criado (insert + returning) com dono definido pelo servidor');
const T = team.id;
await asCommit(ANA, 'ana@x.com', () => q(`insert into crono_team_member (team_id, email, role) values ($1,'bia@x.com','member')`, [T]));
check((await as(BIA, 'bia@x.com', () => q('select name from crono_team'))).rows.map(r => r.name).join() === 'Site Cajamar', 'membro vê o time');
check((await as(CAR, 'carla@x.com', () => q('select * from crono_team'))).rowCount === 0, 'quem não é do time não vê o time');
check(await errCode(as(BIA, 'bia@x.com', () => q(`insert into crono_team_member values ($1,'carla@x.com','member')`, [T]))) === '42501', 'membro comum não adiciona pessoas');
check((await as(BIA, 'bia@x.com', () => q('select * from crono_study where id=$1', ['s3']))).rowCount === 0, 'sem compartilhar, o time não vê o estudo');
await asCommit(ANA, 'ana@x.com', () => q(`insert into crono_study_team_share values ('s3', $1, 'viewer')`, [T]));
check((await as(BIA, 'bia@x.com', () => q('select * from crono_study where id=$1', ['s3']))).rowCount === 1, 'membro vê o estudo compartilhado com o time');
check((await as(BIA, 'bia@x.com', () => q(`update crono_study set data='{}' where id='s3'`))).rowCount === 0, 'time com "ver" não altera');
check((await as(CAR, 'carla@x.com', () => q('select * from crono_study where id=$1', ['s3']))).rowCount === 0, 'quem está fora do time não vê o estudo');
const roles = (await as(BIA, 'bia@x.com', () => q('select * from crono_my_study_roles()'))).rows;
check(roles.some(r => r.study_id === 's3' && r.role === 'viewer') && !roles.some(r => r.study_id === 's4'), 'crono_my_study_roles() devolve o papel vindo do time: ' + JSON.stringify(roles));
await asCommit(ANA, 'ana@x.com', () => q(`update crono_study_team_share set role='editor' where study_id='s3'`));
check((await as(BIA, 'bia@x.com', () => q(`update crono_study set data='{"name":"pelo time"}' where id='s3'`))).rowCount === 1, 'time com "editar" altera');
check(await errCode(as(BIA, 'bia@x.com', () => q(`update crono_study set deleted_at=now() where id='s3'`))) === '42501', 'membro do time não exclui o estudo');
await asCommit(ANA, 'ana@x.com', () => q(`update crono_team_member set role='manager' where team_id=$1 and email='bia@x.com'`, [T]));
check((await asCommit(BIA, 'bia@x.com', () => q(`insert into crono_team_member values ($1,'carla@x.com','member')`, [T]))).rowCount === 1, 'gestor adiciona pessoas');
check((await as(CAR, 'carla@x.com', () => q('select * from crono_study where id=$1', ['s3']))).rowCount === 1, 'nova integrante já vê o estudo do time');
await asCommit(BIA, 'bia@x.com', () => q(`insert into crono_study (id, data) values ('s4', '{"name":"Da Bia"}')`));
check(await errCode(as(CAR, 'carla@x.com', () => q(`insert into crono_study_team_share values ('s4', $1, 'viewer')`, [T]))) === '42501', 'só o dono do estudo compartilha com o time');
check(await errCode(as(ANA, 'ana@x.com', () => q(`update crono_team set owner_id=$1 where id=$2`, [CAR, T]))) === null &&
  (await q('select owner_id from crono_team where id=$1', [T])).rows[0].owner_id === ANA, 'dono do time não muda num UPDATE');
check((await asCommit(CAR, 'carla@x.com', () => q(`delete from crono_team_member where team_id=$1 and email='carla@x.com'`, [T]))).rowCount === 1, 'integrante pode sair do time');
check((await as(CAR, 'carla@x.com', () => q('select * from crono_study where id=$1', ['s3']))).rowCount === 0, 'quem saiu do time perde o acesso');

console.log('▶ fotos (Storage)');
await q(`select 1`);
check((await q(`select public from storage.buckets where id='crono-photos'`)).rows[0]?.public === false, 'bucket privado crono-photos criado');
check((await asCommit(ANA, 'ana@x.com', () => q(`insert into storage.objects (bucket_id, name) values ('crono-photos', 's3/p1.jpg')`))).rowCount === 1, 'dono envia foto do estudo');
check(await errCode(as(CAR, 'carla@x.com', () => q(`insert into storage.objects (bucket_id, name) values ('crono-photos', 's3/p2.jpg')`))) === '42501', 'quem não acessa o estudo não envia foto');
check((await as(CAR, 'carla@x.com', () => q(`select name from storage.objects`))).rowCount === 0, 'quem não acessa o estudo não vê as fotos');
check((await as(BIA, 'bia@x.com', () => q(`select name from storage.objects`))).rowCount === 1, 'membro do time (editar) vê as fotos');
check((await asCommit(BIA, 'bia@x.com', () => q(`insert into storage.objects (bucket_id, name) values ('crono-photos', 's3/p3.jpg')`))).rowCount === 1, 'membro do time (editar) envia foto');
await asCommit(ANA, 'ana@x.com', () => q(`update crono_study_team_share set role='viewer' where study_id='s3'`));
check(await errCode(as(BIA, 'bia@x.com', () => q(`insert into storage.objects (bucket_id, name) values ('crono-photos', 's3/p4.jpg')`))) === '42501', 'quem só pode ver não envia foto');
check((await as(BIA, 'bia@x.com', () => q(`delete from storage.objects where name='s3/p1.jpg'`))).rowCount === 0, 'quem só pode ver não apaga foto');

console.log('▶ tempo real');
const pub = (await q(`select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1`)).rows.map(r => r.tablename);
check(['crono_study', 'crono_study_share', 'crono_study_team_share', 'crono_team_member'].every(t => pub.includes(t)), 'tabelas publicadas para o Realtime: ' + pub.join(', '));

console.log('▶ erros do aplicativo');
await asCommit(BIA, 'bia@x.com', () => q(`insert into crono_client_error (message, stack, app_version, user_id, email) values ('TypeError: x', 'at f', 'Beta 11', $1, 'falso@x.com')`, [ANA]));
const er = (await q(`select user_id, email from crono_client_error`)).rows[0];
check(er.user_id === BIA && er.email === 'bia@x.com', 'usuário e e-mail do erro definidos pelo servidor');
check((await as(BIA, 'bia@x.com', () => q('select * from crono_client_error'))).rowCount === 0, 'usuário comum não lê erros');
check((await as(ADM, 'daniel.thomaseto@dhl.com', () => q('select * from crono_client_error'))).rowCount === 1, 'admin lê os erros');
check(await errCode(as(BIA, 'bia@x.com', () => q(`insert into crono_client_error (message) values ($1)`, ['x'.repeat(1001)]))) === '23514', 'mensagem grande demais é recusada');
await asCommit(BIA, 'bia@x.com', () => q(`insert into crono_client_error (message) select 'spam ' || g from generate_series(1, 150) g`));
check((await q(`select count(*)::int n from crono_client_error where user_id=$1`, [BIA])).rows[0].n === 100, 'no máximo 100 erros por hora por usuário');

console.log('▶ verificação em duas etapas');
await q(`insert into auth.mfa_factors (user_id, status) values ($1, 'verified')`, [ANA]);
const asAal = (aal, sql) => (async () => {
  await q('begin');
  try {
    await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ANA, email: 'ana@x.com', role: 'authenticated', aal })]);
    await q('set local role authenticated');
    return await q(sql);
  } finally { await q('rollback').catch(() => {}); }
})();
check((await asAal('aal1', 'select id from crono_study')).rowCount === 0, 'com 2 etapas ativada, sessão sem verificar não vê os estudos');
check((await asAal('aal2', 'select id from crono_study')).rowCount >= 1, 'sessão verificada (aal2) vê os estudos');
check((await asAal('aal1', `select name from storage.objects`)).rowCount === 0, 'sessão sem verificar não vê as fotos');
check((await as(BIA, 'bia@x.com', () => q('select id from crono_study'))).rowCount >= 1, 'quem não ativou continua acessando normalmente');
await q(`delete from auth.mfa_factors where user_id=$1`, [ANA]);

console.log('▶ retenção (LGPD)');
await q(`insert into crono_client_error (user_id, message, created_at) values ($1, 'antigo', now() - interval '100 days')`, [BIA]);
await q(`alter table crono_client_error disable trigger crono_client_error_before_insert`);
await q(`insert into crono_client_error (user_id, message, created_at) values ($1, 'antigo', now() - interval '100 days')`, [BIA]);
await q(`alter table crono_client_error enable trigger crono_client_error_before_insert`);
await q(`alter table crono_study disable trigger crono_study_before_insert`);
await q(`insert into crono_study (id, owner_id, owner_email, data, deleted_at) values ('velho', $1, 'ana@x.com', '{}', now() - interval '200 days')`, [ANA]);
await q(`alter table crono_study enable trigger crono_study_before_insert`);
check(await errCode(as(BIA, 'bia@x.com', () => q('select crono_purge_old_data()'))) === '42501', 'limpeza bloqueada para não-admin');
const pr = (await asCommit(ADM, 'daniel.thomaseto@dhl.com', () => q('select crono_purge_old_data() r'))).rows[0].r;
check(pr.erros === 1 && pr.estudos_excluidos === 1, 'limpeza apaga erros antigos e estudos excluídos há mais de 180 dias: ' + JSON.stringify(pr));
check((await q(`select count(*)::int n from crono_study where id='velho'`)).rows[0].n === 0, 'estudo excluído antigo removido de vez');
check((await q(`select count(*)::int n from crono_study where id='s3'`)).rows[0].n === 1, 'estudos ativos ficam');

console.log('▶ excluir conta');
await asCommit(BIA, 'bia@x.com', () => q(`insert into crono_study (id, data) values ('s2', '{"name":"Da Bia"}')`));
await asCommit(BIA, 'bia@x.com', () => q('select crono_delete_account()'));
check((await q(`select count(*)::int n from auth.users where id=$1`, [BIA])).rows[0].n === 0, 'usuário removido de auth.users');
check((await q(`select count(*)::int n from crono_study where owner_id=$1`, [BIA])).rows[0].n === 0, 'estudos removidos');
check((await q(`select count(*)::int n from crono_studies where user_id=$1`, [BIA])).rows[0].n === 0, 'tabela antiga removida');
check((await q(`select count(*)::int n from crono_user_activity where user_id=$1`, [BIA])).rows[0].n === 0, 'atividade removida');
check((await q(`select count(*)::int n from crono_team_member where email='bia@x.com'`)).rows[0].n === 0, 'participação em times removida');
check((await q(`select count(*)::int n from crono_client_error where user_id=$1`, [BIA])).rows[0].n === 0, 'erros do usuário removidos');
await asCommit(ANA, 'ana@x.com', () => q('select crono_delete_account()'));
check((await q(`select count(*)::int n from crono_team`)).rows[0].n === 0, 'times do usuário removidos');
check(await errCode(as(null, null, () => q('select crono_delete_account()'))) !== null, 'sem login não exclui nada');

await db.end();
await server.stop();
console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
