import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/core/timer.js';

test('iniciar, marcar e pausar com relógio injetado', () => {
  let t = T.newTimer();
  assert.ok(T.isIdle(t));
  t = T.start(t, 1000);
  assert.equal(T.elapsedOf(t, 3500), 2500);

  const m1 = T.mark(t, 3500);
  assert.equal(m1.seconds, 2.5);
  t = m1.timer;
  assert.equal(T.liveSeconds(t, 4000), 0.5);

  // precisão: o tempo é calculado no instante da marcação, não no último "tick"
  const m2 = T.mark(t, 4234);
  assert.equal(m2.seconds, 0.73);
  t = m2.timer;

  t = T.pause(t, 5000);
  assert.equal(t.running, false);
  assert.equal(T.elapsedOf(t, 99999), 4000);
  assert.equal(T.liveSeconds(t, 99999), (4000 - 3234) / 1000);
});

test('retomar depois de pausar não conta o tempo parado', () => {
  let t = T.start(T.newTimer(), 0);
  t = T.pause(t, 1000);
  t = T.start(t, 10000);
  assert.equal(T.elapsedOf(t, 10500), 1500);
});

test('novo ciclo zera o elemento atual', () => {
  let t = T.start(T.newTimer(), 0);
  t = T.newCycle(t, 7000);
  assert.equal(T.liveSeconds(t, 7000), 0);
  assert.equal(T.mark(t, 9000).seconds, 2);
});

test('estado sobrevive a serialização (recarregar a página)', () => {
  let t = T.start(T.newTimer(), 1_000_000);
  t = T.mark(t, 1_002_000).timer;
  const restored = T.normalizeTimer(JSON.parse(JSON.stringify(t)));
  assert.deepEqual(restored, t);
  assert.equal(T.mark(restored, 1_005_000).seconds, 3);
});

test('normalizeTimer rejeita lixo', () => {
  assert.deepEqual(T.normalizeTimer(null), T.newTimer());
  assert.deepEqual(T.normalizeTimer({ running: true, startedAt: 'x' }), T.newTimer());
  assert.equal(T.normalizeTimer({ elapsed: -5 }).elapsed, 0);
});

test('relógio que volta no tempo não gera negativos', () => {
  const t = T.start(T.newTimer(), 5000);
  assert.equal(T.elapsedOf(t, 4000), 0);
  assert.equal(T.mark(t, 4000).seconds, 0);
});
