'use strict';

const { ValidationError } = require('./errors');

// Quantidades são persistidas como inteiros na menor unidade de cada dimensão
// (mg, ml e milésimo de unidade). `scale` é o expoente decimal até essa base:
// 1 kg = 10^6 mg. Conversões são feitas sobre o texto do número, nunca com floats.
const DIMENSIONS = Object.freeze({
  mass: { display: 'kg', steps: ['kg', 'g', 'mg'] },
  volume: { display: 'L', steps: ['L', 'ml'] },
  count: { display: 'un', steps: ['un'] },
});

const UNITS = Object.freeze({
  kg: { symbol: 'kg', dimension: 'mass', scale: 6 },
  g: { symbol: 'g', dimension: 'mass', scale: 3 },
  mg: { symbol: 'mg', dimension: 'mass', scale: 0 },
  l: { symbol: 'L', dimension: 'volume', scale: 3 },
  ml: { symbol: 'ml', dimension: 'volume', scale: 0 },
  un: { symbol: 'un', dimension: 'count', scale: 3 },
});

const ALIASES = Object.freeze({ unidade: 'un', unidades: 'un', und: 'un', lt: 'l', litro: 'l', litros: 'l' });

// Limite de uma única quantidade informada: 10.000 kg, 10.000 L ou 10.000 un.
const MAX_DISPLAY_QUANTITY = 10_000;

const DECIMAL = /^(\d{1,12})(?:[.,](\d{1,12}))?$/;

/** Unidade normalizada ({ symbol, dimension, scale }) ou null. */
function getUnit(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  return UNITS[ALIASES[key] || key] || null;
}

const displayUnitOf = dimension => DIMENSIONS[dimension]?.display ?? null;
const maxBase = dimension => MAX_DISPLAY_QUANTITY * 10 ** getUnit(displayUnitOf(dimension)).scale;
const compatible = (a, b) => Boolean(getUnit(a) && getUnit(b) && getUnit(a).dimension === getUnit(b).dimension);

function decimalText(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return typeof value === 'string' ? value.trim() : null;
}

/**
 * Converte "0,2" kg -> 200000 (mg). Lança ValidationError quando o texto não é
 * um decimal positivo simples ou tem mais casas do que a menor unidade permite.
 */
function toBase(value, unitName, { allowZero = false } = {}) {
  const unit = getUnit(unitName);
  if (!unit) throw new ValidationError('Unidade inválida. Use kg, g, mg, L, ml ou un.');
  const text = decimalText(value);
  const match = text === null ? null : DECIMAL.exec(text);
  if (!match) throw new ValidationError('Informe a quantidade como número, por exemplo 2,5.');

  const fraction = (match[2] || '').replace(/0+$/, '');
  if (fraction.length > unit.scale) {
    const smallest = DIMENSIONS[unit.dimension].steps.at(-1);
    throw new ValidationError(
      unit.dimension === 'count'
        ? 'Use no máximo três casas decimais para unidades.'
        : `Quantidade mais precisa que 1 ${smallest}; ajuste as casas decimais.`,
    );
  }
  const base = Number(match[1]) * 10 ** unit.scale + Number(fraction.padEnd(unit.scale, '0') || 0);
  if (!Number.isSafeInteger(base) || base > maxBase(unit.dimension)) {
    throw new ValidationError(
      `A quantidade máxima por registro é ${MAX_DISPLAY_QUANTITY.toLocaleString('pt-BR')} ${displayUnitOf(unit.dimension)}.`,
    );
  }
  if (base === 0 && !allowZero) throw new ValidationError('A quantidade deve ser maior que zero.');
  return base;
}

/** Texto decimal exato de um inteiro na base, na unidade pedida ("2.3"). */
function baseToDecimal(base, unitName) {
  const { scale } = getUnit(unitName);
  const digits = String(Math.abs(base)).padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, '');
  return (base < 0 ? '-' : '') + int + (fraction ? '.' + fraction : '');
}

/** Número na unidade pedida (contrato da API: 2300000 mg -> 2.3 kg). */
const fromBase = (base, unitName) => Number(baseToDecimal(base, unitName));

/** "2,3 kg"; com `best`, escolhe a maior unidade em que o valor é >= 1 (ex.: 200 g). */
function formatQuantity(base, unitName, { best = false } = {}) {
  let unit = getUnit(unitName);
  if (best && base !== 0) {
    const steps = DIMENSIONS[unit.dimension].steps.map(getUnit);
    unit = steps.find(step => Math.abs(base) >= 10 ** step.scale) || steps.at(-1);
  }
  const [int, fraction] = baseToDecimal(base, unit.symbol).split('.');
  const grouped = Number(int).toLocaleString('pt-BR');
  return `${grouped}${fraction ? ',' + fraction : ''} ${unit.symbol}`;
}

module.exports = {
  DIMENSIONS,
  UNITS,
  MAX_DISPLAY_QUANTITY,
  getUnit,
  displayUnitOf,
  compatible,
  toBase,
  baseToDecimal,
  fromBase,
  formatQuantity,
};
