'use strict';

const { ValidationError } = require('./errors');

/** floor(a / b) exato para inteiros seguros (a divisão em float pode arredondar para cima). */
function floorDiv(a, b) {
  let q = Math.floor(a / b);
  while (q * b > a) q--;
  while ((q + 1) * b <= a) q++;
  return q;
}

/**
 * Porções possíveis pela ficha técnica: o ingrediente mais escasso limita o prato.
 * items: [{ ingredientId, perPortion, available }] em inteiros da menor unidade.
 * Retorna { portions, limitingIngredientId }.
 */
function portionsAvailable(items) {
  if (!items.length) return { portions: 0, limitingIngredientId: null };
  let best = null;
  for (const item of items) {
    const portions = floorDiv(Math.max(0, item.available), item.perPortion);
    if (!best || portions < best.portions) best = { portions, limitingIngredientId: item.ingredientId };
  }
  return best;
}

/** Quantidade total de cada ingrediente para `portions` porções. */
function requirements(items, portions) {
  return items.map(item => {
    const total = item.perPortion * portions;
    if (!Number.isSafeInteger(total)) throw new ValidationError('Quantidade de porções grande demais.');
    return { ingredientId: item.ingredientId, quantity: total };
  });
}

module.exports = { floorDiv, portionsAvailable, requirements };
