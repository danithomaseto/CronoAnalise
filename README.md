# CronoAnálise

<img width="1917" height="941" alt="Dashboard do CronoAnálise" src="https://github.com/user-attachments/assets/a37afc61-13c0-4a91-a5ce-87eca638e57e" />

<img width="1899" height="940" alt="Editor de estudo do CronoAnálise" src="https://github.com/user-attachments/assets/722ed059-52a2-441a-8b0c-2cbb4d4bc150" />

Ferramenta web de cronoanálise (*time & motion study*) para captura e análise de tempos de processo em tempo real.

🔗 **Aplicativo:** [crono-analise.vercel.app](https://crono-analise.vercel.app)

## O que é

O CronoAnálise nasceu para substituir a combinação cronômetro de celular + planilha por um fluxo único: você define as etapas do processo, cronometra cada ciclo tocando na etapa correspondente, e a ferramenta calcula os indicadores na hora — tempo total, produtividade, % de tempo que agrega valor, variabilidade, tamanho de amostra e takt time — além de manter um histórico organizado por estudo.

Cada etapa é classificada segundo a lógica clássica de análise de processo:

| Tipo | Significado |
|------|-------------|
| **VA** | Valor Agregado — a etapa transforma o produto/serviço |
| **NVA** | Não Agrega Valor — necessário, mas não transforma nada |
| **Espera** | Tempo parado entre etapas |
| **Transporte** | Movimentação de material, produto ou pessoas |

## Funcionalidades

### Captura
- ⏱️ Cronômetro contínuo organizado em ciclos, com o tempo calculado no instante exato do toque
- 🔁 O cronômetro sobrevive a recarregar a página, trocar de aba ou o celular fechar o navegador — cada estudo guarda o próprio cronômetro
- ⚡ **Interrupção** (elemento estranho): registra o tempo à parte, fora dos cálculos (tecla `0`)
- 📝 Observação em cada registro (na tabela ou no botão 📝 da última marcação)
- ↶ **Desfazer** marcação, novo ciclo, zerar cronômetro ou exclusão de registro (o tempo volta para o elemento em andamento)
- 🏷️ Etapas configuráveis por estudo (nome + tipo), **reordenáveis**, e **modelos** (novo estudo com as mesmas etapas e parâmetros)
- ✏️ Registros editáveis direto na tabela, removíveis ou **ignorados nos cálculos** sem excluir
- 🔢 Quantidade produzida por etapa
- ⌨️ Atalhos no computador: `Espaço` iniciar/pausar · `1–9` marcar etapa · `0` interrupção · `N` novo ciclo · `Ctrl+Z` desfazer

### Indicadores e análise
- Tempo total, quantidade, produtividade (unid./hora), % de Valor Agregado, nº de ciclos, tempo médio e desvio do ciclo
- Resumo por etapa: ocorrências, total, média, mínimo, máximo, **desvio padrão, coeficiente de variação, ciclos necessários** (n = (z·s / (e·x̄))², confiança e erro configuráveis) e produtividade por etapa
- **Gráficos**: composição do tempo por ciclo (Yamazumi), Pareto das etapas e tempo de ciclo com faixa de ±2σ — com tooltip (mouse, toque e teclado) e cores testadas para daltonismo
- **Takt time**: demanda e tempo disponível → takt, tempo por unidade e operadores necessários
- Fator de ritmo e tolerâncias → tempo normal e tempo padrão
- Etapas que **contam para a produção** (evita somar a quantidade de todas as etapas)
- Destaque de valores fora de ±2σ (possíveis toques errados)
- ⚖ **Comparação antes × depois** de dois estudos (indicadores, composição e etapas)

### Organização e equipe
- 📊 Dashboard com busca, ordenação e ações rápidas (abrir, modelo, duplicar, excluir), com selo de cronômetro em andamento
- 🕓 Linha do tempo de eventos por estudo e **versões anteriores no servidor** com restauração¹
- 👥 **Compartilhamento** de estudos por e-mail, para ver ou editar¹
- 👤 Painel de administração com acessos e estatísticas por usuário

### Nuvem e dados
- 🔐 Autenticação por e-mail/senha, com recuperação de senha
- ☁️ Sincronização automática entre aparelhos, **mesclando registro a registro**: dois aparelhos editando o mesmo estudo somam as alterações; exclusões se propagam
- 📴 Funciona offline de verdade (PWA): abre sem internet, salva no aparelho (IndexedDB) e sincroniza quando a conexão volta
- 👥 Dados locais separados por conta — seguro em computador compartilhado
- 💾 Backup/restauração em JSON e **excluir minha conta e meus dados** (LGPD)¹

### Feito para uso em campo
- 📱 "Modo Campo": alvos de toque maiores, layout próprio com o celular deitado
- 📳 Vibração ao marcar etapa (configurável) e tela sempre acesa durante a coleta
- 📲 Instalável na tela inicial do celular · 🌙 Tema escuro (segue o sistema)

### Exportação
- 📗 **Excel (.xlsx)** com abas: Resumo, Registros, Por etapa, Por ciclo, Pareto e Observações
- 📄 CSV pronto para o Excel brasileiro (`;`, vírgula decimal, BOM UTF-8), com proteção contra fórmulas maliciosas
- 🖨️ Relatório para imprimir / salvar em PDF, com os gráficos

¹ Requer a migração `supabase/migrations/002_estudos_por_linha.sql` no banco (ver abaixo).

## Tech stack

- **Frontend:** HTML5, CSS3 (variáveis nativas, sem framework), JavaScript vanilla (módulos ES), gráficos em SVG e Excel gerados sem bibliotecas
- **Backend/Nuvem:** [Supabase](https://supabase.com) (autenticação + Postgres com RLS)
- **Deploy:** Vercel (site estático)
- **Sem build step, sem bundler, sem dependências** — o `supabase-js` vem versionado em `vendor/`

## Rodando localmente

Os módulos ES precisam ser servidos por HTTP (abrir o `index.html` direto do disco não funciona):

```bash
npx serve .            # ou: npm start
# ou
python3 -m http.server 5173
```

## Testes e verificações

| Comando | O que faz | Precisa instalar |
|---|---|---|
| `npm test` | Lógica pura: cronômetro, indicadores, mesclagem (inclui 200 cenários aleatórios), CSV, Excel, gráficos | nada |
| `npm run lint` | ESLint + checagem de tipos (JSDoc) em `js/core` | `npm i --no-save eslint@9 typescript@5` |
| `npm run test:sql` | Aplica `schema.sql` e a migração 002 num **Postgres real** e testa RLS, gatilhos e funções | `npm i --no-save embedded-postgres pg` |
| `npm run test:e2e` | 17 cenários no navegador com o `supabase-js` real contra um Supabase simulado (sem internet) | `npm i --no-save playwright && npx playwright install chromium` |
| `npm run test:staging` | Fluxo completo contra um **Supabase de homologação** (pulado sem credenciais) | Playwright + variáveis `STAGING_*` |

Todos rodam no GitHub Actions. Para ativar o teste de homologação: crie um projeto Supabase separado, rode nele `supabase/schema.sql` e a migração 002, crie um usuário de teste e cadastre os segredos `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, `STAGING_EMAIL` e `STAGING_PASSWORD` no repositório (*Settings → Secrets and variables → Actions*).

## Banco de dados

- [`supabase/schema.sql`](supabase/schema.sql) — as tabelas atuais (`crono_studies` e `crono_user_activity`) com suas políticas de segurança (RLS) e a função opcional de contagem de acessos.
- [`supabase/migrations/002_estudos_por_linha.sql`](supabase/migrations/002_estudos_por_linha.sql) — **um estudo por linha** (sincronização incremental, sem limite de tamanho), **compartilhamento**, **versões anteriores** (backup automático por 90 dias), **administradores em tabela**, **estatísticas** para o painel e **exclusão de conta**.

Como aplicar: Supabase → *SQL Editor* → colar o arquivo → *Run*. Os scripts são idempotentes (podem rodar de novo). O app **detecta sozinho** quando a migração 002 foi aplicada: cada aparelho copia os estudos da tabela antiga (que é mantida intacta como backup) e passa a usar o novo formato. Até lá, tudo continua funcionando como antes.

Para a recuperação de senha, a URL do app precisa estar em *Authentication → URL Configuration* (Site URL ou Redirect URLs).

## Estrutura

```
index.html              Página única (HTML)
css/styles.css          Estilos (tema escuro, Modo Campo, impressão, gráficos)
js/main.js              Entrada: login, navegação, ações, atalhos
js/editor*.js           Tela do estudo (núcleo, cronômetro, etapas, registros, indicadores, histórico)
js/dashboard.js         Tela inicial com a lista de estudos
js/share.js             Compartilhamento
js/compare.js           Comparação antes × depois
js/cloud.js             Supabase: sincronização (2 modos), compartilhamento, versões, admin, conta
js/storage.js           IndexedDB (com fallback para localStorage), separado por usuário
js/auth.js · js/ui.js   Autenticação · toast, modais, menu, tema
js/config.js            Configurações (Supabase, admin, rótulos dos campos)
js/core/                Lógica pura, testável no Node
  model.js              Formato dos dados, migração e mesclagem registro a registro
  timer.js · stats.js   Cronômetro serializável · indicadores, takt, Pareto, série por ciclo
  charts.js             Gráficos SVG
  csv.js · xlsx.js · zip.js · report.js   Exportações
  types.js              Tipos (JSDoc)
sw.js                   Service worker (offline)
supabase/               schema.sql e migrations/
tests/                  Testes (node --test), e2e/, sql/, staging/
vendor/                 supabase-js versionado
```

## Autor

Desenvolvido por Daniel Thomaseto.
