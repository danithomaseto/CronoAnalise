/* Exportação CSV no formato do Excel brasileiro: ";" como separador,
   vírgula decimal e BOM UTF-8 (adicionado por quem gera o arquivo). */

import { FIELD_LABELS } from '../config.js';
import { toBR, fmtTimeOfDay } from './format.js';

/* Célula de texto: aspas quando necessário e proteção contra "CSV injection"
   (Excel interpreta =, +, -, @ no início como fórmula). */
export function textCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function row(...cells) {
  return cells.join(';');
}

export function buildCSV(study, stats, exportedAt = new Date()) {
  const t = textCell;
  const lines = [];
  lines.push(row(t('Estudo'), t(study.name)));
  lines.push(row(t(FIELD_LABELS.process), t(study.process)));
  lines.push(row(t(FIELD_LABELS.operator), t(study.operator)));
  lines.push(row(t(FIELD_LABELS.observer), t(study.observer)));
  if (stats.hasStdParams) {
    lines.push(row(t('Fator de ritmo (%)'), toBR(stats.rating, 1)));
    lines.push(row(t('Tolerâncias (%)'), toBR(stats.allowance, 1)));
  }
  lines.push(row(t('Data da exportação'), t(exportedAt.toLocaleString('pt-BR'))));
  lines.push('');

  lines.push(row('Ciclo', 'Etapa', 'Tipo', 'Tempo(s)', 'Qtd', 'Horário', 'Considerado', 'Observação'));
  (study.records || []).forEach(r => {
    lines.push(row(
      r.cycle,
      t(r.stageName),
      t(r.interruption ? 'Interrupção' : r.type),
      toBR(r.time),
      toBR(r.qty ?? 1, 0),
      t(fmtTimeOfDay(r.ts)),
      r.excluded || r.interruption ? 'Não' : 'Sim',
      t(r.note || '')
    ));
  });
  lines.push('');

  lines.push('Resumo por Etapa');
  const head = ['Etapa', 'Tipo', 'Ocorrências', 'Tempo Total(s)', 'Tempo Médio(s)', 'Tempo Mín(s)', 'Tempo Máx(s)',
    'Desvio Padrão(s)', 'CV(%)', 'Ciclos Necessários', 'Qtd Total', 'Produtividade (un/h)'];
  if (stats.hasStdParams) head.push('Tempo Normal(s)', 'Tempo Padrão(s)');
  lines.push(row(...head));
  stats.summary.forEach(s => {
    const cells = [
      t(s.name), t(s.type), s.count, toBR(s.total), toBR(s.avg), toBR(s.min), toBR(s.max),
      toBR(s.sd), toBR(s.cv, 1), s.nRequired === null ? '' : s.nRequired, toBR(s.qty, 0), toBR(s.productivity)
    ];
    if (stats.hasStdParams) cells.push(toBR(s.normal), toBR(s.standard));
    lines.push(row(...cells));
  });
  lines.push('');

  lines.push(row(t('Tempo Total(s)'), toBR(stats.total)));
  lines.push(row(t('Quantidade Total'), toBR(stats.qtyTotal, 0)));
  lines.push(row(t('Produtividade (un/h)'), toBR(stats.productivity)));
  lines.push(row(t('% Valor Agregado'), toBR(stats.vaPct, 1)));
  lines.push(row(t('Ciclos'), stats.cycleCount));
  lines.push(row(t('Tempo Médio de Ciclo(s)'), toBR(stats.avgCycle)));
  if (stats.hasStdParams) lines.push(row(t('Tempo Padrão de Ciclo(s)'), toBR(stats.stdCycle)));
  if (stats.takt > 0) {
    lines.push(row(t('Takt time (s/un)'), toBR(stats.takt)));
    lines.push(row(t((stats.hasStdParams ? 'Tempo padrão' : 'Tempo') + ' por unidade (s/un)'), toBR(stats.perUnitRef)));
    lines.push(row(t('Operadores necessários'), toBR(stats.operatorsNeeded)));
  }
  if (stats.interruptionCount) {
    lines.push(row(t('Interrupções (qtd)'), stats.interruptionCount));
    lines.push(row(t('Interrupções (s)'), toBR(stats.interruptionTime)));
  }
  lines.push(row(t('Nível de confiança (%)'), stats.confidence));
  lines.push(row(t('Erro relativo (%)'), stats.errorPct));

  const notes = String(study.notes || '').trim();
  if (notes) {
    lines.push('');
    lines.push('Observações / Oportunidades Observadas');
    notes.split(/\r?\n/).forEach(l => lines.push(t(l)));
  }
  return lines.join('\r\n');
}
