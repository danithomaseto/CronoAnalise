/* Regressão visual: tira screenshots das telas principais com dados e relógio
   fixos e compara pixel a pixel com as referências em tests/visual/baseline/.
   Uma diferença acima do limite falha o teste; a imagem da diferença vai para
   tests/visual/out/ (e para os artefatos do GitHub Actions).

   Uso:  npm i --no-save playwright@1.56.1 pixelmatch pngjs && npm run test:visual
         npm run test:visual -- --update      (aceita o visual atual como referência)

   As fontes do app são locais (fonts/) e o Chromium é fixado na versão do
   Playwright acima, para o resultado ser igual em qualquer máquina. */
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../e2e/server.mjs';
import { createFakeSupabase } from '../e2e/fake-supabase.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const BASE_DIR = path.join(HERE, 'baseline');
const OUT = path.join(HERE, 'out');
const UPDATE = process.argv.includes('--update') || process.env.UPDATE_VISUAL === '1';
const MAX_DIFF = Number(process.env.VISUAL_MAX_DIFF || 0.004); // fração de pixels diferentes tolerada
fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const NOW = new Date('2026-10-01T10:30:00-03:00');
const iso = (min, sec = 0) => new Date(NOW.getTime() - (240 - min) * 60000 + sec * 1000).toISOString();

/* Dados fixos: uma cronoanálise com postos e uma amostragem. */
function fixtureStore() {
  const stages = [
    { id: 'st1', name: 'Pegar caixa', type: 'VA', pos: 0, station: 'Posto 1' },
    { id: 'st2', name: 'Andar até a doca', type: 'Transporte', pos: 1, station: 'Posto 1' },
    { id: 'st3', name: 'Conferir etiqueta', type: 'NVA', pos: 2, station: 'Posto 2', wh: { skill: 'C1', effort: 'C2' } },
    { id: 'st4', name: 'Aguardar empilhadeira', type: 'Espera', pos: 3, station: 'Posto 2' },
    { id: 'st5', name: 'Embalar', type: 'VA', pos: 4, station: 'Posto 3', countsOutput: true }
  ];
  const base = [8.2, 6.1, 3.4, 5.0, 9.3];
  const records = [];
  for (let c = 1; c <= 8; c++) {
    stages.forEach((s, i) => {
      const t = Math.round((base[i] * (1 + (8 - c) * 0.025) + ((c * 7 + i * 3) % 5) * 0.2) * 100) / 100;
      records.push({ id: `r${c}_${i}`, cycle: c, stageId: s.id, stageName: s.name, type: s.type, time: t, qty: 1, ts: iso(c * 3, i * 9), ...(c === 3 && i === 3 ? { note: 'Empilhadeira em outro corredor' } : {}) });
    });
  }
  const time = {
    id: 'study_visual_time', name: 'Expedição — Doca 3', process: 'Separação e embalagem', operator: 'op.silva', observer: 'Champion A',
    notes: 'Espera recorrente pela empilhadeira no início do turno.', stages, records, cycleQty: { 1: 1 }, currentCycle: 9,
    demand: 520, availableMin: 440, createdAt: iso(0), updatedAt: iso(30), history: [{ ts: iso(0), text: 'Estudo criado' }]
  };
  const cats = [['c1', 'Produtivo', true], ['c2', 'Aguardando / ocioso', false], ['c3', 'Deslocamento', false], ['c4', 'Falta de material', false]];
  const pattern = [0, 0, 1, 0, 2, 0, 0, 3, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 2];
  const sampling = {
    id: 'study_visual_sampling', name: 'Picking — turno A', kind: 'sampling', process: 'Picking', operator: '', observer: 'Champion A', notes: '',
    stages: [], records: [], cycleQty: { 1: 1 }, currentCycle: 1, availableMin: 480, createdAt: iso(0), updatedAt: iso(40),
    categories: cats.map(([id, name, productive], i) => ({ id, name, productive, pos: i })),
    observations: pattern.map((k, i) => ({ id: 'o' + i, ts: iso(5 + i * 9), cat: cats[k][0], catName: cats[k][1], productive: cats[k][2] })),
    samplingPlan: { start: '06:00', end: '14:00', count: 24 }, history: [{ ts: iso(0), text: 'Estudo de amostragem criado' }]
  };
  return { format: 3, studies: { [time.id]: time, [sampling.id]: sampling }, deleted: {} };
}

const { server, port } = await startServer(ROOT);
const BASE = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
let failures = 0, passes = 0;

const HIDE_CSS = '.toast{display:none!important} *{caret-color:transparent!important;transition:none!important;animation:none!important} #syncTime{visibility:hidden!important}';

async function newPage({ width, height, dark = false }) {
  const fake = createFakeSupabase();
  fake.addUser('ana@x.com', 'segredo1');
  fake.setRow('ana@x.com', fixtureStore(), iso(40));
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block',
    locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', colorScheme: dark ? 'dark' : 'light'
  });
  await ctx.clock.setFixedTime(NOW);
  await fake.attach(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return { ctx, page, errors };
}

async function settle(page) {
  await page.addStyleTag({ content: HIDE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function login(page) {
  await page.goto(BASE);
  await page.waitForSelector('#authEmail', { state: 'visible' });
  await page.fill('#authEmail', 'ana@x.com');
  await page.fill('#authPass', 'segredo1');
  await page.click('#authForm button[type=submit]');
  await page.waitForSelector('body.authed');
  await page.waitForFunction(() => !document.body.classList.contains('booting') && document.querySelectorAll('.study-card').length === 2);
}

async function compare(name, buffer) {
  const file = path.join(BASE_DIR, name + '.png');
  fs.writeFileSync(path.join(OUT, name + '.png'), buffer);
  if (UPDATE || !fs.existsSync(file)) {
    fs.writeFileSync(file, buffer);
    console.log('  • ' + name + ': referência ' + (UPDATE ? 'atualizada' : 'criada'));
    passes++;
    return;
  }
  const a = PNG.sync.read(fs.readFileSync(file));
  const b = PNG.sync.read(buffer);
  if (a.width !== b.width || a.height !== b.height) {
    failures++;
    console.log(`  ✗ FALHOU: ${name}: tamanho mudou (${a.width}×${a.height} → ${b.width}×${b.height})`);
    return;
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.12, includeAA: false });
  const ratio = n / (a.width * a.height);
  if (ratio > MAX_DIFF) {
    failures++;
    fs.writeFileSync(path.join(OUT, name + '-diff.png'), PNG.sync.write(diff));
    console.log(`  ✗ FALHOU: ${name}: ${(ratio * 100).toFixed(2)}% dos pixels diferentes (limite ${(MAX_DIFF * 100).toFixed(2)}%) — veja out/${name}-diff.png`);
  } else {
    passes++;
    console.log(`  ✓ ${name} (${(ratio * 100).toFixed(3)}% diferente)`);
  }
}

const shots = [
  ['login-desktop', { width: 1280, height: 800 }, async page => { await page.goto(BASE); await page.waitForSelector('#authEmail', { state: 'visible' }); }],
  ['login-celular', { width: 390, height: 844 }, async page => { await page.goto(BASE); await page.waitForSelector('#authEmail', { state: 'visible' }); }],
  ['login-escuro', { width: 390, height: 844, dark: true }, async page => { await page.goto(BASE); await page.waitForSelector('#authEmail', { state: 'visible' }); }],
  ['dashboard', { width: 1280, height: 800 }, login],
  ['editor-cronoanalise', { width: 1280, height: 900, full: true }, async page => {
    await login(page);
    await page.click('.study-card:has-text("Expedição") [data-action=open-study]');
    await page.waitForSelector('#balanceChart svg');
  }],
  ['editor-celular-escuro', { width: 390, height: 844, dark: true }, async page => {
    await login(page);
    await page.click('.study-card:has-text("Expedição") [data-action=open-study]');
    await page.waitForSelector('.stage-wrap');
  }],
  ['amostragem', { width: 1280, height: 900, full: true }, async page => {
    await login(page);
    await page.click('.study-card:has-text("Picking") [data-action=open-study]');
    await page.waitForSelector('#samplingStats svg');
  }],
  ['a3', { width: 1280, height: 900 }, async page => {
    await login(page);
    await page.click('.study-card:has-text("Expedição") [data-action=open-study]');
    await page.click('#tabA3');
  }]
];

const only = process.argv.slice(2).find(a => !a.startsWith('--'));
for (const [name, opts, go] of shots) {
  if (only && !name.includes(only)) continue;
  const { ctx, page, errors } = await newPage(opts);
  try {
    await go(page);
    await settle(page);
    await compare(name, await page.screenshot({ fullPage: !!opts.full }));
    if (errors.length) { failures++; console.log('  ✗ erros na página: ' + errors.join(' | ')); }
  } catch (e) {
    failures++;
    console.log('  ✗ EXCEÇÃO em ' + name + ': ' + String(e.stack || e).split('\n').slice(0, 3).join(' '));
  }
  await ctx.close();
}

await browser.close();
server.close();
console.log(`\n${passes} ok, ${failures} falha(s)`);
process.exit(failures ? 1 : 0);
