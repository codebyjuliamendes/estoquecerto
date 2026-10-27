'use strict';

const { ValidationError } = require('../domain/errors');
const { getUnit, displayUnitOf, compatible, toBase } = require('../domain/units');
const { isValidIsoDate, addDays } = require('../domain/dates');

const MAX_RECIPE_ITEMS = 20;
const MAX_PORTIONS = 500;
const MAX_REASON = 120;
const MAX_SHELF_LIFE_DAYS = 3660; // ~10 anos: acima disso é quase certamente erro de digitação.

const cleanText = value => (typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '');
const isBlank = value => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
// Remove caracteres de controle (quebras, tabs) de textos livres que vão para o histórico.
const plainText = value => cleanText(typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ') : value);

/** Inteiro positivo vindo de JSON ou de parâmetro de rota; null se inválido. */
function parseId(value) {
  const id = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requireId(value, message) {
  const id = parseId(value);
  if (!id) throw new ValidationError(message);
  return id;
}

function parseName(value, label = 'O nome') {
  const name = plainText(value);
  if (name.length < 2 || name.length > 60) throw new ValidationError(`${label} deve ter entre 2 e 60 caracteres.`);
  return name;
}

function parseReason(value, fallback) {
  const reason = plainText(value);
  if (reason.length > MAX_REASON) throw new ValidationError(`O motivo deve ter no máximo ${MAX_REASON} caracteres.`);
  return reason || fallback;
}

/** Unidade informada ou, se ausente, a do ingrediente; precisa ser da mesma dimensão. */
function resolveUnit(value, ingredientUnit) {
  const raw = cleanText(value);
  if (!raw) return ingredientUnit;
  const unit = getUnit(raw);
  if (!unit) throw new ValidationError('Unidade inválida. Use kg, g, mg, L, ml ou un.');
  if (ingredientUnit && !compatible(unit.symbol, ingredientUnit)) {
    throw new ValidationError(`Unidade incompatível com o cadastro do ingrediente (${ingredientUnit}).`);
  }
  return unit.symbol;
}

/** Validade do lote: data real, não vencida e dentro de um horizonte plausível. */
function parseExpiry(value, today) {
  const date = cleanText(value);
  if (!isValidIsoDate(date)) throw new ValidationError('Informe uma validade válida (AAAA-MM-DD).');
  if (date < today) throw new ValidationError('A validade informada já passou; lotes vencidos não entram no estoque.');
  if (date > addDays(today, MAX_SHELF_LIFE_DAYS)) throw new ValidationError('Validade distante demais; confira a data.');
  return date;
}

/** Corpo de POST /api/lots, normalizado para a menor unidade. */
function parseLotInput(body, existing, today) {
  const name = parseName(body?.name, 'O nome do ingrediente');
  const unit = resolveUnit(body?.unit, existing?.unit) || 'un';
  const ingredientUnit = existing?.unit ?? displayUnitOf(getUnit(unit).dimension);
  return {
    name,
    unit,
    ingredientUnit,
    quantity: toBase(body?.quantity, unit),
    minimum: isBlank(body?.minimum) ? undefined : toBase(body.minimum, unit, { allowZero: true }),
    expiresOn: parseExpiry(body?.expiresOn, today),
  };
}

/** items: [{ name | ingredientId, quantity, unit? }] -> [{ ingredientId, quantity }] por porção. */
function parseRecipeInput(body, findIngredient) {
  const name = parseName(body?.name, 'O nome da receita');
  const raw = body?.items;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RECIPE_ITEMS) {
    throw new ValidationError(`Informe um nome e de 1 a ${MAX_RECIPE_ITEMS} ingredientes para a receita.`);
  }
  const seen = new Set();
  const items = raw.map(item => {
    const label = plainText(item?.name) || (item?.ingredientId ? `#${item.ingredientId}` : '?');
    const ingredient = findIngredient(item);
    if (!ingredient) throw new ValidationError(`Ingrediente não cadastrado: ${label}. Registre uma entrada antes.`);
    if (seen.has(ingredient.id)) throw new ValidationError(`Ingrediente repetido na receita: ${ingredient.name}.`);
    seen.add(ingredient.id);
    try {
      const unit = resolveUnit(item?.unit, ingredient.unit);
      return { ingredientId: ingredient.id, quantity: toBase(item?.quantity, unit) };
    } catch (err) {
      if (err instanceof ValidationError)
        throw new ValidationError(`Ingrediente, unidade ou quantidade inválida: ${ingredient.name}. ${err.message}`);
      throw err;
    }
  });
  return { name, items };
}

function parsePortions(value) {
  const portions = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(portions) || portions < 1 || portions > MAX_PORTIONS) {
    throw new ValidationError(`Informe de 1 a ${MAX_PORTIONS} porções.`);
  }
  return portions;
}

function parseLimit(value, { fallback = 50, max = 200 } = {}) {
  if (isBlank(value)) return fallback;
  const limit = parseId(value);
  if (!limit || limit > max) throw new ValidationError(`O limite deve ser um inteiro entre 1 e ${max}.`);
  return limit;
}

/** Quantidade com sinal para ajustes ("-0,5" kg). */
function parseSignedQuantity(value, unit) {
  const text = typeof value === 'number' ? String(value) : cleanText(value);
  const negative = text.startsWith('-');
  const base = toBase(negative ? text.slice(1) : text.replace(/^\+/, ''), unit);
  return negative ? -base : base;
}

module.exports = {
  MAX_PORTIONS,
  MAX_RECIPE_ITEMS,
  cleanText,
  plainText,
  isBlank,
  parseId,
  requireId,
  parseName,
  parseReason,
  resolveUnit,
  parseExpiry,
  parseLotInput,
  parseRecipeInput,
  parsePortions,
  parseLimit,
  parseSignedQuantity,
};
