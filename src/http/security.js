'use strict';

const { HttpError } = require('./errors');

// Sem 'unsafe-inline': todo script e estilo vem de arquivos do próprio app.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
}

/**
 * Escritas com corpo precisam ser JSON. Bloqueia CSRF por <form> de outro site
 * (que só envia text/plain, urlencoded ou multipart sem preflight de CORS).
 */
function requireJson(req, _res, next) {
  const hasBody = Number(req.get('content-length') || 0) > 0 || req.get('transfer-encoding') !== undefined;
  if (hasBody && !req.is('application/json')) return next(new HttpError(415, 'Envie os dados como JSON (Content-Type: application/json).'));
  next();
}

module.exports = { securityHeaders, requireJson, CSP };
