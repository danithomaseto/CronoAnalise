/* Avaliação de ritmo pelo sistema Westinghouse (habilidade, esforço, condições e
   consistência). Cada fator soma (ou subtrai) uma fração ao ritmo normal:
     ritmo = (1 + Σ fatores) × 100 %
   Tabela clássica (Lowry, Maynard e Stegemerten). Sem DOM, testável no Node. */

/** @type {Object<string, { label: string, levels: [string, number, string][] }>} */
export const WH_FACTORS = {
  skill: {
    label: 'Habilidade',
    levels: [
      ['A1', 0.15, 'Superior'], ['A2', 0.13, 'Superior'], ['B1', 0.11, 'Excelente'], ['B2', 0.08, 'Excelente'],
      ['C1', 0.06, 'Boa'], ['C2', 0.03, 'Boa'], ['D', 0, 'Média'], ['E1', -0.05, 'Regular'], ['E2', -0.10, 'Regular'],
      ['F1', -0.16, 'Fraca'], ['F2', -0.22, 'Fraca']
    ]
  },
  effort: {
    label: 'Esforço',
    levels: [
      ['A1', 0.13, 'Excessivo'], ['A2', 0.12, 'Excessivo'], ['B1', 0.10, 'Excelente'], ['B2', 0.08, 'Excelente'],
      ['C1', 0.05, 'Bom'], ['C2', 0.02, 'Bom'], ['D', 0, 'Médio'], ['E1', -0.04, 'Regular'], ['E2', -0.08, 'Regular'],
      ['F1', -0.12, 'Fraco'], ['F2', -0.17, 'Fraco']
    ]
  },
  conditions: {
    label: 'Condições',
    levels: [['A', 0.06, 'Ideais'], ['B', 0.04, 'Excelentes'], ['C', 0.02, 'Boas'], ['D', 0, 'Médias'], ['E', -0.03, 'Regulares'], ['F', -0.07, 'Ruins']]
  },
  consistency: {
    label: 'Consistência',
    levels: [['A', 0.04, 'Perfeita'], ['B', 0.03, 'Excelente'], ['C', 0.01, 'Boa'], ['D', 0, 'Média'], ['E', -0.02, 'Regular'], ['F', -0.04, 'Ruim']]
  }
};

export const WH_KEYS = ['skill', 'effort', 'conditions', 'consistency'];

function valueOf(key, level) {
  const f = WH_FACTORS[key];
  const row = f && f.levels.find(l => l[0] === level);
  return row ? row[1] : null;
}

/* Mantém só fatores e níveis válidos; sem nenhum fator válido devolve null. */
export function normalizeWh(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  WH_KEYS.forEach(k => { if (valueOf(k, raw[k]) !== null) out[k] = raw[k]; });
  return Object.keys(out).length ? out : null;
}

/* Ritmo em % (ex.: 109) ou null quando a etapa não tem avaliação.
   Fator não avaliado conta como "D" (médio = 0). */
export function whRating(wh) {
  const n = normalizeWh(wh);
  if (!n) return null;
  const sum = WH_KEYS.reduce((a, k) => a + (n[k] ? valueOf(k, n[k]) : 0), 0);
  return Math.round((1 + sum) * 1000) / 10;
}
