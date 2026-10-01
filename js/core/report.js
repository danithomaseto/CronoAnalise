/* Conteúdo do relatório em Excel (abas, linhas e formatos) — sem DOM. */

import { FIELD_LABELS } from '../config.js';
import { fmtTimeOfDay } from './format.js';
import { CHART_TYPE_ORDER } from './stats.js';

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
  resumo.push(['Nível de confiança (%)', I(stats.confidence)]);
  resumo.push(['Erro relativo (%)', I(stats.errorPct)]);

  const registros = [[H('Ciclo'), H('Etapa'), H('Tipo'), H('Tempo (s)'), H('Qtd'), H('Horário'), H('Considerado'), H('Observação')]];
  (study.records || []).forEach(r => {
    registros.push([
      I(r.cycle), r.stageName, r.interruption ? 'Interrupção' : r.type, N2(r.time), { v: Number(r.qty) || 0, s: 'int' },
      fmtTimeOfDay(r.ts), r.excluded || r.interruption ? 'Não' : 'Sim', r.note ? { v: r.note, s: 'wrap' } : ''
    ]);
  });

  const head = ['Etapa', 'Tipo', 'Ocorrências', 'Total (s)', 'Média (s)', 'Mín (s)', 'Máx (s)', 'Desvio padrão (s)', 'CV (%)', 'Ciclos necessários', 'Qtd', 'Produtividade (un/h)'];
  if (stats.hasStdParams) head.push('Tempo normal (s)', 'Tempo padrão (s)');
  const etapas = [head.map(H)];
  stats.summary.forEach(s => {
    const row = [s.name, s.type, I(s.count), N2(s.total), N2(s.avg), N2(s.min), N2(s.max), N2(s.sd), N1(s.cv),
      s.nRequired === null ? '' : I(s.nRequired), I(s.qty), N2(s.productivity)];
    if (stats.hasStdParams) row.push(N2(s.normal), N2(s.standard));
    etapas.push(row);
  });

  const types = CHART_TYPE_ORDER;
  const ciclos = [[H('Ciclo'), H('Total (s)'), ...types.map(t => H(t + ' (s)')), H('Qtd')]];
  stats.cycles.forEach(c => ciclos.push([I(c.cycle), N2(c.total), ...types.map(t => N2(c.byType[t] || 0)), I(c.qty)]));

  const pareto = [[H('Etapa'), H('Tipo'), H('Total (s)'), H('% do tempo'), H('% acumulado')]];
  stats.pareto.forEach(p => pareto.push([p.name, p.type, N2(p.total), N1(p.share), N1(p.cumulative)]));

  const sheets = [
    { name: 'Resumo', rows: resumo, widths: [36, 40] },
    { name: 'Registros', rows: registros, widths: [8, 28, 12, 11, 8, 11, 12, 40], freezeRow: 1 },
    { name: 'Por etapa', rows: etapas, widths: [28, 12, 12, 11, 11, 10, 10, 16, 9, 18, 8, 20, 16, 16], freezeRow: 1 },
    { name: 'Por ciclo', rows: ciclos, widths: [8, 11, 10, 10, 14, 11, 8], freezeRow: 1 },
    { name: 'Pareto', rows: pareto, widths: [28, 12, 11, 12, 13], freezeRow: 1 }
  ];
  const notes = String(study.notes || '').trim();
  if (notes) sheets.push({ name: 'Observações', rows: [[H('Observações / Oportunidades Observadas')], ...notes.split(/\r?\n/).map(l => [{ v: l, s: 'wrap' }])], widths: [100] });
  return sheets;
}
