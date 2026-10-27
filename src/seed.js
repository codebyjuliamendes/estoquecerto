'use strict';

const { addDays, formatDateBR } = require('./domain/dates');
const { toBase } = require('./domain/units');

// Dados fictícios para explorar o painel; só rodam com o banco vazio.
const INGREDIENTS = [
  {
    name: 'Tomate',
    unit: 'kg',
    minimum: '3',
    lots: [
      ['8', 2],
      ['5', 8],
    ],
  },
  { name: 'Arroz', unit: 'kg', minimum: '4', lots: [['12', 90]] },
  { name: 'Feijão', unit: 'kg', minimum: '2', lots: [['5', 45]] },
  { name: 'Alface', unit: 'un', minimum: '4', lots: [['6', 1]] },
  { name: 'Frango', unit: 'kg', minimum: '3', lots: [['4', 3]] },
  { name: 'Cebola', unit: 'kg', minimum: '1', lots: [['2', 28]] },
];

const RECIPES = [
  {
    name: 'Bowl da casa',
    items: [
      ['Tomate', '200', 'g'],
      ['Arroz', '100', 'g'],
      ['Alface', '1', 'un'],
    ],
  },
  {
    name: 'Frango com arroz',
    items: [
      ['Frango', '250', 'g'],
      ['Arroz', '150', 'g'],
      ['Feijão', '80', 'g'],
    ],
  },
];

function seedDemoData(store, today) {
  if (store.countIngredients() > 0) return false;
  for (const item of INGREDIENTS) {
    item.lots.forEach(([quantity, days], index) => {
      const expiresOn = addDays(today, days);
      store.receiveLot({
        name: item.name,
        unit: item.unit,
        minimum: index === 0 ? toBase(item.minimum, item.unit) : undefined,
        quantity: toBase(quantity, item.unit),
        expiresOn,
        describe: () => `Entrada de lote · ${quantity} ${item.unit} · validade ${formatDateBR(expiresOn)} (demonstração)`,
      });
    });
  }
  for (const recipe of RECIPES) {
    const items = recipe.items.map(([name, quantity, unit]) => ({
      ingredientId: store.findIngredientByName(name).id,
      quantity: toBase(quantity, unit),
    }));
    store.createRecipe(recipe.name, items);
  }
  return true;
}

module.exports = { seedDemoData };
