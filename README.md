# EstoqueCerto

Painel de estoque para pequenos restaurantes. Acompanha lotes e validade, sinaliza itens abaixo do mínimo e calcula quantas porções podem ser preparadas com o saldo atual.

## Rodar localmente

Requer Node.js 20 ou superior.

```bash
npm install
npm start
```

Abra <http://localhost:3002>. A primeira execução cria dados fictícios para explorar o painel; o banco SQLite fica em `data/estoque.sqlite` e não é versionado.

## Funcionalidades

- Estoque agregado por ingrediente e lote com validade.
- Alertas de estoque mínimo e lotes próximos do vencimento.
- Receitas com ingredientes e consumo por porção.
- Planejamento de porções possíveis e baixa de ingredientes ao preparar.
- Registro de perdas e histórico recente de movimentações.

## Decisões técnicas

- O preparo usa transação SQLite: valida todos os ingredientes antes de baixar qualquer lote.
- As baixas consomem primeiro o lote que vence antes (FEFO).
- Movimentações são registradas como entrada, preparo ou perda para manter o histórico auditável.
- Dados de demonstração são fictícios; não há autenticação nesta versão.

## API

- `GET /api/summary` — inventário, alertas, receitas e histórico.
- `POST /api/lots` — recebe lote de ingrediente.
- `POST /api/recipes` — cria receita.
- `POST /api/recipes/:id/prepare` — registra preparo e baixa do estoque.
- `POST /api/waste` — registra perda.

## Próximas melhorias

Autenticação e perfis de equipe, conversões entre unidades, exportação de relatórios e previsão de compras baseada no histórico de consumo.
