CronoAnálise

<img width="1917" height="941" alt="image" src="https://github.com/user-attachments/assets/a37afc61-13c0-4a91-a5ce-87eca638e57e" />

<img width="1899" height="940" alt="image" src="https://github.com/user-attachments/assets/722ed059-52a2-441a-8b0c-2cbb4d4bc150" />

Ferramenta web de cronoanálise (time & motion study) para captura e análise de tempos de processo em tempo real.

🔗 Aplicativo Final: crono-analise.vercel.app

O que é

CronoAnálise nasceu para substituir a combinação cronômetro-de-celular + planilha por um fluxo único: você define as etapas do processo, cronometra cada ciclo tocando na etapa correspondente, e a ferramenta calcula os indicadores na hora — tempo total, produtividade, % de tempo que agrega valor — além de manter um histórico organizado por estudo.

Cada etapa é classificada segundo a lógica clássica de análise de processo:

Tipo	Significado
VA	Valor Agregado — a etapa transforma o produto/serviço
NVA	Não Agrega Valor — necessário, mas não transforma nada
Espera	Tempo parado entre etapas
Transporte	Movimentação de material, produto ou pessoas
Funcionalidades

Captura

⏱️ Cronômetro contínuo com precisão de décimos de segundo, organizado em ciclos
🏷️ Etapas configuráveis por estudo (nome + tipo VA/NVA/Espera/Transporte)
✏️ Registros editáveis direto na tabela e removíveis individualmente
🔢 Quantidade produzida controlada por ciclo

Indicadores em tempo real

Tempo total, quantidade total, produtividade (unid./hora) e % de Valor Agregado
Distribuição de tempo por tipo
Resumo por etapa: ocorrências, total, média, mínimo e máximo

Organização

📊 Dashboard com todos os estudos: busca, ordenação e ações rápidas (abrir, duplicar, excluir)
🕓 Linha do tempo de eventos por estudo
📝 Campo de observações por estudo, incluído na exportação

Nuvem

🔐 Autenticação por e-mail/senha
☁️ Sincronização automática entre dispositivos, com indicador visual de status
📴 Funciona offline — os dados ficam salvos localmente e sincronizam assim que possível

Feito para uso em campo

📱 "Modo Campo": alvos de toque maiores, otimizado pra uso em pé com o celular
🔆 Mantém a tela acesa durante a coleta (Wake Lock API)
🌙 Tema escuro

Exportação

📄 CSV pronto pro Excel brasileiro (; como separador, vírgula decimal, BOM UTF-8) — inclui registros, resumo por etapa e observações
Tech stack
Frontend: HTML5, CSS3 (variáveis nativas, sem framework), JavaScript vanilla (ES6+)
Backend/Nuvem: Supabase (autenticação + Postgres)
Deploy: Vercel
Sem build step, sem bundler — um único arquivo estático
Rodando localmente

Autor

Desenvolvido por Daniel Thomaseto.
