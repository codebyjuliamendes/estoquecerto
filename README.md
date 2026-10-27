# EstoqueCerto

Painel de estoque para pequenos restaurantes. Acompanha lotes e validade, sinaliza itens no mínimo ou abaixo dele e calcula quantas porções podem ser preparadas com o saldo atual — com baixa automática pelo lote que vence primeiro (FEFO) e histórico auditável de cada movimentação.

## Funcionalidades

- Entrada de mercadoria por lote, cada um com validade própria; o ingrediente é criado na primeira entrada.
- Saldo disponível que **não conta lotes vencidos**; o saldo vencido aparece à parte, com alerta para descarte.
- Alertas de validade (vencido, vence hoje, vence em breve) e de estoque mínimo, no topo do painel e por ingrediente.
- Fichas técnicas (receitas) com quantidade por porção e cálculo de porções possíveis, indicando o ingrediente que limita o prato.
- Preparo com baixa FEFO em transação: ou baixa todos os ingredientes, ou nenhum.
- Perdas por quantidade (consomem primeiro os lotes vencidos) e descarte de um lote inteiro.
- Ajuste de inventário pelo saldo contado ou pela diferença, sempre com motivo.
- Histórico de movimentações (entrada, preparo, perda, ajuste) com os lotes afetados por cada uma; registros são imutáveis no banco.
- Conversão exata entre kg/g/mg, L/ml e unidades.
- Exportação do inventário em CSV, protegida contra injeção de fórmulas.
- Interface responsiva (a partir de 390 px) com tema claro/escuro, diálogos acessíveis e estados de carregamento, erro e vazio.

## Regras de estoque

### Quantidades e unidades

| Dimensão | Unidade do ingrediente | Unidades aceitas | Menor unidade gravada |
| -------- | ---------------------- | ---------------- | --------------------- |
| Massa    | `kg`                   | `kg`, `g`, `mg`  | 1 mg                  |
| Volume   | `L`                    | `L`, `ml`        | 1 ml                  |
| Contagem | `un`                   | `un`, `unidade`  | 0,001 un              |

- Toda quantidade é gravada como **inteiro na menor unidade** (`2,3 kg` → `2300000` mg). A conversão é feita sobre o texto do número (`"0,2"`, `"0.2"` ou `0.2`), sem multiplicar floats; por isso `0,1 kg + 0,2 kg` dá exatamente `0,3 kg`.
- Valores mais precisos que a menor unidade (ex.: `0,5 ml`) são rejeitados em vez de arredondados. Cada registro aceita até 10.000 kg, L ou un.
- O ingrediente fica na unidade da sua dimensão (`kg`, `L` ou `un`); entradas e receitas podem usar qualquer unidade compatível. Unidade incompatível (ex.: `ml` para um ingrediente em `kg`) é recusada.
- A API responde números na unidade do ingrediente (contrato original) e também rótulos prontos em pt-BR na melhor unidade (`labels`, ex.: `"200 g"`).

### Validade e fuso

- Validades são datas civis (`AAAA-MM-DD`). "Hoje" é calculado no fuso `APP_TIMEZONE` (padrão `America/Sao_Paulo`), não em UTC — às 22h em Brasília ainda é o mesmo dia.
- Um lote **vence ao fim do dia da validade**: com validade hoje ainda é utilizável; a partir de amanhã é vencido.
- Lotes vencidos não contam no saldo disponível, no cálculo de porções nem no preparo. Não é possível registrar entrada já vencida nem com validade a mais de ~10 anos.
- "Vence em breve" usa a janela `EXPIRY_WARNING_DAYS` (padrão 3 dias).

### FEFO (primeiro a vencer, primeiro a sair)

- Preparo e ajustes negativos consomem lotes válidos em ordem de validade; empate pelo lote mais antigo.
- Perdas por quantidade consomem primeiro os lotes vencidos (que vencem antes) e depois os válidos.
- Cada baixa grava em `movement_lots` quanto saiu de cada lote. As escritas usam transações `IMMEDIATE` do SQLite e um `UPDATE` condicional que impede saldo negativo.

### Porções

- Porções possíveis = menor valor de `floor(saldo válido ÷ quantidade por porção)` entre os ingredientes da ficha técnica, em divisão inteira exata.
- O preparo confere todos os ingredientes antes de baixar qualquer lote; se algum faltar, nada é alterado (HTTP 409).

### Mínimo e alertas

- Item com saldo válido **igual ou menor** que o mínimo é marcado como `Baixo` (mantém a regra original). Mínimo `0` desativa o alerta, exceto o de sem estoque.
- Entrada sem mínimo informado mantém o mínimo atual; mínimo `0` explícito é aplicado.
- O campo `status` mantém os valores originais (`Baixo`, `Vence em breve`, `Em dia`); `alerts` traz a lista completa (`vencido`, `vence_hoje`, `sem_estoque`, `abaixo_do_minimo`, `vence_em_breve`).

### Auditoria

- Toda alteração de saldo gera uma movimentação: `entrada`, `preparo`, `perda` ou `ajuste`, com quantidade com sinal (`delta`), descrição e lotes afetados.
- Gatilhos no banco impedem `UPDATE` e `DELETE` em `movements` e `movement_lots`.
- Ajustes exigem motivo; aumento de saldo por ajuste cria um lote e exige validade.

## API

Respostas em JSON (inclusive erros: `{ "error": "mensagem" }`). Escritas exigem `Content-Type: application/json`.

| Método  | Rota                        | Descrição                                                                                           |
| ------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/health`               | Saúde (consulta o banco) e versão.                                                                  |
| `GET`   | `/api/summary`              | Inventário, receitas, últimas 12 movimentações e indicadores.                                       |
| `POST`  | `/api/lots`                 | Entrada de lote: `{ "name", "quantity", "unit", "expiresOn", "minimum"? }`.                         |
| `POST`  | `/api/lots/:id/discard`     | Descarta o saldo de um lote como perda: `{ "reason"? }`.                                            |
| `GET`   | `/api/ingredients`          | Inventário (mesmo formato de `summary.inventory`).                                                  |
| `GET`   | `/api/ingredients/:id/lots` | Lotes com saldo e situação da validade.                                                             |
| `PATCH` | `/api/ingredients/:id`      | Atualiza o mínimo: `{ "minimum", "unit"? }`.                                                        |
| `GET`   | `/api/recipes`              | Receitas com porções possíveis.                                                                     |
| `POST`  | `/api/recipes`              | Cria receita: `{ "name", "items": [{ "name" ou "ingredientId", "quantity", "unit"? }] }`.           |
| `POST`  | `/api/recipes/:id/prepare`  | Registra preparo: `{ "portions" }` (1 a 500).                                                       |
| `POST`  | `/api/waste`                | Perda: `{ "ingredientId", "quantity", "unit"?, "reason"? }`.                                        |
| `POST`  | `/api/adjustments`          | Ajuste: `{ "ingredientId", "counted" ou "quantity" (com sinal), "unit"?, "reason", "expiresOn"? }`. |
| `GET`   | `/api/movements`            | Histórico: `?limit=50&ingredientId=&kind=&before=` (paginação por id).                              |
| `GET`   | `/api/export/inventory.csv` | Inventário em CSV (UTF-8 com BOM).                                                                  |

Códigos: `400` dado inválido, `404` não encontrado, `409` conflito com o estoque atual (saldo insuficiente, nome repetido), `413` corpo grande demais, `415` corpo que não é JSON, `429` limite de escritas.

```bash
curl -X POST localhost:3002/api/lots -H 'Content-Type: application/json' \
  -d '{"name":"Tomate","quantity":"500","unit":"g","expiresOn":"2026-11-02"}'
```

## Executar localmente

Requer Node.js 20 ou superior (`.nvmrc` aponta para 22).

```bash
npm install
npm start
```

Abra <http://localhost:3002>. Fora de produção, a primeira execução cria dados fictícios para explorar o painel. O banco fica em `data/estoque.sqlite` (não versionado).

### Variáveis de ambiente

Validadas no boot (valor inválido derruba o processo com mensagem clara). Modelo em `.env.example`.

| Variável                | Padrão                    | Descrição                                                    |
| ----------------------- | ------------------------- | ------------------------------------------------------------ |
| `PORT`                  | `3002`                    | Porta HTTP.                                                  |
| `DATABASE_PATH`         | `data/estoque.sqlite`     | Caminho do banco SQLite.                                     |
| `LOG_LEVEL`             | `info`                    | `debug`, `info`, `warn`, `error` ou `silent`.                |
| `APP_TIMEZONE`          | `America/Sao_Paulo`       | Fuso IANA que define "hoje" para validades.                  |
| `EXPIRY_WARNING_DAYS`   | `3`                       | Janela do alerta "vence em breve" (0 a 60).                  |
| `TRUST_PROXY`           | `0`                       | Saltos de proxy confiáveis; `1` atrás de Nginx/Fly/Render.   |
| `RATE_LIMIT_PER_MINUTE` | `120`                     | Escritas por IP por minuto na API; `0` desativa.             |
| `SEED_DEMO_DATA`        | `true` (fora de produção) | Cria dados fictícios se o banco estiver vazio.               |
| `BASIC_AUTH_USER`       | —                         | Com `BASIC_AUTH_PASSWORD`, exige login HTTP Basic no painel. |
| `BASIC_AUTH_PASSWORD`   | —                         | Mínimo de 12 caracteres. `/api/health` continua aberto.      |
| `BACKUP_KEEP`           | `14`                      | Quantidade de backups mantidos por `npm run backup`.         |

### Scripts

```bash
npm run dev           # servidor com recarga automática
npm test              # testes de domínio, API, migração, infra e servidor real (node:test)
npm run lint          # ESLint
npm run format        # Prettier (format:check só confere)
npm run check         # lint + formatação + testes (o mesmo que roda no CI)
npm run backup        # backup online do SQLite com retenção
```

## Estrutura

```
server.js            # ponto de entrada: config, logger, banco, dados de demonstração, HTTP e shutdown gracioso
src/
  app.js             # createApp(db, options): composição do Express
  config.js          # variáveis de ambiente validadas
  logger.js          # logger JSON com request id e redação de segredos
  db.js              # conexão SQLite e migrações versionadas (PRAGMA user_version)
  store.js           # acesso a dados e transações (toda a SQL fica aqui)
  seed.js            # dados de demonstração
  domain/            # regras puras, sem I/O: unidades, datas, FEFO, porções, situação do item
  http/              # erros, segurança (CSP), autenticação, request id/log, rate limit, validação e apresentação
  routes/            # inventário/lotes, receitas e movimentações
public/              # frontend estático (HTML, CSS com tokens claro/escuro, JS sem framework)
scripts/backup.js    # backup online do SQLite
test/                # domínio, API, migração, infra e servidor real
```

## Arquitetura

- **Domínio puro** (`src/domain`): conversão de unidades, datas civis, planejamento FEFO e porções — funções sem banco nem HTTP, testadas isoladamente.
- **Store** (`src/store.js`): consultas preparadas e operações transacionais (entrada, preparo, perda, descarte, ajuste). Recebe e devolve inteiros na menor unidade.
- **HTTP** (`src/http`, `src/routes`): valida a entrada, chama o store e converte para o formato público em `http/present.js`. Erros de regra viram `400`/`409`; falhas inesperadas viram `500` genérico com detalhes só no log.
- **Relógio injetável**: `createApp(db, { now, timeZone })` permite testar vencimentos sem depender da data real.
- **Migrações**: a v1 descreve o esquema original; a v2 converte bancos existentes de `REAL` para inteiros preservando ids, lotes, receitas e histórico, e valida as chaves estrangeiras antes de gravar a nova versão.

## Produção

### Docker

```bash
docker compose up --build    # http://localhost:3002, dados no volume estoquecerto-data
```

A imagem roda como usuário sem privilégios, guarda o banco em `/data` (volume) e tem `HEALTHCHECK` em `/api/health`. Em produção (`NODE_ENV=production`) não há dados de demonstração; defina `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` e sirva atrás de HTTPS (proxy reverso com `TRUST_PROXY=1`).

### Backups

`npm run backup` usa a API de backup online do SQLite (cópia consistente com o app no ar), confere a integridade da cópia e mantém os `BACKUP_KEEP` mais recentes em `data/backups/`. Agende via cron e copie o diretório para um storage externo. No container: `docker compose exec app node scripts/backup.js /data/backups`.

### Observabilidade

- Logs em JSON, uma linha por evento, com `requestId` (propaga `X-Request-Id` válido ou gera um UUID, devolvido na resposta). Query strings não vão para o log e campos sensíveis (senha, token, authorization) são redigidos.
- `GET /api/health` verifica o banco e retorna a versão em execução.

### Segurança

- Content-Security-Policy sem `unsafe-inline`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- O frontend monta o DOM com `textContent` (sem `innerHTML` com dados).
- Escritas exigem JSON (bloqueia CSRF por formulário de outro site) e têm limite por IP.
- Autenticação HTTP Basic opcional, com comparação em tempo constante.

### CI/CD

Cada push e PR roda lint, formatação e testes em Node 20 e 22, constrói a imagem Docker e faz smoke test do container. O Dependabot abre PRs semanais de npm e mensais de actions e imagem base.

## Compatibilidade

- Bancos criados pela versão anterior são migrados automaticamente no primeiro boot (faça um backup antes, por precaução).
- Contratos da API foram mantidos; campos novos são aditivos. `wasteTotal` continua no resumo, mas soma unidades diferentes — use `losses` (por unidade, últimos 30 dias).
- O CSV ganhou a coluna `expired` ao final e a data no nome do arquivo.

## Limitações

- Usuário único: a autenticação Basic protege o painel, mas não há perfis nem trilha por pessoa.
- SQLite exige **uma única instância** com volume persistente; o rate limit é em memória.
- Receitas ainda não podem ser editadas ou excluídas pela interface.
- Não há conversão entre dimensões (ex.: "1 un de ovo = 50 g") nem custo por lote.
- Sem modo offline.
