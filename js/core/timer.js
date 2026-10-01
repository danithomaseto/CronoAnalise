/* Cronômetro baseado em "epoch": o estado cabe num objeto pequeno que pode ser
   salvo no localStorage e restaurado depois de recarregar a página.
   Todos os tempos internos em milissegundos; `now` é injetado (testável). */

import { round2 } from './format.js';

export function newTimer() {
  return { running: false, startedAt: 0, elapsed: 0, lastMark: 0 };
}

export function normalizeTimer(raw) {
  const t = newTimer();
  if (!raw || typeof raw !== 'object') return t;
  const num = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
  t.running = raw.running === true;
  t.startedAt = num(raw.startedAt);
  t.elapsed = num(raw.elapsed);
  t.lastMark = num(raw.lastMark);
  if (t.running && !t.startedAt) t.running = false;
  return t;
}

export function elapsedOf(t, now) {
  return t.running ? Math.max(0, now - t.startedAt) : t.elapsed;
}

export function start(t, now) {
  if (t.running) return t;
  return { ...t, running: true, startedAt: now - t.elapsed };
}

export function pause(t, now) {
  if (!t.running) return t;
  return { ...t, running: false, elapsed: elapsedOf(t, now), startedAt: 0 };
}

/* Segundos do elemento em andamento (desde a última marcação). */
export function liveSeconds(t, now) {
  return Math.max(0, (elapsedOf(t, now) - t.lastMark) / 1000);
}

/* Marca uma etapa: devolve o tempo do elemento (s, 2 casas) e o novo estado. */
export function mark(t, now) {
  const e = elapsedOf(t, now);
  const seconds = round2(Math.max(0, (e - t.lastMark) / 1000));
  return { timer: { ...t, lastMark: e }, seconds };
}

/* Novo ciclo: zera o elemento atual (o tempo desde a última marcação não é registrado). */
export function newCycle(t, now) {
  return { ...t, lastMark: elapsedOf(t, now) };
}

export function isIdle(t) {
  return !t.running && t.elapsed === 0 && t.lastMark === 0;
}
