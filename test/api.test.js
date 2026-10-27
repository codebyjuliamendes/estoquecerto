'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

// Relógio controlado: 10/03/2026 12h em São Paulo.
let clock = new Date('2026-03-10T15:00:00Z');
const setClock = iso => (clock = new Date(iso));
let server, baseUrl, db;

test.before(async () => {
  db = openDatabase(':memory:');
  server = createApp(db, { now: () => clock }).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => setClock('2026-03-10T15:00:00Z'));

async function request(method, url, body, headers = {}) {
  const response = await fetch(baseUrl + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : body && JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // CSV e outros formatos seguem como texto
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

const post = (url, body) => request('POST', url, body);
const summary = async () => (await request('GET', '/api/summary')).body;
const item = async name => (await summary()).inventory.find(i => i.name === name);

let seq = 0;
async function receive(name, quantity, unit, expiresOn, extra = {}) {
  const res = await post('/api/lots', { name, quantity, unit, expiresOn, ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}
const uniqueName = prefix => `${prefix} ${++seq}`;

test('health check responde ok com cabeçalhos de segurança', async () => {
  const { status, headers, body } = await request('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.match(headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  assert.equal(headers.get('cache-control'), 'no-store');
  const csp = headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(headers.get('x-powered-by'), null);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
});

test('entrada: converte unidades sem erro de ponto flutuante e mantém o mínimo', async () => {
  const name = uniqueName('Farinha');
  const first = await receive(name, '0.1', 'kg', '2026-04-01', { minimum: '0.5' });
  assert.equal(first.unit, 'kg');
  assert.equal(first.quantity, 0.1);
  const second = await receive(name, 200, 'g', '2026-04-02');
  assert.equal(second.quantity, 0.2);
  const row = await item(name);
  assert.equal(row.quantity, 0.3); // 0.1 + 0.2 em float daria 0.30000000000000004
  assert.equal(row.minimum, 0.5); // entrada sem mínimo não apaga o mínimo
  assert.equal(row.labels.quantity, '300 g');

  // Mínimo 0 explícito agora é aplicado (antes era ignorado).
  await receive(name, 1, 'kg', '2026-04-03', { minimum: 0 });
  assert.equal((await item(name)).minimum, 0);
  // Sem unidade: usa a do ingrediente.
  const noUnit = await receive(name, '1,5', undefined, '2026-04-03');
  assert.equal(noUnit.quantity, 1.5);
});

test('entrada: nome sem diferenciar maiúsculas/acentos maiúsculos reaproveita o ingrediente', async () => {
  await receive('Açúcar Mascavo', 1, 'kg', '2026-05-01');
  const again = await receive('AÇÚCAR   MASCAVO', 500, 'g', '2026-05-01');
  const inventory = (await summary()).inventory.filter(i => /a[çÇ]úcar mascavo/i.test(i.name));
  assert.equal(inventory.length, 1);
  assert.equal(again.ingredientId, inventory[0].id);
  assert.equal(inventory[0].quantity, 1.5);
});

test('entrada: valida unidade, quantidade, nome e validade', async () => {
  const name = uniqueName('Leite');
  await receive(name, 1, 'L', '2026-03-20');
  const cases = [
    [{ name, quantity: 1, unit: 'kg', expiresOn: '2026-03-20' }, /incompatível/],
    [{ name: 'X', quantity: 1, unit: 'kg', expiresOn: '2026-03-20' }, /entre 2 e 60/],
    [{ name, quantity: 0, unit: 'L', expiresOn: '2026-03-20' }, /maior que zero/],
    [{ name, quantity: -2, unit: 'L', expiresOn: '2026-03-20' }, /número/],
    [{ name, quantity: '0.5', unit: 'ml', expiresOn: '2026-03-20' }, /1 ml/],
    [{ name, quantity: 1, unit: 'xícara', expiresOn: '2026-03-20' }, /Unidade inválida/],
    [{ name, quantity: 1, unit: 'L', expiresOn: '2026-02-31' }, /validade válida/],
    [{ name, quantity: 1, unit: 'L', expiresOn: '2026-03-09' }, /já passou/],
    [{ name, quantity: 1, unit: 'L', expiresOn: '2099-01-01' }, /distante/],
    [{ name, quantity: 20000, unit: 'L', expiresOn: '2026-03-20' }, /máxima/],
  ];
  for (const [body, message] of cases) {
    const res = await post('/api/lots', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, message);
  }
  // Vence hoje ainda é aceito.
  await receive(name, 1, 'L', '2026-03-10');
});

test('lote vencido sai do saldo disponível, do cálculo de porções e do preparo', async () => {
  const name = uniqueName('Creme');
  await receive(name, 1, 'L', '2026-03-11');
  await receive(name, 500, 'ml', '2026-03-20');
  const recipe = await post('/api/recipes', { name: uniqueName('Molho'), items: [{ name, quantity: 500, unit: 'ml' }] });
  assert.equal(recipe.status, 201);
  const portionsOf = async () => (await summary()).recipes.find(r => r.id === recipe.body.id).portions;
  assert.equal(await portionsOf(), 3);

  setClock('2026-03-12T15:00:00Z'); // primeiro lote venceu ontem
  const row = await item(name);
  assert.equal(row.quantity, 0.5);
  assert.equal(row.expired, 1);
  assert.ok(row.alerts.includes('vencido'));
  assert.equal(await portionsOf(), 1);
  assert.equal((await summary()).expiredCount >= 1, true);

  const tooMany = await post(`/api/recipes/${recipe.body.id}/prepare`, { portions: 2 });
  assert.equal(tooMany.status, 409);
  assert.equal((await item(name)).quantity, 0.5); // nada foi baixado

  assert.equal((await post(`/api/recipes/${recipe.body.id}/prepare`, { portions: 1 })).status, 200);
  const after = await item(name);
  assert.equal(after.quantity, 0);
  assert.equal(after.expired, 1); // preparo não tocou no lote vencido
});

test('preparo: FEFO em transação, auditado por lote', async () => {
  const a = uniqueName('Batata');
  const b = uniqueName('Sal');
  const lateLot = await receive(a, 1, 'kg', '2026-03-30');
  const earlyLot = await receive(a, 1, 'kg', '2026-03-15');
  await receive(b, 10, 'g', '2026-12-01');
  const recipe = await post('/api/recipes', {
    name: uniqueName('Purê'),
    items: [
      { name: a, quantity: '0,3', unit: 'kg' },
      { name: b, quantity: 2, unit: 'g' },
    ],
  });
  assert.equal(recipe.status, 201);

  // Sal limita a 5 porções; 6 falha sem baixar a batata.
  assert.equal((await summary()).recipes.find(r => r.id === recipe.body.id).portions, 5);
  assert.equal((await post(`/api/recipes/${recipe.body.id}/prepare`, { portions: 6 })).status, 409);
  assert.equal((await item(a)).quantity, 2);

  const ok = await post(`/api/recipes/${recipe.body.id}/prepare`, { portions: 4 });
  assert.deepEqual(ok.body, { ok: true, portions: 4 });
  assert.equal((await item(a)).quantity, 0.8);
  assert.equal((await item(b)).labels.quantity, '2 g');

  const lots = (await request('GET', `/api/ingredients/${(await item(a)).id}/lots`)).body.lots;
  assert.deepEqual(
    lots.map(l => [l.id, l.quantity]),
    [
      [earlyLot.lotId, 0],
      [lateLot.lotId, 0.8],
    ].filter(([, q]) => q > 0),
  );

  const [movement] = (await request('GET', `/api/movements?ingredientId=${(await item(a)).id}&kind=preparo`)).body;
  assert.equal(movement.delta, -1.2);
  assert.equal(movement.quantity, 1.2);
  assert.match(movement.description, /4 porções/);
  assert.deepEqual(
    movement.lots.map(l => [l.lotId, l.delta]),
    [
      [earlyLot.lotId, -1],
      [lateLot.lotId, -0.2],
    ],
  );
});

test('preparo: valida porções e receita', async () => {
  for (const portions of [0, 1.5, 501, '2x', null]) {
    assert.equal((await post('/api/recipes/1/prepare', { portions })).status, 400, String(portions));
  }
  assert.equal((await post('/api/recipes/999999/prepare', { portions: 1 })).status, 404);
  assert.equal((await post('/api/recipes/abc/prepare', { portions: 1 })).status, 400);
});

test('receitas: nome único, ingredientes existentes, sem repetidos e unidades compatíveis', async () => {
  const name = uniqueName('Ovo');
  await receive(name, 12, 'un', '2026-03-25');
  const recipeName = uniqueName('Omelete');
  assert.equal((await post('/api/recipes', { name: recipeName, items: [{ name, quantity: 2 }] })).status, 201);
  const duplicate = await post('/api/recipes', { name: recipeName.toUpperCase(), items: [{ name, quantity: 2 }] });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /Já existe/);

  const repeated = await post('/api/recipes', {
    name: uniqueName('R'),
    items: [
      { name, quantity: 1 },
      { name: name.toLowerCase(), quantity: 1 },
    ],
  });
  assert.equal(repeated.status, 400);
  assert.match(repeated.body.error, /repetido/);

  const unknown = await post('/api/recipes', { name: uniqueName('R'), items: [{ name: 'Inexistente', quantity: 1 }] });
  assert.equal(unknown.status, 400);
  const wrongUnit = await post('/api/recipes', { name: uniqueName('R'), items: [{ name, quantity: 1, unit: 'kg' }] });
  assert.equal(wrongUnit.status, 400);
  assert.equal((await post('/api/recipes', { name: uniqueName('R'), items: [null] })).status, 400);
  assert.equal((await post('/api/recipes', { name: uniqueName('R'), items: [] })).status, 400);
  const byId = await post('/api/recipes', { name: uniqueName('R'), items: [{ ingredientId: (await item(name)).id, quantity: '0,5' }] });
  assert.equal(byId.status, 201);
});

test('perda: inclui lotes vencidos primeiro e respeita o saldo', async () => {
  const name = uniqueName('Peixe');
  await receive(name, 1, 'kg', '2026-03-11');
  await receive(name, 2, 'kg', '2026-03-14');
  setClock('2026-03-12T15:00:00Z');
  const id = (await item(name)).id;

  const loss = await post('/api/waste', { ingredientId: id, quantity: 1500, unit: 'g', reason: 'Validade\n<script>' });
  assert.equal(loss.status, 200);
  assert.equal(loss.body.quantity, 1.5);
  const row = await item(name);
  assert.equal(row.expired, 0);
  assert.equal(row.quantity, 1.5);
  const [movement] = (await request('GET', `/api/movements?ingredientId=${id}&kind=perda`)).body;
  assert.equal(movement.description, 'Validade <script> · 1.500 g');

  assert.equal((await post('/api/waste', { ingredientId: id, quantity: 2 })).status, 409);
  assert.equal((await post('/api/waste', { ingredientId: 999999, quantity: 1 })).status, 400);
  assert.equal((await post('/api/waste', { ingredientId: id, quantity: -1 })).status, 400);
  assert.equal((await post('/api/waste', { ingredientId: id, quantity: 1, reason: 'x'.repeat(200) })).status, 400);
});

test('descarte de lote vencido zera o lote e registra perda', async () => {
  const name = uniqueName('Iogurte');
  const lot = await receive(name, 6, 'un', '2026-03-11');
  setClock('2026-03-13T15:00:00Z');
  const res = await post(`/api/lots/${lot.lotId}/discard`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.quantity, 6);
  assert.equal((await item(name)).expired, 0);
  const [movement] = (await request('GET', `/api/movements?ingredientId=${lot.ingredientId}`)).body;
  assert.equal(movement.kind, 'perda');
  assert.match(movement.description, /Lote vencido descartado/);
  assert.equal((await post(`/api/lots/${lot.lotId}/discard`, {})).status, 409);
  assert.equal((await post('/api/lots/999999/discard', {})).status, 404);
});

test('ajuste de inventário: por diferença ou saldo contado, sempre com motivo', async () => {
  const name = uniqueName('Queijo');
  const lot = await receive(name, 2, 'kg', '2026-03-20');
  const id = lot.ingredientId;

  const counted = await post('/api/adjustments', { ingredientId: id, counted: '1,75', unit: 'kg', reason: 'Contagem semanal' });
  assert.equal(counted.status, 201);
  assert.equal(counted.body.delta, -0.25);
  assert.equal((await item(name)).quantity, 1.75);

  const plus = await post('/api/adjustments', {
    ingredientId: id,
    quantity: '+300',
    unit: 'g',
    reason: 'Achado na câmara',
    expiresOn: '2026-03-18',
  });
  assert.equal(plus.status, 201);
  assert.equal((await item(name)).quantity, 2.05);

  const missingExpiry = await post('/api/adjustments', { ingredientId: id, quantity: 1, reason: 'Contagem' });
  assert.equal(missingExpiry.status, 409);
  assert.equal((await post('/api/adjustments', { ingredientId: id, quantity: -1, reason: '' })).status, 400);
  assert.equal((await post('/api/adjustments', { ingredientId: id, quantity: -1, counted: 1, reason: 'Contagem' })).status, 400);
  assert.equal((await post('/api/adjustments', { ingredientId: id, counted: '2.05', reason: 'Contagem' })).status, 409);
  assert.equal((await post('/api/adjustments', { ingredientId: id, quantity: -5, reason: 'Contagem' })).status, 409);

  const history = (await request('GET', `/api/movements?ingredientId=${id}&kind=ajuste`)).body;
  assert.deepEqual(
    history.map(m => m.delta),
    [0.3, -0.25],
  );
});

test('mínimo por ingrediente e alerta de estoque baixo', async () => {
  const name = uniqueName('Manteiga');
  const { ingredientId } = await receive(name, 500, 'g', '2026-04-10');
  const res = await request('PATCH', `/api/ingredients/${ingredientId}`, { minimum: '0,5', unit: 'kg' });
  assert.equal(res.status, 200);
  assert.equal(res.body.minimum, 0.5);
  const row = await item(name);
  assert.equal(row.status, 'Baixo');
  assert.ok(row.alerts.includes('abaixo_do_minimo'));
  assert.equal((await request('PATCH', `/api/ingredients/${ingredientId}`, {})).status, 400);
  assert.equal((await request('PATCH', '/api/ingredients/999999', { minimum: 1 })).status, 404);
});

test('resumo: perdas por unidade (sem somar kg com un) e campos legados', async () => {
  const body = await summary();
  for (const key of ['inventory', 'recipes', 'movements', 'lowCount', 'expiringCount', 'wasteTotal', 'losses', 'expiredCount']) {
    assert.ok(key in body, key);
  }
  assert.ok(body.movements.length <= 12);
  assert.ok(body.losses.byUnit.every(u => ['kg', 'L', 'un'].includes(u.unit)));
  const first = body.inventory[0];
  for (const key of ['id', 'name', 'unit', 'minimum', 'quantity', 'nextExpiry', 'status']) assert.ok(key in first, key);
});

test('movimentações são imutáveis no banco', () => {
  assert.throws(() => db.prepare("UPDATE movements SET description = 'x'").run(), /imutáveis/);
  assert.throws(() => db.prepare('DELETE FROM movements').run(), /imutáveis/);
});

test('CSV: protege contra fórmulas e usa o saldo válido', async () => {
  await receive('=HYPERLINK("x")', 1, 'kg', '2026-04-01');
  const res = await request('GET', '/api/export/inventory.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /estoquecerto-inventory-2026-03-10\.csv/);
  assert.match(res.body, /^ingredient,available,unit,minimum,next_expiry,status,expired\r\n/);
  // BOM para o Excel abrir em UTF-8 (fetch().text() o remove; confere nos bytes).
  const bytes = new Uint8Array(await (await fetch(baseUrl + '/api/export/inventory.csv')).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(res.body, /"'=HYPERLINK\(""x""\)"/);
});

test('erros sempre em JSON: corpo malformado, tipo errado e rota inexistente', async () => {
  const malformed = await post('/api/lots', '{oops');
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /JSON/);
  const form = await request('POST', '/api/lots', 'name=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(form.status, 415);
  const tooBig = await post('/api/lots', { name: 'x'.repeat(40_000) });
  assert.equal(tooBig.status, 413);
  const missing = await request('GET', '/api/nada');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'Rota da API não encontrada.');
});
