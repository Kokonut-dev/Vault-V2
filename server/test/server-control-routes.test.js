/**
 * Routes behind the new buttons:
 *   /api/server  — status for everyone, restart/stop/network admin-only,
 *                  409 NOT_SUPERVISED without the launcher,
 *   /api/remote  — admin-only,
 *   /api/import  — admin-only; Google errors never surface as 401 (the app
 *                  treats every 401 as "signed out"),
 *   /api/auth/pair — QR sign-in from a signed-in device: single use,
 *                  non-consuming state for the showing device, the session
 *                  is only created on redeem, and guessing is throttled.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configModule = require('../config');
// A server that has finished setup: before setup, other devices (the
// X-Forwarded-For requests below) are refused by services/setupGuard.js.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-server-control-'));
configModule.CONFIG_PATH = path.join(TMP, 'config.json');
fs.writeFileSync(configModule.CONFIG_PATH, JSON.stringify({ auth: { username: 'admin', passwordHash: 'set' } }));
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.server = { ...memory.server, host: '127.0.0.1', port: 4000 };
memory.auth = { ...memory.auth, username: 'admin', jwtSecret: 'test-secret-'.padEnd(48, 'x') };
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const jsonStore = require('../utils/jsonStore');
jsonStore.createJsonStore = (_name, defaultValue) => {
  let data = structuredClone(defaultValue);
  return { get: () => data, set: (next) => { data = next; }, update: (fn) => { data = fn(data) ?? data; return data; }, save: () => {}, flush: async () => {} };
};

const profiles = require('../services/profiles');
profiles.get = (id) => ({ default: { id: 'default', name: 'admin', isAdmin: true }, kid: { id: 'kid', name: 'Kid', isAdmin: false }, kids: { id: 'kids', name: 'Kids', isAdmin: false, kids: true } }[id] || null);
profiles.toPublic = (p) => (p ? { id: p.id, name: p.name, isAdmin: p.isAdmin } : null);

const authService = require('../services/authService');
const sessions = require('../services/sessions');
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/requireAdmin');
const authRouter = require('../routes/auth');

function tokenFor(profileId) {
  const session = sessions.create({ username: 'admin', profileId, req: { headers: {}, ip: '127.0.0.1' }, label: 'test' });
  return authService.generateAccessToken('admin', { sid: session.id, profileId });
}

let server;
let port;
test.before(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/server', authMiddleware, require('../routes/serverControl'));
  app.use('/api/remote', authMiddleware, requireAdmin, require('../routes/remote'));
  app.use('/api/import', authMiddleware, requireAdmin, require('../routes/imports'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  return new Promise(r => server.close(r));
});

function call(method, path, { body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* */ } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('/api/server: status for any profile, changes for admins, 409 without the launcher', async () => {
  const admin = tokenFor('default');
  const kid = tokenFor('kid');
  const info = await call('GET', '/api/server', { token: kid });
  assert.equal(info.status, 200);
  assert.equal(info.body.supervised, false);
  assert.equal(info.body.network.lan, false);
  assert.equal((await call('POST', '/api/server/restart', { token: kid })).status, 403);
  const restart = await call('POST', '/api/server/restart', { token: admin });
  assert.equal(restart.status, 409);
  assert.equal(restart.body.code, 'NOT_SUPERVISED');
  assert.equal((await call('POST', '/api/server/stop', { token: admin })).body.code, 'NOT_SUPERVISED');
  assert.equal((await call('PUT', '/api/server/network', { token: admin, body: { lan: 'yes' } })).status, 400);
  const open = await call('PUT', '/api/server/network', { token: admin, body: { lan: true } });
  assert.equal(open.body.restartRequired, true);
  assert.equal(memory.server.host, '0.0.0.0');
  const same = await call('PUT', '/api/server/network', { token: admin, body: { lan: true } });
  assert.equal(same.body.restartRequired, false);
  assert.equal((await call('GET', '/api/server')).status, 401);
});

test('/api/remote and /api/import are admin-only', async () => {
  const kid = tokenFor('kid');
  for (const [m, p] of [['GET', '/api/remote'], ['POST', '/api/remote/tunnel'], ['GET', '/api/import/jobs'], ['POST', '/api/import/gdrive/inspect']]) {
    const r = await call(m, p, { token: kid, body: m === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.code, 'ADMIN_REQUIRED');
  }
  const status = await call('GET', '/api/remote', { token: tokenFor('default') });
  assert.equal(status.status, 200);
  assert.ok(Array.isArray(status.body.lan.addresses));
});

test('/api/import: validation and token errors are 400, never 401', async () => {
  const admin = tokenFor('default');
  const bad = await call('POST', '/api/import/gdrive/inspect', { token: admin, body: { link: 'https://example.com/x' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'INVALID_LINK');
  const malformed = await call('GET', '/api/import/gdrive/browse', { token: admin, headers: { 'X-Google-Token': 'bad token with spaces' } });
  assert.equal(malformed.status, 400);
  const noToken = await call('GET', '/api/import/gdrive/browse', { token: admin });
  assert.equal(noToken.status, 400);
  assert.equal(noToken.body.code, 'NO_TOKEN');
  const sel = await call('POST', '/api/import/gdrive', { token: admin, body: { link: 'https://drive.google.com/file/d/abcdefghijk/view', selection: 'all' } });
  assert.equal(sel.body.code, 'INVALID_SELECTION');

  const cfg = await call('PUT', '/api/import/gdrive/config', { token: admin, body: { apiKey: 'AIzaSyA1234567890abcdefghijklmnopqrstu', clientId: 'nope' } });
  assert.equal(cfg.status, 400);
  assert.equal(cfg.body.field, 'clientId');
  const ok = await call('PUT', '/api/import/gdrive/config', { token: admin, body: { apiKey: 'AIzaSyA1234567890abcdefghijklmnopqrstu', clientId: '123-abc.apps.googleusercontent.com' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.apiKeyConfigured, true);
  assert.equal(ok.body.apiKeyHint, 'AIza…rstu');
  assert.ok(!JSON.stringify(ok.body).includes('1234567890abcdefghijklmnop'), 'the key never comes back');
  const removed = await call('PUT', '/api/import/gdrive/config', { token: admin, body: { apiKey: '' } });
  assert.equal(removed.body.apiKeyConfigured, false);
  assert.equal(removed.body.clientId, '123-abc.apps.googleusercontent.com');
});

test('QR sign-in: pre-approved, single-use, session created on redeem only', async () => {
  authRouter._resetPairingForTests();
  const admin = tokenFor('default');
  const before = sessions.list ? sessions.list().length : null;
  const made = await call('POST', '/api/auth/pair', { token: admin, body: { baseUrl: 'http://192.168.1.9:4000/', deviceLabel: 'Phone' } });
  assert.equal(made.status, 200);
  assert.equal(made.body.approved, true);
  assert.equal(made.body.url, `http://192.168.1.9:4000/?pair=${made.body.token}`);
  assert.match(made.body.code, /^\d{6}$/);
  if (before !== null) assert.equal(sessions.list().length, before, 'no session until the code is used');

  assert.equal((await call('GET', `/api/auth/pair/${made.body.code}/state`, { token: admin })).body.status, 'waiting');
  assert.equal((await call('GET', `/api/auth/pair/${made.body.code}/state`)).status, 401, 'state needs a signed-in device');

  const redeemed = await call('POST', '/api/auth/pair/exchange', { body: { token: made.body.token } });
  assert.equal(redeemed.status, 200);
  assert.ok(redeemed.body.token);
  const me = await call('GET', '/api/server', { token: redeemed.body.token });
  assert.equal(me.status, 200, 'the new device is signed in');
  assert.equal((await call('GET', `/api/auth/pair/${made.body.code}/state`, { token: admin })).body.status, 'used');
  assert.equal((await call('POST', '/api/auth/pair/exchange', { body: { token: made.body.token } })).status, 404);
  assert.equal((await call('GET', `/api/auth/pair/${made.body.code}`)).status, 404, 'the digits die with the link');

  // Codes from a signed-out device (TV flow) wait for approval.
  const tv = await call('POST', '/api/auth/pair', { body: {} });
  assert.equal(tv.body.approved, false);
  assert.equal((await call('POST', '/api/auth/pair/exchange', { body: { token: tv.body.token } })).status, 202);
  assert.equal((await call('GET', `/api/auth/pair/${tv.body.code}`)).body.status, 'pending');
  await call('POST', '/api/auth/pair/approve', { token: admin, body: { code: tv.body.code } });
  const tvIn = await call('GET', `/api/auth/pair/${tv.body.code}`);
  assert.equal(tvIn.body.status, 'approved');
  assert.ok(tvIn.body.token);

  // A restricted profile can't hand the new device someone else's profile.
  const kid = tokenFor('kids');
  const tv2 = await call('POST', '/api/auth/pair', { body: {} });
  const approved = await call('POST', '/api/auth/pair/approve', { token: kid, body: { code: tv2.body.code, profileId: 'default', deviceLabel: 'x'.repeat(500) } });
  assert.equal(approved.status, 200);
  const session = sessions.get(approved.body.sessionId);
  assert.equal(session.profileId, 'kids');
  assert.ok(session.device.length <= 60);
});

test('guessing pairing codes is throttled per IP', async () => {
  authRouter._resetPairingForTests();
  const guesses = [];
  for (let i = 0; i < 12; i++) guesses.push((await call('GET', `/api/auth/pair/${100000 + i}`, { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status);
  assert.deepEqual(guesses.slice(0, 10), Array(10).fill(404));
  assert.deepEqual(guesses.slice(10), [429, 429]);
  // Another device is unaffected.
  assert.equal((await call('GET', '/api/auth/pair/123456', { headers: { 'X-Forwarded-For': '203.0.113.8' } })).status, 404);
  assert.equal((await call('POST', '/api/auth/pair/exchange', { body: { token: 'x' }, headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 429);
  authRouter._resetPairingForTests();
});
