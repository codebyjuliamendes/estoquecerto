'use strict';

const path = require('node:path');
const { isValidTimeZone } = require('./domain/dates');

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

function int(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} inválido: "${raw}" (inteiro entre ${min} e ${max}).`);
  return value;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'sim'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'nao', 'não'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} inválido: "${raw}" (true ou false).`);
}

/** Lê e valida o ambiente uma vez; falha no boot em vez de em runtime. */
function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const logLevel = env.LOG_LEVEL || 'info';
  if (!LOG_LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL inválido: "${logLevel}" (${LOG_LEVELS.join(', ')}).`);
  const timeZone = env.APP_TIMEZONE || 'America/Sao_Paulo';
  if (!isValidTimeZone(timeZone)) throw new Error(`APP_TIMEZONE inválido: "${timeZone}" (ex.: America/Sao_Paulo).`);

  const authUser = env.BASIC_AUTH_USER || '';
  const authPassword = env.BASIC_AUTH_PASSWORD || '';
  if (Boolean(authUser) !== Boolean(authPassword)) throw new Error('Defina BASIC_AUTH_USER e BASIC_AUTH_PASSWORD juntos.');
  if (authPassword && authPassword.length < 12) throw new Error('BASIC_AUTH_PASSWORD deve ter ao menos 12 caracteres.');

  return Object.freeze({
    env: nodeEnv,
    port: int(env, 'PORT', 3002, { min: 1, max: 65535 }),
    databasePath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'estoque.sqlite'),
    logLevel,
    // Saltos de proxy confiáveis (ex.: 1 atrás de Nginx/Fly/Render) para obter o IP real.
    trustProxy: int(env, 'TRUST_PROXY', 0, { min: 0, max: 10 }),
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 120, { min: 0 }),
    timeZone,
    expiryWarningDays: int(env, 'EXPIRY_WARNING_DAYS', 3, { min: 0, max: 60 }),
    // Dados fictícios só fora de produção, salvo pedido explícito.
    seedDemoData: bool(env, 'SEED_DEMO_DATA', nodeEnv !== 'production'),
    basicAuth: authUser ? Object.freeze({ user: authUser, password: authPassword }) : null,
  });
}

module.exports = { loadConfig, LOG_LEVELS };
