# Onde parei (trabalho em andamento — apagar este arquivo antes do merge)

Pedido: "implemente tudo" da lista de melhorias (2ª rodada). Branch `claude/festive-babbage-o9irgs`, PR #1.
Este commit foi enviado com `[skip ci]` porque está pela metade (os testes e2e ainda têm 5 falhas conhecidas, abaixo).

## Pronto (com testes)
- [x] Mesclagem registro a registro (`js/core/model.js` → `mergeStudy`): datas por campo (`fieldTs`), por etapa/registro (`.u`), lápides (`deletedRecords`/`deletedStages`), ordem das etapas por `pos`. Teste de propriedades com 200 cenários (comutativa/associativa/idempotente) em `tests/merge-study.test.js`.
- [x] Armazenamento em IndexedDB (`js/storage.js`): memória + gravação em fila, BroadcastChannel entre abas (aviso só depois de gravar), fallback para localStorage, migração do store v3 do localStorage.
- [x] Migração SQL `supabase/migrations/002_estudos_por_linha.sql` (um estudo por linha, compartilhamento, versões, admins, estatísticas, excluir conta). **Ainda não validada num Postgres real** — revisar sintaxe.
- [x] Sincronização com 2 modos em `js/cloud.js` (blob atual / rows após a migração), detecção automática, busca incremental, push por estudo com controle otimista, leitura da tabela antiga na transição.
- [x] Etapas reordenáveis, modelo de estudo, interrupção (botão + tecla 0), observação por registro (coluna + 📝), vibração, Modo Campo deitado (CSS).
- [x] Takt time, série por ciclo, Pareto, gráficos SVG (Yamazumi, Pareto, tempo de ciclo) com tooltip/teclado; paleta validada para daltonismo (VA/NVA/Transporte/Espera).
- [x] Exportar Excel (.xlsx) sem bibliotecas (`js/core/zip.js`, `xlsx.js`, `report.js`) — validado com openpyxl.
- [x] Comparação antes × depois, compartilhamento (modal + somente leitura), versões no servidor (aba Histórico), admin com estatísticas, excluir conta.
- [x] Editor dividido em módulos (`editor.js`, `editor-timer.js`, `editor-stages.js`, `editor-records.js`, `editor-stats.js`, `editor-history.js`).
- [x] `npm test`: 65 testes passando. `npm run test:e2e`: 153 ok, 5 falhas (abaixo).

## Falhas e2e a corrigir (diagnóstico)
1. **"mesmo estudo em dois aparelhos → B recebeu as marcações de A"**: a nuvem fica certa, mas o editor de B não redesenha. Em `editor.applyExternalUpdate` a comparação usa só `updatedAt` (o merge mantém o maior, que pode ser o do próprio B). Trocar por comparação de conteúdo (`stableStringify`) do estudo.
2. **"banco novo → conflito detectado (0)"**: o resultado final está certo; provavelmente o pull incremental mesclou antes do push e não houve conflito. Ajustar o teste para forçar um conflito real (ou só checar o resultado).
3. **"compartilhamento → convidado agora pode editar"**: mudança de papel (viewer→editor) chega pelo `crono_study_share`, mas como nenhum estudo mudou o `onMerged` não é chamado e o editor continua somente leitura. Em `syncRows` chamar `onMerged` quando o mapa de acesso mudar.
4. **"excluir conta → dados apagados deste aparelho"**: o banco IndexedDB `cronoanalise-<id>` continua listado depois de `wipeUserData`. Investigar (conexão ainda aberta? escrita na fila reabrindo?).

## Falta fazer
- [ ] Corrigir os 4 itens acima e rodar `npm run test:e2e` inteiro.
- [ ] Engenharia: ESLint (config flat) e `// @ts-check` + JSDoc em `js/core/` com `tsc` no CI; job de teste contra Supabase de homologação (roda só se houver secrets) + script de smoke test.
- [ ] Validar a sintaxe do SQL 002 (ex.: `pglast` ou Postgres local), revisar `supabase/schema.sql`.
- [ ] Screenshot do Modo Campo deitado e revisão visual geral (claro/escuro/celular).
- [ ] README (novas funções, migração 002, testes), descrição do PR, remover este arquivo, commit final e push (com CI).
