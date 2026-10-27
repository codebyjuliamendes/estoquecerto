'use strict';

const { ValidationError, ConflictError } = require('../domain/errors');
const { serializeError } = require('../logger');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = message => new HttpError(404, message);

// Erros sempre em JSON; detalhes de falhas inesperadas só no log.
function errorHandler(err, req, res, _next) {
  if (res.headersSent) return req.socket.destroy();
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'O corpo da requisição não é um JSON válido.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'A requisição é grande demais.' });
  if (err.code === 'SQLITE_BUSY') {
    (req.log ?? console).warn('database_busy', { err: serializeError(err) });
    return res.status(503).set('Retry-After', '1').json({ error: 'O banco está ocupado. Tente de novo em instantes.' });
  }
  (req.log ?? console).error('unhandled_error', { err: serializeError(err) });
  res.status(500).json({ error: 'Não foi possível concluir a ação.' });
}

module.exports = { HttpError, notFound, errorHandler };
