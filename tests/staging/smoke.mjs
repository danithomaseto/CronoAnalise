/* Teste de fumaça contra um Supabase REAL de homologação (não o de produção).
   Roda o fluxo completo do app: login, cronometragem, sincronização, outro
   "aparelho" vendo o estudo e exclusão propagando.

   Requer (variáveis de ambiente / segredos do GitHub):
     STAGING_SUPABASE_URL       https://<projeto-de-homologacao>.supabase.co
     STAGING_SUPABASE_ANON_KEY  chave publishable/anon do projeto de homologação
     STAGING_EMAIL              usuário de teste (já criado e confirmado)
     STAGING_PASSWORD           senha desse usuário
   Sem elas o teste é pulado.

   Uso: npm i --no-save playwright && npx playwright install chromium && npm run test:staging */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../e2e/server.mjs';

const { STAGING_SUPABASE_URL: url, STAGING_SUPABASE_ANON_KEY: key, STAGING_EMAIL: email, STAGING_PASSWORD: password } = process.env;
if (!url || !key || !email || !password) {
  console.log('Sem credenciais de homologação (STAGING_*): teste pulado.');
  process.exit(0);
}
if (/zwfnsknaxqnexeuzvvjn/.test(url)) {
  console.error('STAGING_SUPABASE_URL aponta para o projeto de PRODUÇÃO. Use um projeto de homologação.');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let failures = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ FALHOU: ') + m); if (!c) failures++; };

const { server, port } = await startServer(ROOT, 0, { headers: false }); // a CSP de produção só libera o projeto de produção
const BASE = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();

async function device(name) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  await ctx.addInitScript(cfg => { window.__CRONO_CONFIG__ = cfg; }, { supabaseUrl: url, supabaseAnonKey: key });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.goto(BASE);
  await page.fill('#authEmail', email);
  await page.fill('#authPass', password);
  await page.click('#authForm button[type=submit]');
  await page.waitForSelector('body.authed', { timeout: 20000 });
  await page.waitForFunction(() => !document.body.classList.contains('booting'), null, { timeout: 20000 });
  return { ctx, page, errors, name };
}

async function waitSaved(page) {
  await page.waitForFunction(() => /Salvo/.test(document.getElementById('syncStatus').textContent), null, { timeout: 30000 });
}

const studyName = 'Smoke ' + new Date().toISOString();
try {
  console.log('▶ aparelho A: login, estudo, cronometragem');
  const A = await device('A');
  check(true, 'login no projeto de homologação');
  await A.page.click('.dash-hero [data-action=new-study]');
  await A.page.fill('#studyName', studyName);
  await A.page.fill('#stageName', 'Etapa 1');
  await A.page.press('#stageName', 'Enter');
  await A.page.click('#btnStart');
  for (let i = 0; i < 3; i++) { await A.page.waitForTimeout(500); await A.page.click('.stage-wrap .stage'); }
  await waitSaved(A.page);
  check(true, 'sincronizado ("Salvo")');
  const mode = await A.page.evaluate(async () => (await import('/js/storage.js')).getSyncMeta().mode);
  console.log('    modo do banco: ' + mode);

  console.log('▶ aparelho B: vê o estudo pela nuvem e exclui');
  const B = await device('B');
  await B.page.waitForSelector('.study-card', { timeout: 20000 });
  const card = B.page.locator('.study-card', { hasText: studyName });
  check(await card.count() === 1, 'estudo aparece no outro aparelho');
  await card.locator('[data-action=open-study]').click();
  check((await B.page.$$('#recordsTable tr[data-id]')).length === 3, '3 marcações sincronizadas');
  await B.page.click('[data-action=delete-current]');
  await B.page.waitForSelector('#dashboardView', { state: 'visible' });
  await waitSaved(B.page);

  console.log('▶ aparelho A: exclusão chega');
  await A.page.click('[data-action=toggle-menu]');
  await A.page.click('#menuDropdown [data-action=back-dashboard]');
  await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await A.page.waitForFunction(n => ![...document.querySelectorAll('.study-card b')].some(b => b.textContent === n), studyName, { timeout: 30000 });
  check(true, 'estudo excluído também no aparelho A');
  check(A.errors.length === 0 && B.errors.length === 0, 'sem erros de JavaScript: ' + [...A.errors, ...B.errors].join(' | '));
} catch (e) {
  failures++;
  console.log('  ✗ EXCEÇÃO: ' + (e.stack || e).toString().split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} falha(s)` : '\nok');
process.exit(failures ? 1 : 0);
