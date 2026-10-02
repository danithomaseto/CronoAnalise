/* Gera as imagens do guia de uso (docs/img/) a partir dos dados de
   demonstração, com o Supabase simulado — rode de novo sempre que a tela mudar.

   Uso:  npm i --no-save playwright@1.56.1 && npm run docs:screenshots */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { startServer } from '../e2e/server.mjs';
import { createFakeSupabase } from '../e2e/fake-supabase.mjs';
import { NOW, iso, fixtureStore } from '../fixtures/demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'docs', 'img');
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
const USER = 'daniel.thomaseto@dhl.com';

/* Foto de exemplo (gradiente) para a galeria. */
function samplePhoto(w = 480, h = 360) {
  const crc = buf => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3;
    const box = x > w * 0.3 && x < w * 0.7 && y > h * 0.35 && y < h * 0.8;
    raw[o] = box ? 170 : 90 + (y / h) * 60; raw[o + 1] = box ? 120 : 100 + (x / w) * 50; raw[o + 2] = box ? 60 : 110;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function fakeWithData() {
  const fake = createFakeSupabase({ v3: true, rpcEnabled: true, azure: true });
  const uid = fake.addUser(USER, 'demo1234');
  const store = fixtureStore();
  store.studies.study_visual_time.records[18].photos = [{ id: 'ph1', path: 'study_visual_time/ph1.jpg', ts: iso(12) }];
  store.studies.study_visual_time.a3 = {
    problem: 'Operadores aguardam a empilhadeira no início do turno; fila de caixas na doca 3.',
    goal: 'Ciclo abaixo do takt (50,8 s) e espera menor que 5% até 30/11.',
    rootCause: 'Empilhadeira compartilhada entre dois corredores; abastecimento sem horário fixo.',
    countermeasures: 'Kanban de caixas vazias e janela fixa de abastecimento às 06:00 e 10:00.',
    followUp: 'Novo estudo após a implantação para comparar antes × depois.',
    actions: [
      { id: 'a1', what: 'Implantar kanban de caixas', who: 'Ana', when: '2026-10-20', status: 'andamento' },
      { id: 'a2', what: 'Definir janela de abastecimento', who: 'Bruno', when: '2026-10-15', status: 'concluida' }
    ]
  };
  fake.db.storage.set('study_visual_time/ph1.jpg', { bytes: samplePhoto(), contentType: 'image/png', owner: uid });
  fake.setRow(USER, store, iso(40));
  fake.db.crono_team.set('t1', { id: 't1', name: 'Site Cajamar — Turno A', owner_id: uid, created_at: iso(0) });
  fake.db.crono_team_member.push({ team_id: 't1', email: 'ana.lima@empresa.com', role: 'manager', created_at: iso(0) }, { team_id: 't1', email: 'bruno.souza@empresa.com', role: 'member', created_at: iso(1) });
  fake.db.crono_study_team_share.push({ study_id: 'study_visual_time', team_id: 't1', role: 'viewer', created_at: iso(2) });
  fake.db.crono_study_share.push({ study_id: 'study_visual_time', email: 'carla.dias@empresa.com', role: 'editor', created_at: iso(3) });
  fake.db.crono_user_activity.set(uid, { user_id: uid, email: USER, first_seen: iso(0), last_seen: iso(30), login_count: 42 });
  fake.db.crono_client_error.push({ id: 1, user_id: uid, email: 'ana.lima@empresa.com', created_at: iso(20), message: 'TypeError: Cannot read properties of undefined', stack: 'TypeError: ...\n    at render (editor.js:120:5)', url: 'https://crono-analise.vercel.app/', app_version: 'Beta 11', user_agent: 'Mozilla/5.0 (Linux; Android 14)', context: { view: 'editor' } });
  return fake;
}

const { server, port } = await startServer(ROOT);
const BASE = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();

async function open({ width = 1280, height = 820, dark = false, mobile = false } = {}) {
  const fake = fakeWithData();
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', colorScheme: dark ? 'dark' : 'light', isMobile: mobile, hasTouch: mobile });
  await ctx.clock.setFixedTime(NOW);
  await fake.attach(ctx);
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept());
  await page.addInitScript(() => {
    const css = '*{caret-color:transparent!important;transition:none!important;animation:none!important} .toast{display:none!important}';
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); });
  });
  return { ctx, page, fake };
}

async function login(page) {
  await page.goto(BASE);
  await page.waitForSelector('#authEmail', { state: 'visible' });
  await page.fill('#authEmail', USER);
  await page.fill('#authPass', 'demo1234');
  await page.click('#authForm button[type=submit]');
  await page.waitForSelector('body.authed');
  await page.waitForFunction(() => !document.body.classList.contains('booting') && document.querySelectorAll('.study-card').length === 2);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

const menu = async (page, action) => { await page.click('[data-action=toggle-menu]'); await page.click('#menuDropdown [data-action=' + action + ']'); };
const openTime = async page => { await page.click('.study-card:has-text("Expedição") [data-action=open-study]'); await page.waitForSelector('#balanceChart svg'); await page.waitForTimeout(200); };
const openSampling = async page => { await page.click('.study-card:has-text("Picking") [data-action=open-study]'); await page.waitForSelector('#samplingStats svg'); await page.waitForTimeout(200); };
const shot = async (page, name, target, opts = {}) => {
  const file = path.join(OUT, name + '.png');
  /* a barra do topo é fixa e cobriria o alto do painel recortado */
  if (target) await page.locator(target).first().screenshot({ path: file, style: HIDE_BAR, ...opts });
  else await page.screenshot({ path: file, ...opts });
  console.log('  • ' + name + '.png');
};
const HIDE_BAR = '.topbar{visibility:hidden!important}';
/* Recorte do topo de um elemento (painéis muito longos). */
const shotTop = async (page, name, target, height) => {
  /* a barra do topo é fixa: rola o elemento para logo abaixo dela */
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    const bar = document.querySelector('.topbar');
    const offset = (bar ? bar.getBoundingClientRect().height : 0) + 12;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - offset);
  }, target);
  await page.waitForTimeout(100);
  const b = await page.locator(target).first().boundingBox();
  await page.screenshot({ path: path.join(OUT, name + '.png'), style: HIDE_BAR, clip: { x: b.x, y: b.y, width: b.width, height: Math.min(height, b.height) } });
  console.log('  • ' + name + '.png');
};

const jobs = {
  async login() {
    const { ctx, page, fake } = await open({ width: 1000, height: 760 });
    fake.setAzure(false); // como em produção enquanto o TI não ativa o login Microsoft
    await page.goto(BASE); await page.waitForSelector('#authEmail', { state: 'visible' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.fonts.ready);
    await shot(page, '01-login');
    await ctx.close();
  },
  async dashboard() {
    const { ctx, page } = await open({ width: 1280, height: 800 });
    await login(page);
    await shot(page, '02-dashboard');
    await page.selectOption('#dashFilter', 'team:t1');
    await shot(page, '19-painel-do-time');
    await ctx.close();
  },
  async editor() {
    const { ctx, page } = await open({ width: 1280, height: 900 });
    await login(page);
    await openTime(page);
    await shot(page, '03-dados-do-estudo', '#editorMain > section.panel:first-of-type');
    await shot(page, '04-etapas', '.stages-panel');
    await shot(page, '05-cronometro', 'section.module');
    await shot(page, '06-quantidade', '.qty-panel');
    await page.click('.stage-wrap:nth-child(3) .stage-edit');
    await page.click('#whBox summary');
    await shot(page, '07-editar-etapa', '#stageEditForm');
    await page.keyboard.press('Escape');
    await shotTop(page, '08-indicadores', '#stats', 1150);
    await shot(page, '09-graficos', '#charts');
    await shot(page, '10-balanceamento', '#balancePanel');
    await shotTop(page, '11-registros', '#recordsWrap', 360);
    await page.click('#tabHist');
    await page.click('[data-action=load-versions]');
    await page.waitForTimeout(300);
    await shot(page, '12-historico', '#editorHistory');
    await page.click('#tabCrono');
    await page.setViewportSize({ width: 1280, height: 1200 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('[data-action=toggle-menu]');
    const m = await page.locator('#menuDropdown').boundingBox();
    await shot(page, '13-menu', null, { clip: { x: 760, y: 0, width: 520, height: Math.ceil(m.y + m.height + 12) } });
    await ctx.close();
  },
  async campo() {
    let { ctx, page } = await open({ width: 390, height: 844, mobile: true });
    await login(page); await openTime(page); await menu(page, 'toggle-field');
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
    await shot(page, '14-modo-campo-celular');
    await ctx.close();
    ({ ctx, page } = await open({ width: 844, height: 390, mobile: true }));
    await login(page); await openTime(page); await menu(page, 'toggle-field');
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
    await shot(page, '15-modo-campo-deitado');
    await ctx.close();
  },
  async amostragem() {
    const { ctx, page } = await open({ width: 1280, height: 900 });
    await login(page); await openSampling(page);
    await shot(page, '16-amostragem-observacao', '#samplingCapture');
    await shot(page, '17-amostragem-roteiro', '#editorMain > section.panel:has(#planList)');
    await shot(page, '18-amostragem-resultados', '#editorMain > section.panel:has(#samplingStats)');
    await ctx.close();
  },
  async equipe() {
    const { ctx, page } = await open({ width: 1280, height: 900 });
    await login(page); await openTime(page);
    await menu(page, 'share');
    await page.waitForSelector('#teamShareBox:not([hidden])');
    await page.waitForSelector('#shareList table');
    await shot(page, '20-compartilhar', '#shareModal .modal-box');
    await page.keyboard.press('Escape');
    await menu(page, 'open-teams');
    await page.waitForSelector('#teamsList [data-team]');
    await page.click('#teamsList [data-team]');
    await shot(page, '21-times', '#teamsModal .modal-box');
    await page.keyboard.press('Escape');
    await menu(page, 'open-photos');
    await page.waitForFunction(() => { const i = document.querySelector('#photoGrid img'); return i && i.naturalWidth > 0; });
    await shot(page, '22-fotos', '#photoModal .modal-box');
    await page.keyboard.press('Escape');
    await ctx.close();
  },
  async a3() {
    const { ctx, page } = await open({ width: 1280, height: 1000 });
    await login(page); await openTime(page);
    await page.click('#tabA3');
    await page.waitForTimeout(200);
    await shot(page, '23-a3-formulario', '#editorA3');
    await page.evaluate(() => { window.print = () => {}; });
    await page.click('#editorA3 [data-action=print-a3]');
    await page.waitForTimeout(900); // a limpeza pós-impressão roda ~550 ms depois
    await page.evaluate(() => document.body.classList.add('print-a3'));
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: 1500, height: 1060 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const a = await page.locator('.a3-sheet').boundingBox();
    await shot(page, '24-a3-impresso', null, { clip: { x: 0, y: 0, width: 1500, height: Math.ceil(a.y + a.height + 8) } });
    await ctx.close();
  },
  async conta() {
    const { ctx, page } = await open({ width: 1280, height: 900 });
    await login(page);
    await menu(page, 'open-settings');
    await page.waitForFunction(() => !document.getElementById('btnMfaToggle').disabled);
    await shot(page, '25-configuracoes', '#settingsModal .modal-box');
    await page.click('#btnMfaToggle');
    await page.waitForSelector('#mfaEnrollModal:not([hidden])');
    await shot(page, '26-ativar-duas-etapas', '#mfaEnrollModal .modal-box');
    await page.keyboard.press('Escape');
    await menu(page, 'open-admin');
    await page.waitForSelector('#adminUsersTable tr');
    await shot(page, '27-administracao', '#adminModal .modal-box');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const s = await import('/js/storage.js');
      const st = s.getStudy('study_visual_time');
      st.id = 'study_depois'; st.name = 'Expedição — Doca 3 (depois)'; st.createdAt = new Date().toISOString();
      st.records = st.records.filter(r => r.stageName !== 'Aguardar empilhadeira').map(r => ({ ...r, time: Math.round(r.time * 0.9 * 100) / 100 }));
      s.putStudy(st);
    });
    await page.evaluate(() => document.getElementById('dashSearch').dispatchEvent(new Event('input')));
    await page.click('#btnCompare');
    await shot(page, '28-comparar', '#compareModal .modal-box');
    await ctx.close();
  },
  async mfaLogin() {
    const { ctx, page } = await open({ width: 1000, height: 700 });
    await page.goto(BASE); await page.waitForSelector('#authEmail', { state: 'visible' });
    await page.evaluate(() => { document.getElementById('mfaOverlay').hidden = false; document.getElementById('authOverlay').hidden = true; });
    await page.evaluate(() => document.fonts.ready);
    await shot(page, '29-codigo-duas-etapas');
    await ctx.close();
  },
  async escuro() {
    const { ctx, page } = await open({ width: 390, height: 844, dark: true, mobile: true });
    await login(page); await openTime(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, '30-tema-escuro-celular');
    await ctx.close();
  }
};

for (const [name, job] of Object.entries(jobs)) {
  if (only && !only.test(name)) continue;
  console.log('▶ ' + name);
  try { await job(); } catch (e) { console.log('  ✗ ' + name + ': ' + String(e.message).split('\n')[0]); process.exitCode = 1; }
}
await browser.close();
server.close();
