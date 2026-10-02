/* Conteúdo do relatório em Excel (abas, linhas e formatos) — sem DOM. */

import { FIELD_LABELS } from '../config.js';
import { fmtTimeOfDay } from './format.js';
import { CHART_TYPE_ORDER } from './stats.js';
import { computeBalance } from './balance.js';
import { A3_STATUS } from './model.js';

const round = (v, d = 2) => (isFinite(v) ? Math.round(v * Math.pow(10, d)) / Math.pow(10, d) : 0);
const H = v => ({ v, s: 'head' });
const N2 = v => ({ v: round(v, 2), s: 'num2' });
const N1 = v => ({ v: round(v, 1), s: 'num1' });
const I = v => ({ v: Math.round(v || 0), s: 'int' });
const B = v => ({ v, s: 'bold' });

export function buildReportSheets(study, stats, exportedAt = new Date()) {
  const resumo = [
    [{ v: study.name, s: 'title' }],
    [],
    [B('Estudo'), study.name],
    [B(FIELD_LABELS.process), study.process],
    [B(FIELD_LABELS.operator), study.operator],
    [B(FIELD_LABELS.observer), study.observer],
    [B('Data da exportação'), exportedAt.toLocaleString('pt-BR')],
    [],
    [H('Indicador'), H('Valor')],
    ['Tempo total (s)', N2(stats.total)],
    ['Quantidade total' + (stats.usesOutputStages ? ' (etapas de produção)' : ''), I(stats.qtyTotal)],
    ['Produtividade (un/h)', N2(stats.productivity)],
    ['% Valor Agregado', N1(stats.vaPct)],
    ['Ciclos', I(stats.cycleCount)],
    ['Tempo médio de ciclo (s)', N2(stats.avgCycle)],
    ['Desvio padrão do ciclo (s)', N2(stats.cycleSd)]
  ];
  if (stats.hasStdParams) {
    resumo.push(['Fator de ritmo (%)', N1(stats.rating)]);
    resumo.push(['Tolerâncias (%)', N1(stats.allowance)]);
    resumo.push(['Tempo padrão de ciclo (s)', N2(stats.stdCycle)]);
  }
  if (stats.takt > 0) {
    resumo.push(['Demanda (un/período)', N2(Number(study.demand) || 0)]);
    resumo.push(['Tempo disponível (min/período)', N2(Number(study.availableMin) || 0)]);
    resumo.push(['Takt time (s/un)', N2(stats.takt)]);
    resumo.push([(stats.hasStdParams ? 'Tempo padrão' : 'Tempo') + ' por unidade (s/un)', N2(stats.perUnitRef)]);
    resumo.push(['Operadores necessários', N2(stats.operatorsNeeded)]);
  }
  if (stats.interruptionCount) {
    resumo.push(['Interrupções (qtd)', I(stats.interruptionCount)]);
    resumo.push(['Interrupções (s)', N2(stats.interruptionTime)]);
  }
  if (stats.trend) {
    resumo.push(['Tendência do ciclo (s/ciclo)', N2(stats.trend.slope)]);
    resumo.push(['Tendência', stats.trend.direction === 'down' ? 'queda (melhora/aprendizado)' : stats.trend.direction === 'up' ? 'alta (piora/fadiga)' : 'estável']);
    if (stats.trend.learningRate) resumo.push(['Curva de aprendizado (%)', N1(stats.trend.learningRate)]);
  }
  resumo.push(['Nível de confiança (%)', I(stats.confidence)]);
  resumo.push(['Erro relativo (%)', I(stats.errorPct)]);

  const registros = [[H('Ciclo'), H('Etapa'), H('Tipo'), H('Tempo (s)'), H('Qtd'), H('Horário'), H('Considerado'), H('Observação'), H('Fotos')]];
  (study.records || []).forEach(r => {
    registros.push([
      I(r.cycle), r.stageName, r.interruption ? 'Interrupção' : r.type, N2(r.time), { v: Number(r.qty) || 0, s: 'int' },
      fmtTimeOfDay(r.ts), r.excluded || r.interruption ? 'Não' : 'Sim', r.note ? { v: r.note, s: 'wrap' } : '',
      r.photos && r.photos.length ? I(r.photos.length) : ''
    ]);
  });

  const head = ['Etapa', 'Tipo', 'Posto', 'Ocorrências', 'Total (s)', 'Média (s)', 'Mín (s)', 'Máx (s)', 'Desvio padrão (s)', 'CV (%)', 'Ciclos necessários', 'Qtd', 'Produtividade (un/h)'];
  if (stats.hasStdParams) head.push('Ritmo (%)', 'Tempo normal (s)', 'Tempo padrão (s)');
  const etapas = [head.map(H)];
  const stationOf = new Map((study.stages || []).map(st => [st.id, st.station || '']));
  stats.summary.forEach(s => {
    const row = [s.name, s.type, stationOf.get(s.stageId) || '', I(s.count), N2(s.total), N2(s.avg), N2(s.min), N2(s.max), N2(s.sd), N1(s.cv),
      s.nRequired === null ? '' : I(s.nRequired), I(s.qty), N2(s.productivity)];
    if (stats.hasStdParams) row.push(N1(s.rating), N2(s.normal), N2(s.standard));
    etapas.push(row);
  });

  const types = CHART_TYPE_ORDER;
  const ciclos = [[H('Ciclo'), H('Total (s)'), ...types.map(t => H(t + ' (s)')), H('Qtd')]];
  stats.cycles.forEach(c => ciclos.push([I(c.cycle), N2(c.total), ...types.map(t => N2(c.byType[t] || 0)), I(c.qty)]));

  const pareto = [[H('Etapa'), H('Tipo'), H('Total (s)'), H('% do tempo'), H('% acumulado')]];
  stats.pareto.forEach(p => pareto.push([p.name, p.type, N2(p.total), N1(p.share), N1(p.cumulative)]));

  const sheets = [
    { name: 'Resumo', rows: resumo, widths: [36, 40] },
    { name: 'Registros', rows: registros, widths: [8, 28, 12, 11, 8, 11, 12, 40, 8], freezeRow: 1 },
    { name: 'Por etapa', rows: etapas, widths: [28, 12, 14, 12, 11, 11, 10, 10, 16, 9, 18, 8, 20, 10, 16, 16], freezeRow: 1 },
    { name: 'Por ciclo', rows: ciclos, widths: [8, 11, 10, 10, 14, 11, 8], freezeRow: 1 },
    { name: 'Pareto', rows: pareto, widths: [28, 12, 11, 12, 13], freezeRow: 1 }
  ];
  // Balanceamento de linha: carga de cada posto
  const bal = computeBalance(study, stats);
  if (bal.stations.length && bal.hasStations) {
    const rows = [
      [{ v: 'Balanceamento de linha', s: 'title' }],
      [],
      [B('Eficiência do balanceamento (%)'), N1(bal.efficiency)],
      [B('Posto gargalo'), bal.bottleneck || ''],
      [B('Carga do gargalo (s/ciclo)'), N2(bal.maxLoad)]
    ];
    if (bal.taktCycle > 0) {
      rows.push([B('Takt do ciclo (s)'), N2(bal.taktCycle)]);
      rows.push([B('Mínimo teórico de postos'), I(bal.minStations)]);
    }
    rows.push([]);
    rows.push([H('Posto'), H('Etapa'), H('Tipo'), H('Carga (s/ciclo)')]);
    bal.stations.forEach(stn => {
      stn.items.forEach(it => rows.push([stn.name, it.name, it.type, N2(it.load)]));
      rows.push([B(stn.name + ' — total'), '', '', { v: Math.round(stn.load * 100) / 100, s: 'bold' }]);
    });
    sheets.push({ name: 'Balanceamento', rows, widths: [30, 28, 12, 16] });
  }
  // A3: textos e plano de ação
  const a3 = study.a3;
  if (a3) {
    const label = { problem: '1. Problema / contexto', current: '2. Situação atual', goal: '3. Meta', rootCause: '4. Análise de causa', countermeasures: '5. Contramedidas', followUp: '7. Acompanhamento' };
    const rows = [[{ v: 'Relatório A3 — ' + study.name, s: 'title' }], []];
    Object.keys(label).forEach(k => { if (a3[k]) rows.push([B(label[k]), { v: a3[k], s: 'wrap' }]); });
    if (a3.actions && a3.actions.length) {
      const stName = { aberta: 'Aberta', andamento: 'Em andamento', concluida: 'Concluída' };
      rows.push([]);
      rows.push([H('6. Plano de ação — o quê'), H('Quem'), H('Quando'), H('Status')]);
      a3.actions.forEach(a => rows.push([{ v: a.what, s: 'wrap' }, a.who, a.when ? a.when.split('-').reverse().join('/') : '', stName[A3_STATUS.includes(a.status) ? a.status : 'aberta']]));
    }
    sheets.push({ name: 'A3', rows, widths: [40, 60, 14, 16] });
  }
  const notes = String(study.notes || '').trim();
  if (notes) sheets.push({ name: 'Observações', rows: [[H('Observações / Oportunidades Observadas')], ...notes.split(/\r?\n/).map(l => [{ v: l, s: 'wrap' }])], widths: [100] });
  return sheets;
}

/* Amostragem do trabalho: Resumo, Por categoria e Observações. */
export function buildSamplingSheets(study, st, exportedAt = new Date()) {
  const resumo = [
    [{ v: study.name, s: 'title' }],
    [],
    [B('Estudo'), study.name],
    [B('Tipo'), 'Amostragem do trabalho'],
    [B(FIELD_LABELS.process), study.process],
    [B(FIELD_LABELS.operator), study.operator],
    [B(FIELD_LABELS.observer), study.observer],
    [B('Data da exportação'), exportedAt.toLocaleString('pt-BR')],
    [],
    [H('Indicador'), H('Valor')],
    ['Observações', I(st.n)],
    ['% produtivo', N1(st.productivePct)],
    ['Intervalo de confiança — mínimo (%)', N1(st.productiveLo)],
    ['Intervalo de confiança — máximo (%)', N1(st.productiveHi)],
    ['Observações necessárias', I(st.nRequired)],
    ['Nível de confiança (%)', I(st.confidence)],
    ['Erro aceitável (pontos %)', I(st.errorPts)]
  ];
  if (st.availableMin > 0) resumo.push(['Minutos observados por dia', N1(st.availableMin)]);
  const cats = [[H('Categoria'), H('Produtiva'), H('Observações'), H('%'), H('IC mín (%)'), H('IC máx (%)'), H('Minutos estimados')]];
  st.categories.forEach(c => cats.push([c.name, c.productive ? 'Sim' : 'Não', I(c.count), N1(c.p * 100), N1(c.lo * 100), N1(c.hi * 100), c.minutes === null ? '' : N1(c.minutes)]));
  const obs = [[H('Data'), H('Horário'), H('Categoria'), H('Produtiva'), H('Observação')]];
  (study.observations || []).forEach(o => {
    const d = new Date(o.ts);
    obs.push([isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR'), fmtTimeOfDay(o.ts), o.catName, o.productive ? 'Sim' : 'Não', o.note ? { v: o.note, s: 'wrap' } : '']);
  });
  const sheets = [
    { name: 'Resumo', rows: resumo, widths: [36, 40] },
    { name: 'Por categoria', rows: cats, widths: [30, 11, 13, 9, 11, 11, 18], freezeRow: 1 },
    { name: 'Observações', rows: obs, widths: [12, 11, 30, 11, 40], freezeRow: 1 }
  ];
  const notes = String(study.notes || '').trim();
  if (notes) sheets.push({ name: 'Notas', rows: [[H('Observações / Oportunidades Observadas')], ...notes.split(/\r?\n/).map(l => [{ v: l, s: 'wrap' }])], widths: [100] });
  return sheets;
}
