# CronoAnalise System

<img width="1917" height="941" alt="Dashboard do CronoAnálise" src="https://github.com/user-attachments/assets/a37afc61-13c0-4a91-a5ce-87eca638e57e" />

<img width="1899" height="940" alt="Editor de estudo do CronoAnálise" src="https://github.com/user-attachments/assets/722ed059-52a2-441a-8b0c-2cbb4d4bc150" />

Ferramenta web de **cronoanálise** (*time & motion study*) e **amostragem do trabalho** para captura e análise de tempos de processo em tempo real.

🔗 **Aplicativo:** [crono-analise.vercel.app](https://crono-analise.vercel.app)

## Documentação

| Documento | Para quem |
|---|---|
| 📘 [**Guia de uso passo a passo**](docs/GUIA-DE-USO.md) | Quem usa a ferramenta: login, cronometragem, Modo Campo, amostragem, balanceamento, A3, exportações, equipe e configurações, com imagens de cada tela |
| 🛠️ [**Como funciona e como foi feito**](docs/FUNCIONAMENTO.md) | Quem mantém ou evolui: arquitetura, modelo de dados, mesclagem, fórmulas, banco de dados e RLS, segurança, testes e a história de cada etapa |

## O que é

O CronoAnálise substitui a combinação cronômetro de celular + planilha por um fluxo único: você define as etapas do processo, cronometra cada ciclo tocando na etapa correspondente, e a ferramenta calcula os indicadores na hora — tempo total, produtividade, % de tempo que agrega valor, variabilidade, tamanho de amostra, takt time, balanceamento da linha e tendência de aprendizado — além de manter um histórico organizado por estudo, compartilhável com pessoas e times.

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
- 🔁 O cronômetro sobrevive a recarregar a página, trocar de aba ou o celular fechar o navegador
- ⚡ **Interrupção** (elemento estranho): registra o tempo à parte, fora dos cálculos (tecla `0`)
- 📝 Observação e 📷 **fotos** em cada registro (o desperdício fica documentado; funciona offline)
- ↶ **Desfazer** marcação, novo ciclo, zerar cronômetro ou exclusão de registro
- 🏷️ Etapas configuráveis (nome, tipo, **posto**), reordenáveis, e **modelos** de estudo
- ✏️ Registros editáveis direto na tabela, removíveis ou ignorados nos cálculos
- ⌨️ Atalhos: `Espaço` iniciar/pausar · `1–9` marcar etapa · `0` interrupção · `N` novo ciclo · `Ctrl+Z` desfazer

### Análise
- Tempo total, quantidade, produtividade, % de Valor Agregado, ciclos, tempo médio e desvio do ciclo
- Resumo por etapa com desvio padrão, CV e **ciclos necessários** (n = (z·s / (e·x̄))²)
- **Ritmo por etapa (Westinghouse)**: habilidade, esforço, condições e consistência → tempo normal e padrão de cada etapa
- **Tendência do ciclo e curva de aprendizado**: regressão com teste de significância e taxa de aprendizado de Wright
- **Balanceamento de linha**: carga por posto × takt, gargalo, eficiência, mínimo teórico de postos e **sugestão automática** de redistribuição (com um clique para aplicar)
- **Gráficos**: Yamazumi por ciclo, carga por posto, Pareto e tempo de ciclo com ±2σ e tendência
- **Takt time**, tempo padrão por unidade e operadores necessários
- ⚖ **Comparação antes × depois** de dois estudos

### Amostragem do trabalho
- 🎲 Novo tipo de estudo: observações em **horários aleatórios** (o roteiro do dia é o mesmo em todos os aparelhos) com aviso na hora de observar
- Categorias produtivas e não produtivas configuráveis; registro com um toque (atalhos `1–9`)
- % de cada categoria com **intervalo de confiança** (Wilson), % produtivo, **observações necessárias** (n = z²·p(1−p)/e²) e minutos estimados por dia

### Equipe
- 🔴 **Tempo real**: quem acompanha um estudo vê as marcações chegando ao vivo (Supabase Realtime)
- 👥 Compartilhamento por e-mail (ver ou editar) e 🏢 **times** (por site ou turno): compartilhe com o time inteiro
- 📊 **Painel do time** no dashboard e filtros "meus" / "compartilhados comigo"
- 🧾 **Relatório A3** de uma página (problema, situação atual com gráficos, meta, causas, contramedidas, plano de ação e acompanhamento com comparação antes × depois)

### Segurança e dados
- 🔐 Login com e-mail/senha ou com a **conta Microsoft da empresa** (Entra ID)
- 🔑 **Verificação em duas etapas** (aplicativo autenticador) — exigida também pelo banco para quem ativar
- ⏲️ **Saída automática por inatividade** (para aparelhos compartilhados; nunca durante uma coleta)
- 🛡️ Política de **retenção de dados (LGPD)** com limpeza automática, tela de privacidade, backup e "excluir minha conta"
- 🩺 **Registro de erros do app** (sem dados pessoais) no painel de administração

### Nuvem, offline e desempenho
- ☁️ Sincronização entre aparelhos mesclando registro a registro
- 📴 Funciona offline de verdade (PWA, IndexedDB): fotos e marcações sobem quando a conexão volta
- 🚀 Estudos com milhares de registros: tabela virtual e marcação em ~0,1 s (≈0,04 s no Modo Campo)

### Exportação
- 📗 **Excel (.xlsx)** com abas Resumo, Registros, Por etapa, Por ciclo, Pareto, Balanceamento, A3 e Observações
- ☁ **Salvar no OneDrive** (pasta "CronoAnalise", abre no Excel Online) e 📤 **enviar o arquivo** pelo celular (Teams, Outlook, WhatsApp…)
- 📄 CSV para o Excel brasileiro · 🖨️ Relatório PDF · 🧾 A3 em paisagem

## Tech stack

- **Frontend:** HTML5, CSS3 e JavaScript vanilla (módulos ES), sem build step; gráficos SVG e Excel gerados sem bibliotecas; fontes locais (Lexend e Roboto Mono, licença OFL)
- **Backend:** [Supabase](https://supabase.com) — Auth (e-mail, Microsoft, MFA), Postgres com RLS, Realtime e Storage
- **Deploy:** Vercel (site estático, com CSP)

## Configuração no Supabase

Rode, no *SQL Editor* do Supabase (todos são idempotentes — podem rodar de novo):

1. [`supabase/schema.sql`](supabase/schema.sql) — tabelas originais.
2. [`supabase/migrations/002_estudos_por_linha.sql`](supabase/migrations/002_estudos_por_linha.sql) — um estudo por linha, compartilhamento, versões, admin, excluir conta.
3. [`supabase/migrations/003_equipe_seguranca.sql`](supabase/migrations/003_equipe_seguranca.sql) — **times, tempo real, fotos (bucket privado `crono-photos`), erros do app, duas etapas obrigatória para quem ativar e retenção (LGPD)**.

O app detecta sozinho o que já foi aplicado; sem a 003, tudo continua funcionando (sem times/tempo real/fotos na nuvem).

**Limpeza automática (opcional):** ative a extensão *pg_cron* (Database → Extensions) e rode a 003 de novo — a limpeza diária fica agendada. Sem ela, o administrador aplica a política pelo painel (Administração → Dados).

**Recuperação de senha:** a URL do app precisa estar em *Authentication → URL Configuration* (Site URL ou Redirect URLs).

### Login com a conta Microsoft ("Acesso com e-mail DHL")

O botão e o "Salvar no OneDrive" só aparecem quando o provedor **Azure** está ativo no Supabase. Até lá ficam escondidos, e quando o provedor é ativado aparecem sozinhos, sem novo deploy. Se o portal do Azure negar acesso (erro 401), peça ao TI o registro do app com os itens 1 a 3 abaixo.

1. No portal do Azure (Entra ID) → *App registrations* → *New registration* (contas só deste diretório). Em *Redirect URI* (Web), use `https://zwfnsknaxqnexeuzvvjn.supabase.co/auth/v1/callback`.
2. Em *Certificates & secrets*, crie um *client secret*. Em *Token configuration*, adicione a declaração opcional **email**.
3. Para salvar no OneDrive, em *API permissions* adicione *Microsoft Graph → Delegated → Files.ReadWrite* (o app só pede essa permissão quando a pessoa usa "Salvar no OneDrive"; pode precisar de consentimento do administrador do tenant).
4. No Supabase → *Authentication → Providers → Azure*: ative, cole o *Application (client) ID*, o *secret* e o *Azure Tenant URL* `https://login.microsoftonline.com/<ID do diretório>` (assim só contas da empresa entram).
5. Em *Authentication → URL Configuration*, inclua `https://crono-analise.vercel.app` nas Redirect URLs.

Quem já tem conta com o mesmo e-mail continua com os mesmos estudos (o Supabase liga as duas formas de entrar). O texto do botão, o título da tela e um logo próprio ficam em `BRAND`, em [`js/config.js`](js/config.js) — para usar o logo oficial, salve o arquivo do portal de marca (ex.: `icons/logo-empresa.svg`) e aponte `BRAND.logo` para ele.

## Rodando localmente

Os módulos ES precisam ser servidos por HTTP:

```bash
npx serve .            # ou: npm start
```

## Testes e verificações

| Comando | O que faz | Precisa instalar |
|---|---|---|
| `npm test` | Lógica pura: cronômetro, indicadores, Westinghouse, tendência, balanceamento, amostragem, mesclagem (200 cenários aleatórios), CSV, Excel, gráficos | nada |
| `npm run lint` | ESLint + checagem de tipos (JSDoc) em `js/core` | `npm i --no-save eslint@9 typescript@5` |
| `npm run test:sql` | Aplica `schema.sql`, 002 e 003 num **Postgres real** e testa RLS, times, fotos, MFA, retenção, gatilhos e funções | `npm i --no-save embedded-postgres pg` |
| `npm run test:e2e` | 31 cenários no navegador com o `supabase-js` real contra um Supabase simulado (HTTP, Realtime, Storage, MFA, login Microsoft e OneDrive), incluindo **acessibilidade com axe-core** | `npm i --no-save playwright@1.56.1 axe-core && npx playwright install chromium` |
| `npm run test:visual` | **Regressão visual**: compara screenshots das telas com as referências em `tests/visual/baseline/` (`-- --update` aceita o visual novo) | `npm i --no-save playwright@1.56.1 pixelmatch pngjs` |
| `npm run docs:screenshots` | Gera as imagens do guia de uso (`docs/img/`) com dados de demonstração | `npm i --no-save playwright@1.56.1` |
| `npm run test:staging` | Fluxo completo contra um **Supabase de homologação** (pulado sem credenciais) | Playwright + variáveis `STAGING_*` |

> Instale as dependências de teste **numa única linha** (`npm i --no-save` remove o que não estiver na mesma chamada).

Todos rodam no GitHub Actions. Para ativar o teste de homologação: crie um projeto Supabase separado, rode nele os três scripts SQL, crie um usuário de teste e cadastre os segredos `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, `STAGING_EMAIL` e `STAGING_PASSWORD` (*Settings → Secrets and variables → Actions*).

## Estrutura

```
index.html              Página única (HTML)
css/styles.css          Estilos (tema DHL claro/escuro, Modo Campo, impressão, A3)
fonts/                  Lexend e Roboto Mono (locais, licença OFL)
js/main.js              Entrada: login (e-mail, Microsoft, duas etapas), navegação, ações, inatividade, admin
js/editor*.js           Tela do estudo: núcleo, cronômetro, etapas, registros, indicadores,
                        balanceamento, amostragem, A3, histórico
js/dashboard.js         Tela inicial (filtros e painel do time)
js/teams.js · share.js  Times · compartilhamento
js/photos.js            Fotos (câmera, compressão, fila offline, galeria)
js/monitor.js           Registro de erros do app
js/integrations.js      OneDrive (Microsoft Graph) e compartilhar arquivo
js/cloud.js             Supabase: sincronização, tempo real, times, fotos, erros, admin, conta
js/storage.js           IndexedDB (estudos e fotos), separado por usuário
js/auth.js · js/ui.js   Autenticação e MFA · toast, modais, menu, tema
js/config.js            Configurações (Supabase, marca, admin, rótulos)
js/core/                Lógica pura, testável no Node
  model.js              Formato dos dados e mesclagem registro a registro
  stats.js · trend.js   Indicadores · tendência e curva de aprendizado
  westinghouse.js       Ritmo por etapa
  balance.js            Balanceamento de linha
  sampling.js           Amostragem do trabalho
  charts.js             Gráficos SVG
  csv.js · xlsx.js · zip.js · report.js   Exportações
sw.js                   Service worker (offline)
supabase/               schema.sql e migrations/ (002, 003)
tests/                  node --test, e2e/, sql/, visual/, staging/, docs/ (imagens do guia)
docs/                   Guia de uso, documento técnico e imagens (docs/img)
vendor/                 supabase-js versionado
```

## Autor

**CronoAnalise System** — desenvolvido por **Daniel Thomaseto**.

A assinatura do autor aparece na tela de login, no rodapé do app, nas Configurações, nos relatórios impressos (PDF e A3) e nas propriedades dos arquivos Excel (configurável em `BRAND.author`, em `js/config.js`).
