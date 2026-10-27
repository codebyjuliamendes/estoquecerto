'use strict';

// Converte linhas do store (inteiros na menor unidade) no formato público da API:
// números na unidade do ingrediente (contrato original) + rótulos prontos em pt-BR.
const { fromBase, formatQuantity } = require('../domain/units');
const { ingredientStatus } = require('../domain/inventory');
const { expiryStatus, daysBetween } = require('../domain/dates');
const { portionsAvailable } = require('../domain/portions');

const ALERT_RANK = { vencido: 0, vence_hoje: 1, sem_estoque: 2, abaixo_do_minimo: 3, vence_em_breve: 4 };
const urgency = item => Math.min(99, ...item.alerts.map(a => ALERT_RANK[a]));

function inventoryItem(row, today, warningDays) {
  const { status, alerts, daysToExpiry } = ingredientStatus(row, today, warningDays);
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    minimum: fromBase(row.minimum, row.unit),
    quantity: fromBase(row.available, row.unit),
    expired: fromBase(row.expired, row.unit),
    nextExpiry: row.nextExpiry,
    daysToExpiry,
    status,
    alerts,
    lotCount: row.lotCount,
    labels: {
      quantity: formatQuantity(row.available, row.unit, { best: true }),
      minimum: formatQuantity(row.minimum, row.unit, { best: true }),
      expired: formatQuantity(row.expired, row.unit, { best: true }),
    },
  };
}

/** Mais urgente primeiro: vencido, vence hoje, sem estoque...; depois a validade mais próxima. */
function inventory(rows, today, warningDays) {
  return rows
    .map(row => inventoryItem(row, today, warningDays))
    .sort(
      (a, b) =>
        urgency(a) - urgency(b) || (a.nextExpiry ?? '9999').localeCompare(b.nextExpiry ?? '9999') || a.name.localeCompare(b.name, 'pt-BR'),
    );
}

function lot(row, unit, today, warningDays) {
  return {
    id: row.id,
    quantity: fromBase(row.quantity, unit),
    received: fromBase(row.received, unit),
    expiresOn: row.expiresOn,
    daysToExpiry: daysBetween(today, row.expiresOn),
    expiry: expiryStatus(row.expiresOn, today, warningDays),
    createdAt: row.createdAt,
    label: formatQuantity(row.quantity, unit, { best: true }),
  };
}

function recipe(row) {
  const { portions, limitingIngredientId } = portionsAvailable(row.items);
  return {
    id: row.id,
    name: row.name,
    portions,
    limitingIngredientId,
    items: row.items.map(item => ({
      id: item.ingredientId,
      name: item.name,
      unit: item.unit,
      quantity: fromBase(item.perPortion, item.unit),
      available: fromBase(item.available, item.unit),
      labels: {
        quantity: formatQuantity(item.perPortion, item.unit, { best: true }),
        available: formatQuantity(item.available, item.unit, { best: true }),
      },
    })),
  };
}

function movement(row) {
  return {
    id: row.id,
    ingredientId: row.ingredientId,
    name: row.name,
    kind: row.kind,
    // `quantity` segue sem sinal (contrato original); `delta` traz o sinal.
    quantity: fromBase(Math.abs(row.delta), row.unit),
    delta: fromBase(row.delta, row.unit),
    unit: row.unit,
    label: formatQuantity(Math.abs(row.delta), row.unit, { best: true }),
    description: row.description,
    recipeId: row.recipeId,
    createdAt: row.createdAt,
    lots: row.lots.map(l => ({ lotId: l.lotId, expiresOn: l.expiresOn, delta: fromBase(l.delta, row.unit) })),
  };
}

module.exports = { inventory, inventoryItem, lot, recipe, movement };
