'use strict';

const { LOG_LEVELS } = require('./config');

// Campos que nunca devem chegar ao agregador de logs, em qualquer profundidade.
const SENSITIVE_KEY = /pass(word)?|senha|secret|token|authorization|cookie|api[-_]?key/i;
const REDACTED = '[redacted]';

function redact(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1)]));
}

/** Logger JSON (uma linha por evento), pronto para agregadores de log. */
function createLogger({ level = 'info', bindings = {}, write = line => process.stdout.write(line + '\n') } = {}) {
  const threshold = LOG_LEVELS.indexOf(level);
  const log = (lvl, msg, fields) => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg, ...redact({ ...bindings, ...fields }) }));
  };
  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: extra => createLogger({ level, bindings: { ...bindings, ...extra }, write }),
  };
}

const serializeError = err => ({ name: err.name, message: err.message, stack: err.stack });

module.exports = { createLogger, serializeError, redact };
