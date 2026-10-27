'use strict';

// Validades são datas civis ("AAAA-MM-DD"), sem hora. "Hoje" é calculado no fuso
// do restaurante: em UTC, às 21h de Brasília o dia já teria virado.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function isValidIsoDate(text) {
  const match = typeof text === 'string' ? ISO_DATE.exec(text) : null;
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Data civil de `now` no fuso informado. */
function todayIn(timeZone, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map(p => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const toUtcMs = iso => Date.parse(`${iso}T00:00:00Z`);

function addDays(iso, days) {
  return new Date(toUtcMs(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Dias inteiros de `from` até `to` (negativo se `to` já passou). */
const daysBetween = (from, to) => Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);

// O lote vale até o fim do dia da validade: vence hoje ainda pode ser usado.
const isExpired = (expiresOn, today) => expiresOn < today;

/** 'vencido' | 'vence_hoje' | 'vence_em_breve' | 'ok' */
function expiryStatus(expiresOn, today, warningDays) {
  const days = daysBetween(today, expiresOn);
  if (days < 0) return 'vencido';
  if (days === 0) return 'vence_hoje';
  if (days <= warningDays) return 'vence_em_breve';
  return 'ok';
}

/** "2026-03-10" -> "10/03/2026" (textos do histórico). */
const formatDateBR = iso => iso.split('-').reverse().join('/');

module.exports = { formatDateBR, isValidIsoDate, isValidTimeZone, todayIn, addDays, daysBetween, isExpired, expiryStatus };
