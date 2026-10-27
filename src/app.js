'use strict';

const express = require('express');
const path = require('node:path');
const { version } = require('../package.json');
const { createStore } = require('./store');
const { createLogger } = require('./logger');
const { todayIn } = require('./domain/dates');
const { securityHeaders, requireJson } = require('./http/security');
const { basicAuth } = require('./http/auth');
const { requestContext } = require('./http/request-context');
const { rateLimit } = require('./http/rate-limit');
const { errorHandler, notFound } = require('./http/errors');
const { inventoryRoutes } = require('./routes/inventory');
const { recipeRoutes } = require('./routes/recipes');
const { movementRoutes } = require('./routes/movements');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * @param db conexão better-sqlite3 já migrada
 * @param options.logger padrão: silencioso (testes)
 * @param options.now relógio injetável (testes de validade)
 * @param options.timeZone fuso que define "hoje" para validades
 * @param options.expiryWarningDays janela do alerta "vence em breve"
 * @param options.rateLimitPerMinute escritas por IP por minuto; 0 desativa
 * @param options.trustProxy saltos de proxy confiáveis para req.ip
 * @param options.basicAuth { user, password } protege o painel inteiro
 */
function createApp(
  db,
  {
    logger = createLogger({ level: 'silent' }),
    now = () => new Date(),
    timeZone = 'America/Sao_Paulo',
    expiryWarningDays = 3,
    rateLimitPerMinute = 0,
    trustProxy = 0,
    basicAuth: credentials = null,
  } = {},
) {
  const store = createStore(db, { now });
  const clock = { now, today: () => todayIn(timeZone, now()) };
  const context = { store, clock, warningDays: expiryWarningDays };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxy);

  app.use(requestContext(logger));
  app.use(securityHeaders);
  app.use(basicAuth(credentials));
  // Assets sem hash no nome: revalida sempre via ETag (304 barato, nunca desatualizado).
  app.use(express.static(PUBLIC_DIR, { setHeaders: res => res.set('Cache-Control', 'no-cache') }));

  const api = express.Router();
  const limiter = rateLimit({ limit: rateLimitPerMinute });
  api.use((req, res, next) => (MUTATING.has(req.method) ? limiter(req, res, next) : next()));
  api.use((req, res, next) => (MUTATING.has(req.method) ? requireJson(req, res, next) : next()));
  api.use(express.json({ limit: '32kb' }));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.get('/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', version });
  });
  api.use(inventoryRoutes(context));
  api.use('/recipes', recipeRoutes(context));
  api.use(movementRoutes(context));
  api.use((_req, _res, next) => next(notFound('Rota da API não encontrada.')));

  app.use('/api', api);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
