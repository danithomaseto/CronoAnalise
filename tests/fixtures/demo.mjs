/* Dados de demonstração fixos (testes visuais e screenshots da documentação):
   uma cronoanálise com postos e uma amostragem do trabalho. */

export const NOW = new Date('2026-10-01T10:30:00-03:00');
export const iso = (min, sec = 0) => new Date(NOW.getTime() - (240 - min) * 60000 + sec * 1000).toISOString();

/* Dados fixos: uma cronoanálise com postos e uma amostragem. */
export function fixtureStore() {
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

