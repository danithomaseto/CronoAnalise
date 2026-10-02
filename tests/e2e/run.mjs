/* Testes de ponta a ponta no navegador, com a biblioteca real do supabase-js e um
   Supabase simulado (tests/e2e/fake-supabase.mjs) — não acessa a internet.
   Uso:  npm i --no-save playwright && npx playwright install chromium && npm run test:e2e
         npm run test:e2e -- "offline"     (roda só os cenários cujo nome casa com o filtro) */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { createFakeSupabase, SB_URL, totp } from './fake-supabase.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out') + path.sep;
fs.mkdirSync(OUT, { recursive: true });

const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { failures++; console.log('  ✗ FALHOU: ' + msg); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const { server, port } = await startServer(ROOT);
const BASE = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();

async function newCtx(fake, { sw = 'block' } = {}) {
  const ctx = await browser.newContext({ serviceWorkers: sw, acceptDownloads: true, viewport: { width: 1200, height: 900 } });
  await fake.attach(ctx);
  return ctx;
}

function watch(page, name) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push('console: ' + t);
    if (/Content Security Policy|Refused to/.test(t)) errors.push('CSP: ' + t);
  });
  page._dialogs = [];
  page.on('dialog', d => {
    // diálogos esperados (acceptNextDialog) são aceitos em ordem; os outros viram erro
    if (page._dialogs.length) { d.accept(page._dialogs.shift() ?? undefined); return; }
    errors.push('dialog inesperado: ' + d.message());
    d.dismiss();
  });
  page._errors = errors;
  page._name = name;
  return errors;
}

async function login(page, email, pass) {
  await page.goto(BASE);
  await page.waitForSelector('#authEmail', { state: 'visible' });
  await page.fill('#authEmail', email);
  await page.fill('#authPass', pass);
  await page.click('#authForm button[type=submit]');
  await page.waitForSelector('body.authed', { timeout: 10000 });
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
}

async function acceptNextDialog(page, text = null) {
  page._dialogs.push(text);
}

const studyData = async page => page.evaluate(async () => {
  const s = await import('/js/storage.js');
  return s.loadStore();
});

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

/* ================================================================ */
T('login, novo estudo, etapas, marcações, desfazer e indicadores', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'A');

  await login(page, 'ana@x.com', 'segredo1');
  check(await page.isVisible('#dashboardView'), 'dashboard visível após login');
  check((await page.textContent('#userEmail')) === 'ana@x.com', 'e-mail no topo');
  await sleep(500);
  check(fake.db.crono_user_activity.size === 1 && [...fake.db.crono_user_activity.values()][0].login_count === 1, 'acesso registrado (fallback sem RPC)');

  await page.click('.dash-hero [data-action=new-study]');
  check(await page.isVisible('#editorView'), 'editor aberto');
  let store = await studyData(page);
  check(Object.keys(store.studies).length === 0, 'estudo novo não é gravado antes da 1ª alteração');

  await page.fill('#stageName', 'Pegar');
  await page.press('#stageName', 'Enter');
  await page.fill('#stageName', 'Andar');
  await page.selectOption('#stageType', 'Transporte');
  await page.click('#stageForm button[type=submit]');
  check((await page.$$('.stage-wrap')).length === 2, 'duas etapas adicionadas (Enter e botão)');
  store = await studyData(page);
  const ids = Object.keys(store.studies);
  check(ids.length === 1 && store.studies[ids[0]].name.startsWith('Estudo_'), 'gravado com nome automático na 1ª alteração');

  await page.fill('#studyName', 'Linha A');
  await page.locator('#studyName').blur();

  // marcar sem iniciar
  await page.click('.stage-wrap:nth-child(1) .stage');
  check((await page.$$('#recordsTable tr[data-id]')).length === 0, 'marcar com cronômetro parado não grava 0 s');
  check((await page.textContent('#toast')).includes('Inicie o cronômetro'), 'aviso para iniciar o cronômetro');

  await page.click('#btnStart');
  await sleep(400);
  await page.click('.stage-wrap:nth-child(1) .stage');
  await page.click('.stage-wrap:nth-child(1) .stage'); // toque duplo acidental
  check((await page.$$('#recordsTable tr[data-id]')).length === 1, 'toque duplo acidental ignorado');
  await sleep(600);
  await page.click('.stage-wrap:nth-child(2) .stage');
  let rows = await page.$$eval('#recordsTable tr[data-id]', trs => trs.map(tr => tr.children[3].innerText));
  const t1 = parseFloat(rows[0].replace(',', '.')), t2 = parseFloat(rows[1].replace(',', '.'));
  check(t1 > 0.3 && t1 < 1.5, 'tempo 1 plausível: ' + rows[0]);
  check(t2 > 0.5 && t2 < 1.8, 'tempo 2 plausível: ' + rows[1]);
  check((await page.textContent('#lastMarkText')).includes('Andar'), 'última marcação exibida');

  // desfazer: o tempo volta para o elemento atual
  await page.click('#btnUndo');
  check((await page.$$('#recordsTable tr[data-id]')).length === 1, 'desfazer remove a marcação');
  await sleep(300);
  await page.click('.stage-wrap:nth-child(2) .stage');
  rows = await page.$$eval('#recordsTable tr[data-id]', trs => trs.map(tr => tr.children[3].innerText));
  const t2b = parseFloat(rows[1].replace(',', '.'));
  check(t2b > t2 + 0.2, `após desfazer, o tempo acumulou (${t2} → ${t2b})`);

  // novo ciclo + atalhos
  await page.click('[data-action=new-cycle]');
  check((await page.textContent('#cycle')) === '2', 'ciclo 2');
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await sleep(350);
  await page.keyboard.press('1');
  rows = await page.$$eval('#recordsTable tr[data-id]', trs => trs.map(tr => tr.children[0].innerText));
  check(rows.length === 3 && rows[2] === '2', 'atalho "1" marca a etapa 1 no ciclo 2');
  await page.keyboard.press('Space');
  check(await page.isEnabled('#btnStart'), 'Espaço pausa');
  check((await page.textContent('#btnStart')).includes('Retomar'), 'botão vira "Retomar"');
  await page.keyboard.press('Space');
  check(await page.isDisabled('#btnStart'), 'Espaço retoma');
  await page.keyboard.press('Control+z');
  check((await page.$$('#recordsTable tr[data-id]')).length === 2, 'Ctrl+Z desfaz');
  // Espaço com foco em uma etapa não deve marcar
  await page.focus('.stage-wrap:nth-child(2) .stage');
  const before = (await page.$$('#recordsTable tr[data-id]')).length;
  await page.keyboard.press('Space');
  await sleep(100);
  check((await page.$$('#recordsTable tr[data-id]')).length === before, 'Espaço com foco numa etapa não marca (só pausa)');
  await page.keyboard.press('Space');

  // quantidade 0 é respeitada
  await page.fill('#qty', '0');
  await sleep(350);
  await page.click('.stage-wrap:nth-child(1) .stage');
  rows = await page.$$eval('#recordsTable tr[data-id]', trs => trs.map(tr => tr.children[4].innerText));
  check(rows[rows.length - 1] === '0', 'quantidade 0 gravada como 0 (antes virava 1)');
  check((await page.inputValue('#qty')) === '1', 'quantidade volta para 1');

  // indicadores
  const kpis = await page.$$eval('#stats .kpi', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  check(kpis.some(k => k.startsWith('CICLOS 2') || k.startsWith('Ciclos 2')), 'KPI de ciclos = 2: ' + kpis.join(' | '));
  check((await page.$$('#stats .summary-table tbody tr')).length === 2, 'resumo por etapa com 2 linhas');

  // edição inline de registro
  const cell = page.locator('#recordsTable tr[data-id] >> nth=0').locator('td[data-edit=time]');
  await cell.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('12,5');
  await page.keyboard.press('Enter');
  check((await cell.innerText()).startsWith('12,50'), 'tempo editado inline (Enter confirma)');
  const nameCell = page.locator('#recordsTable tr[data-id] >> nth=0').locator('td[data-edit=stageName]');
  await nameCell.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Pegar caixa');
  await page.keyboard.press('Tab');
  check((await nameCell.innerText()) === 'Pegar caixa', 'nome editado inline (Tab confirma)');

  // ignorar / excluir registro + desfazer exclusão
  await page.click('#recordsTable tr[data-id] >> nth=0 >> [data-action=toggle-exclude]');
  check(await page.locator('#recordsTable tr.excluded').count() === 1, 'registro ignorado nos cálculos');
  const n0 = await page.locator('#recordsTable tr[data-id]').count();
  await page.click('#recordsTable tr[data-id] >> nth=1 >> [data-action=delete-record]');
  check(await page.locator('#recordsTable tr[data-id]').count() === n0 - 1, 'registro excluído');
  await page.click('#btnUndo');
  check(await page.locator('#recordsTable tr[data-id]').count() === n0, 'exclusão desfeita');

  // sincronizou com a nuvem no formato novo
  await sleep(1500);
  const cloud = fake.studiesOf('ana@x.com');
  check(cloud && cloud.format === 3 && Object.keys(cloud.studies).length === 1, 'nuvem recebeu o estudo no formato v3');
  check((await page.textContent('#syncStatus')).includes('Salvo'), 'indicador "Salvo"');
  check(Object.values(cloud.studies)[0].name === 'Linha A', 'nome sincronizado');

  await page.screenshot({ path: OUT + 'editor.png', fullPage: true });
  check(errors.length === 0, 'sem erros no console/CSP: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('voltar para a aba / renovar token não derruba o usuário nem o cronômetro', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'ana@x.com', 'segredo1');
  await page.click('.dash-hero [data-action=new-study]');
  await page.fill('#stageName', 'Etapa');
  await page.press('#stageName', 'Enter');
  await page.click('#btnStart');
  await sleep(300);
  await page.click('.stage');
  const loginsBefore = [...fake.db.crono_user_activity.values()][0].login_count;

  await page.evaluate(async () => {
    const m = await import('/js/cloud.js');
    await m.sb.auth._recoverAndRefresh();   // o que o supabase-js faz ao voltar para a aba (SIGNED_IN)
    await m.sb.auth.refreshSession();       // TOKEN_REFRESHED
  });
  await sleep(800);
  check(await page.isVisible('#editorView'), 'continua no editor');
  check(await page.isDisabled('#btnStart'), 'cronômetro continua rodando');
  check((await page.$$('#recordsTable tr[data-id]')).length === 1, 'registros intactos');
  check([...fake.db.crono_user_activity.values()][0].login_count === loginsBefore, 'contador de acessos não sobe ao voltar para a aba');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('recarregar a página restaura o estudo e o cronômetro em andamento', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'ana@x.com', 'segredo1');
  await page.click('.dash-hero [data-action=new-study]');
  await page.fill('#studyName', 'Recarregar');
  await page.fill('#stageName', 'E1');
  await page.press('#stageName', 'Enter');
  await page.click('#btnStart');
  await sleep(500);
  await page.click('.stage');
  await page.click('[data-action=toggle-menu]');
  await page.click('#btnField');
  await sleep(700);
  const t0 = await page.textContent('#timer');
  await page.reload();
  await page.waitForSelector('body.authed');
  await page.waitForSelector('#editorView', { state: 'visible' });
  check((await page.inputValue('#studyName')) === 'Recarregar', 'mesmo estudo reaberto');
  check(await page.isDisabled('#btnStart'), 'cronômetro ainda rodando');
  await sleep(300);
  const t1 = await page.textContent('#timer');
  check(t1 > t0, `tempo continuou contando (${t0} → ${t1})`);
  check(await page.evaluate(() => document.body.classList.contains('field')), 'Modo Campo restaurado');
  check(!(await page.isVisible('.stage-remove')), 'Modo Campo esconde o ✕ das etapas');
  check((await page.textContent('#toast')).includes('restaurada'), 'aviso de cronometragem restaurada');

  // voltar ao dashboard com o cronômetro rodando mostra o selo; reabrir continua
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=back-dashboard]');
  check(await page.isVisible('.timer-badge'), 'card mostra "Em andamento"');
  await page.click('.study-card [data-action=open-study]');
  check(await page.isDisabled('#btnStart'), 'reabrir: cronômetro continua');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('renomear não duplica; excluir no editor exclui de verdade; card mostra ciclos', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'ana@x.com', 'segredo1');

  for (const name of ['Estudo 1', 'Estudo 2']) {
    await page.click('[data-action=toggle-menu]');
    await page.click('#menuDropdown [data-action=new-study]');
    await page.fill('#studyName', name);
    await page.fill('#stageName', 'E');
    await page.press('#stageName', 'Enter');
    await page.click('#btnStart');
    await sleep(350);
    await page.click('.stage');
    await page.click('[data-action=new-cycle]');
    await sleep(350);
    await page.click('.stage');
  }
  // renomeia "Estudo 2" para "Estudo 2 renomeado" e depois para "Estudo 1" (nome de outro)
  await page.fill('#studyName', 'Estudo 2 renomeado');
  await page.locator('#studyName').blur();
  await page.fill('#studyName', 'Estudo 1');
  await page.locator('#studyName').blur();
  check((await page.textContent('#toast')).includes('já existe'), 'aviso de nome repetido');
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=back-dashboard]');
  const cards = await page.$$eval('.study-card', els => els.map(e => e.innerText));
  check(cards.length === 2, 'continuam 2 estudos (renomear não duplica, nome igual não sobrescreve)');
  check(cards.every(c => c.includes('2 registros · 2 ciclos')), 'card mostra 2 ciclos: ' + JSON.stringify(cards.map(c => c.split('\n').pop())));

  // excluir no editor
  await page.click('.study-card >> nth=0 >> [data-action=open-study]');
  await acceptNextDialog(page);
  await page.click('[data-action=delete-current]');
  await page.waitForSelector('#dashboardView', { state: 'visible' });
  check((await page.$$('.study-card')).length === 1, 'excluído no editor → some do dashboard');
  await sleep(1500);
  const cloud = fake.studiesOf('ana@x.com');
  check(Object.keys(cloud.studies).length === 1 && Object.keys(cloud.deleted).length === 1, 'nuvem tem 1 estudo e 1 lápide de exclusão');

  // duplicar
  await page.click('.study-card [data-action=duplicate-study]');
  check((await page.$$('.study-card')).length === 2, 'duplicar cria cópia');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('nomes maliciosos não injetam HTML; CSV protegido', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await page.exposeFunction('__pwned', () => errors.push('XSS executou!'));
  await login(page, 'ana@x.com', 'segredo1');
  await page.click('.dash-hero [data-action=new-study]');
  const evil = `x" onmouseover="__pwned()" a="<img src=x onerror=__pwned()>\\`;
  await page.fill('#studyName', evil);
  await page.fill('#stageName', '=HYPERLINK("http://mal")');
  await page.press('#stageName', 'Enter');
  await page.fill('#notes', 'linha; com ponto e vírgula\n+perigo');
  await page.locator('#notes').blur();
  await page.click('#btnStart');
  await sleep(300);
  await page.click('.stage');
  const dl = page.waitForEvent('download');
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=export-csv]');
  const d = await dl;
  const csv = fs.readFileSync(await d.path(), 'utf8');
  check(csv.charCodeAt(0) === 0xfeff, 'CSV com BOM');
  check(csv.includes(`"'=HYPERLINK(""http://mal"")"`), 'fórmula neutralizada no CSV');
  check(csv.includes('"linha; com ponto e vírgula"'), 'ponto e vírgula entre aspas');
  check(d.suggestedFilename().endsWith('.csv'), 'nome do arquivo: ' + d.suggestedFilename());

  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=back-dashboard]');
  await page.hover('.study-card b');
  await page.hover('.study-card');
  await sleep(200);
  check((await page.textContent('.study-card b')) === evil, 'nome exibido literalmente');
  await page.click('.study-card [data-action=open-study]');
  check(await page.isVisible('#editorView'), 'botão Abrir funciona com nome malicioso');
  check(errors.length === 0, 'sem erros/XSS: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('dois aparelhos: edições em estudos diferentes não se apagam; exclusão propaga', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctxA = await newCtx(fake), ctxB = await newCtx(fake);
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const eA = watch(A, 'A'), eB = watch(B, 'B');
  await login(A, 'ana@x.com', 'segredo1');
  for (const name of ['Compartilhado 1', 'Compartilhado 2']) {
    await A.click('[data-action=toggle-menu]');
    await A.click('#menuDropdown [data-action=new-study]');
    await A.fill('#studyName', name);
    await A.locator('#studyName').blur();
  }
  await sleep(1500);
  await login(B, 'ana@x.com', 'segredo1');
  check((await B.$$('.study-card')).length === 2, 'B vê os 2 estudos criados em A');

  // A edita estudo 2 (aberto), B edita estudo 1 — "ao mesmo tempo"
  await B.click('.study-card:has-text("Compartilhado 1") [data-action=open-study]');
  await B.fill('#notes', 'nota do B');
  await B.locator('#notes').blur();
  await A.fill('#notes', 'nota do A');
  await A.locator('#notes').blur();
  await sleep(2500);
  // A ainda não "sabe" da versão de B: o UPDATE condicional falha, A relê e mescla
  const cloud = fake.studiesOf('ana@x.com');
  const notes = Object.values(cloud.studies).map(s => s.name + ':' + s.notes).sort();
  const conflicts = fake.log.filter(l => l.method === 'PATCH' && l.matched === 0).length;
  check(conflicts >= 1, 'houve conflito detectado pelo UPDATE condicional (' + conflicts + ')');
  check(notes.join('|') === 'Compartilhado 1:nota do B|Compartilhado 2:nota do A', 'nuvem tem as duas edições: ' + notes.join('|'));

  // A volta ao dashboard e busca da nuvem (o evento "online" dispara a mesma busca de voltar para a aba)
  await A.click('[data-action=toggle-menu]');
  await A.click('#menuDropdown [data-action=back-dashboard]');
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  const storeA = await studyData(A);
  check(Object.values(storeA.studies).some(s => s.notes === 'nota do B'), 'A recebeu a edição de B');

  // B exclui o estudo 1 aberto em A? (A está no dashboard) → exclusão chega em A
  await B.click('[data-action=toggle-menu]');
  await B.click('#menuDropdown [data-action=back-dashboard]');
  await acceptNextDialog(B);
  await B.click('.study-card:has-text("Compartilhado 1") [data-action=delete-study]');
  await sleep(1500);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  check(!(await A.textContent('#studyCards')).includes('Compartilhado 1'), 'exclusão feita em B chega em A');
  check(eA.length === 0 && eB.length === 0, 'sem erros: ' + [...eA, ...eB].join(' || '));
  await ctxA.close(); await ctxB.close();
});

/* ================================================================ */
T('offline: continua funcionando e sincroniza quando a conexão volta', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'ana@x.com', 'segredo1');
  await page.click('.dash-hero [data-action=new-study]');
  await page.fill('#studyName', 'Offline');
  await page.fill('#stageName', 'E');
  await page.press('#stageName', 'Enter');
  await sleep(1500);
  fake.setOffline(true);
  await ctx.setOffline(true);
  await page.click('#btnStart');
  await sleep(300);
  await page.click('.stage');
  await sleep(2500);
  check((await page.textContent('#syncStatus')).includes('Offline'), 'indicador mostra offline: ' + await page.textContent('#syncStatus'));
  const cloudBefore = fake.studiesOf('ana@x.com');
  check(Object.values(cloudBefore.studies)[0].records.length === 0, 'nuvem ainda sem o registro');
  fake.setOffline(false);
  await ctx.setOffline(false);
  await sleep(2500);
  const cloudAfter = fake.studiesOf('ana@x.com');
  check(Object.values(cloudAfter.studies)[0].records.length === 1, 'registro enviado quando a conexão voltou');
  check((await page.textContent('#syncStatus')).includes('Salvo'), 'indicador volta a "Salvo"');
  // erros de rede esperados no console são filtrados; não pode ter pageerror
  check(!errors.some(e => e.startsWith('pageerror')), 'sem exceções: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('migração dos dados da versão anterior (local v2 + nuvem v2)', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  // nuvem no formato antigo (chave = nome)
  fake.setRow('ana@x.com', {
    'Estudo nuvem': { id: 'study_a', process: 'P', stages: [], records: [], cycleQty: { 1: 1 }, currentCycle: 1, notes: 'versão nuvem', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z', history: [] }
  }, '2026-09-10T00:00:00.000Z');
  const local = {
    'Estudo nuvem': { id: 'study_a', notes: 'editado offline (mais novo)', stages: [], records: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z' },
    'Criado offline': { id: 'study_b', stages: [], records: [], createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z' },
    'Apagado em outro aparelho': { id: 'study_c', stages: [], records: [], createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }
  };
  const ctx = await newCtx(fake);
  await ctx.addInitScript(data => {
    if (!localStorage.getItem('__seeded')) {
      localStorage.setItem('cronoanalise_studies_v2', data);
      localStorage.setItem('__seeded', '1');
    }
  }, JSON.stringify(local));
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'ana@x.com', 'segredo1');
  await sleep(1500);
  const cards = await page.$$eval('.study-card b', els => els.map(e => e.textContent).sort());
  check(cards.join('|') === 'Criado offline|Estudo nuvem', 'mesclou: ' + cards.join('|'));
  const cloud = fake.studiesOf('ana@x.com');
  check(cloud.format === 3, 'nuvem convertida para v3');
  check(cloud.studies.study_a.notes === 'editado offline (mais novo)', 'edição offline não enviada foi recuperada');
  check(!cloud.studies.study_c, 'estudo apagado em outro aparelho não ressuscitou');
  check(await page.evaluate(() => !!localStorage.getItem('cronoanalise_studies_v2')), 'chave antiga mantida como backup');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('navegador compartilhado: dados de outra conta não vazam', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  fake.addUser('bia@x.com', 'segredo2');
  fake.setRow('bia@x.com', { format: 3, studies: { study_bia: { id: 'study_bia', name: 'Da Bia', updatedAt: '2026-09-01T00:00:00.000Z' } }, deleted: {} }, '2026-09-01T00:00:00.000Z');
  const ctx = await newCtx(fake);
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('__seeded')) {
      localStorage.setItem('cronoanalise_studies_v2', JSON.stringify({ 'Da Ana (antigo)': { id: 'study_ana', stages: [], records: [], updatedAt: '2026-09-20T00:00:00.000Z' } }));
      localStorage.setItem('__seeded', '1');
    }
  });
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'bia@x.com', 'segredo2');
  await sleep(1200);
  const cards = await page.$$eval('.study-card b', els => els.map(e => e.textContent));
  check(cards.join('|') === 'Da Bia', 'Bia vê só os estudos dela: ' + cards.join('|'));
  check(!JSON.stringify(fake.studiesOf('bia@x.com')).includes('study_ana'), 'nada da outra conta foi enviado para a nuvem da Bia');

  // Bia sai; Ana entra no mesmo navegador: não vê os estudos da Bia
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=sign-out]');
  await page.waitForSelector('#authOverlay', { state: 'visible' });
  await page.fill('#authEmail', 'ana@x.com');
  await page.fill('#authPass', 'segredo1');
  await page.click('#authForm button[type=submit]');
  await page.waitForSelector('body.authed');
  await sleep(1500);
  const cardsAna = await page.$$eval('.study-card b', els => els.map(e => e.textContent));
  check(!cardsAna.includes('Da Bia'), 'Ana não vê estudos da Bia: ' + cardsAna.join('|'));
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('admin (com RPC), tema, configurações, backup e recuperação de senha', async () => {
  const fake = createFakeSupabase({ rpcEnabled: true });
  fake.addUser('daniel.thomaseto@dhl.com', 'admin123');
  fake.addUser('ana@x.com', 'segredo1');
  const ctx0 = await newCtx(fake);
  const p0 = await ctx0.newPage();
  watch(p0, 'ana');
  await login(p0, 'ana@x.com', 'segredo1');
  await ctx0.close();

  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'admin');
  await login(page, 'daniel.thomaseto@dhl.com', 'admin123');
  await sleep(500);
  check([...fake.db.crono_user_activity.values()].every(r => r.login_count === 1), 'RPC de acesso usada quando existe');
  await page.click('[data-action=toggle-menu]');
  check(await page.isVisible('#btnAdmin'), 'botão admin visível para o admin');
  await page.click('#btnAdmin');
  await page.waitForFunction(() => document.querySelectorAll('#adminUsersTable tr').length === 2);
  check((await page.textContent('#adminSummary')).includes('2'), 'admin lista 2 usuários');
  await page.keyboard.press('Escape');
  check(!(await page.isVisible('#adminModal')), 'Esc fecha o modal');

  // tema
  await page.click('[data-action=toggle-menu]');
  await page.click('#btnTheme');
  check(await page.evaluate(() => document.documentElement.classList.contains('dark-theme')), 'tema escuro aplicado');
  await page.click('[data-action=toggle-menu]');
  check((await page.textContent('#btnTheme')).includes('Claro'), 'botão vira "Tema Claro"');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('body.authed');
  check(await page.evaluate(() => document.documentElement.classList.contains('dark-theme')), 'tema escuro persiste');
  await page.screenshot({ path: OUT + 'dashboard-dark.png' });

  // backup: cria um estudo, baixa backup, exclui, restaura
  await page.click('.dash-hero [data-action=new-study]');
  await page.fill('#studyName', 'Para backup');
  await page.locator('#studyName').blur();
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=open-settings]');
  const dl = page.waitForEvent('download');
  await page.click('[data-action=export-backup]');
  const file = await (await dl).path();
  await page.click('#settingsModal [data-action=close-modal]');
  await acceptNextDialog(page);
  await page.click('[data-action=delete-current]');
  await page.waitForSelector('#dashboardView', { state: 'visible' });
  check((await page.$$('.study-card')).length === 0, 'estudo excluído');
  await sleep(1200);
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=open-settings]');
  await page.setInputFiles('#backupFile', file);
  await sleep(1500);
  await page.click('#settingsModal [data-action=close-modal]');
  check((await page.$$('.study-card')).length === 1, 'backup restaurado');
  const cloud = fake.studiesOf('daniel.thomaseto@dhl.com');
  check(Object.keys(cloud.studies).length === 1, 'restauração venceu a exclusão na nuvem');

  // recuperação de senha via link
  const s = fake.session({ id: fake.userId('ana@x.com'), email: 'ana@x.com' });
  const ctx2 = await newCtx(fake);
  const p2 = await ctx2.newPage();
  const e2 = watch(p2, 'recovery');
  await p2.goto(BASE + `#access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=recovery`);
  await p2.waitForSelector('#recoveryModal', { state: 'visible', timeout: 8000 });
  await p2.fill('#newPass', 'novasenha');
  await p2.fill('#newPass2', 'novasenha');
  await p2.click('#recoveryForm button[type=submit]');
  await sleep(500);
  check(!(await p2.isVisible('#recoveryModal')), 'nova senha salva');
  await p2.click('[data-action=toggle-menu]');
  await p2.click('#menuDropdown [data-action=sign-out]');
  await p2.waitForSelector('#authOverlay', { state: 'visible' });
  await p2.fill('#authEmail', 'ana@x.com');
  await p2.fill('#authPass', 'novasenha');
  await p2.click('#authForm button[type=submit]');
  await p2.waitForSelector('body.authed');
  check(true, 'login com a nova senha');

  // esqueci minha senha
  await p2.click('[data-action=toggle-menu]');
  await p2.click('#menuDropdown [data-action=sign-out]');
  await p2.waitForSelector('#authOverlay', { state: 'visible' });
  await p2.fill('#authEmail', 'ana@x.com');
  await p2.click('[data-action=forgot-password]');
  await p2.waitForFunction(() => document.getElementById('authMsg').textContent.length > 0);
  check((await p2.textContent('#authMsg')).includes('link'), 'mensagem de recuperação enviada');
  await p2.fill('#authPass', 'errada');
  await p2.click('#authForm button[type=submit]');
  await p2.waitForFunction(() => document.getElementById('authError').textContent.length > 0);
  check((await p2.textContent('#authError')) === 'E-mail ou senha incorretos.', 'erro de login traduzido');
  check(errors.length === 0 && e2.filter(e => !/400|invalid/i.test(e)).length === 0, 'sem erros: ' + [...errors, ...e2].join(' || '));
  await ctx.close(); await ctx2.close();
});

/* ================================================================ */
T('PWA: abre offline depois da primeira visita', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake, { sw: 'allow' });
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'ana@x.com', 'segredo1');
  await page.click('.dash-hero [data-action=new-study]');
  await page.fill('#studyName', 'Visto offline');
  await page.locator('#studyName').blur();
  await page.waitForFunction(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!(r && r.active);
  }, null, { timeout: 10000 });
  await page.reload();
  await page.waitForSelector('body.authed');
  await sleep(500);
  fake.setOffline(true);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('body.authed', { timeout: 10000 });
  check(await page.isVisible('#editorView'), 'app abriu offline pelo cache do service worker');
  check((await page.inputValue('#studyName')) === 'Visto offline', 'dados locais disponíveis offline');
  check(!errors.some(e => e.startsWith('pageerror') || e.startsWith('CSP')), 'sem exceções/CSP: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('layout mobile e Modo Campo (screenshots)', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await fake.attach(ctx);
  const page = await ctx.newPage();
  const errors = watch(page, 'mobile');
  await login(page, 'ana@x.com', 'segredo1');
  await page.screenshot({ path: OUT + 'mobile-dashboard.png' });
  await page.tap('.dash-hero [data-action=new-study]');
  await page.fill('#studyName', 'Separação Linha A');
  for (const [n, t] of [['Pegar item', 'VA'], ['Andar', 'Transporte'], ['Aguardar', 'Espera'], ['Conferir', 'NVA']]) {
    await page.fill('#stageName', n);
    await page.selectOption('#stageType', t);
    await page.tap('#stageForm button[type=submit]');
  }
  await page.tap('#btnStart');
  for (let c = 0; c < 2; c++) {
    for (let i = 1; i <= 4; i++) { await sleep(250); await page.tap(`.stage-wrap:nth-child(${i}) .stage`); }
    await page.tap('[data-action=new-cycle]');
  }
  await page.screenshot({ path: OUT + 'mobile-editor.png', fullPage: true });
  await page.tap('[data-action=toggle-menu]');
  await page.tap('#btnField');
  await page.screenshot({ path: OUT + 'mobile-field.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'sem rolagem horizontal no celular');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});


/* ================================================================ */
T('duas abas no mesmo navegador; ritmo/tolerâncias; etapa de produção; confiança; impressão', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const A = await ctx.newPage();
  const errors = watch(A, 'A');
  await login(A, 'ana@x.com', 'segredo1');
  await A.click('.dash-hero [data-action=new-study]');
  await A.fill('#studyName', 'Aba A');
  for (const n of ['Separar', 'Embalar']) { await A.fill('#stageName', n); await A.press('#stageName', 'Enter'); }
  await A.click('#btnStart');
  for (let i = 0; i < 6; i++) {
    await sleep(120); await A.click('.stage-wrap:nth-child(1) .stage');
    await A.fill('#qty', '5');
    await sleep(120); await A.click('.stage-wrap:nth-child(2) .stage');
    await A.click('[data-action=new-cycle]');
  }
  // segunda aba: dashboard mostra o estudo; cria outro estudo nela
  const B = await ctx.newPage();
  const eB = watch(B, 'B');
  await B.goto(BASE);
  await B.waitForSelector('body.authed');
  await B.waitForSelector('#editorView', { state: 'visible' }); // retoma a sessão (mesmo estudo)
  await B.click('[data-action=toggle-menu]');
  await B.click('#menuDropdown [data-action=back-dashboard]');
  await B.click('.dash-hero [data-action=new-study]');
  await B.fill('#studyName', 'Aba B');
  await B.locator('#studyName').blur();
  // A continua marcando depois que B gravou: nada se perde entre as abas
  await A.bringToFront();
  await sleep(150); await A.click('.stage-wrap:nth-child(1) .stage');
  await sleep(200);
  const names = Object.values((await studyData(A)).studies).map(s => s.name).sort();
  check(names.join('|') === 'Aba A|Aba B', 'as duas abas gravaram sem se sobrescrever: ' + names.join('|'));
  const recsA = Object.values((await studyData(A)).studies).find(s => s.name === 'Aba A').records.length;
  check(recsA === 13, 'registros da aba A intactos: ' + recsA);

  // ritmo e tolerâncias
  await A.click('#stdParams summary');
  await A.fill('#rating', '110');
  await A.fill('#allowance', '10');
  await A.locator('#allowance').blur();
  const heads = await A.$$eval('#stats .summary-table th', ths => ths.map(t => t.textContent));
  check(heads.includes('T. Padrão(s)'), 'colunas de tempo normal/padrão aparecem');
  check((await A.textContent('#stats')).includes('Tempo Padrão de Ciclo'), 'KPI de tempo padrão de ciclo');

  // etapa que conta para produção
  const qtyBefore = await A.$eval('#stats .kpi:nth-child(2) .kpi-val', e => e.textContent);
  await A.click('.stage-wrap:nth-child(2) .stage-edit');
  await A.check('#editStageOutput');
  await A.click('#stageEditForm button[type=submit]');
  const qtyAfter = await A.$eval('#stats .kpi:nth-child(2) .kpi-val', e => e.textContent);
  check(qtyBefore === '37' && qtyAfter === '30', `quantidade só da etapa de produção (${qtyBefore} → ${qtyAfter})`);
  check((await A.textContent('.stage-wrap:nth-child(2) .stage-type')).includes('produção'), 'etapa marcada com 📦');

  // confiança 99% muda "n nec."
  const nBefore = await A.$$eval('#stats .summary-table tbody tr td:nth-child(10)', t => t.map(x => x.textContent).join(','));
  await A.click('[data-action=toggle-menu]');
  await A.click('#menuDropdown [data-action=open-settings]');
  await A.selectOption('#prefConfidence', '99');
  await A.click('#settingsModal [data-action=close-modal]');
  const nAfter = await A.$$eval('#stats .summary-table tbody tr td:nth-child(10)', t => t.map(x => x.textContent).join(','));
  check(nBefore !== nAfter, `ciclos necessários recalculados (${nBefore} → ${nAfter})`);

  // histórico
  await A.click('#tabHist');
  check((await A.textContent('#historyTimeline')).includes('Etapa "Embalar" editada'), 'histórico registra a edição da etapa');
  await A.click('#tabCrono');

  // impressão
  await A.emulateMedia({ media: 'print' });
  await A.screenshot({ path: OUT + 'print.png', fullPage: true });
  check(!(await A.isVisible('.module')) && await A.isVisible('#stats'), 'layout de impressão esconde o cronômetro e mostra os indicadores');
  await A.emulateMedia({ media: 'screen' });
  check(errors.length === 0 && eB.length === 0, 'sem erros: ' + [...errors, ...eB].join(' || '));
  await ctx.close();
});


/* ================================================================ */
async function setupStudy(page, name, stages) {
  await page.click('.dash-hero [data-action=new-study]');
  await page.fill('#studyName', name);
  for (const [n, t] of stages) {
    await page.fill('#stageName', n);
    await page.selectOption('#stageType', t);
    await page.click('#stageForm button[type=submit]');
  }
}

T('etapas reordenáveis, modelo, interrupção, observações, gráficos, takt, Excel e comparação', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'A');
  await login(page, 'ana@x.com', 'segredo1');
  await setupStudy(page, 'Antes', [['Pegar', 'VA'], ['Andar', 'Transporte'], ['Conferir', 'NVA']]);

  // reordenar: "Conferir" para a 1ª posição
  await page.click('.stage-wrap:nth-child(3) .stage-edit');
  check((await page.textContent('#stagePosLabel')) === 'Posição 3 de 3', 'modal mostra a posição');
  await page.click('#btnStageBack');
  await page.click('#btnStageBack');
  check(await page.isDisabled('#btnStageBack'), 'não passa da 1ª posição');
  await page.keyboard.press('Escape');
  const order = await page.$$eval('.stage-wrap .stage-name', els => els.map(e => e.textContent));
  check(order.join('|') === 'Conferir|Pegar|Andar', 'ordem das etapas alterada: ' + order.join('|'));

  // cronometrar 4 ciclos com interrupção e observação
  await page.click('#btnStart');
  for (let c = 0; c < 4; c++) {
    for (let i = 1; i <= 3; i++) { await sleep(120); await page.click(`.stage-wrap:nth-child(${i}) .stage`); }
    if (c === 1) {
      await sleep(150);
      await page.locator('body').click({ position: { x: 5, y: 300 } });
      await page.keyboard.press('0'); // atalho de interrupção
      acceptNextDialog(page, 'falta de caixa');
      await page.click('#btnNote');
      await sleep(100);
    }
    await page.click('[data-action=new-cycle]');
  }
  const intRow = page.locator('#recordsTable tr.interruption');
  check(await intRow.count() === 1, 'interrupção registrada');
  check((await intRow.locator('td.note-cell').innerText()) === 'falta de caixa', 'observação anotada na interrupção');
  check((await page.textContent('#stats')).includes('Interrupções'), 'KPI de interrupções');
  // observação editada direto na tabela
  const note = page.locator('#recordsTable tr[data-id] >> nth=0').locator('td.note-cell');
  await note.click();
  await page.keyboard.type('operador novo');
  await page.locator('#studyName').click();
  check((await note.innerText()) === 'operador novo', 'observação editada na tabela');

  // takt
  await page.click('#stdParams summary');
  await page.fill('#demand', '480');
  await page.fill('#availableMin', '480');
  await page.locator('#availableMin').blur();
  const statsText = await page.textContent('#stats');
  check(statsText.includes('Takt Time') && statsText.includes('Operadores Necessários'), 'KPIs de takt time');
  check(statsText.includes('dentro do takt'), 'status do takt com ícone e texto');

  // gráficos
  check(await page.locator('#charts .chart-card').count() === 3, '3 gráficos (Yamazumi, Pareto, tempo de ciclo)');
  const ymarks = await page.locator('#charts .chart-card').nth(0).locator('.mark').evaluateAll(els => els.map(e => e.getAttribute('data-tip')));
  check(ymarks.length === 12, 'Yamazumi: 3 segmentos × 4 ciclos (' + ymarks.length + ') ' + (ymarks.length === 12 ? '' : JSON.stringify(ymarks)));
  check((await page.locator('#charts .chart-card').nth(0).textContent()).includes('Takt do ciclo'), 'linha de takt no Yamazumi');
  await page.locator('#charts .chart-card').nth(1).locator('.mark').first().hover();
  check(!(await page.isHidden('#stats .chart-tip')) && (await page.textContent('#stats .chart-tip')).includes('% do tempo'), 'tooltip no Pareto');
  await page.locator('#charts .chart-card').nth(2).locator('.hit').nth(1).hover();
  check((await page.textContent('#stats .chart-tip')).startsWith('Ciclo 2:'), 'tooltip no tempo de ciclo');
  check(await page.locator('#charts .crosshair[visibility=visible]').count() === 1, 'crosshair acompanha o ponteiro');
  await page.locator('#charts .chart-card').nth(0).locator('.mark').first().focus();
  check(!(await page.isHidden('#stats .chart-tip')), 'tooltip também pelo teclado (foco)');
  await page.screenshot({ path: OUT + 'charts.png', fullPage: true });

  // Excel
  const dl = page.waitForEvent('download');
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=export-xlsx]');
  const d = await dl;
  check(d.suggestedFilename() === 'Antes.xlsx', 'arquivo .xlsx: ' + d.suggestedFilename());
  const bytes = fs.readFileSync(await d.path());
  check(bytes[0] === 0x50 && bytes[1] === 0x4b, 'é um ZIP (formato .xlsx)');
  fs.copyFileSync(await d.path(), OUT + 'Antes.xlsx');

  // modelo: novo estudo com as mesmas etapas, sem registros
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=back-dashboard]');
  await page.click('.study-card [data-action=template-study]');
  check((await page.inputValue('#studyName')) === 'Antes (novo)', 'estudo criado a partir do modelo');
  const tplStages = await page.$$eval('.stage-wrap .stage-name', els => els.map(e => e.textContent));
  check(tplStages.join('|') === 'Conferir|Pegar|Andar', 'modelo copia as etapas na ordem');
  check((await page.$$('#recordsTable tr[data-id]')).length === 0, 'modelo não copia registros');
  check((await page.inputValue('#demand')) === '480', 'modelo copia os parâmetros de takt');
  await page.fill('#studyName', 'Depois');
  await page.locator('#studyName').blur();
  await page.click('#btnStart');
  for (let c = 0; c < 3; c++) {
    for (let i = 1; i <= 3; i++) { await sleep(60); await page.click(`.stage-wrap:nth-child(${i}) .stage`); }
    await page.click('[data-action=new-cycle]');
  }

  // comparação antes × depois
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=back-dashboard]');
  await page.click('#btnCompare');
  await page.selectOption('#compareA', { label: 'Antes' });
  await page.selectOption('#compareB', { label: 'Depois' });
  const comp = await page.textContent('#compareResult');
  check(comp.includes('Tempo médio de ciclo') && comp.includes('melhor'), 'comparação mostra variação com texto "melhor"/"pior"');
  check(await page.locator('#compareResult .comp-bar').count() === 2, 'barras de composição dos dois estudos');
  check(await page.locator('#compareResult tbody tr').count() >= 3 + 7, 'tabelas de indicadores e etapas');
  await page.screenshot({ path: OUT + 'compare.png' });
  await page.keyboard.press('Escape');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
T('mesmo estudo em dois aparelhos: marcações de um + observações do outro se somam', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctxA = await newCtx(fake), ctxB = await newCtx(fake);
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const eA = watch(A, 'A'), eB = watch(B, 'B');
  await login(A, 'ana@x.com', 'segredo1');
  await setupStudy(A, 'Juntos', [['E1', 'VA']]);
  await sleep(1500);
  await login(B, 'ana@x.com', 'segredo1');
  await B.click('.study-card [data-action=open-study]');
  // A cronometra; B escreve observações e renomeia a etapa — sem sincronizar entre si no meio
  await A.click('#btnStart');
  for (let i = 0; i < 3; i++) { await sleep(400); await A.click('.stage'); }
  await B.fill('#notes', 'anotado no aparelho B');
  await B.locator('#notes').blur();
  await sleep(2500);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(2500);
  const cloud = Object.values(fake.studiesOf('ana@x.com').studies)[0];
  check(cloud.records.length === 3, 'nuvem tem as 3 marcações de A: ' + cloud.records.length);
  check(cloud.notes === 'anotado no aparelho B', 'nuvem tem a observação de B');
  check((await A.inputValue('#notes')) === 'anotado no aparelho B', 'A recebeu a observação de B');
  check((await B.$$('#recordsTable tr[data-id]')).length === 3, 'B recebeu as marcações de A');
  check(eA.length === 0 && eB.length === 0, 'sem erros: ' + [...eA, ...eB].join(' || '));
  await ctxA.close(); await ctxB.close();
});

/* ================================================================ */
T('banco novo (um estudo por linha): migração automática, incremental, conflito e exclusão', async () => {
  const fake = createFakeSupabase({ versionThrottleMs: 0 });
  fake.addUser('ana@x.com', 'segredo1');
  const ctxA = await newCtx(fake);
  const A = await ctxA.newPage();
  const eA = watch(A, 'A');
  await login(A, 'ana@x.com', 'segredo1');
  await setupStudy(A, 'Antigo 1', [['E1', 'VA']]);
  await A.click('[data-action=toggle-menu]');
  await A.click('#menuDropdown [data-action=back-dashboard]');
  await setupStudy(A, 'Antigo 2', [['E1', 'VA']]);
  await sleep(1500);
  check(fake.rows().length === 0 && Object.keys(fake.studiesOf('ana@x.com').studies).length === 2, 'antes da migração: tudo na tabela antiga');

  // administrador roda a migração 002
  fake.enableV2();
  await A.reload();
  await A.waitForSelector('body.authed');
  await sleep(2500);
  check(fake.rows().length === 2, 'estudos copiados para crono_study: ' + fake.rows().length);
  check(Object.keys(fake.studiesOf('ana@x.com').studies).length === 2, 'tabela antiga mantida intacta (backup)');
  const blobBefore = fake.rowOf('ana@x.com').updated_at;

  // segundo aparelho, modo novo
  const ctxB = await newCtx(fake);
  const B = await ctxB.newPage();
  const eB = watch(B, 'B');
  await login(B, 'ana@x.com', 'segredo1');
  await sleep(1200);
  check((await B.$$('.study-card')).length === 2, 'B vê os 2 estudos pelas linhas novas');

  // edição concorrente do mesmo estudo: A marca, B edita a observação
  if (await A.isVisible('#editorView')) { await A.click('[data-action=toggle-menu]'); await A.click('#menuDropdown [data-action=back-dashboard]'); }
  await A.click('.study-card:has-text("Antigo 1") [data-action=open-study]');
  await B.click('.study-card:has-text("Antigo 1") [data-action=open-study]');
  // "terceiro aparelho" grava no mesmo estudo bem na hora em que A envia
  const studyRowId = fake.rows().find(r => r.data.name === 'Antigo 1').id;
  fake.interfereNextPatch(studyRowId, data => {
    data.records.push({ id: 'r_outro', cycle: 1, stageId: null, stageName: 'Outro aparelho', type: 'VA', time: 1, qty: 1, ts: new Date().toISOString() });
    data.updatedAt = new Date().toISOString();
    return data;
  });
  await A.click('#btnStart');
  await sleep(200);
  await A.click('.stage');
  await B.fill('#notes', 'nota B');
  await B.locator('#notes').blur();
  await sleep(2500);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(2500);
  const row = fake.rows().find(r => r.data.name === 'Antigo 1');
  check(row.data.records.length === 2 && row.data.notes === 'nota B' && row.data.records.some(r => r.id === 'r_outro'),
    'linha tem a marcação de A, a do outro aparelho e a nota de B (' + row.data.records.length + ' registros)');
  const conflicts = fake.log.filter(l => l.method === 'PATCH' && l.path.startsWith('/rest/v1/crono_study?') && l.matched === 0).length;
  check(conflicts >= 1, 'conflito detectado e resolvido por estudo (' + conflicts + ')');
  check(fake.rowOf('ana@x.com').updated_at === blobBefore, 'modo novo não grava mais na tabela antiga');
  const incremental = fake.log.filter(l => l.method === 'GET' && /crono_study\?.*updated_at=gt\./.test(l.path)).length;
  check(incremental >= 1, 'busca incremental (só o que mudou): ' + incremental);

  // exclusão propaga (deleted_at)
  await B.click('[data-action=toggle-menu]');
  await B.click('#menuDropdown [data-action=back-dashboard]');
  await acceptNextDialog(B);
  await B.click('.study-card:has-text("Antigo 2") [data-action=delete-study]');
  await sleep(1500);
  check(!!fake.rows().find(r => r.data.name === 'Antigo 2').deleted_at, 'exclusão marcada na linha (deleted_at)');
  await A.click('[data-action=toggle-menu]');
  await A.click('#menuDropdown [data-action=back-dashboard]');
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  check(!(await A.textContent('#studyCards')).includes('Antigo 2'), 'exclusão chegou em A');

  // versões no servidor + restaurar
  await A.click('.study-card:has-text("Antigo 1") [data-action=open-study]');
  await A.fill('#notes', 'versão ruim');
  await A.locator('#notes').blur();
  await sleep(1500);
  await A.click('#tabHist');
  await A.click('[data-action=load-versions]');
  await A.waitForSelector('#versionsList .version-btn');
  const nv = await A.locator('#versionsList .version-btn').count();
  check(nv >= 1, 'versões anteriores listadas: ' + nv);
  await acceptNextDialog(A);
  await A.locator('#versionsList .version-btn').first().click();
  await sleep(500);
  await A.click('#tabCrono');
  check((await A.inputValue('#notes')) === 'nota B', 'versão restaurada (observação anterior voltou)');
  check(eA.filter(e => !/409|Conflict/.test(e)).length === 0 && eB.length === 0, 'sem erros: ' + [...eA, ...eB].join(' || '));
  await ctxA.close(); await ctxB.close();
});

/* ================================================================ */
T('compartilhamento: leitura, edição, sair e revogar', async () => {
  const fake = createFakeSupabase({ v2: true });
  fake.addUser('ana@x.com', 'segredo1');
  fake.addUser('bia@x.com', 'segredo2');
  const ctxA = await newCtx(fake), ctxB = await newCtx(fake);
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const eA = watch(A, 'A'), eB = watch(B, 'B');
  await login(A, 'ana@x.com', 'segredo1');
  await setupStudy(A, 'Do time', [['E1', 'VA'], ['E2', 'NVA']]);
  await A.click('#btnStart');
  await sleep(200);
  await A.click('.stage-wrap:nth-child(1) .stage');
  await sleep(1500);
  await A.click('[data-action=toggle-menu]');
  check(await A.isVisible('#btnShare'), 'botão Compartilhar para o dono');
  await A.click('#btnShare');
  await A.fill('#shareEmail', 'BIA@x.com');
  await A.selectOption('#shareRole', 'viewer');
  await A.click('#shareForm button[type=submit]');
  await A.waitForSelector('#shareList table');
  check(fake.shares().length === 1 && fake.shares()[0].email === 'bia@x.com', 'convite gravado (e-mail normalizado)');
  await A.keyboard.press('Escape');

  await login(B, 'bia@x.com', 'segredo2');
  await sleep(1200);
  check((await B.textContent('.study-card')).includes('Somente leitura'), 'card mostra "Somente leitura"');
  await B.click('.study-card [data-action=open-study]');
  check(await B.evaluate(() => document.body.classList.contains('readonly')), 'editor em modo somente leitura');
  check(!(await B.isVisible('.timer-controls')) && !(await B.isVisible('#stageForm')), 'controles de edição escondidos');
  check(await B.isDisabled('.stage-wrap .stage'), 'etapas não podem ser marcadas');
  check(await B.locator('#recordsTable [contenteditable]').count() === 0, 'tabela sem edição');
  await B.click('[data-action=toggle-menu]');
  check(!(await B.isVisible('#btnShare')), 'convidado não compartilha');
  await B.keyboard.press('Escape');

  // dono muda para "pode editar"
  await A.click('[data-action=toggle-menu]');
  await A.click('#btnShare');
  await A.waitForSelector('#shareList select');
  await A.selectOption('#shareList select', 'editor');
  await sleep(300);
  await A.keyboard.press('Escape');
  await B.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  check(!(await B.evaluate(() => document.body.classList.contains('readonly'))), 'convidado agora pode editar');
  await B.fill('#notes', 'editado pela Bia');
  await B.locator('#notes').blur();
  await sleep(1500);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(1500);
  check((await A.inputValue('#notes')) === 'editado pela Bia', 'dono recebeu a edição da convidada');
  check((await B.textContent('#btnDeleteCurrent')) === 'Sair do compartilhamento', 'convidado não exclui: só sai');

  // convidado sai
  await B.click('[data-action=toggle-menu]');
  await B.click('#menuDropdown [data-action=back-dashboard]');
  await acceptNextDialog(B);
  await B.click('.study-card [data-action=leave-study]');
  await sleep(500);
  check((await B.$$('.study-card')).length === 0 && fake.shares().length === 0, 'convidado saiu do estudo');
  check(!!fake.rows()[0] && !fake.rows()[0].deleted_at, 'estudo continua com o dono');

  // revogação: dono compartilha de novo e depois remove → some na próxima busca completa
  await A.click('[data-action=toggle-menu]');
  await A.click('#btnShare');
  await A.fill('#shareEmail', 'bia@x.com');
  await A.click('#shareForm button[type=submit]');
  await A.waitForSelector('#shareList table');
  await B.reload(); await B.waitForSelector('body.authed'); await sleep(1500);
  check((await B.$$('.study-card')).length === 1, 'compartilhado de novo');
  await acceptNextDialog(A);
  await A.click('#shareList [data-unshare]');
  await sleep(500);
  await A.keyboard.press('Escape');
  await B.reload(); await B.waitForSelector('body.authed'); await sleep(1500);
  check((await B.$$('.study-card')).length === 0, 'acesso revogado: estudo some do convidado');
  check(eA.length === 0 && eB.length === 0, 'sem erros: ' + [...eA, ...eB].join(' || '));
  await ctxA.close(); await ctxB.close();
});

/* ================================================================ */
T('admin com estatísticas, IndexedDB e excluir conta', async () => {
  const fake = createFakeSupabase({ v2: true, rpcEnabled: true });
  fake.addUser('daniel.thomaseto@dhl.com', 'admin123');
  fake.addUser('ana@x.com', 'segredo1');
  const ctxA = await newCtx(fake);
  const A = await ctxA.newPage();
  const eA = watch(A, 'A');
  await login(A, 'ana@x.com', 'segredo1');
  await setupStudy(A, 'Da Ana', [['E1', 'VA']]);
  await A.click('#btnStart'); await sleep(200); await A.click('.stage');
  await sleep(1500);
  // dados ficam no IndexedDB
  const idb = await A.evaluate(async () => new Promise(res => {
    const r = indexedDB.open('cronoanalise-' + JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-')))).user.id);
    r.onsuccess = () => { const t = r.result.transaction('studies').objectStore('studies').getAll(); t.onsuccess = () => { r.result.close(); res(t.result.map(s => s.name)); }; };
  }));
  check(idb.includes('Da Ana'), 'estudo gravado no IndexedDB');
  check(!(await A.evaluate(() => Object.keys(localStorage).some(k => k.endsWith(':store')))), 'store grande não fica mais no localStorage');

  const ctxD = await newCtx(fake);
  const D = await ctxD.newPage();
  const eD = watch(D, 'admin');
  await login(D, 'daniel.thomaseto@dhl.com', 'admin123');
  await sleep(800);
  await D.click('[data-action=toggle-menu]');
  await D.click('#btnAdmin');
  await D.waitForFunction(() => document.querySelectorAll('#adminUsersTable tr').length === 2);
  const headers = await D.$$eval('#adminUsersHead th', ths => ths.map(t => t.textContent));
  check(headers.includes('Estudos') && headers.includes('Registros'), 'colunas de estatísticas por usuário');
  const anaRow = await D.$eval('#adminUsersTable', tb => [...tb.querySelectorAll('tr')].find(tr => tr.textContent.includes('ana@x.com')).textContent);
  check(/1\s*1\s*0$/.test(anaRow.replace(/\s+/g, ' ').trim().split(' ').slice(-3).join(' ')) || anaRow.includes('11'), 'Ana: 1 estudo, 1 registro: ' + anaRow);
  await D.keyboard.press('Escape');

  // Ana exclui a conta
  await A.click('[data-action=toggle-menu]');
  await A.click('#menuDropdown [data-action=back-dashboard]');
  await A.click('[data-action=toggle-menu]');
  await A.click('#menuDropdown [data-action=open-settings]');
  await A.click('[data-action=delete-account]');
  await A.fill('#deleteConfirm', 'excluir');
  await A.click('#btnConfirmDelete');
  await A.waitForSelector('#authOverlay', { state: 'visible', timeout: 8000 });
  check(!fake.hasUser('ana@x.com') && fake.rows().length === 0, 'conta e estudos apagados no servidor');
  await sleep(500);
  const left = await A.evaluate(async () => (await indexedDB.databases()).map(d => d.name).filter(n => n.startsWith('cronoanalise-')));
  check(left.length === 0, 'dados apagados deste aparelho');
  check(eA.length === 0 && eD.length === 0, 'sem erros: ' + [...eA, ...eD].join(' || '));
  await ctxA.close(); await ctxD.close();
});

/* ================================================================ */
/* Funções da versão Beta 11                                         */
/* ================================================================ */

/* PNG válido gerado na hora (para simular a câmera). */
function makePng(w, h, rgb = [212, 5, 17]) {
  const crc = buf => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = rgb[0]; raw[o + 1] = (x * 4) & 255; raw[o + 2] = rgb[2]; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function waitFor(fn, ms = 6000, step = 100) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(step); }
  return false;
}

async function menu(page, action) {
  await page.click('[data-action=toggle-menu]');
  await page.click('#menuDropdown [data-action=' + action + ']');
}

async function markCycles(page, n, stages, delay = () => 80) {
  if (!(await page.isDisabled('#btnPause'))) { /* já rodando */ } else await page.click('#btnStart');
  for (let c = 0; c < n; c++) {
    for (let i = 1; i <= stages; i++) { await sleep(delay(c, i)); await page.click(`.stage-wrap:nth-child(${i}) .stage`); }
    await page.click('[data-action=new-cycle]');
  }
}

async function shareWith(page, email, role) {
  await menu(page, 'share');
  await page.fill('#shareEmail', email);
  await page.selectOption('#shareRole', role);
  await page.click('#shareForm button[type=submit]');
  await page.waitForSelector('#shareList table');
  await page.keyboard.press('Escape');
}

const xlsxHas = (file, text) => fs.readFileSync(file).toString('latin1').includes(text);

T('login no visual da empresa: título, olho da senha e entrar com a conta Microsoft', async () => {
  const fake = createFakeSupabase({ v3: true });
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'login');
  await page.goto(BASE);
  await page.waitForSelector('#authEmail', { state: 'visible' });
  check((await page.textContent('#loginTitle')) === 'CronoAnalise System', 'título "CronoAnalise System"');
  await page.waitForTimeout(300);
  check(await page.locator('#btnMicrosoft').isHidden() && await page.locator('#msSep').isHidden(), 'provedor Microsoft desligado no Supabase: botão escondido');
  check(await page.$eval('#btnOneDrive', b => b.hidden), 'sem o provedor, "Salvar no OneDrive" também fica escondido');
  check((await page.textContent('#loginCredit')).includes('Daniel Thomaseto'), 'assinatura do autor na tela de login');
  check((await page.$eval('.login-submit', b => getComputedStyle(b).backgroundColor)) === 'rgb(255, 204, 0)', 'botão Entrar no amarelo DHL');
  check((await page.$eval('.login-brand', b => getComputedStyle(b).backgroundColor)) === 'rgb(255, 204, 0)', 'faixa da marca amarela');
  await page.screenshot({ path: OUT + 'login-dhl.png' });
  await page.fill('#authPass', 'abc123');
  await page.click('#btnShowPass');
  check((await page.getAttribute('#authPass', 'type')) === 'text' && (await page.getAttribute('#btnShowPass', 'aria-pressed')) === 'true', 'olho mostra a senha');
  await page.click('#btnShowPass');
  check((await page.getAttribute('#authPass', 'type')) === 'password', 'olho esconde a senha de novo');

  fake.setAzure(true);
  await page.reload();
  await page.waitForSelector('#btnMicrosoft', { state: 'visible' });
  check(true, 'provedor ativado no Supabase: botão aparece sozinho (sem deploy)');
  check((await page.textContent('#btnMicrosoft')).includes('Acesso com e-mail DHL'), 'botão "Acesso com e-mail DHL"');
  check(await page.locator('#btnMicrosoft .ms-logo rect').count() === 4, 'logo da Microsoft (4 quadrados)');
  await page.click('#btnMicrosoft');
  await page.waitForSelector('body.authed', { timeout: 10000 });
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
  check((await page.textContent('#userEmail')) === 'ana.ms@dhl.com', 'entrou com a conta Microsoft');
  const last = fake.authorizeLog[fake.authorizeLog.length - 1];
  check(last.provider === 'azure' && /email/.test(last.scopes) && !/Files/.test(last.scopes), 'login comum pede só o e-mail (OneDrive só quando usar)');
  check(await page.evaluate(() => !!sessionStorage.getItem('cronoanalise:graphToken')), 'token do Microsoft Graph guardado só nesta aba');
  check(!(await page.$eval('#btnOneDrive', b => b.hidden)), 'com o provedor ativo, "Salvar no OneDrive" aparece no menu');
  check(!page.url().includes('access_token'), 'tokens removidos da barra de endereço');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

T('verificação em duas etapas (TOTP): ativar, entrar com código e desativar', async () => {
  const fake = createFakeSupabase({ v3: true });
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'mfa');
  await login(page, 'ana@x.com', 'segredo1');
  await menu(page, 'open-settings');
  await page.waitForFunction(() => document.getElementById('mfaStatus').textContent === 'desativada');
  await page.click('#btnMfaToggle');
  await page.waitForSelector('#mfaEnrollModal:not([hidden])');
  const secret = (await page.textContent('#mfaSecret')).trim();
  check(/^[A-Z2-7]{16,}$/.test(secret) && (await page.getAttribute('#mfaQr', 'src')).startsWith('data:image/svg+xml'), 'QR code e chave exibidos');
  await page.fill('#mfaEnrollCode', '123456');
  await page.click('#mfaEnrollForm button[type=submit]');
  await page.waitForFunction(() => document.getElementById('mfaEnrollError').textContent.length > 0);
  check((await page.textContent('#mfaEnrollError')).includes('Código inválido'), 'código errado é recusado');
  await page.fill('#mfaEnrollCode', totp(secret));
  await page.click('#mfaEnrollForm button[type=submit]');
  await page.waitForSelector('#mfaEnrollModal', { state: 'hidden' });
  check(fake.factorsOf('ana@x.com').some(f => f.status === 'verified'), 'fator verificado no servidor');

  await menu(page, 'sign-out');
  await page.waitForSelector('#authOverlay', { state: 'visible' });
  await page.fill('#authEmail', 'ana@x.com');
  await page.fill('#authPass', 'segredo1');
  await page.click('#authForm button[type=submit]');
  await page.waitForSelector('#mfaOverlay:not([hidden])');
  check(!(await page.evaluate(() => document.body.classList.contains('authed'))), 'sem o código, o app não abre');
  await page.fill('#mfaCode', '000000');
  await page.click('#mfaForm button[type=submit]');
  await page.waitForFunction(() => document.getElementById('mfaError').textContent.length > 0);
  await page.fill('#mfaCode', totp(secret));
  await page.click('#mfaForm button[type=submit]');
  await page.waitForSelector('body.authed', { timeout: 10000 });
  check(await page.isHidden('#mfaOverlay'), 'código certo abre o app');
  await setupStudy(page, 'Com 2 etapas', [['E1', 'VA']]);
  await page.click('#btnStart'); await sleep(150); await page.click('.stage');
  check(await waitFor(() => fake.rows().length === 1), 'sessão verificada (aal2) sincroniza normalmente');

  await menu(page, 'open-settings');
  await page.waitForFunction(() => document.getElementById('mfaStatus').textContent === 'ativada');
  await acceptNextDialog(page);
  await page.click('#btnMfaToggle');
  check(await waitFor(() => fake.factorsOf('ana@x.com').length === 0), 'verificação em duas etapas desativada');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

T('saída automática por inatividade (exceto com cronômetro rodando)', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'idle');
  await login(page, 'ana@x.com', 'segredo1');
  await menu(page, 'open-settings');
  await page.selectOption('#prefAutoLogout', '15');
  await page.keyboard.press('Escape');
  await setupStudy(page, 'Coleta longa', [['E1', 'VA']]);
  await page.click('#btnStart');
  const goIdle = ms => page.evaluate(ago => { localStorage.setItem('cronoanalise:lastActive', String(Date.now() - ago)); document.dispatchEvent(new Event('visibilitychange')); }, ms);
  await goIdle(3600000);
  await sleep(600);
  check(await page.evaluate(() => document.body.classList.contains('authed')), 'com cronômetro rodando, não sai');
  await page.click('#btnPause');
  await goIdle(3600000);
  await page.waitForSelector('#authOverlay', { state: 'visible', timeout: 8000 });
  check((await page.textContent('#toast')).includes('inatividade'), 'saiu por inatividade e avisou');

  await login(page, 'ana@x.com', 'segredo1');
  await page.evaluate(() => localStorage.setItem('cronoanalise:lastActive', String(Date.now() - 15 * 60000 - 5000)));
  await page.waitForSelector('#idleModal:not([hidden])', { timeout: 20000 });
  check(Number(await page.textContent('#idleCount')) <= 60, 'aviso com contagem regressiva');
  await page.click('[data-action=idle-stay]');
  check(await page.isHidden('#idleModal') && await page.evaluate(() => document.body.classList.contains('authed')), '"Continuar conectado" mantém a sessão');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

T('balanceamento de linha, ritmo Westinghouse por etapa e tendência do ciclo', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'bal');
  await login(page, 'ana@x.com', 'segredo1');
  await setupStudy(page, 'Linha balanceada', [['Pegar', 'VA'], ['Montar', 'VA'], ['Conferir', 'NVA'], ['Embalar', 'VA']]);
  await page.click('#stdParams summary');
  await page.fill('#demand', '480');
  await page.fill('#availableMin', '400');
  for (const [i, st] of [[1, 'P1'], [2, 'P1'], [3, 'P2'], [4, 'P2']]) {
    await page.click(`.stage-wrap:nth-child(${i}) .stage-edit`);
    await page.fill('#editStageStation', st);
    if (i === 2) {
      await page.click('#whBox summary');
      await page.selectOption('#whFields [data-wh=skill]', 'C1');
      await page.selectOption('#whFields [data-wh=effort]', 'C2');
      check((await page.textContent('#whResult')) === '108%', 'ritmo Westinghouse calculado no modal (C1 + C2 = 108%)');
    }
    await page.click('#stageEditForm button[type=submit]');
  }
  const t2 = await page.textContent('.stage-wrap:nth-child(2) .stage-type');
  check(t2.includes('P1') && t2.includes('ritmo 108%'), 'etapa mostra posto e ritmo: ' + t2);
  await markCycles(page, 6, 4, (c, i) => 50 + (6 - c) * 45 + (i === 2 ? 60 : 0));
  await sleep(300);
  const kpis = await page.textContent('#stats .kpi-grid');
  check(kpis.includes('Tendência do Ciclo') && kpis.includes('▼'), 'tendência de queda (aprendizado) detectada');
  check((await page.$$eval('#stats .summary-table th', ths => ths.map(t => t.textContent))).includes('Ritmo%'), 'coluna de ritmo no resumo');
  check(await page.locator('#stats .summary-table td', { hasText: '108 W' }).count() === 1, 'etapa com avaliação Westinghouse marcada com W');
  const bal = await page.textContent('#balance');
  check(bal.includes('P1') && bal.includes('P2') && bal.includes('Gargalo') && bal.includes('Mínimo de postos'), 'painel de balanceamento com postos, gargalo e mínimo de postos');
  check(await page.locator('#balanceChart svg path.mark').count() === 4, 'gráfico de carga por posto (4 etapas empilhadas)');
  check((await page.textContent('#stats .chart-card:last-child figcaption')).includes('tendência'), 'linha de tendência no gráfico de ciclo');
  await page.selectOption('#balanceK', '3');
  await acceptNextDialog(page);
  await page.click('[data-balance-apply]');
  const types = await page.$$eval('.stage-wrap .stage-type', els => els.map(e => e.textContent));
  check(types.some(t => t.includes('Posto 3')), 'sugestão aplicada nas etapas: ' + types.join(' | '));
  const store = await studyData(page);
  const st = Object.values(store.studies)[0];
  check(st.stages.find(x => x.name === 'Montar').wh.skill === 'C1', 'avaliação gravada na etapa');
  const dl = page.waitForEvent('download');
  await menu(page, 'export-xlsx');
  const d = await dl;
  check(xlsxHas(await d.path(), 'Balanceamento') && xlsxHas(await d.path(), 'Ritmo (%)'), 'Excel com a aba Balanceamento e o ritmo por etapa');
  await page.screenshot({ path: OUT + 'balanceamento.png', fullPage: true });
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

T('amostragem do trabalho: categorias, roteiro aleatório, observações, resultados e exportação', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'amostra');
  await login(page, 'ana@x.com', 'segredo1');
  await page.click('.dash-hero [data-action=new-sampling]');
  check(await page.evaluate(() => document.body.classList.contains('kind-sampling')), 'editor no modo amostragem');
  check((await page.textContent('#tabCrono')) === 'Amostragem' && !(await page.isVisible('.module')), 'aba "Amostragem" e sem cronômetro');
  check(await page.locator('#samplingCats .stage').count() === 5, '5 categorias padrão');
  await page.fill('#studyName', 'Picking turno A');
  await page.fill('#planStart', '00:00');
  await page.fill('#planEnd', '23:59');
  await page.fill('#planCount', '40');
  await page.locator('#planCount').blur();
  check(await page.locator('#planList .plan-chip').count() === 40, 'roteiro com 40 horários sorteados');
  for (const i of [1, 1, 1, 2]) { await page.click(`#samplingCats .stage:nth-child(${i})`); await sleep(80); }
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('3');
  check(await page.locator('#obsTable tr[data-id]').count() === 5, '5 observações (toques e atalho 3)');
  const res = await page.textContent('#samplingStats');
  check(res.includes('60,0%') && res.includes('necessárias'), '% produtivo e observações necessárias: ' + res.slice(0, 80));
  check(await page.locator('#samplingStats svg .whisker').count() > 0, 'gráfico com intervalo de confiança');
  await page.fill('#catName', 'Retrabalho');
  await page.click('#catForm button[type=submit]');
  check(await page.locator('#samplingCats .stage').count() === 6, 'categoria nova');
  await page.click('#btnSampleUndo');
  check(await page.locator('#obsTable tr[data-id]').count() === 4, 'desfazer a última observação');
  await acceptNextDialog(page);
  await page.click('#catList tr:has(input[value="Ausente"]) [data-cat-remove]');
  check(await page.locator('#samplingCats .stage').count() === 5, 'categoria removida');
  let dl = page.waitForEvent('download');
  await menu(page, 'export-csv');
  let d = await dl;
  const csv = fs.readFileSync(await d.path(), 'utf8');
  check(csv.includes('Amostragem do trabalho') && csv.includes('% produtivo'), 'CSV da amostragem');
  dl = page.waitForEvent('download');
  await menu(page, 'export-xlsx');
  d = await dl;
  check(xlsxHas(await d.path(), 'Por categoria'), 'Excel da amostragem (aba Por categoria)');
  await page.screenshot({ path: OUT + 'amostragem.png', fullPage: true });
  await menu(page, 'back-dashboard');
  const card = await page.textContent('.study-card');
  check(card.includes('Amostragem do trabalho') && card.includes('4 observações'), 'card mostra o tipo e as observações');
  check(await page.isDisabled('#btnCompare'), 'comparação é só para cronoanálises');
  await page.click('.study-card [data-action=template-study]');
  check(await page.locator('#samplingCats .stage').count() === 5 && (await page.inputValue('#planCount')) === '40', 'modelo copia categorias e roteiro');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

T('tempo real: alterações de outro aparelho aparecem sozinhas (selo "ao vivo")', async () => {
  const fake = createFakeSupabase({ v3: true });
  fake.addUser('ana@x.com', 'segredo1');
  fake.addUser('bia@x.com', 'segredo2');
  const ctxA = await newCtx(fake), ctxB = await newCtx(fake);
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const eA = watch(A, 'A'), eB = watch(B, 'B');
  await login(A, 'ana@x.com', 'segredo1');
  await setupStudy(A, 'Ao vivo', [['E1', 'VA'], ['E2', 'VA']]);
  await A.click('#btnStart'); await sleep(150); await A.click('.stage-wrap:nth-child(1) .stage');
  await sleep(1500);
  await shareWith(A, 'bia@x.com', 'editor');
  await login(B, 'bia@x.com', 'segredo2');
  await B.waitForSelector('.study-card');
  await B.click('.study-card [data-action=open-study]');
  await B.waitForSelector('#liveBadge:not([hidden])', { timeout: 8000 });
  check(true, 'selo "ao vivo" no aparelho B');
  check(fake.subscriberCount() >= 2, 'os dois aparelhos assinaram as mudanças');
  await sleep(300);
  await A.click('.stage-wrap:nth-child(2) .stage');
  const t0 = Date.now();
  const got = await waitFor(() => B.evaluate(() => document.querySelectorAll('#recordsTable tr[data-id]').length === 2), 6000);
  check(got, 'B recebeu a marcação de A em ' + (Date.now() - t0) + ' ms (sem esperar a busca periódica)');
  const id = Object.keys((await studyData(A)).studies)[0];
  fake.serverUpdate(id, d => ({ ...d, notes: 'escrito no servidor', fieldTs: { ...(d.fieldTs || {}), notes: new Date(Date.now() + 1000).toISOString() } }));
  check(await waitFor(() => A.evaluate(() => document.getElementById('notes').value === 'escrito no servidor'), 6000), 'A recebeu a alteração do servidor em tempo real');
  check(eA.length === 0 && eB.length === 0, 'sem erros: ' + [...eA, ...eB].join(' || '));
  await ctxA.close(); await ctxB.close();
});

T('times: criar, adicionar pessoas, compartilhar com o time, painel do time e sair', async () => {
  const fake = createFakeSupabase({ v3: true });
  fake.addUser('ana@x.com', 'segredo1');
  fake.addUser('bia@x.com', 'segredo2');
  const ctxA = await newCtx(fake), ctxB = await newCtx(fake);
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const eA = watch(A, 'A'), eB = watch(B, 'B');
  await login(A, 'ana@x.com', 'segredo1');
  await setupStudy(A, 'Estudo do time', [['E1', 'VA']]);
  await A.click('#btnStart'); await sleep(150); await A.click('.stage');
  await sleep(1500);
  await menu(A, 'open-teams');
  await A.waitForSelector('#teamForm:not([hidden])');
  await A.fill('#teamName', 'Site Cajamar');
  await A.click('#teamForm button[type=submit]');
  await A.waitForSelector('#teamDetail:not([hidden])');
  await A.fill('#memberEmail', 'BIA@x.com');
  await A.click('#memberForm button[type=submit]');
  await A.waitForFunction(() => document.getElementById('membersList').textContent.includes('bia@x.com'));
  check(fake.db.crono_team.size === 1 && fake.db.crono_team_member.length === 1, 'time criado com a Bia');
  await A.keyboard.press('Escape');
  await menu(A, 'share');
  await A.waitForSelector('#teamShareBox:not([hidden])');
  await A.selectOption('#teamShareRole', 'viewer');
  await A.click('#teamShareForm button[type=submit]');
  await A.waitForFunction(() => document.getElementById('teamShareList').textContent.includes('Site Cajamar'));
  check(fake.db.crono_study_team_share.length === 1, 'estudo compartilhado com o time');
  await A.keyboard.press('Escape');

  await login(B, 'bia@x.com', 'segredo2');
  await B.waitForSelector('.study-card');
  check((await B.textContent('.study-card')).includes('Somente leitura'), 'integrante vê o estudo do time (somente leitura)');
  const teamId = [...fake.db.crono_team.keys()][0];
  await B.waitForSelector(`#dashFilter option[value="team:${teamId}"]`, { state: 'attached', timeout: 8000 });
  await B.selectOption('#dashFilter', 'team:' + teamId);
  check((await B.textContent('#dashKpisTitle')).includes('Painel do time — Site Cajamar'), 'painel do time no dashboard');
  check(await B.locator('.study-card').count() === 1 && (await B.textContent('.study-card')).includes('Site Cajamar'), 'card com o selo do time');
  await B.click('.study-card [data-action=open-study]');
  check(await B.evaluate(() => document.body.classList.contains('readonly')), 'editor somente leitura');

  await menu(A, 'share');
  await A.waitForSelector('#teamShareList select');
  await A.selectOption('#teamShareList select', 'editor');
  await sleep(300);
  await A.keyboard.press('Escape');
  check(await waitFor(() => B.evaluate(() => !document.body.classList.contains('readonly')), 8000), 'time passou a "editar": B pode editar sem recarregar');

  await menu(B, 'open-teams');
  await B.waitForSelector('#teamsList [data-team]');
  await B.click('#teamsList [data-team]');
  await acceptNextDialog(B);
  await B.click('#btnTeamLeave');
  await sleep(500);
  await B.keyboard.press('Escape');
  check(await waitFor(() => B.evaluate(() => document.body.classList.contains('view-dashboard') && !document.querySelector('.study-card')), 8000), 'saiu do time: o estudo some do aparelho');
  check(eA.length === 0 && eB.length === 0, 'sem erros: ' + [...eA, ...eB].join(' || '));
  await ctxA.close(); await ctxB.close();
});

T('fotos: tirar, enviar ao Storage, ver em outro aparelho, offline e remover', async () => {
  const fake = createFakeSupabase({ v3: true });
  fake.addUser('ana@x.com', 'segredo1');
  fake.addUser('bia@x.com', 'segredo2');
  const ctxA = await newCtx(fake), ctxB = await newCtx(fake);
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const eA = watch(A, 'A'), eB = watch(B, 'B');
  await login(A, 'ana@x.com', 'segredo1');
  await setupStudy(A, 'Com fotos', [['Espera de caixa', 'Espera']]);
  await A.click('#btnStart'); await sleep(150); await A.click('.stage');
  await sleep(1500);
  let fc = A.waitForEvent('filechooser');
  await A.click('#btnPhoto');
  await (await fc).setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: makePng(320, 240) });
  await A.waitForSelector('#recordsTable [data-action=record-photos]');
  check((await A.textContent('#recordsTable [data-action=record-photos]')).includes('1'), 'registro com 1 foto');
  check(await waitFor(() => fake.db.storage.size === 1), 'foto enviada ao Storage');
  const [path, file] = [...fake.db.storage.entries()][0];
  const studyId = Object.keys((await studyData(A)).studies)[0];
  check(path.startsWith(studyId + '/') && path.endsWith('.jpg') && file.contentType === 'image/jpeg', 'caminho <estudo>/<foto>.jpg em JPEG: ' + path);
  check(file.bytes[0] === 0xff && file.bytes[1] === 0xd8, 'foto convertida para JPEG no aparelho');
  await A.click('#recordsTable [data-action=record-photos]');
  await A.waitForFunction(() => { const i = document.querySelector('#photoGrid img'); return i && i.naturalWidth > 0; });
  check(true, 'galeria mostra a foto (cópia local)');
  await A.keyboard.press('Escape');

  await shareWith(A, 'bia@x.com', 'viewer');
  await login(B, 'bia@x.com', 'segredo2');
  await B.waitForSelector('.study-card');
  await B.click('.study-card [data-action=open-study]');
  await B.click('#recordsTable [data-action=record-photos]');
  await B.waitForFunction(() => { const i = document.querySelector('#photoGrid img'); return i && i.naturalWidth > 0; }, null, { timeout: 8000 });
  check((await B.getAttribute('#photoGrid img', 'src')).startsWith(SB_URL + '/storage/v1/object/sign/'), 'outro aparelho vê a foto por link assinado');
  check(await B.locator('#photoGrid [data-photo-remove]').count() === 0, 'quem só pode ver não remove fotos');
  await B.keyboard.press('Escape');

  await ctxA.setOffline(true); fake.setOffline(true);
  fc = A.waitForEvent('filechooser');
  await A.click('#recordsTable [data-action=record-photo]');
  await (await fc).setFiles({ name: 'foto2.png', mimeType: 'image/png', buffer: makePng(200, 150, [0, 131, 0]) });
  await A.waitForFunction(() => (document.querySelector('#recordsTable [data-action=record-photos]') || {}).textContent === '🖼 2');
  check(fake.db.storage.size === 1, 'offline: a foto fica no aparelho');
  await A.click('#recordsTable [data-action=record-photos]');
  await A.waitForSelector('#photoGrid [data-pending]:not([hidden])');
  check(true, 'galeria indica "aguardando envio"');
  await A.keyboard.press('Escape');
  await ctxA.setOffline(false); fake.setOffline(false);
  await A.evaluate(() => window.dispatchEvent(new Event('online')));
  check(await waitFor(() => fake.db.storage.size === 2, 10000), 'conexão voltou: a foto subiu sozinha');

  await A.click('#recordsTable [data-action=record-photos]');
  await A.waitForSelector('#photoGrid [data-photo-remove]');
  await acceptNextDialog(A);
  await A.click('#photoGrid [data-photo-remove]');
  check(await waitFor(() => fake.db.storage.size === 1), 'foto removida também do servidor');
  check(eA.length === 0 && eB.length === 0, 'sem erros: ' + [...eA, ...eB].join(' || '));
  await ctxA.close(); await ctxB.close();
});

T('erros do app: registrados sem dados pessoais, painel do admin e retenção', async () => {
  const fake = createFakeSupabase({ v3: true, rpcEnabled: true });
  fake.addUser('ana@x.com', 'segredo1');
  fake.addUser('daniel.thomaseto@dhl.com', 'admin123');
  const ctxA = await newCtx(fake);
  const A = await ctxA.newPage();
  const eA = watch(A, 'A');
  await login(A, 'ana@x.com', 'segredo1');
  await A.evaluate(() => setTimeout(() => { throw new Error('Falha de teste para ana@x.com com eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl'); }, 0));
  check(await waitFor(() => fake.db.crono_client_error.length === 1), 'erro enviado ao servidor');
  const err = fake.db.crono_client_error[0];
  check(err.message.includes('Falha de teste') && !err.message.includes('ana@x.com') && err.message.includes('<e-mail>') && err.message.includes('<token>'), 'e-mail e token mascarados: ' + err.message);
  check(err.app_version === 'Beta 11' && err.context && err.context.view === 'dashboard' && !/[?#]/.test(err.url), 'versão, contexto e URL sem tokens');
  const ctxD = await newCtx(fake);
  const D = await ctxD.newPage();
  const eD = watch(D, 'admin');
  await login(D, 'daniel.thomaseto@dhl.com', 'admin123');
  await sleep(500);
  await menu(D, 'open-admin');
  await D.click('#adminTabErrors');
  await D.waitForSelector('#adminErrorsList .error-item');
  check((await D.textContent('#adminErrorsList')).includes('Falha de teste'), 'admin vê o erro no painel');
  await D.click('#adminTabData');
  await D.click('[data-action=admin-purge]');
  await D.waitForFunction(() => document.getElementById('adminPurgeResult').textContent.startsWith('Removidos'));
  check(true, 'política de retenção aplicada pelo painel');
  await D.click('#adminTabErrors');
  await D.waitForSelector('#adminErrorsList .error-item');
  await acceptNextDialog(D);
  await D.click('[data-action=admin-clear-errors]');
  check(await waitFor(() => fake.db.crono_client_error.length === 0), 'admin apaga os erros');
  const real = eA.filter(e => !e.includes('Falha de teste'));
  check(real.length === 0 && eD.length === 0, 'sem outros erros: ' + [...real, ...eD].join(' || '));
  await ctxA.close(); await ctxD.close();
});

T('relatório A3, salvar no OneDrive e enviar arquivo (Teams/e-mail)', async () => {
  const fake = createFakeSupabase({ v3: true, azure: true });
  const ctx = await newCtx(fake);
  const uploads = [];
  await ctx.route('https://graph.microsoft.com/**', r => {
    const q = r.request();
    uploads.push({ url: q.url(), method: q.method(), auth: q.headers().authorization, body: q.postDataBuffer() });
    r.fulfill({ status: 201, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ name: 'Antes A3.xlsx', webUrl: 'https://contoso-my.sharepoint.com/personal/x/Antes%20A3.xlsx' }) });
  });
  const page = await ctx.newPage();
  const errors = watch(page, 'a3');
  await page.goto(BASE);
  await page.click('#btnMicrosoft');
  await page.waitForSelector('body.authed', { timeout: 10000 });
  await page.waitForFunction(() => !document.body.classList.contains('booting'));
  await setupStudy(page, 'Depois A3', [['Pegar', 'VA'], ['Andar', 'Transporte']]);
  await markCycles(page, 2, 2, () => 60);
  await menu(page, 'back-dashboard');
  await setupStudy(page, 'Antes A3', [['Pegar', 'VA'], ['Andar', 'Transporte']]);
  await markCycles(page, 3, 2, () => 90);
  await page.click('#tabA3');
  await page.fill('[data-a3=problem]', 'Fila no picking');
  await page.fill('[data-a3=goal]', 'Ciclo abaixo do takt');
  await page.click('[data-action=a3-add-action]');
  await page.fill('#a3Actions tr:last-child [data-f=what]', 'Kanban de caixas');
  await page.fill('#a3Actions tr:last-child [data-f=who]', 'Ana');
  await page.fill('#a3Actions tr:last-child [data-f=when]', '2026-11-30');
  await page.selectOption('#a3Actions tr:last-child [data-f=status]', 'andamento');
  await page.selectOption('#a3After', { label: 'Depois A3' });
  await sleep(900);
  const st = Object.values((await studyData(page)).studies).find(s => s.name === 'Antes A3');
  check(st.a3 && st.a3.problem === 'Fila no picking' && st.a3.actions.length === 1 && st.a3.actions[0].status === 'andamento' && st.a3.afterStudyId, 'A3 gravado no estudo (textos, plano e estudo "depois")');
  await page.evaluate(() => { window.__printed = []; window.print = () => window.__printed.push({ a3: document.getElementById('a3Print').innerHTML, cls: document.body.classList.contains('print-a3'), page: !!document.getElementById('a3PageStyle') }); });
  await page.click('#editorA3 [data-action=print-a3]');
  await page.waitForFunction(() => window.__printed.length === 1);
  const pr = await page.evaluate(() => window.__printed[0]);
  check(pr.cls && pr.page, 'impressão em folha A3 paisagem');
  check(pr.a3.includes('Fila no picking') && pr.a3.includes('6. Plano de ação') && pr.a3.includes('Kanban de caixas') && pr.a3.includes('Variação') && pr.a3.includes('<svg'), 'A3 com textos, plano, comparação antes × depois e gráficos');

  await menu(page, 'export-onedrive');
  await page.waitForSelector('#infoModal:not([hidden])');
  check((await page.textContent('#infoModal')).includes('Salvo no OneDrive'), 'aviso de salvo no OneDrive com link');
  check(uploads.length === 1 && uploads[0].method === 'PUT' && uploads[0].url.includes('/me/drive/root:/CronoAnalise/Antes%20A3.xlsx:/content'), 'enviado para a pasta CronoAnalise do OneDrive');
  check(/^Bearer graph-/.test(uploads[0].auth) && uploads[0].body[0] === 0x50, 'com o token da Microsoft e o arquivo .xlsx');
  await page.keyboard.press('Escape');
  // autorização expirada: volta ao login da Microsoft pedindo o OneDrive e envia na volta
  await page.evaluate(() => sessionStorage.removeItem('cronoanalise:graphToken'));
  await acceptNextDialog(page);
  await menu(page, 'export-onedrive');
  await page.waitForFunction(() => document.body.classList.contains('authed') && !document.body.classList.contains('booting') && !location.hash, null, { timeout: 10000 });
  check(await waitFor(() => uploads.length === 2, 10000), 'após entrar de novo com a Microsoft, o envio continua sozinho');
  check(/Files\.ReadWrite/.test(fake.authorizeLog[fake.authorizeLog.length - 1].scopes), 'pede permissão do OneDrive só nessa hora');
  await page.waitForSelector('#infoModal:not([hidden])');
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.__shared = null;
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: async d => { window.__shared = { name: d.files[0].name, type: d.files[0].type, size: d.files[0].size }; }, configurable: true });
  });
  await menu(page, 'share-file');
  await page.waitForFunction(() => window.__shared);
  const shared = await page.evaluate(() => window.__shared);
  check(shared.name === 'Antes A3.xlsx' && shared.size > 1000, 'planilha enviada pela folha de compartilhamento do celular');
  const dl = page.waitForEvent('download');
  await menu(page, 'export-xlsx');
  check(xlsxHas(await (await dl).path(), 'name="A3"'), 'Excel com a aba A3');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

T('estudo grande (5.000 registros): tabela virtual e marcação rápida', async () => {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'grande');
  await login(page, 'ana@x.com', 'segredo1');
  await setupStudy(page, 'Grande', [['A', 'VA'], ['B', 'NVA'], ['C', 'Espera'], ['D', 'VA'], ['E', 'Transporte']]);
  await page.click('#btnStart'); await sleep(100); await page.click('.stage-wrap:nth-child(1) .stage');
  await sleep(300);
  await menu(page, 'back-dashboard');
  await page.evaluate(async () => {
    const storage = await import('/js/storage.js');
    const s = storage.listStudies()[0];
    const st = storage.getStudy(s.id);
    const base = Date.now() - 5000 * 1000;
    for (let i = 0; i < 5000; i++) {
      const stg = st.stages[i % 5];
      st.records.push({ id: 'big' + i, cycle: Math.floor(i / 5) + 2, stageId: stg.id, stageName: stg.name, type: stg.type, time: 1 + (i % 7) * 0.3, qty: 1, ts: new Date(base + i * 1000).toISOString() });
    }
    st.currentCycle = 1002;
    storage.putStudy(st);
    await storage.flushWrites();
  });
  const t0 = Date.now();
  await page.click('.study-card [data-action=open-study]');
  await page.waitForSelector('#recordsWrap.virtual');
  const openMs = Date.now() - t0;
  check(openMs < 4000, 'abre o estudo grande em ' + openMs + ' ms');
  const rows = await page.locator('#recordsTable tr[data-id]').count();
  check(rows > 10 && rows < 200, 'só as linhas visíveis são desenhadas: ' + rows + ' de 5001');
  check(await page.isVisible('#recordsHint'), 'aviso de tabela virtual');
  await page.evaluate(() => { const w = document.getElementById('recordsWrap'); w.scrollTop = w.scrollHeight / 2; });
  await sleep(300);
  const cyc = Number(await page.textContent('#recordsTable tr[data-id] td:first-child'));
  check(cyc > 300 && cyc < 700, 'rolagem desenha o meio da tabela (ciclo ' + cyc + ')');
  await page.click('#btnStart').catch(() => {});
  await sleep(200);
  const ms = await page.evaluate(() => {
    const t = performance.now();
    document.querySelector('.stage-wrap:nth-child(2) .stage').click();
    return performance.now() - t;
  });
  check(ms < 400, 'marcar uma etapa leva ' + Math.round(ms) + ' ms');
  await menu(page, 'toggle-field');
  await sleep(200);
  const msField = await page.evaluate(() => {
    const t = performance.now();
    document.querySelector('.stage-wrap:nth-child(3) .stage').click();
    return performance.now() - t;
  });
  check(msField < 200, 'no Modo Campo, marcar leva ' + Math.round(msField) + ' ms');
  await menu(page, 'toggle-field');
  await sleep(300);
  check(await page.locator('#recordsTable tr[data-id]').count() > 10, 'ao sair do Modo Campo, a tabela é redesenhada');
  const n = await page.evaluate(async () => (await import('/js/storage.js')).listStudies()[0].records.length);
  check(n === 5003, 'as marcações foram gravadas: ' + n);
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

T('banco sem a migração 003 (produção hoje): tudo funciona, sem erros nem tentativas repetidas', async () => {
  const fake = createFakeSupabase({ v2: true });
  fake.addUser('ana@x.com', 'segredo1');
  const ctx = await newCtx(fake);
  const page = await ctx.newPage();
  const errors = watch(page, 'sem003');
  await login(page, 'ana@x.com', 'segredo1');
  await setupStudy(page, 'Sem 003', [['E1', 'VA']]);
  await page.click('#btnStart'); await sleep(150); await page.click('.stage');
  await sleep(1500);
  const fc = page.waitForEvent('filechooser');
  await page.click('#btnPhoto');
  await (await fc).setFiles({ name: 'f.png', mimeType: 'image/png', buffer: makePng(64, 48) });
  await page.waitForSelector('#recordsTable [data-action=record-photos]');
  for (let i = 0; i < 3; i++) { await menu(page, 'manual-save'); await sleep(700); }
  const storageCalls = fake.log.filter(l => l.path.startsWith('/storage/')).length;
  check(storageCalls <= 2, 'sem o bucket, a foto fica no aparelho e o envio não é repetido a cada sincronização (' + storageCalls + ' tentativa(s))');
  const roleCalls = fake.log.filter(l => l.path.includes('crono_my_study_roles')).length;
  check(roleCalls >= 1, 'papéis lidos pelo fallback (sem a função da 003)');
  await menu(page, 'open-teams');
  await page.waitForSelector('#teamsUnavailable:not([hidden])');
  check(true, 'tela de times explica que falta a migração 003');
  await page.keyboard.press('Escape');
  await page.evaluate(() => setTimeout(() => { throw new Error('erro sem tabela'); }, 0));
  await sleep(800);
  const errCalls = fake.log.filter(l => l.path.includes('crono_client_error')).length;
  check(errCalls <= 1, 'registro de erros desiste sem a tabela (' + errCalls + ' tentativa)');
  check(!(await page.isVisible('#liveBadge')), 'sem tempo real: sem selo "ao vivo" (a busca periódica cobre)');
  const real = errors.filter(e => !e.includes('erro sem tabela'));
  check(real.length === 0, 'sem erros: ' + real.join(' || '));
  await ctx.close();
});

T('acessibilidade (axe-core): telas principais sem violações graves', async () => {
  let axePath;
  try { axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js'); } catch (e) {
    console.log('  (axe-core não instalado: npm i --no-save axe-core — cenário pulado)');
    return;
  }
  const fake = createFakeSupabase({ v3: true });
  fake.addUser('ana@x.com', 'segredo1');
  // bypassCSP só para injetar o axe; o app continua com a CSP nos outros cenários
  const ctx = await browser.newContext({ serviceWorkers: 'block', bypassCSP: true, viewport: { width: 1200, height: 900 } });
  await fake.attach(ctx);
  const page = await ctx.newPage();
  const errors = watch(page, 'a11y');
  const scan = async name => {
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ path: axePath });
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, resultTypes: ['violations'] });
      return r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' → ' + String(n.failureSummary || '').split('\n').slice(1, 2).join('')) }));
    });
    const bad = res.filter(v => v.impact === 'serious' || v.impact === 'critical');
    const minor = res.filter(v => !bad.includes(v)).map(v => v.id + '×' + v.n);
    check(bad.length === 0, name + (bad.length ? ': ' + JSON.stringify(bad, null, 1) : ' sem violações graves') + (minor.length ? ' (menores: ' + minor.join(', ') + ')' : ''));
  };
  // espera as transições de cor terminarem (senão o axe mede a cor no meio da animação)
  const dark = async on => { await page.evaluate(v => document.documentElement.classList.toggle('dark-theme', v), on); await sleep(400); };

  await page.goto(BASE);
  await page.waitForSelector('#authEmail', { state: 'visible' });
  await scan('login');
  await dark(true); await scan('login (tema escuro)'); await dark(false);
  await login(page, 'ana@x.com', 'segredo1');
  await scan('dashboard');
  await setupStudy(page, 'Acessível', [['Pegar', 'VA'], ['Andar', 'Transporte'], ['Conferir', 'NVA']]);
  await page.click('.stage-wrap:nth-child(1) .stage-edit');
  await page.fill('#editStageStation', 'P1');
  await page.click('#whBox summary');
  await scan('modal de etapa (posto e Westinghouse)');
  await page.click('#stageEditForm button[type=submit]');
  await markCycles(page, 4, 3, () => 60);
  await page.click('#btnPause');
  await sleep(300);
  await scan('editor de cronoanálise (indicadores, gráficos, balanceamento, registros)');
  await dark(true); await scan('editor (tema escuro)'); await dark(false);
  await page.click('#tabA3');
  await sleep(400);
  await scan('aba A3');
  await page.click('#tabCrono');
  await menu(page, 'open-settings');
  await scan('configurações');
  await page.keyboard.press('Escape');
  await menu(page, 'open-teams');
  await page.waitForSelector('#teamForm:not([hidden])');
  await scan('times');
  await page.keyboard.press('Escape');
  await menu(page, 'new-sampling');
  for (const i of [1, 2, 1]) { await page.click(`#samplingCats .stage:nth-child(${i})`); await sleep(60); }
  await scan('amostragem do trabalho');
  await dark(true); await scan('amostragem (tema escuro)'); await dark(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await menu(page, 'back-dashboard');
  await scan('dashboard no celular');
  check(errors.length === 0, 'sem erros: ' + errors.join(' || '));
  await ctx.close();
});

/* ================================================================ */
for (const t of tests) {
  if (only && !only.test(t.name)) continue;
  console.log('\n▶ ' + t.name);
  try { await t.fn(); }
  catch (e) { failures++; console.log('  ✗ EXCEÇÃO: ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n    ')); }
}
await browser.close();
server.close();
console.log(`\n${passes} ok, ${failures} falha(s)`);
process.exit(failures ? 1 : 0);
