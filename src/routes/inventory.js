'use strict';

const express = require('express');
const { HttpError, notFound } = require('../http/errors');
const { requireId, isBlank, parseName, resolveUnit, parseLotInput, parseReason } = require('../http/validation');
const { ValidationError } = require('../domain/errors');
const { toBase, fromBase, formatQuantity } = require('../domain/units');
const { addDays, formatDateBR } = require('../domain/dates');
const present = require('../http/present');

// Planilhas executam células que começam com = + - @ (CSV/formula injection).
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function inventoryRoutes({ store, clock, warningDays }) {
  const router = express.Router();

  router.get('/summary', (_req, res) => {
    const today = clock.today();
    const inventory = present.inventory(store.inventory(today), today, warningDays);
    const since = new Date(clock.now().getTime() - 30 * 86_400_000);
    const losses = store.lossesSince(since);
    res.json({
      today,
      warningDays,
      inventory,
      recipes: store.recipes(today).map(present.recipe),
      movements: store.movements({ limit: 12 }).map(present.movement),
      lowCount: inventory.filter(i => i.status === 'Baixo').length,
      expiringCount: store.expiringLotCount(today, addDays(today, warningDays)),
      expiredCount: store.expiredLotCount(today),
      losses: {
        days: 30,
        count: losses.reduce((sum, row) => sum + row.count, 0),
        byUnit: losses.map(row => ({
          unit: row.unit,
          quantity: fromBase(row.quantity, row.unit),
          label: formatQuantity(row.quantity, row.unit, { best: true }),
        })),
      },
      // Legado: soma de todas as perdas misturando unidades; prefira `losses`.
      wasteTotal: store.lossesTotalByUnit().reduce((sum, row) => sum + fromBase(row.quantity, row.unit), 0),
    });
  });

  router.post('/lots', (req, res) => {
    const today = clock.today();
    const existing = store.findIngredientByName(parseName(req.body?.name, 'O nome do ingrediente'));
    const input = parseLotInput(req.body, existing, today);
    const { ingredient, lotId } = store.receiveLot({
      name: input.name,
      unit: input.ingredientUnit,
      minimum: input.minimum,
      quantity: input.quantity,
      expiresOn: input.expiresOn,
      describe: () => `Entrada de lote · ${formatQuantity(input.quantity, input.unit)} · validade ${formatDateBR(input.expiresOn)}`,
    });
    res
      .status(201)
      .json({ ingredientId: ingredient.id, lotId, unit: ingredient.unit, quantity: fromBase(input.quantity, ingredient.unit) });
  });

  router.post('/lots/:id/discard', (req, res) => {
    const lot = store.getLot(requireId(req.params.id, 'Lote inválido.'));
    if (!lot) throw notFound('Lote não encontrado.');
    if (lot.quantity === 0) throw new HttpError(409, 'Este lote já não tem saldo.');
    const ingredient = store.getIngredient(lot.ingredientId);
    const reason = parseReason(req.body?.reason, lot.expiresOn < clock.today() ? 'Lote vencido descartado' : 'Lote descartado');
    store.discardLot({ lot, description: `${reason} · lote #${lot.id} · validade ${formatDateBR(lot.expiresOn)}` });
    res.json({ ok: true, quantity: fromBase(lot.quantity, ingredient.unit), unit: ingredient.unit });
  });

  router.get('/ingredients', (_req, res) => {
    const today = clock.today();
    res.json(present.inventory(store.inventory(today), today, warningDays));
  });

  router.get('/ingredients/:id/lots', (req, res) => {
    const ingredient = store.getIngredient(requireId(req.params.id, 'Ingrediente inválido.'));
    if (!ingredient) throw notFound('Ingrediente não encontrado.');
    const today = clock.today();
    res.json({
      ingredient: {
        id: ingredient.id,
        name: ingredient.name,
        unit: ingredient.unit,
        minimum: fromBase(ingredient.minimum, ingredient.unit),
      },
      lots: store.lotsOf(ingredient.id).map(row => present.lot(row, ingredient.unit, today, warningDays)),
    });
  });

  router.patch('/ingredients/:id', (req, res) => {
    const ingredient = store.getIngredient(requireId(req.params.id, 'Ingrediente inválido.'));
    if (!ingredient) throw notFound('Ingrediente não encontrado.');
    const unit = resolveUnit(req.body?.unit, ingredient.unit);
    if (isBlank(req.body?.minimum)) throw new ValidationError('Informe o estoque mínimo (0 desativa o alerta).');
    const minimum = toBase(req.body.minimum, unit, { allowZero: true });
    store.setMinimum(ingredient.id, minimum);
    res.json({ id: ingredient.id, unit: ingredient.unit, minimum: fromBase(minimum, ingredient.unit) });
  });

  router.get('/export/inventory.csv', (_req, res) => {
    const today = clock.today();
    const rows = present.inventory(store.inventory(today), today, warningDays);
    const header = 'ingredient,available,unit,minimum,next_expiry,status,expired';
    const lines = rows.map(i => [i.name, i.quantity, i.unit, i.minimum, i.nextExpiry || '', i.status, i.expired].map(csvCell).join(','));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="estoquecerto-inventory-${today}.csv"`);
    res.send('﻿' + [header, ...lines].join('\r\n'));
  });

  return router;
}

module.exports = { inventoryRoutes, csvCell };
