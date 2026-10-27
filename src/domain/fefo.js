'use strict';

const { ConflictError } = require('./errors');
const { isExpired } = require('./dates');

/** FEFO: menor validade primeiro; empate pelo lote mais antigo (id). */
const fefoOrder = (a, b) => (a.expiresOn < b.expiresOn ? -1 : a.expiresOn > b.expiresOn ? 1 : a.id - b.id);

/** Lotes com saldo que podem ser consumidos hoje (validade >= hoje). */
const usableLots = (lots, today) => lots.filter(lot => lot.quantity > 0 && !isExpired(lot.expiresOn, today));

const availableQuantity = (lots, today) => usableLots(lots, today).reduce((sum, lot) => sum + lot.quantity, 0);

/**
 * Planeja a baixa de `amount` (inteiro na menor unidade) pelos lotes.
 * Preparo e ajuste usam só lotes válidos; perdas (`includeExpired`) também
 * descartam lotes vencidos, que, por vencerem antes, saem primeiro.
 * Retorna [{ lotId, quantity }]; lança ConflictError se o saldo não cobre.
 */
function planConsumption(lots, amount, { today, includeExpired = false }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new RangeError('amount deve ser inteiro positivo');
  const candidates = (includeExpired ? lots.filter(lot => lot.quantity > 0) : usableLots(lots, today)).slice().sort(fefoOrder);
  const plan = [];
  let remaining = amount;
  for (const lot of candidates) {
    if (remaining === 0) break;
    const quantity = Math.min(remaining, lot.quantity);
    plan.push({ lotId: lot.id, quantity });
    remaining -= quantity;
  }
  if (remaining > 0) throw new ConflictError('Estoque insuficiente; atualize o painel e confira os lotes.');
  return plan;
}

module.exports = { fefoOrder, usableLots, availableQuantity, planConsumption };
