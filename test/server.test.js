const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let child, baseUrl, tempDir;
before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'estoquecerto-test-'));
  const port = 20000 + Math.floor(Math.random() * 40000);
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DATABASE_PATH: path.join(tempDir, 'test.sqlite') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/summary`)).ok) return;
    } catch {
      // servidor ainda subindo
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not become ready');
});
after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});
async function json(url, options) {
  const response = await fetch(baseUrl + url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
  return { response, body: await response.json() };
}
test('converts compatible units, rejects incompatible units, and exports safe CSV', async () => {
  const expiresOn = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const first = await json('/api/lots', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Flour', unit: 'kg', quantity: 2, minimum: 0.5, expiresOn }),
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.quantity, 2);
  const second = await json('/api/lots', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Flour', unit: 'g', quantity: 500, minimum: 200, expiresOn }),
  });
  assert.equal(second.response.status, 201);
  assert.equal(second.body.quantity, 0.5);
  const invalid = await json('/api/lots', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Flour', unit: 'ml', quantity: 250, expiresOn }),
  });
  assert.equal(invalid.response.status, 400);
  const recipe = await json('/api/recipes', {
    method: 'POST',
    body: JSON.stringify({ name: 'Test Pancakes', items: [{ name: 'Test Flour', quantity: 200, unit: 'g' }] }),
  });
  assert.equal(recipe.response.status, 201);
  const prepared = await json(`/api/recipes/${recipe.body.id}/prepare`, { method: 'POST', body: JSON.stringify({ portions: 1 }) });
  assert.equal(prepared.response.status, 200);
  const summary = await json('/api/summary');
  assert.equal(summary.body.inventory.find(i => i.name === 'Test Flour').quantity, 2.3);
  await json('/api/lots', { method: 'POST', body: JSON.stringify({ name: '=Formula', unit: 'kg', quantity: 1, expiresOn }) });
  const csv = await fetch(baseUrl + '/api/export/inventory.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(await csv.text(), /"'=Formula"/);
});

test('encerra de forma graciosa com SIGTERM', async () => {
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});
