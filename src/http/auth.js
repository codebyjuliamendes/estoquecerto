'use strict';

const crypto = require('node:crypto');

// Comparação em tempo constante sobre hashes (tamanhos iguais, sem vazar o comprimento).
const digest = value => crypto.createHash('sha256').update(value).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

/**
 * HTTP Basic opcional para todo o painel (API e arquivos estáticos).
 * /api/health fica aberto para healthchecks de container e balanceador.
 */
function basicAuth(credentials) {
  return (req, res, next) => {
    if (!credentials || req.path === '/api/health') return next();
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const okUser = safeEqual(decoded.slice(0, sep), credentials.user);
      const okPassword = safeEqual(decoded.slice(sep + 1), credentials.password);
      if (sep > 0 && okUser && okPassword) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="EstoqueCerto", charset="UTF-8"');
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Autenticação necessária.' });
    res.status(401).type('text').send('Autenticação necessária.');
  };
}

module.exports = { basicAuth };
