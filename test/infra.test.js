'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadConfig } = require('../src/config');
const { createLogger, redact } = require('../src/logger');
const { redactPath } = require('../src/http/request-context');
const { openDatabase, SCHEMA_VERSION } = require('../src/db');
const { createStore } = require('../src/store');
const { seedDemoData } = require('../src/seed');
const { createApp } = require('../src/app');

async function withServer(options, fn) {
  const server = createApp(openDatabase(':memory:'), options).listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('config: padrões e validação no boot', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3002);
  assert.equal(config.timeZone, 'America/Sao_Paulo');
  assert.equal(config.expiryWarningDays, 3);
  assert.equal(config.seedDemoData, true);
  assert.equal(config.basicAuth, null);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).seedDemoData, false);
  assert.equal(loadConfig({ NODE_ENV: 'production', SEED_DEMO_DATA: 'true' }).seedDemoData, true);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT inválido/);
  assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL inválido/);
  assert.throws(() => loadConfig({ APP_TIMEZONE: 'Marte/Base' }), /APP_TIMEZONE inválido/);
  assert.throws(() => loadConfig({ SEED_DEMO_DATA: 'talvez' }), /SEED_DEMO_DATA inválido/);
  assert.throws(() => loadConfig({ BASIC_AUTH_USER: 'cozinha' }), /juntos/);
  assert.throws(() => loadConfig({ BASIC_AUTH_USER: 'cozinha', BASIC_AUTH_PASSWORD: 'curta' }), /12 caracteres/);
});

test('logger: JSON por linha, respeita nível, herda campos e redige segredos', () => {
  const lines = [];
  const logger = createLogger({ level: 'info', write: line => lines.push(JSON.parse(line)) }).child({ requestId: 'abc' });
  logger.debug('oculto');
  logger.warn('visivel', { status: 404, headers: { authorization: 'Basic xyz' }, password: '123' });
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].level, lines[0].msg, lines[0].requestId, lines[0].status], ['warn', 'visivel', 'abc', 404]);
  assert.equal(lines[0].headers.authorization, '[redacted]');
  assert.equal(lines[0].password, '[redacted]');
  assert.deepEqual(redact({ list: [{ token: 'a' }] }), { list: [{ token: '[redacted]' }] });
  assert.equal(redactPath('/api/movements?ingredientId=1'), '/api/movements');
});

test('log de acesso com request id propagado', async () => {
  const lines = [];
  const logger = createLogger({ write: line => lines.push(JSON.parse(line)) });
  await withServer({ logger }, async url => {
    const res = await fetch(`${url}/api/summary?x=segredo`, { headers: { 'X-Request-Id': 'req-12345678' } });
    assert.equal(res.headers.get('x-request-id'), 'req-12345678');
    const invalid = await fetch(`${url}/api/health`, { headers: { 'X-Request-Id': 'inválido com espaço' } });
    assert.match(invalid.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });
  const entry = lines.find(l => l.msg === 'request' && l.requestId === 'req-12345678');
  assert.deepEqual([entry.status, entry.path, entry.method], [200, '/api/summary', 'GET']);
});

test('rate limit só em escritas e responde 429 com Retry-After', async () => {
  await withServer({ rateLimitPerMinute: 2 }, async url => {
    const write = () => fetch(`${url}/api/lots`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await write()).status, 400);
    assert.equal((await write()).status, 400);
    const limited = await write();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.match((await limited.json()).error, /Muitas requisições/);
    assert.equal((await fetch(`${url}/api/summary`)).status, 200);
  });
});

test('autenticação básica opcional protege painel e API, menos o health check', async () => {
  const basicAuth = { user: 'cozinha', password: 'senha-muito-forte' };
  const header = value => ({ Authorization: 'Basic ' + Buffer.from(value).toString('base64') });
  await withServer({ basicAuth }, async url => {
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    const denied = await fetch(`${url}/api/summary`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /^Basic/);
    assert.equal((await fetch(`${url}/`)).status, 401);
    assert.equal((await fetch(`${url}/api/summary`, { headers: header('cozinha:errada') })).status, 401);
    assert.equal((await fetch(`${url}/api/summary`, { headers: header('cozinha:senha-muito-forte') })).status, 200);
  });
});

test('página e assets com CSP, sem cache agressivo e sem estilos inline', async () => {
  await withServer({}, async url => {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    const html = await res.text();
    assert.match(html, /<title>/);
    assert.doesNotMatch(html, /\sstyle=|<style|<script>(?!<\/script>)|\son[a-z]+="/i);
    assert.equal((await fetch(`${url}/theme.js`)).status, 200);
    assert.equal((await fetch(`${url}/mark-ec.svg`)).status, 200);
  });
});

test('dados de demonstração só entram em banco vazio', () => {
  const store = createStore(openDatabase(':memory:'));
  assert.equal(seedDemoData(store, '2026-03-10'), true);
  assert.equal(seedDemoData(store, '2026-03-10'), false);
  assert.equal(store.countIngredients(), 6);
  assert.equal(store.recipes('2026-03-10').length, 2);
});

test('backup gera cópia consistente e aplica retenção', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estoquecerto-backup-'));
  try {
    const databasePath = path.join(dir, 'app.sqlite');
    openDatabase(databasePath).close();
    const env = { ...process.env, DATABASE_PATH: databasePath, BACKUP_KEEP: '2' };
    for (let i = 0; i < 3; i++)
      execFileSync(process.execPath, ['scripts/backup.js', path.join(dir, 'bk')], { env, cwd: path.join(__dirname, '..') });
    const files = fs.readdirSync(path.join(dir, 'bk'));
    assert.equal(files.length, 2);
    const copy = openDatabase(path.join(dir, 'bk', files[0]));
    assert.equal(copy.pragma('user_version', { simple: true }), SCHEMA_VERSION);
    copy.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
