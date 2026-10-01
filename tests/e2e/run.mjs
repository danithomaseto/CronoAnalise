/* Testes de ponta a ponta no navegador, com a biblioteca real do supabase-js e um
   Supabase simulado (tests/e2e/fake-supabase.mjs) — não acessa a internet.
   Uso:  npm i --no-save playwright && npx playwright install chromium && npm run test:e2e
         npm run test:e2e -- "offline"     (roda só os cenários cujo nome casa com o filtro) */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { createFakeSupabase, SB_URL } from './fake-supabase.mjs';

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
  await ctx.route(SB_URL + '/**', r => fake.handle(r));
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
  page.on('dialog', d => { errors.push('dialog inesperado: ' + d.message()); d.dismiss(); });
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

async function acceptNextDialog(page) {
  page.removeAllListeners('dialog');
  page.once('dialog', d => d.accept());
  setTimeout(() => page.on('dialog', d => { page._errors.push('dialog inesperado: ' + d.message()); d.dismiss(); }), 50);
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
  await ctx.route(SB_URL + '/**', r => fake.handle(r));
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
      page.once('dialog', d => d.accept('falta de caixa'));
      page.removeAllListeners('dialog');
      page.once('dialog', d => d.accept('falta de caixa'));
      await page.click('#btnNote');
      await sleep(100);
      page.on('dialog', d => { errors.push('dialog inesperado: ' + d.message()); d.dismiss(); });
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
  check(!(await page.isHidden('#chartTip')) && (await page.textContent('#chartTip')).includes('% do tempo'), 'tooltip no Pareto');
  await page.locator('#charts .chart-card').nth(2).locator('.hit').nth(1).hover();
  check((await page.textContent('#chartTip')).startsWith('Ciclo 2:'), 'tooltip no tempo de ciclo');
  check(await page.locator('#charts .crosshair[visibility=visible]').count() === 1, 'crosshair acompanha o ponteiro');
  await page.locator('#charts .chart-card').nth(0).locator('.mark').first().focus();
  check(!(await page.isHidden('#chartTip')), 'tooltip também pelo teclado (foco)');
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
