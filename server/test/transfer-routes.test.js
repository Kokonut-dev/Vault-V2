/**
 * /api/transfer and /api/server/keep-awake:
 *   - export links are admin-only, expire, and stream a valid zip whose
 *     Content-Length matches the body (browsers show real progress),
 *   - import is admin-only once set up, open in a brand-new server's wizard,
 *   - "keep running when locked" is admin-only, saved, and applied at once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.server = { ...memory.server, host: '127.0.0.1', port: 4000, keepAwake: true };
memory.auth = { ...memory.auth, username: 'admin', jwtSecret: 'test-secret-'.padEnd(48, 'x') };
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const jsonStore = require('../utils/jsonStore');
jsonStore.createJsonStore = (_name, defaultValue) => {
  let data = structuredClone(defaultValue);
  return { get: () => data, set: (next) => { data = next; }, update: (fn) => { data = fn(data) ?? data; return data; }, save: () => {}, flush: async () => {} };
};

const profiles = require('../services/profiles');
profiles.get = (id) => ({ default: { id: 'default', name: 'admin', isAdmin: true }, kid: { id: 'kid', name: 'Kid', isAdmin: false } }[id] || null);

// Never spawn caffeinate & co. from tests.
const keepAwake = require('../utils/keepAwake');
const spawned = [];
keepAwake._setPlatform('darwin');
keepAwake._setSpawn((cmd, args) => {
  const proc = new (require('node:events'))();
  proc.kill = () => { proc.killed = true; };
  proc.unref = () => {};
  spawned.push({ cmd, args, proc });
  return proc;
});

const transfer = require('../services/transfer');
const zip = require('../utils/zipStream');
const authService = require('../services/authService');
const sessions = require('../services/sessions');
const { authMiddleware } = require('../middleware/auth');
require('./helpers/terms').autoAcceptTerms(); // not a Terms of Use test (see test/terms.test.js)
const transferRouter = require('../routes/transfer');

function tokenFor(profileId) {
  const session = sessions.create({ username: 'admin', profileId, req: { headers: {}, ip: '127.0.0.1' }, label: 'test' });
  return authService.generateAccessToken('admin', { sid: session.id, profileId });
}

let server;
let port;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/transfer', transferRouter);
  app.use('/api/server', authMiddleware, require('../routes/serverControl'));
  app.use('/api/system', authMiddleware, require('../routes/system'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => { keepAwake.stop(); return new Promise(r => server.close(r)); });

function call(method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { /* binary */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('export links: admin only, expire, and stream a zip with an exact Content-Length', async () => {
  transferRouter._internals.access.needsSetup = () => false;
  const original = transfer.planExport;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-dl-'));
  const film = path.join(tmp, 'Film.mkv');
  fs.writeFileSync(film, Buffer.alloc(50000, 7));
  transfer.planExport = async ({ includeMedia }) => ({
    entries: [
      { name: 'vault-transfer.json', data: Buffer.from(JSON.stringify({ format: 'vault-transfer', version: 1, includesMedia: includeMedia })) },
      ...(includeMedia ? [{ name: 'media/Movies/Film.mkv', size: 50000, path: film, mtime: new Date() }] : []),
    ],
    manifest: {},
  });
  try {
    assert.equal((await call('POST', '/api/transfer/export-link', { body: { media: true } })).status, 401);
    assert.equal((await call('POST', '/api/transfer/export-link', { body: { media: true }, token: tokenFor('kid') })).status, 403);

    const link = await call('POST', '/api/transfer/export-link', { body: { media: true }, token: tokenFor('default') });
    assert.equal(link.status, 200);
    assert.match(link.body.url, /^\/api\/transfer\/download\/[\w-]{20,}$/);
    assert.match(link.body.fileName, /^Vault transfer - .+\.zip$/);

    // No Authorization header needed: the link itself is the credential, so
    // it can be opened on the new computer.
    const dl = await call('GET', link.body.url);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers['content-type'], 'application/zip');
    assert.match(dl.headers['content-disposition'], /attachment; filename=/);
    assert.equal(Number(dl.headers['content-length']), dl.raw.length);
    const file = path.join(tmp, 'dl.zip');
    fs.writeFileSync(file, dl.raw);
    const entries = await zip.listZip(file);
    assert.deepEqual(entries.map(e => e.name), ['vault-transfer.json', 'media/Movies/Film.mkv']);
    assert.deepEqual(await zip.readEntry(file, entries[1]), Buffer.alloc(50000, 7));

    assert.equal((await call('GET', '/api/transfer/download/not-a-real-ticket')).status, 410);
    const { tickets } = transferRouter._internals;
    const ticket = link.body.url.split('/').pop();
    tickets.get(ticket).expires = Date.now() - 1;
    assert.equal((await call('GET', link.body.url)).status, 410, 'expired links stop working');
  } finally {
    transfer.planExport = original;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('import: admin only on a configured server, open in a new server’s setup wizard', async () => {
  transferRouter._internals.access.needsSetup = () => false;
  assert.equal((await call('POST', '/api/transfer/inspect', { body: { source: '/nope.zip' } })).status, 401);
  assert.equal((await call('POST', '/api/transfer/inspect', { body: { source: '/nope.zip' }, token: tokenFor('kid') })).status, 403);
  const admin = await call('POST', '/api/transfer/inspect', { body: { source: '/definitely/missing.zip' }, token: tokenFor('default') });
  assert.equal(admin.status, 400);
  assert.equal(admin.body.code, 'NOT_FOUND');

  transferRouter._internals.access.needsSetup = () => true;
  const wizard = await call('GET', '/api/transfer');
  assert.equal(wizard.status, 200);
  assert.equal(wizard.body.setupMode, true);
  assert.ok(path.isAbsolute(wizard.body.defaults.mediaDir));
  const bad = await call('POST', '/api/transfer/import', { body: { source: '/definitely/missing.zip', mediaDir: '/tmp/x' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'source');
  const relative = await call('POST', '/api/transfer/import', { body: { source: '/x.zip', mediaDir: 'media' } });
  assert.equal(relative.status, 400);
  assert.equal(relative.body.field, 'mediaDir');
  // Export never opens up, even before setup.
  assert.equal((await call('POST', '/api/transfer/export-link', { body: {} })).status, 401);
  transferRouter._internals.access.needsSetup = () => false;
});

test('keep running when locked: status for everyone, admin-only switch that applies immediately', async () => {
  const info = await call('GET', '/api/server', { token: tokenFor('kid') });
  assert.equal(info.status, 200);
  assert.equal(info.body.keepAwake.supported, true);
  assert.equal(info.body.keepAwake.enabled, true);
  assert.match(info.body.keepAwake.note, /lid/);

  assert.equal((await call('PUT', '/api/server/keep-awake', { body: { enabled: false }, token: tokenFor('kid') })).status, 403);
  assert.equal((await call('PUT', '/api/server/keep-awake', { body: { enabled: 'yes' }, token: tokenFor('default') })).status, 400);

  const on = await call('PUT', '/api/server/keep-awake', { body: { enabled: true }, token: tokenFor('default') });
  assert.equal(on.status, 200);
  assert.equal(on.body.keepAwake.active, true);
  const last = spawned.at(-1);
  assert.equal(last.cmd, '/usr/bin/caffeinate');
  assert.deepEqual(last.args.slice(0, 4), ['-i', '-m', '-s', '-w']);
  assert.equal(last.args[4], String(process.pid), 'tied to the server process, so a crash releases it');

  const off = await call('PUT', '/api/server/keep-awake', { body: { enabled: false }, token: tokenFor('default') });
  assert.equal(off.body.keepAwake.enabled, false);
  assert.equal(off.body.keepAwake.active, false);
  assert.equal(last.proc.killed, true);
  assert.equal(memory.server.keepAwake, false, 'saved to config.json');
});

test('keep-awake commands per platform', () => {
  const win = keepAwake.command(1234, 'win32');
  assert.equal(win.cmd, 'powershell.exe');
  assert.match(win.args.at(-1), /SetThreadExecutionState\(\[uint32\]2147483649\)/);
  assert.match(win.args.at(-1), /Wait-Process -Id 1234/);
  assert.equal(keepAwake.command(1234, 'darwin').args.at(-1), '1234');
  assert.equal(keepAwake.command(1234, 'aix'), null);
});

test('system console: kids can read status but not restore, delete or download backups', async () => {
  const kid = tokenFor('kid');
  assert.equal((await call('POST', '/api/system/backups/restore', { body: { name: 'x.zip' }, token: kid })).status, 403);
  assert.equal((await call('DELETE', '/api/system/backups/x.zip', { token: kid })).status, 403);
  assert.equal((await call('GET', '/api/system/backups', { token: kid })).status, 403);
  assert.equal((await call('GET', '/api/system/logs', { token: kid })).status, 403);
  assert.equal((await call('DELETE', '/api/system/cache', { token: kid })).status, 403);
  assert.equal((await call('GET', '/api/system/capabilities', { token: kid })).status, 200);
  assert.equal((await call('GET', '/api/system/backups', { token: tokenFor('default') })).status, 200);
});
