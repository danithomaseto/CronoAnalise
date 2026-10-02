/* Tipos do modelo de dados (só JSDoc — verificados com `tsc -p jsconfig.json`). */

/**
 * @typedef {Object} Stage            Etapa do processo
 * @property {string} id
 * @property {string} name
 * @property {'VA'|'NVA'|'Espera'|'Transporte'} type
 * @property {number} pos             ordem (mescla entre aparelhos)
 * @property {boolean} [countsOutput] conta para a produção
 * @property {string} [station]       posto de trabalho (balanceamento de linha)
 * @property {Object<string, string>} [wh] avaliação Westinghouse (skill, effort, conditions, consistency)
 * @property {string} [u]             ISO da última edição
 */

/**
 * @typedef {Object} TimeRecord       Marcação de tempo
 * @property {string} id
 * @property {number} cycle
 * @property {string|null} stageId
 * @property {string} stageName
 * @property {string} type
 * @property {number} time            segundos
 * @property {number} qty
 * @property {string} [ts]            ISO do momento da marcação
 * @property {string} [u]             ISO da última edição
 * @property {boolean} [excluded]     ignorado nos cálculos
 * @property {boolean} [interruption] interrupção (elemento estranho)
 * @property {string} [note]
 * @property {{id: string, path: string, ts?: string}[]} [photos] fotos (Supabase Storage)
 */

/**
 * @typedef {Object} SamplingCategory  Categoria da amostragem do trabalho
 * @property {string} id
 * @property {string} name
 * @property {boolean} productive
 * @property {number} pos
 * @property {string} [u]
 */

/**
 * @typedef {Object} Observation       Observação da amostragem do trabalho
 * @property {string} id
 * @property {string} ts
 * @property {string} cat              id da categoria
 * @property {string} catName
 * @property {boolean} productive
 * @property {string} [note]
 * @property {boolean} [excluded]
 * @property {string} [u]
 */

/**
 * @typedef {Object} Study
 * @property {string} id
 * @property {string} name
 * @property {string} process
 * @property {string} operator
 * @property {string} observer
 * @property {string} notes
 * @property {Stage[]} stages
 * @property {TimeRecord[]} records
 * @property {number} currentCycle
 * @property {Object<string, number>} cycleQty
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {{ts: string, text: string}[]} history
 * @property {number} [rating]        fator de ritmo (%)
 * @property {number} [allowance]     tolerâncias (%)
 * @property {number} [demand]        demanda (un/período)
 * @property {number} [availableMin]  tempo disponível (min/período)
 * @property {Object<string, string>} [fieldTs]         data de edição de cada campo
 * @property {Object<string, string>} [deletedRecords]  lápides de registros
 * @property {Object<string, string>} [deletedStages]   lápides de etapas
 * @property {'sampling'} [kind]      tipo do estudo (ausente = cronoanálise)
 * @property {SamplingCategory[]} [categories]
 * @property {Observation[]} [observations]
 * @property {{start: string, end: string, count: number}} [samplingPlan]
 * @property {Object<string, string>} [deletedCategories]
 * @property {Object<string, string>} [deletedObservations]
 * @property {Object} [a3]            relatório A3 (textos e plano de ação)
 */

/**
 * @typedef {Object} Store
 * @property {number} format
 * @property {Object<string, Study>} studies
 * @property {Object<string, string>} deleted   lápides de estudos (id → ISO)
 */

/** @typedef {{ confidence?: number, error?: number, vibrate?: boolean }} Prefs */

export {};
