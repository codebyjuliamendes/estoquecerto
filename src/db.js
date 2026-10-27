'use strict';

const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');
const { getUnit, displayUnitOf } = require('./domain/units');

const nameKey = name => name.normalize('NFC').toLocaleLowerCase('pt-BR');

// v1: esquema original (quantidades REAL na unidade do ingrediente). Bancos
// anteriores às migrações já têm essas tabelas e entram com user_version = 0.
const legacySchema = `
  CREATE TABLE IF NOT EXISTS ingredients(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, unit TEXT NOT NULL, minimum REAL NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS lots(id INTEGER PRIMARY KEY, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL CHECK(quantity>=0), expires_on TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS recipes(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS recipe_items(recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), quantity REAL NOT NULL CHECK(quantity>0), PRIMARY KEY(recipe_id, ingredient_id));
  CREATE TABLE IF NOT EXISTS movements(id INTEGER PRIMARY KEY, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), kind TEXT NOT NULL CHECK(kind IN ('entrada','preparo','perda')), quantity REAL NOT NULL, description TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`;

// v2: quantidades inteiras na menor unidade (mg, ml, milésimo de un), chave de
// nome sem diferenciar maiúsculas (inclusive acentuadas), ajuste como movimento,
// rastreio de lotes por movimentação e movimentações imutáveis.
const integerSchema = `
  CREATE TABLE ingredients (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    unit TEXT NOT NULL CHECK (unit IN ('kg', 'L', 'un')),
    minimum_base INTEGER NOT NULL DEFAULT 0 CHECK (minimum_base >= 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE lots (
    id INTEGER PRIMARY KEY,
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
    quantity_base INTEGER NOT NULL CHECK (quantity_base >= 0),
    received_base INTEGER NOT NULL CHECK (received_base >= 0),
    expires_on TEXT NOT NULL CHECK (expires_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_lots_ingredient_expiry ON lots(ingredient_id, expires_on);
  CREATE TABLE recipes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE recipe_items (
    recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
    quantity_base INTEGER NOT NULL CHECK (quantity_base > 0),
    PRIMARY KEY (recipe_id, ingredient_id)
  );
  CREATE INDEX idx_recipe_items_ingredient ON recipe_items(ingredient_id);
  CREATE TABLE movements (
    id INTEGER PRIMARY KEY,
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
    kind TEXT NOT NULL CHECK (kind IN ('entrada', 'preparo', 'perda', 'ajuste')),
    delta_base INTEGER NOT NULL,
    description TEXT NOT NULL,
    recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_movements_ingredient ON movements(ingredient_id, id);
  CREATE INDEX idx_movements_kind_created ON movements(kind, created_at);
  CREATE TABLE movement_lots (
    movement_id INTEGER NOT NULL REFERENCES movements(id),
    lot_id INTEGER NOT NULL REFERENCES lots(id),
    delta_base INTEGER NOT NULL,
    PRIMARY KEY (movement_id, lot_id)
  );
  CREATE INDEX idx_movement_lots_lot ON movement_lots(lot_id);
  CREATE TRIGGER movements_immutable_update BEFORE UPDATE ON movements BEGIN SELECT RAISE(ABORT, 'movimentações são imutáveis'); END;
  CREATE TRIGGER movements_immutable_delete BEFORE DELETE ON movements BEGIN SELECT RAISE(ABORT, 'movimentações são imutáveis'); END;
  CREATE TRIGGER movement_lots_immutable_update BEFORE UPDATE ON movement_lots BEGIN SELECT RAISE(ABORT, 'movimentações são imutáveis'); END;
  CREATE TRIGGER movement_lots_immutable_delete BEFORE DELETE ON movement_lots BEGIN SELECT RAISE(ABORT, 'movimentações são imutáveis'); END;`;

/** Converte o esquema v1 (REAL) para v2 (inteiros), preservando ids e histórico. */
function migrateToIntegerQuantities(db) {
  for (const table of ['movements', 'recipe_items', 'lots', 'recipes', 'ingredients'])
    db.exec(`ALTER TABLE ${table} RENAME TO legacy_${table}`);
  db.exec(integerSchema);

  // Unidade legada -> unidade de exibição da dimensão + fator para a menor unidade.
  // Unidades desconhecidas (só possíveis por edição manual do banco) viram "un".
  const factors = new Map();
  const usedKeys = new Set();
  const insertIngredient = db.prepare('INSERT INTO ingredients (id, name, name_key, unit, minimum_base) VALUES (?, ?, ?, ?, ?)');
  for (const row of db.prepare('SELECT id, name, unit, minimum FROM legacy_ingredients ORDER BY id').all()) {
    const unit = getUnit(row.unit) || getUnit('un');
    factors.set(row.id, 10 ** unit.scale);
    let key = nameKey(row.name);
    // NOCASE só ignora maiúsculas ASCII; "FEIJÃO" e "feijão" podiam coexistir.
    if (usedKeys.has(key)) key = `${key}#${row.id}`;
    usedKeys.add(key);
    insertIngredient.run(row.id, row.name, key, displayUnitOf(unit.dimension), Math.max(0, Math.round(row.minimum * factors.get(row.id))));
  }
  const toBase = (ingredientId, quantity) => Math.round(quantity * factors.get(ingredientId));

  const insertLot = db.prepare(
    'INSERT INTO lots (id, ingredient_id, quantity_base, received_base, expires_on, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const lot of db.prepare('SELECT * FROM legacy_lots ORDER BY id').all()) {
    const quantity = Math.max(0, toBase(lot.ingredient_id, lot.quantity));
    insertLot.run(lot.id, lot.ingredient_id, quantity, quantity, lot.expires_on, lot.created_at);
  }

  const recipeKeys = new Set();
  const insertRecipe = db.prepare('INSERT INTO recipes (id, name, name_key, created_at) VALUES (?, ?, ?, ?)');
  for (const recipe of db.prepare('SELECT * FROM legacy_recipes ORDER BY id').all()) {
    let key = nameKey(recipe.name);
    if (recipeKeys.has(key)) key = `${key}#${recipe.id}`;
    recipeKeys.add(key);
    insertRecipe.run(recipe.id, recipe.name, key, recipe.created_at);
  }

  const insertItem = db.prepare('INSERT INTO recipe_items (recipe_id, ingredient_id, quantity_base) VALUES (?, ?, ?)');
  for (const item of db.prepare('SELECT * FROM legacy_recipe_items').all()) {
    insertItem.run(item.recipe_id, item.ingredient_id, Math.max(1, toBase(item.ingredient_id, item.quantity)));
  }

  // Legado guardava a quantidade sem sinal; entrada soma, preparo e perda subtraem.
  const insertMovement = db.prepare(
    'INSERT INTO movements (id, ingredient_id, kind, delta_base, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const m of db.prepare('SELECT * FROM legacy_movements ORDER BY id').all()) {
    const magnitude = Math.abs(toBase(m.ingredient_id, m.quantity));
    insertMovement.run(m.id, m.ingredient_id, m.kind, m.kind === 'entrada' ? magnitude : -magnitude, m.description, m.created_at);
  }

  for (const table of ['movements', 'recipe_items', 'lots', 'recipes', 'ingredients']) db.exec(`DROP TABLE legacy_${table}`);
}

// Cada migração roda uma única vez, em ordem, controlada por PRAGMA user_version.
// Nunca altere uma migração já publicada: adicione uma nova ao final da lista.
const migrations = [legacySchema, migrateToIntegerQuantities];

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let version = current; version < migrations.length; version++) {
    db.transaction(() => {
      const step = migrations[version];
      if (typeof step === 'function') step(db);
      else db.exec(step);
      const broken = db.pragma('foreign_key_check');
      if (broken.length) throw new Error(`Migração ${version + 1} deixou chaves estrangeiras inválidas: ${JSON.stringify(broken[0])}`);
      db.pragma(`user_version = ${version + 1}`);
    }).immediate();
  }
}

function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

module.exports = { openDatabase, migrate, nameKey, SCHEMA_VERSION: migrations.length };
