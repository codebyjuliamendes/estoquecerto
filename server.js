'use strict';

const { loadConfig } = require('./src/config');
const { createLogger, serializeError } = require('./src/logger');
const { openDatabase } = require('./src/db');
const { createStore } = require('./src/store');
const { seedDemoData } = require('./src/seed');
const { todayIn } = require('./src/domain/dates');
const { createApp } = require('./src/app');

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, bindings: { service: 'estoquecerto' } });
const db = openDatabase(config.databasePath);
if (config.seedDemoData && seedDemoData(createStore(db), todayIn(config.timeZone))) logger.info('demo_data_seeded');

const app = createApp(db, {
  logger,
  timeZone: config.timeZone,
  expiryWarningDays: config.expiryWarningDays,
  rateLimitPerMinute: config.rateLimitPerMinute,
  trustProxy: config.trustProxy,
  basicAuth: config.basicAuth,
});

const server = app.listen(config.port, () =>
  logger.info('server_started', { port: config.port, env: config.env, timeZone: config.timeZone, auth: Boolean(config.basicAuth) }),
);

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info('shutdown', { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Conexões keep-alive ociosas não seguram o encerramento.
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', reason => logger.error('unhandled_rejection', { err: serializeError(Object(reason)) }));
process.on('uncaughtException', err => {
  logger.error('uncaught_exception', { err: serializeError(err) });
  process.exit(1);
});
