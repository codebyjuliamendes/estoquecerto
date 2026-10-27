'use strict';

const { addDays, daysBetween } = require('./dates');

// Rótulos legados do campo `status` (contrato da API e do CSV).
const STATUS = Object.freeze({ LOW: 'Baixo', EXPIRING: 'Vence em breve', OK: 'Em dia' });

/**
 * Situação de um ingrediente. `available` exclui lotes vencidos; `expired` é o
 * saldo vencido aguardando descarte. No mínimo ou abaixo dele conta como baixo.
 */
function ingredientStatus({ available, minimum, expired, nextExpiry }, today, warningDays) {
  const low = available <= minimum;
  const expiring = Boolean(nextExpiry) && nextExpiry <= addDays(today, warningDays);
  const alerts = [];
  if (available === 0) alerts.push('sem_estoque');
  else if (low) alerts.push('abaixo_do_minimo');
  if (expired > 0) alerts.push('vencido');
  if (expiring) alerts.push(nextExpiry === today ? 'vence_hoje' : 'vence_em_breve');
  return {
    status: low ? STATUS.LOW : expiring ? STATUS.EXPIRING : STATUS.OK,
    alerts,
    daysToExpiry: nextExpiry ? daysBetween(today, nextExpiry) : null,
  };
}

module.exports = { STATUS, ingredientStatus };
