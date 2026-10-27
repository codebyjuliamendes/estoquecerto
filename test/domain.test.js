'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toBase, fromBase, baseToDecimal, formatQuantity, getUnit, compatible } = require('../src/domain/units');
const { isValidIsoDate, todayIn, addDays, daysBetween, expiryStatus } = require('../src/domain/dates');
const { planConsumption, availableQuantity } = require('../src/domain/fefo');
const { floorDiv, portionsAvailable, requirements } = require('../src/domain/portions');
const { ingredientStatus } = require('../src/domain/inventory');
const { ValidationError, ConflictError } = require('../src/domain/errors');

test('unidades: conversão exata para a menor unidade, sem ponto flutuante', () => {
  assert.equal(toBase('0,2', 'kg'), 200_000);
  assert.equal(toBase(0.1, 'kg') + toBase(0.2, 'kg'), toBase('0.3', 'kg')); // 0.1 + 0.2 !== 0.3 em float
  assert.equal(toBase('1.5', 'g'), 1_500);
  assert.equal(toBase('250', 'ml'), 250);
  assert.equal(toBase('1,25', 'L'), 1_250);
  assert.equal(toBase('0.5', 'unidade'), 500);
  assert.equal(toBase('2.300', 'kg'), 2_300_000); // zeros à direita não contam como precisão extra
  assert.equal(toBase('0', 'kg', { allowZero: true }), 0);
});

test('unidades: rejeita entradas inválidas e precisão acima da menor unidade', () => {
  for (const [value, unit] of [
    ['0', 'kg'],
    ['-1', 'kg'],
    ['abc', 'kg'],
    ['1e3', 'g'],
    ['1,2,3', 'g'],
    ['0.5', 'ml'],
    ['0.0001', 'un'],
    ['0.0000001', 'kg'],
    ['10001', 'kg'],
    ['10000001', 'g'],
    [Infinity, 'kg'],
    [null, 'kg'],
    ['1', 'xícara'],
  ]) {
    assert.throws(() => toBase(value, unit), ValidationError, `${value} ${unit}`);
  }
  assert.equal(toBase('10000', 'kg'), 10_000_000_000);
});

test('unidades: volta para a unidade de exibição e formata em pt-BR', () => {
  assert.equal(fromBase(2_300_000, 'kg'), 2.3);
  assert.equal(fromBase(200_000, 'kg'), 0.2);
  assert.equal(fromBase(1, 'kg'), 0.000001);
  assert.equal(baseToDecimal(-500, 'un'), '-0.5');
  assert.equal(formatQuantity(2_300_000, 'kg'), '2,3 kg');
  assert.equal(formatQuantity(200_000, 'kg', { best: true }), '200 g');
  assert.equal(formatQuantity(250, 'kg', { best: true }), '250 mg');
  assert.equal(formatQuantity(1_500, 'L', { best: true }), '1,5 L');
  assert.equal(formatQuantity(10_000_000_000, 'kg', { best: true }), '10.000 kg');
  assert.equal(formatQuantity(0, 'kg', { best: true }), '0 kg');
  assert.equal(getUnit('ML').symbol, 'ml');
  assert.ok(compatible('kg', 'mg'));
  assert.ok(!compatible('kg', 'ml'));
});

test('datas: validade civil, fuso do restaurante e janelas de alerta', () => {
  assert.ok(isValidIsoDate('2024-02-29'));
  assert.ok(!isValidIsoDate('2026-02-29'));
  assert.ok(!isValidIsoDate('2026-02-31'));
  assert.ok(!isValidIsoDate('26-02-01'));
  // 23h30 em São Paulo ainda é o dia anterior em relação ao UTC.
  const lateNight = new Date('2026-03-11T02:30:00Z');
  assert.equal(todayIn('America/Sao_Paulo', lateNight), '2026-03-10');
  assert.equal(todayIn('UTC', lateNight), '2026-03-11');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(daysBetween('2026-03-10', '2026-03-08'), -2);
  assert.equal(expiryStatus('2026-03-09', '2026-03-10', 3), 'vencido');
  assert.equal(expiryStatus('2026-03-10', '2026-03-10', 3), 'vence_hoje');
  assert.equal(expiryStatus('2026-03-13', '2026-03-10', 3), 'vence_em_breve');
  assert.equal(expiryStatus('2026-03-14', '2026-03-10', 3), 'ok');
});

const lots = [
  { id: 3, quantity: 500, expiresOn: '2026-03-20' },
  { id: 1, quantity: 300, expiresOn: '2026-03-12' },
  { id: 2, quantity: 400, expiresOn: '2026-03-12' },
  { id: 4, quantity: 1000, expiresOn: '2026-03-01' }, // vencido
  { id: 5, quantity: 0, expiresOn: '2026-03-11' },
];
const today = '2026-03-10';

test('FEFO: consome primeiro o que vence antes, empate pelo lote mais antigo', () => {
  assert.deepEqual(planConsumption(lots, 900, { today }), [
    { lotId: 1, quantity: 300 },
    { lotId: 2, quantity: 400 },
    { lotId: 3, quantity: 200 },
  ]);
  assert.deepEqual(planConsumption(lots, 300, { today }), [{ lotId: 1, quantity: 300 }]);
});

test('FEFO: lotes vencidos não contam no saldo nem no preparo, mas saem primeiro na perda', () => {
  assert.equal(availableQuantity(lots, today), 1200);
  assert.throws(() => planConsumption(lots, 1201, { today }), ConflictError);
  assert.deepEqual(planConsumption(lots, 1100, { today, includeExpired: true }), [
    { lotId: 4, quantity: 1000 },
    { lotId: 1, quantity: 100 },
  ]);
  // Vence hoje ainda é utilizável.
  assert.equal(availableQuantity([{ id: 9, quantity: 10, expiresOn: today }], today), 10);
  assert.throws(() => planConsumption(lots, 0, { today }), RangeError);
});

test('porções: divisão inteira exata e o ingrediente mais escasso limita', () => {
  assert.equal(floorDiv(300_000, 100_000), 3); // em float: 0.3 / 0.1 = 2.9999999999999996
  assert.equal(floorDiv(299_999, 100_000), 2);
  assert.equal(floorDiv(9_007_199_254_740_990, 3), 3_002_399_751_580_330);
  assert.deepEqual(
    portionsAvailable([
      { ingredientId: 1, perPortion: 200_000, available: 13_000_000 },
      { ingredientId: 2, perPortion: 1_000, available: 6_000 },
      { ingredientId: 3, perPortion: 100_000, available: 12_000_000 },
    ]),
    { portions: 6, limitingIngredientId: 2 },
  );
  assert.deepEqual(portionsAvailable([]), { portions: 0, limitingIngredientId: null });
  assert.deepEqual(requirements([{ ingredientId: 1, perPortion: 250_000 }], 4), [{ ingredientId: 1, quantity: 1_000_000 }]);
});

test('situação do ingrediente: mínimo, vencido e validade próxima', () => {
  const base = { minimum: 3, expired: 0, nextExpiry: '2026-03-30' };
  assert.deepEqual(ingredientStatus({ ...base, available: 3 }, today, 3).status, 'Baixo');
  assert.deepEqual(ingredientStatus({ ...base, available: 4 }, today, 3), { status: 'Em dia', alerts: [], daysToExpiry: 20 });
  assert.deepEqual(ingredientStatus({ ...base, available: 0, minimum: 0, nextExpiry: null }, today, 3).alerts, ['sem_estoque']);
  const soon = ingredientStatus({ ...base, available: 9, expired: 5, nextExpiry: today }, today, 3);
  assert.equal(soon.status, 'Vence em breve');
  assert.deepEqual(soon.alerts, ['vencido', 'vence_hoje']);
});
