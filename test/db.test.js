'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrate, SCHEMA_VERSION } = require('../src/db');
const { createStore } = require('../src/store');

// Esquema e dados exatamente como a versão anterior gravava (REAL, sem user_version).
function legacyDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE ingredients(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,unit TEXT NOT NULL,minimum REAL NOT NULL DEFAULT 0);
    CREATE TABLE lots(id INTEGER PRIMARY KEY,ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),quantity REAL NOT NULL CHECK(quantity>=0),expires_on TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE recipes(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE recipe_items(recipe_id INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),quantity REAL NOT NULL CHECK(quantity>0),PRIMARY KEY(recipe_id,ingredient_id));
    CREATE TABLE movements(id INTEGER PRIMARY KEY,ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),kind TEXT NOT NULL CHECK(kind IN ('entrada','preparo','perda')),quantity REAL NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO ingredients VALUES (1,'Tomate','kg',3),(2,'Alface','un',4),(3,'Leite','L',0.5),(4,'FEIJÃO','kg',2),(5,'feijão','kg',1);
    -- 2.3 em float é 2.2999999999999998: a migração arredonda para o inteiro exato.
    INSERT INTO lots VALUES (1,1,2.3,'2026-03-12','2026-03-01 10:00:00'),(2,1,0.1,'2026-03-20','2026-03-01 10:00:00'),(3,2,6,'2026-03-11','2026-03-01 10:00:00'),(4,3,1.25,'2026-03-15','2026-03-01 10:00:00');
    INSERT INTO recipes VALUES (1,'Bowl','2026-03-01 10:00:00');
    INSERT INTO recipe_items VALUES (1,1,0.2),(1,2,1);
    INSERT INTO movements VALUES (1,1,'entrada',2.5,'Entrada','2026-03-01 10:00:00'),(2,1,'preparo',0.2,'Preparo: Bowl · 1 porções','2026-03-02 10:00:00'),(3,2,'perda',1,'Perda','2026-03-02 11:00:00');
  `);
  return db;
}

test('migra banco legado (REAL) para inteiros preservando ids, saldos e histórico', () => {
  const db = legacyDatabase();
  migrate(db);
  migrate(db); // idempotente
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  assert.deepEqual(db.pragma('foreign_key_check'), []);

  const lots = db.prepare('SELECT id, quantity_base AS q FROM lots ORDER BY id').all();
  assert.deepEqual(
    lots.map(l => l.q),
    [2_300_000, 100_000, 6_000, 1_250],
  );
  assert.deepEqual(
    db
      .prepare('SELECT unit, minimum_base AS m FROM ingredients ORDER BY id')
      .all()
      .map(r => [r.unit, r.m]),
    [
      ['kg', 3_000_000],
      ['un', 4_000],
      ['L', 500],
      ['kg', 2_000_000],
      ['kg', 1_000_000],
    ],
  );
  // Chaves distintas mesmo para nomes que só diferem em maiúsculas acentuadas.
  const keys = db.prepare('SELECT name_key FROM ingredients WHERE id IN (4, 5) ORDER BY id').pluck().all();
  assert.equal(new Set(keys).size, 2);

  const store = createStore(db);
  const [recipe] = store.recipes('2026-03-10');
  assert.deepEqual(
    recipe.items.map(i => [i.name, i.perPortion]),
    [
      ['Alface', 1_000],
      ['Tomate', 200_000],
    ],
  );
  assert.deepEqual(
    store.movements({ limit: 10 }).map(m => [m.kind, m.delta]),
    [
      ['perda', -1_000],
      ['preparo', -200_000],
      ['entrada', 2_500_000],
    ],
  );
  // Novo tipo de movimentação disponível após a migração.
  store.adjust({ ingredientId: 1, delta: -100_000, description: 'Ajuste: contagem', today: '2026-03-10' });
  assert.equal(store.lotsOf(1)[0].quantity, 2_200_000);
});

test('banco novo nasce na versão atual com o esquema inteiro', () => {
  const db = new Database(':memory:');
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  const columns = db.prepare("SELECT name FROM pragma_table_info('lots')").pluck().all();
  assert.ok(columns.includes('quantity_base'));
  assert.ok(!columns.includes('quantity'));
});
