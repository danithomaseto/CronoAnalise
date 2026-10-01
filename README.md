# CronoAnálise

<img width="1917" height="941" alt="Dashboard do CronoAnálise" src="https://github.com/user-attachments/assets/a37afc61-13c0-4a91-a5ce-87eca638e57e" />

<img width="1899" height="940" alt="Editor de estudo do CronoAnálise" src="https://github.com/user-attachments/assets/722ed059-52a2-441a-8b0c-2cbb4d4bc150" />

Ferramenta web de cronoanálise (*time & motion study*) para captura e análise de tempos de processo em tempo real.

🔗 **Aplicativo:** [crono-analise.vercel.app](https://crono-analise.vercel.app)

## O que é

O CronoAnálise nasceu para substituir a combinação cronômetro de celular + planilha por um fluxo único: você define as etapas do processo, cronometra cada ciclo tocando na etapa correspondente, e a ferramenta calcula os indicadores na hora — tempo total, produtividade, % de tempo que agrega valor, variabilidade e tamanho de amostra — além de manter um histórico organizado por estudo.

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
- ↶ **Desfazer** marcação, novo ciclo, zerar cronômetro ou exclusão de registro (o tempo volta para o elemento em andamento)
- 🏷️ Etapas configuráveis por estudo (nome + tipo VA/NVA/Espera/Transporte)
- ✏️ Registros editáveis direto na tabela, removíveis ou **ignorados nos cálculos** sem excluir
- 🔢 Quantidade produzida por etapa
- ⌨️ Atalhos no computador: `Espaço` iniciar/pausar · `1–9` marcar etapa · `N` novo ciclo · `Ctrl+Z` desfazer

### Indicadores em tempo real
- Tempo total, quantidade total, produtividade (unid./hora), % de Valor Agregado, nº de ciclos e tempo médio de ciclo
- Distribuição de tempo por tipo
- Resumo por etapa: ocorrências, total, média, mínimo, máximo, **desvio padrão, coeficiente de variação, ciclos necessários** (n = (z·s / (e·x̄))², com confiança e erro configuráveis) e produtividade por etapa
- Destaque de valores fora de ±2σ (possíveis toques errados)
- Opcional: **fator de ritmo e tolerâncias** → tempo normal e tempo padrão
- Opcional: marcar as etapas que **contam para a produção** (evita somar a quantidade de todas as etapas)

### Organização
- 📊 Dashboard com todos os estudos: busca, ordenação e ações rápidas (abrir, duplicar, excluir), com selo de cronômetro em andamento
- 🕓 Linha do tempo de eventos por estudo
- 📝 Campo de observações por estudo, incluído na exportação

### Nuvem
- 🔐 Autenticação por e-mail/senha, com recuperação de senha
- ☁️ Sincronização automática entre dispositivos: as alterações são **mescladas estudo a estudo** (dois aparelhos não apagam o trabalho um do outro) e exclusões se propagam
- 📴 Funciona offline de verdade (PWA): abre sem internet, salva no aparelho e sincroniza sozinho quando a conexão volta
- 👥 Dados locais separados por conta — seguro em computador compartilhado
- 💾 Backup/restauração em JSON (em Configurações)

### Feito para uso em campo
- 📱 "Modo Campo": alvos de toque maiores, sem botões de edição perto das etapas
- 🔆 Mantém a tela acesa durante a coleta (Wake Lock API)
- 📲 Instalável na tela inicial do celular
- 🌙 Tema escuro (segue o sistema por padrão)

### Exportação
- 📄 CSV pronto para o Excel brasileiro (`;` como separador, vírgula decimal, BOM UTF-8) — registros, resumo por etapa, totais e observações, com proteção contra fórmulas maliciosas
- 🖨️ Impressão / PDF do estudo

## Tech stack

- **Frontend:** HTML5, CSS3 (variáveis nativas, sem framework), JavaScript vanilla (módulos ES)
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

Depois abra `http://localhost:5173` (ou a porta indicada).

### Testes

```bash
npm test               # node --test, sem dependências
```

Os testes cobrem a lógica pura (cronômetro, indicadores, CSV, migração e mesclagem de dados) e a consistência do cache offline.

Testes de ponta a ponta no navegador (login, cronometragem, desfazer, recarregar a página, dois aparelhos sincronizando, offline, migração de dados antigos, XSS, PWA…), usando a biblioteca real do `supabase-js` contra um Supabase simulado — não acessa a internet nem o banco de produção:

```bash
npm i --no-save playwright && npx playwright install chromium
npm run test:e2e
```

## Estrutura

```
index.html              Página única (HTML)
css/styles.css          Estilos (inclui tema escuro, Modo Campo e impressão)
js/main.js              Entrada: login, navegação, ações e atalhos
js/editor.js            Tela do estudo: cronômetro, etapas, registros, indicadores
js/dashboard.js         Tela inicial com a lista de estudos
js/cloud.js             Supabase: sincronização com mesclagem e registro de acesso
js/storage.js           localStorage separado por usuário
js/auth.js              Entrar, criar conta, recuperar senha
js/ui.js                Toast, modais, menu, tema
js/config.js            Configurações (Supabase, admin, rótulos dos campos)
js/core/                Lógica pura, testável no Node
  timer.js              Cronômetro serializável
  stats.js              Indicadores e estatística
  csv.js                Exportação CSV
  model.js              Formato dos dados, migração e merge entre aparelhos
sw.js                   Service worker (offline)
supabase/schema.sql     Tabelas, políticas RLS e função opcional de acesso
tests/                  Testes (node --test)
vendor/                 supabase-js versionado
```

## Banco de dados

O script [`supabase/schema.sql`](supabase/schema.sql) documenta as tabelas `crono_studies` e `crono_user_activity` com suas políticas de segurança (RLS). A seção 3 é opcional: cria a função `crono_log_activity()` que conta os acessos de forma atômica no servidor — o app usa a função automaticamente quando ela existe.

Para a recuperação de senha, a URL do app precisa estar em *Authentication → URL Configuration* (Site URL ou Redirect URLs) no Supabase.

## Autor

Desenvolvido por Daniel Thomaseto.
