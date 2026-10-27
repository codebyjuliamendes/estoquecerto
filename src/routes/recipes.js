'use strict';

const express = require('express');
const { notFound } = require('../http/errors');
const { requireId, parseId, parseRecipeInput, parsePortions, plainText } = require('../http/validation');
const { requirements } = require('../domain/portions');
const present = require('../http/present');

function recipeRoutes({ store, clock }) {
  const router = express.Router();

  router.get('/', (_req, res) => res.json(store.recipes(clock.today()).map(present.recipe)));

  router.post('/', (req, res) => {
    // Ingrediente por id ou por nome (contrato original usa o nome).
    const find = item =>
      parseId(item?.ingredientId) ? store.getIngredient(parseId(item.ingredientId)) : store.findIngredientByName(plainText(item?.name));
    const { name, items } = parseRecipeInput(req.body, find);
    res.status(201).json({ id: store.createRecipe(name, items) });
  });

  router.post('/:id/prepare', (req, res) => {
    const portions = parsePortions(req.body?.portions);
    const today = clock.today();
    const recipe = store.getRecipe(requireId(req.params.id, 'Receita inválida.'), today);
    if (!recipe) throw notFound('Receita não encontrada.');
    const needs = requirements(recipe.items, portions);
    store.prepare({ recipe, needs, today, description: `Preparo: ${recipe.name} · ${portions} ${portions === 1 ? 'porção' : 'porções'}` });
    res.json({ ok: true, portions });
  });

  return router;
}

module.exports = { recipeRoutes };
