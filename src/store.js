'use strict';

const { nameKey } = require('./db');
const { planConsumption, availableQuantity } = require('./domain/fefo');
const { ConflictError } = require('./domain/errors');

// Mesmo formato de CURRENT_TIMESTAMP do SQLite (UTC), para manter o histórico homogêneo.
const sqlTimestamp = date => date.toISOString().replace('T', ' ').slice(0, 19);

/**
 * Acesso a dados. Toda a SQL fica aqui; quantidades entram e saem como inteiros
 * na menor unidade. Escritas rodam em transação IMMEDIATE (trava de escrita desde
 * o início, sem corrida entre ler o saldo e baixar os lotes).
 */
function createStore(db, { now = () => new Date() } = {}) {
  const sql = {
    ingredientById: db.prepare('SELECT id, name, unit, minimum_base AS minimum FROM ingredients WHERE id = ?'),
    ingredientByKey: db.prepare('SELECT id, name, unit, minimum_base AS minimum FROM ingredients WHERE name_key = ?'),
    insertIngredient: db.prepare('INSERT INTO ingredients (name, name_key, unit, minimum_base, created_at) VALUES (?, ?, ?, ?, ?)'),
    updateMinimum: db.prepare('UPDATE ingredients SET minimum_base = ? WHERE id = ?'),
    countIngredients: db.prepare('SELECT COUNT(*) FROM ingredients').pluck(),

    // Saldo disponível exclui lotes vencidos; o vencido aparece à parte, para descarte.
    inventory: db.prepare(`SELECT i.id, i.name, i.unit, i.minimum_base AS minimum,
        COALESCE(SUM(CASE WHEN l.expires_on >= @today THEN l.quantity_base END), 0) AS available,
        COALESCE(SUM(CASE WHEN l.expires_on < @today THEN l.quantity_base END), 0) AS expired,
        MIN(CASE WHEN l.expires_on >= @today THEN l.expires_on END) AS nextExpiry,
        COUNT(l.id) AS lotCount
      FROM ingredients i LEFT JOIN lots l ON l.ingredient_id = i.id AND l.quantity_base > 0
      GROUP BY i.id`),

    lotsOf: db.prepare(`SELECT id, quantity_base AS quantity, received_base AS received, expires_on AS expiresOn, created_at AS createdAt
      FROM lots WHERE ingredient_id = ? AND quantity_base > 0 ORDER BY expires_on, id`),
    lotById: db.prepare(
      `SELECT id, ingredient_id AS ingredientId, quantity_base AS quantity, expires_on AS expiresOn FROM lots WHERE id = ?`,
    ),
    insertLot: db.prepare('INSERT INTO lots (ingredient_id, quantity_base, received_base, expires_on, created_at) VALUES (?, ?, ?, ?, ?)'),
    takeFromLot: db.prepare('UPDATE lots SET quantity_base = quantity_base - @quantity WHERE id = @lotId AND quantity_base >= @quantity'),
    expiringLots: db.prepare('SELECT COUNT(*) FROM lots WHERE quantity_base > 0 AND expires_on BETWEEN ? AND ?').pluck(),
    expiredLots: db.prepare('SELECT COUNT(*) FROM lots WHERE quantity_base > 0 AND expires_on < ?').pluck(),

    recipes: db.prepare('SELECT id, name FROM recipes ORDER BY name_key'),
    recipeById: db.prepare('SELECT id, name FROM recipes WHERE id = ?'),
    recipeByKey: db.prepare('SELECT id FROM recipes WHERE name_key = ?'),
    insertRecipe: db.prepare('INSERT INTO recipes (name, name_key, created_at) VALUES (?, ?, ?)'),
    insertRecipeItem: db.prepare('INSERT INTO recipe_items (recipe_id, ingredient_id, quantity_base) VALUES (?, ?, ?)'),
    recipeItems: db.prepare(`SELECT ri.recipe_id AS recipeId, i.id AS ingredientId, i.name, i.unit, ri.quantity_base AS perPortion,
        COALESCE((SELECT SUM(l.quantity_base) FROM lots l WHERE l.ingredient_id = i.id AND l.expires_on >= @today), 0) AS available
      FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id
      WHERE @recipeId IS NULL OR ri.recipe_id = @recipeId
      ORDER BY i.name_key`),

    insertMovement: db.prepare(`INSERT INTO movements (ingredient_id, kind, delta_base, description, recipe_id, created_at)
      VALUES (@ingredientId, @kind, @delta, @description, @recipeId, @createdAt)`),
    insertMovementLot: db.prepare('INSERT INTO movement_lots (movement_id, lot_id, delta_base) VALUES (?, ?, ?)'),
    movements: db.prepare(`SELECT m.id, m.ingredient_id AS ingredientId, i.name, i.unit, m.kind, m.delta_base AS delta,
        m.description, m.recipe_id AS recipeId, m.created_at AS createdAt
      FROM movements m JOIN ingredients i ON i.id = m.ingredient_id
      WHERE (@ingredientId IS NULL OR m.ingredient_id = @ingredientId) AND (@kind IS NULL OR m.kind = @kind)
        AND (@before IS NULL OR m.id < @before)
      ORDER BY m.id DESC LIMIT @limit`),
    movementLots: db.prepare(`SELECT ml.movement_id AS movementId, ml.lot_id AS lotId, ml.delta_base AS delta, l.expires_on AS expiresOn
      FROM movement_lots ml JOIN lots l ON l.id = ml.lot_id
      WHERE ml.movement_id IN (SELECT value FROM json_each(?)) ORDER BY l.expires_on, l.id`),
    // Soma por unidade de exibição: kg e un não podem ser somados entre si.
    lossesSince: db.prepare(`SELECT i.unit, COUNT(*) AS count, -SUM(m.delta_base) AS quantity
      FROM movements m JOIN ingredients i ON i.id = m.ingredient_id
      WHERE m.kind = 'perda' AND m.created_at >= ? GROUP BY i.unit ORDER BY i.unit`),
    lossesTotalLegacy:
      db.prepare(`SELECT i.unit, -SUM(m.delta_base) AS quantity FROM movements m JOIN ingredients i ON i.id = m.ingredient_id
      WHERE m.kind = 'perda' GROUP BY i.unit`),
  };

  const stamp = () => sqlTimestamp(now());

  function writeMovement({ ingredientId, kind, delta, description, recipeId = null, lots = [] }) {
    const id = Number(sql.insertMovement.run({ ingredientId, kind, delta, description, recipeId, createdAt: stamp() }).lastInsertRowid);
    for (const lot of lots) sql.insertMovementLot.run(id, lot.lotId, lot.delta);
    return id;
  }

  /** Baixa FEFO registrando quanto saiu de cada lote. */
  function consume({ ingredientId, quantity, kind, description, today, includeExpired = false, recipeId = null }) {
    const plan = planConsumption(sql.lotsOf.all(ingredientId), quantity, { today, includeExpired });
    for (const step of plan) {
      // Guarda contra saldo negativo mesmo que o plano esteja desatualizado.
      if (sql.takeFromLot.run(step).changes !== 1) throw new ConflictError('Estoque alterado durante a operação; tente de novo.');
    }
    return writeMovement({
      ingredientId,
      kind,
      delta: -quantity,
      description,
      recipeId,
      lots: plan.map(step => ({ lotId: step.lotId, delta: -step.quantity })),
    });
  }

  function addLot({ ingredientId, quantity, expiresOn, kind, description }) {
    const lotId = Number(sql.insertLot.run(ingredientId, quantity, quantity, expiresOn, stamp()).lastInsertRowid);
    const movementId = writeMovement({ ingredientId, kind, delta: quantity, description, lots: [{ lotId, delta: quantity }] });
    return { lotId, movementId };
  }

  const recipeItemsOf = (recipeId, today) => sql.recipeItems.all({ recipeId, today });

  return {
    countIngredients: () => sql.countIngredients.get(),
    getIngredient: id => sql.ingredientById.get(id),
    findIngredientByName: name => sql.ingredientByKey.get(nameKey(name)),
    inventory: today => sql.inventory.all({ today }),
    lotsOf: id => sql.lotsOf.all(id),
    getLot: id => sql.lotById.get(id),
    expiringLotCount: (today, until) => sql.expiringLots.get(today, until),
    expiredLotCount: today => sql.expiredLots.get(today),

    /** Entrada: cria o ingrediente se preciso, atualiza o mínimo se informado e abre um lote. */
    receiveLot: db.transaction(({ name, unit, minimum, quantity, expiresOn, describe }) => {
      let ingredient = sql.ingredientByKey.get(nameKey(name));
      if (!ingredient) {
        const id = Number(sql.insertIngredient.run(name, nameKey(name), unit, minimum ?? 0, stamp()).lastInsertRowid);
        ingredient = sql.ingredientById.get(id);
      } else if (minimum !== undefined) {
        sql.updateMinimum.run(minimum, ingredient.id);
      }
      const { lotId } = addLot({ ingredientId: ingredient.id, quantity, expiresOn, kind: 'entrada', description: describe(ingredient) });
      return { ingredient: sql.ingredientById.get(ingredient.id), lotId };
    }).immediate,

    setMinimum: (id, minimum) => sql.updateMinimum.run(minimum, id).changes > 0,

    recipes(today) {
      const items = new Map();
      for (const item of recipeItemsOf(null, today)) {
        if (!items.has(item.recipeId)) items.set(item.recipeId, []);
        items.get(item.recipeId).push(item);
      }
      return sql.recipes.all().map(recipe => ({ ...recipe, items: items.get(recipe.id) || [] }));
    },
    getRecipe: (id, today) => {
      const recipe = sql.recipeById.get(id);
      return recipe && { ...recipe, items: recipeItemsOf(id, today) };
    },

    createRecipe: db.transaction((name, items) => {
      if (sql.recipeByKey.get(nameKey(name))) throw new ConflictError('Já existe uma receita com esse nome.');
      const id = Number(sql.insertRecipe.run(name, nameKey(name), stamp()).lastInsertRowid);
      for (const item of items) sql.insertRecipeItem.run(id, item.ingredientId, item.quantity);
      return id;
    }).immediate,

    /** Preparo: confere todos os ingredientes antes de baixar qualquer lote. */
    prepare: db.transaction(({ recipe, needs, today, description }) => {
      for (const need of needs) {
        if (availableQuantity(sql.lotsOf.all(need.ingredientId), today) < need.quantity) {
          throw new ConflictError('Não há ingredientes suficientes para essa quantidade de porções.');
        }
      }
      return needs.map(need => consume({ ...need, kind: 'preparo', description, today, recipeId: recipe.id }));
    }).immediate,

    registerLoss: db.transaction(({ ingredientId, quantity, description, today }) =>
      consume({ ingredientId, quantity, kind: 'perda', description, today, includeExpired: true }),
    ).immediate,

    /** Descarta todo o saldo de um lote (ex.: vencido) como perda. */
    discardLot: db.transaction(({ lot, description }) => {
      if (sql.takeFromLot.run({ lotId: lot.id, quantity: lot.quantity }).changes !== 1) {
        throw new ConflictError('O lote mudou durante a operação; atualize e tente de novo.');
      }
      return writeMovement({
        ingredientId: lot.ingredientId,
        kind: 'perda',
        delta: -lot.quantity,
        description,
        lots: [{ lotId: lot.id, delta: -lot.quantity }],
      });
    }).immediate,

    /** Ajuste de inventário: positivo abre lote; negativo baixa FEFO só de lotes válidos. */
    adjust: db.transaction(({ ingredientId, delta, counted, expiresOn, description, today }) => {
      const change = counted === undefined ? delta : counted - availableQuantity(sql.lotsOf.all(ingredientId), today);
      if (change === 0) throw new ConflictError('O saldo informado já é o saldo atual; nada a ajustar.');
      if (change > 0) {
        if (!expiresOn) throw new ConflictError('Para aumentar o saldo, informe a validade do lote ajustado.');
        return { delta: change, movementId: addLot({ ingredientId, quantity: change, expiresOn, kind: 'ajuste', description }).movementId };
      }
      return { delta: change, movementId: consume({ ingredientId, quantity: -change, kind: 'ajuste', description, today }) };
    }).immediate,

    movements({ limit = 12, ingredientId = null, kind = null, before = null } = {}) {
      const rows = sql.movements.all({ limit, ingredientId, kind, before });
      const lots = new Map();
      for (const row of sql.movementLots.all(JSON.stringify(rows.map(r => r.id)))) {
        if (!lots.has(row.movementId)) lots.set(row.movementId, []);
        lots.get(row.movementId).push({ lotId: row.lotId, delta: row.delta, expiresOn: row.expiresOn });
      }
      return rows.map(row => ({ ...row, lots: lots.get(row.id) || [] }));
    },
    lossesSince: since => sql.lossesSince.all(sqlTimestamp(since)),
    lossesTotalByUnit: () => sql.lossesTotalLegacy.all(),
  };
}

module.exports = { createStore, sqlTimestamp };
