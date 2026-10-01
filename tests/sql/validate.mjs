/* Valida supabase/schema.sql e a migração 002 num Postgres de verdade, com um
   esquema "auth" parecido com o do Supabase (papéis, auth.uid(), auth.jwt()).
   Testa regras de acesso (RLS), gatilhos, funções de admin e excluir conta.
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
  grant usage on schema public, auth to anon, authenticated;
  grant execute on all functions in schema auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
`);
const ANA = '11111111-1111-1111-1111-111111111111', BIA = '22222222-2222-2222-2222-222222222222', ADM = '33333333-3333-3333-3333-333333333333';
await q(`insert into auth.users values ($1,'ana@x.com'),($2,'bia@x.com'),($3,'daniel.thomaseto@dhl.com')`, [ANA, BIA, ADM]);

console.log('▶ aplicando schema.sql e a migração 002 (2x, para testar idempotência)');
for (let i = 0; i < 2; i++) {
  try { await q(fs.readFileSync(REPO + '/supabase/schema.sql', 'utf8')); check(true, `schema.sql aplicado (${i + 1}ª vez)`); }
  catch (e) { check(false, 'schema.sql: ' + e.message); }
  try { await q(fs.readFileSync(REPO + '/supabase/migrations/002_estudos_por_linha.sql', 'utf8')); check(true, `002 aplicada (${i + 1}ª vez)`); }
  catch (e) { check(false, '002: ' + e.message + (e.position ? ' @' + e.position : '')); }
}

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

console.log('▶ excluir conta');
await asCommit(BIA, 'bia@x.com', () => q(`insert into crono_study (id, data) values ('s2', '{"name":"Da Bia"}')`));
await asCommit(BIA, 'bia@x.com', () => q('select crono_delete_account()'));
check((await q(`select count(*)::int n from auth.users where id=$1`, [BIA])).rows[0].n === 0, 'usuário removido de auth.users');
check((await q(`select count(*)::int n from crono_study where owner_id=$1`, [BIA])).rows[0].n === 0, 'estudos removidos');
check((await q(`select count(*)::int n from crono_studies where user_id=$1`, [BIA])).rows[0].n === 0, 'tabela antiga removida');
check((await q(`select count(*)::int n from crono_user_activity where user_id=$1`, [BIA])).rows[0].n === 0, 'atividade removida');
check(await errCode(as(null, null, () => q('select crono_delete_account()'))) !== null, 'sem login não exclui nada');

await db.end();
await server.stop();
console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
