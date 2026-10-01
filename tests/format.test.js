import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumber, toBR, fmtClock, escapeHtml, stableStringify, hashString, uid, safeFilename, round2
} from '../js/core/format.js';

test('parseNumber aceita vírgula e ponto', () => {
  assert.equal(parseNumber('1,5'), 1.5);
  assert.equal(parseNumber(' 2.25 '), 2.25);
  assert.equal(parseNumber(''), 0);
  assert.equal(parseNumber(null), 0);
  assert.equal(parseNumber('abc'), 0);
  assert.equal(parseNumber(3), 3);
});

test('toBR usa vírgula decimal', () => {
  assert.equal(toBR(1.5), '1,50');
  assert.equal(toBR(1.25, 1), '1,3');
  assert.equal(toBR(NaN), '0,00');
  assert.equal(toBR(Infinity, 0), '0');
});

test('round2', () => {
  assert.equal(round2(1.005 * 1000 / 1000), 1);
  assert.equal(round2(12.3456), 12.35);
});

test('fmtClock formata HH:MM:SS.d', () => {
  assert.equal(fmtClock(0), '00:00:00.0');
  assert.equal(fmtClock(3723456), '01:02:03.4');
  assert.equal(fmtClock(-5), '00:00:00.0');
});

test('escapeHtml escapa aspas (seguro em atributos)', () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&`), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
  assert.equal(escapeHtml(null), '');
});

test('stableStringify independe da ordem das chaves', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: [1, { z: 1, y: 2 }] } }),
    stableStringify({ a: { c: [1, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  assert.equal(stableStringify({ a: undefined, b: 1 }), '{"b":1}');
});

test('hashString é determinístico', () => {
  assert.equal(hashString('Estudo A'), hashString('Estudo A'));
  assert.notEqual(hashString('Estudo A'), hashString('Estudo B'));
});

test('uid gera ids únicos com prefixo', () => {
  const a = uid('r'), b = uid('r');
  assert.match(a, /^r_/);
  assert.notEqual(a, b);
});

test('safeFilename preserva acentos e remove caracteres inválidos', () => {
  assert.equal(safeFilename('Separação: Linha/A'), 'Separação_ Linha_A');
  assert.equal(safeFilename(''), 'CronoAnalise');
  assert.equal(safeFilename('...'), 'CronoAnalise');
});
