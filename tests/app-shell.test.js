import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const shell = JSON.parse('[' + sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1].replace(/'/g, '"').replace(/,\s*$/, '') + ']');

function walk(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name).split(path.sep).join('/')]);
}

test('todo arquivo do app shell do service worker existe', () => {
  shell.filter(f => f !== './').forEach(f => assert.ok(fs.existsSync(path.join(root, f)), 'faltando: ' + f));
});

test('todo módulo JS e o supabase vendorizado estão no cache offline', () => {
  const files = [...walk('js'), ...walk('vendor').filter(f => f.endsWith('.js'))];
  files.forEach(f => assert.ok(shell.includes(f), 'fora do APP_SHELL do sw.js: ' + f));
});

test('index.html referencia o mesmo arquivo do supabase que o service worker', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const src = html.match(/src="(vendor\/[^"]+)"/)[1];
  assert.ok(shell.includes(src));
});
