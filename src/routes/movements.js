'use strict';

const express = require('express');
const { notFound } = require('../http/errors');
const { ValidationError } = require('../domain/errors');
const { toBase, fromBase, formatQuantity } = require('../domain/units');
const {
  requireId,
  parseId,
  isBlank,
  resolveUnit,
  parseReason,
  parseExpiry,
  parseLimit,
  parseSignedQuantity,
} = require('../http/validation');
const present = require('../http/present');

const KINDS = new Set(['entrada', 'preparo', 'perda', 'ajuste']);

function movementRoutes({ store, clock }) {
  const router = express.Router();

  const loadIngredient = value => {
    const ingredient = store.getIngredient(requireId(value, 'Confira o ingrediente e a quantidade perdida.'));
    if (!ingredient) throw new ValidationError('Confira o ingrediente e a quantidade perdida.');
    return ingredient;
  };

  // Perda pela quantidade: descarta FEFO, começando pelos lotes vencidos.
  router.post('/waste', (req, res) => {
    const ingredient = loadIngredient(req.body?.ingredientId);
    const unit = resolveUnit(req.body?.unit, ingredient.unit);
    const quantity = toBase(req.body?.quantity, unit);
    const reason = parseReason(req.body?.reason, 'Perda registrada');
    store.registerLoss({
      ingredientId: ingredient.id,
      quantity,
      description: `${reason} · ${formatQuantity(quantity, unit)}`,
      today: clock.today(),
    });
    res.json({ ok: true, quantity: fromBase(quantity, ingredient.unit), unit: ingredient.unit });
  });

  // Ajuste de inventário: `quantity` com sinal (diferença) ou `counted` (saldo contado).
  router.post('/adjustments', (req, res) => {
    const ingredient = store.getIngredient(requireId(req.body?.ingredientId, 'Ingrediente inválido.'));
    if (!ingredient) throw notFound('Ingrediente não encontrado.');
    const unit = resolveUnit(req.body?.unit, ingredient.unit);
    const hasDelta = !isBlank(req.body?.quantity);
    const hasCounted = !isBlank(req.body?.counted);
    if (hasDelta === hasCounted) throw new ValidationError('Informe a diferença (quantity) ou o saldo contado (counted), não ambos.');
    const reason = parseReason(req.body?.reason, '');
    if (reason.length < 3) throw new ValidationError('Explique o motivo do ajuste (ex.: contagem de inventário).');
    const today = clock.today();
    const result = store.adjust({
      ingredientId: ingredient.id,
      delta: hasDelta ? parseSignedQuantity(req.body.quantity, unit) : undefined,
      counted: hasCounted ? toBase(req.body.counted, unit, { allowZero: true }) : undefined,
      expiresOn: isBlank(req.body?.expiresOn) ? null : parseExpiry(req.body.expiresOn, today),
      description: `Ajuste: ${reason}`,
      today,
    });
    res
      .status(201)
      .json({ ok: true, movementId: result.movementId, delta: fromBase(result.delta, ingredient.unit), unit: ingredient.unit });
  });

  router.get('/movements', (req, res) => {
    const kind = isBlank(req.query.kind) ? null : String(req.query.kind);
    if (kind && !KINDS.has(kind)) throw new ValidationError('Tipo de movimentação inválido.');
    const ingredientId = isBlank(req.query.ingredientId) ? null : requireId(req.query.ingredientId, 'Ingrediente inválido.');
    const before = isBlank(req.query.before) ? null : parseId(req.query.before);
    const rows = store.movements({ limit: parseLimit(req.query.limit), ingredientId, kind, before });
    res.json(rows.map(present.movement));
  });

  return router;
}

module.exports = { movementRoutes };
