/**
 * /api/system routes behind the Server page:
 *   - /health carries the last scan, scan state and index status,
 *   - /disk reports free/used space per filesystem,
 *   - agent updates only accept apiKey/enabled and never echo the key,
 *   - backup restore/delete refuse files that aren't there,
 *   - the notification test reports per-target results,
 *   - a scan records when it ran, and a failed scan doesn't leave a
 *     "running" job behind.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-system-'));
const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.server = { ...memory.server, host: '127.0.0.1', port: 4000 };
memory.auth = { ...memory.auth, username: 'admin', jwtSecret: 'test-secret-'.padEnd(48, 'x') };
memory.media = { ...memory.media, paths: { movies: path.join(tmp, 'movies'), music: path.join(tmp, 'music', 'not-yet-created') } };
memory.notifications = {};
fs.mkdirSync(memory.media.paths.movies, { recursive: true });
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const jsonStore = require('../utils/jsonStore');
jsonStore.createJsonStore = (_name, defaultValue) => {
  let data = structuredClone(defaultValue);
  return { get: () => data, set: (next) => { data = next; }, update: (fn) => { data = fn(data) ?? data; return data; }, save: () => {}, saveNow: async () => {}, flush: async () => {} };
};

const profiles = require('../services/profiles');
profiles.get = (id) => ({ default: { id: 'default', name: 'admin', isAdmin: true }, kid: { id: 'kid', name: 'Kid', isAdmin: false } }[id] || null);

const libraryService = require('../services/library');
libraryService.getAll = () => [];

const events = require('../services/events');
const scanner = require('../services/scanner');
const authService = require('../services/authService');
const sessions = require('../services/sessions');
const { authMiddleware } = require('../middleware/auth');

function tokenFor(profileId) {
  const session = sessions.create({ username: 'admin', profileId, req: { headers: {}, ip: '127.0.0.1' }, label: 'test' });
  return authService.generateAccessToken('admin', { sid: session.id, profileId });
}

let server;
let port;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/system', authMiddleware, require('../routes/system'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  return new Promise(r => server.close(r));
});

function call(method, urlPath, { body, token = tokenFor('default') } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('scans are recorded, and a failed scan finishes its job as an error', async () => {
  assert.equal(scanner.getLastScan(), null);
  const ok = await scanner.scanAll();
  assert.equal(ok.scanned, 0);
  const last = scanner.getLastScan();
  assert.equal(last.status, 'done');
  assert.equal(last.scanned, 0);
  assert.ok(Date.now() - Date.parse(last.at) < 5000);

  const finished = [];
  const originalFinish = events.jobFinish;
  events.jobFinish = (id, status, meta) => { finished.push({ id, status, meta }); return originalFinish(id, status, meta); };
  const originalGetAll = libraryService.getAll;
  libraryService.getAll = () => { throw new Error('disk on fire'); };
  try {
    await assert.rejects(scanner.scanAll(), /disk on fire/);
  } finally {
    libraryService.getAll = originalGetAll;
    events.jobFinish = originalFinish;
  }
  assert.deepEqual(finished.map(f => f.status), ['error']);
  assert.equal(events.jobList().filter(j => j.kind === 'scan').length, 0, 'no zombie scan job');
  assert.equal(scanner.getLastScan().status, 'error');
  assert.equal(scanner.getLastScan().error, 'disk on fire');
  assert.equal(scanner.isScanning(), false);
});

test('/health includes last scan, scan state and index status', async () => {
  const res = await call('GET', '/api/system/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.totals.items, 0);
  assert.equal(res.body.deep, false);
  assert.equal(res.body.scanning, false);
  assert.ok(res.body.lastScan && res.body.lastScan.at);
  assert.ok(res.body.index && 'sqliteAvailable' in res.body.index);
  // Readable by every profile; only changes are admin-only.
  assert.equal((await call('GET', '/api/system/health', { token: tokenFor('kid') })).status, 200);
  assert.equal((await call('POST', '/api/system/health/prune-missing', { token: tokenFor('kid') })).status, 403);
});

test('/disk reports free and used space per filesystem', async () => {
  const res = await call('GET', '/api/system/disk');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.volumes));
  assert.ok(res.body.volumes.length >= 1);
  const [primary] = res.body.volumes;
  assert.ok(primary.total > 0);
  assert.ok(primary.free >= 0 && primary.free <= primary.total);
  assert.equal(primary.used, primary.total - primary.free);
  // A folder that doesn't exist yet is measured at its parent, on the same
  // filesystem as its sibling, so both collapse into one entry.
  assert.ok(primary.labels.includes('movies'));
  assert.ok(primary.labels.includes('music'));
});

test('agent updates only take apiKey/enabled and never echo the key', async () => {
  const res = await call('POST', '/api/system/agents/tmdb', { body: { apiKey: '  abcdef0123456789  ', evil: 'x', baseUrl: 'http://169.254.169.254' } });
  assert.equal(res.status, 200);
  assert.deepEqual(memory.metadata.providers.tmdb, { apiKey: 'abcdef0123456789', enabled: true });
  assert.deepEqual(res.body.providers.tmdb, { enabled: true, requiresKey: true, switchedOn: true, hasKey: true });
  assert.ok(!JSON.stringify(res.body).includes('abcdef0123456789'));

  // Turning it off keeps the key.
  await call('POST', '/api/system/agents/tmdb', { body: { enabled: false } });
  assert.equal(memory.metadata.providers.tmdb.apiKey, 'abcdef0123456789');
  const status = (await call('GET', '/api/system/agents')).body.providers.tmdb;
  assert.equal(status.enabled, false);
  assert.equal(status.hasKey, true);

  assert.equal((await call('POST', '/api/system/agents/musicbrainz', { body: { apiKey: 'nope-nope-nope' } })).status, 400);
  assert.equal((await call('POST', '/api/system/agents/other', { body: {} })).status, 400);
  assert.equal((await call('POST', '/api/system/agents/tmdb', { body: { enabled: true }, token: tokenFor('kid') })).status, 403);
});

test('backup restore/delete refuse files that are not there', async () => {
  assert.equal((await call('POST', '/api/system/backups/restore', { body: { file: 'missing.zip' } })).status, 404);
  assert.equal((await call('POST', '/api/system/backups/restore', { body: { file: '../config.json' } })).status, 404);
  assert.equal((await call('POST', '/api/system/backups/restore', { body: {} })).status, 400);
  assert.equal((await call('DELETE', '/api/system/backups/missing.zip')).status, 404);
  assert.equal((await call('DELETE', '/api/system/backups/library.json')).status, 400);
});

test('notification test reports per-target results', async () => {
  const res = await call('POST', '/api/system/notifications/test');
  assert.equal(res.status, 200);
  assert.equal(res.body.sent, 0);
  assert.equal(res.body.ok, 0);
  assert.match(res.body.message, /No notification targets/);
});

test('capabilities report ffprobe alongside ffmpeg', async () => {
  const res = await call('GET', '/api/system/capabilities', { token: tokenFor('kid') });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.ffmpeg, 'boolean');
  assert.equal(typeof res.body.ffprobe, 'boolean');
});
