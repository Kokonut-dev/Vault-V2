/**
 * Network-facing protections (README → Security):
 *   - a request through Vault's tunnel/a proxy never counts as "this computer",
 *   - a brand-new server can only be set up (or imported into) from another
 *     device with the setup code printed in the server window,
 *   - once set up, /api/setup reveals nothing and re-configuring needs an admin,
 *   - /api/health tells strangers nothing about the library,
 *   - waiting (TV) pairing codes are capped and show where they came from,
 *     and the QR base URL can only be http(s),
 *   - transfer download links work once,
 *   - Subsonic never accepts the main password and locks out guessers,
 *   - remote access turns itself off after a while and reports what protects it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-security-'));
const configModule = require('../config');
// Point the setup routes at a config file of our own (they read it from disk).
configModule.CONFIG_PATH = path.join(TMP, 'config.json');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.server = { ...memory.server, host: '127.0.0.1', port: 4000 };
memory.auth = { ...memory.auth, username: 'admin', jwtSecret: 'security-test-'.padEnd(48, 'x'), maxAttempts: 5, lockoutDurationMinutes: 15 };
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const jsonStore = require('../utils/jsonStore');
jsonStore.createJsonStore = (_name, defaultValue) => {
  let data = structuredClone(defaultValue);
  return { get: () => data, set: (next) => { data = next; }, update: (fn) => { data = fn(data) ?? data; return data; }, save: () => {}, flush: async () => {} };
};

const profiles = require('../services/profiles');
profiles.get = (id) => ({ default: { id: 'default', name: 'admin', isAdmin: true }, kid: { id: 'kid', name: 'Kid', isAdmin: false } }[id] || null);
profiles.toPublic = (p) => p;

const authService = require('../services/authService');
const sessions = require('../services/sessions');
const setupGuard = require('../services/setupGuard');
const clientAddress = require('../utils/clientAddress');
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/requireAdmin');
const transferRouter = require('../routes/transfer');
const authRouter = require('../routes/auth');
const remoteAccess = require('../services/remoteAccess');
const subsonic = require('../services/subsonic');

function tokenFor(profileId) {
  const session = sessions.create({ username: 'admin', profileId, req: { headers: {}, ip: '127.0.0.1' }, label: 'test' });
  return authService.generateAccessToken('admin', { sid: session.id, profileId });
}

let server;
let port;
test.before(async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use('/api/health', require('../routes/health'));
  app.use('/api/setup', require('../routes/setup'));
  app.use('/api/transfer', transferRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/remote', authMiddleware, requireAdmin, require('../routes/remote'));
  app.use('/rest', require('../routes/subsonic'));
  // Stand-ins for media routes and the live-events stream (URL-token users).
  app.use('/api/media', authMiddleware, (req, res) => res.json({ ok: true, scope: req.user.scope || 'full' }));
  app.get('/api/events', authMiddleware, (req, res) => res.json({ ok: true }));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => {
  setupGuard.clear();
  fs.rmSync(TMP, { recursive: true, force: true });
  return new Promise(r => server.close(r));
});

/** `from`: an IP to appear as through the tunnel (X-Forwarded-For), or omitted for "this computer". */
function call(method, urlPath, { body, token, from, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(from ? { 'X-Forwarded-For': from } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const resetLockouts = (ip) => authService.resetAttempts(ip);
/** Put a finished-setup config.json on disk (what /api/setup/complete writes). */
const markSetUp = () => fs.writeFileSync(configModule.CONFIG_PATH, JSON.stringify({ auth: { username: 'admin', passwordHash: memory.auth.passwordHash || 'set' } }));

// ---------------------------------------------------------------- addresses
test('a loopback request through a tunnel/proxy is not "this computer"', () => {
  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });
  assert.equal(clientAddress.isLocalRequest(req('127.0.0.1')), true);
  assert.equal(clientAddress.isLocalRequest(req('::1')), true);
  assert.equal(clientAddress.isLocalRequest(req('::ffff:127.0.0.1')), true);
  assert.equal(clientAddress.isLocalRequest(req('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' })), false, 'Cloudflare tunnel');
  assert.equal(clientAddress.isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), false, 'reverse proxy');
  assert.equal(clientAddress.isLocalRequest(req('192.168.1.20')), false, 'another device on the network');
  assert.equal(clientAddress.isLocalRequest(req('172.17.0.1')), false, 'Docker bridge');
  assert.equal(clientAddress.cameThroughProxy(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), true);
  assert.equal(clientAddress.cameThroughProxy(req('192.168.1.20', { 'x-forwarded-for': '203.0.113.9' })), false, 'LAN devices cannot claim to be a proxy');
});

// ---------------------------------------------------------------- setup code
test('setup code: readable format, private file, forgiving input, cleared after setup', () => {
  setupGuard.clear();
  const code = setupGuard.code();
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(fs.readFileSync(setupGuard.CODE_FILE, 'utf8').trim(), code);
  if (process.platform !== 'win32') assert.equal(fs.statSync(setupGuard.CODE_FILE).mode & 0o077, 0, 'only the owner can read it');
  const remote = (given) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '198.51.100.4', ...(given ? { 'x-vault-setup-code': given } : {}) } });
  assert.equal(setupGuard.matches(remote(code.toLowerCase().replace('-', ' '))), true, 'case, spaces and dashes are ignored');
  assert.equal(setupGuard.matches(remote('AAAA-AAAA')), false);
  setupGuard.clear();
  assert.equal(fs.existsSync(setupGuard.CODE_FILE), false);
  assert.notEqual(setupGuard.code(), code, 'a new server gets a new code');
});

test('brand-new server: other devices need the setup code; this computer does not', async () => {
  fs.rmSync(configModule.CONFIG_PATH, { force: true });
  const ip = '198.51.100.7';
  resetLockouts(ip);

  const local = await call('GET', '/api/setup/status');
  assert.equal(local.body.needsSetup, true);
  assert.equal(local.body.setupCodeRequired, false);
  const remote = await call('GET', '/api/setup/status', { from: ip });
  assert.equal(remote.body.setupCodeRequired, true);

  for (const [method, url, body] of [
    ['POST', '/api/setup/complete', { username: 'mallory', password: 'Hunter22!', gridPattern: [0, 1, 2, 3, 4, 5, 6, 7] }],
    ['POST', '/api/setup/test', { mediaPaths: { movies: '/etc' } }],
    ['POST', '/api/setup/check-code', {}],
    ['POST', '/api/transfer/inspect', { source: '/tmp/x.zip' }],
  ]) {
    if (url.startsWith('/api/transfer')) transferRouter._internals.access.needsSetup = () => true;
    const res = await call(method, url, { body, from: ip });
    assert.equal(res.status, 403, `${url} without the code`);
    assert.equal(res.body.code, 'SETUP_CODE_REQUIRED');
  }
  assert.equal(fs.existsSync(configModule.CONFIG_PATH), false, 'nobody claimed the server');

  const wrong = await call('POST', '/api/setup/check-code', { body: { setupCode: 'WXYZ-2345' }, from: ip });
  assert.equal(wrong.status, 403);
  const right = await call('POST', '/api/setup/check-code', { headers: { 'X-Vault-Setup-Code': setupGuard.code() }, from: ip });
  assert.equal(right.status, 200);
  assert.equal((await call('POST', '/api/setup/test', { body: {}, from: ip, headers: { 'X-Vault-Setup-Code': setupGuard.code() } })).status, 200);
  assert.equal((await call('POST', '/api/setup/test', { body: {} })).status, 200, 'this computer needs no code');
  resetLockouts(ip);
});

test('wrong setup codes lock that device out', async () => {
  fs.rmSync(configModule.CONFIG_PATH, { force: true });
  const ip = '198.51.100.8';
  resetLockouts(ip);
  for (let i = 0; i < memory.auth.maxAttempts; i += 1) {
    await call('POST', '/api/setup/check-code', { body: { setupCode: `BAD${i}-CODE` }, from: ip });
  }
  const locked = await call('POST', '/api/setup/check-code', { headers: { 'X-Vault-Setup-Code': setupGuard.code() }, from: ip });
  assert.equal(locked.status, 429, 'even the right code waits out the lockout');
  assert.ok(Number(locked.headers['retry-after']) > 0);
  resetLockouts(ip);
});

test('set-up server: /api/setup reveals nothing and only an admin may re-configure', async () => {
  fs.writeFileSync(configModule.CONFIG_PATH, JSON.stringify({ auth: { username: 'admin', passwordHash: '$2a$10$abcdefghijklmnopqrstuv' } }));
  try {
    const anon = await call('GET', '/api/setup/status', { from: '203.0.113.20' });
    assert.equal(anon.body.needsSetup, false);
    assert.equal(anon.body.current, null, 'no username or folders for strangers');
    assert.doesNotMatch(anon.raw.toString(), /admin/);
    const admin = await call('GET', '/api/setup/status', { token: tokenFor('default') });
    assert.equal(admin.body.current.username, 'admin');
    const kid = await call('GET', '/api/setup/status', { token: tokenFor('kid') });
    assert.equal(kid.body.current, null);

    assert.equal((await call('POST', '/api/setup/test', { body: { mediaPaths: { m: '/etc' } } })).status, 401, 'no folder probing');
    assert.equal((await call('POST', '/api/setup/test', { body: {}, token: tokenFor('kid') })).status, 403);
    assert.equal((await call('POST', '/api/setup/complete', { body: { username: 'x', password: 'y', gridPattern: [] } })).status, 401);
    const kidReconfig = await call('POST', '/api/setup/complete', { body: { username: 'kidadmin', password: 'Hunter22!', gridPattern: [0, 1, 2, 3, 4, 5, 6, 7] }, token: tokenFor('kid') });
    assert.equal(kidReconfig.status, 403, 'a non-admin profile cannot replace the account');
    assert.equal((await call('POST', '/api/setup/check-code', { body: {} })).status, 409);
  } finally {
    fs.rmSync(configModule.CONFIG_PATH, { force: true });
  }
});

// ---------------------------------------------------------------- health
test('/api/health: strangers learn only that Vault runs here', async () => {
  const anon = await call('GET', '/api/health', { from: '203.0.113.5' });
  assert.equal(anon.status, 200);
  assert.equal(anon.body.status, 'ok');
  assert.ok(anon.body.version);
  assert.equal(anon.body.library, undefined);
  assert.equal(anon.body.uptime, undefined);
  const signedIn = await call('GET', '/api/health', { token: tokenFor('default') });
  assert.equal(typeof signedIn.body.library.total, 'number');
  assert.equal(typeof signedIn.body.uptime, 'number');
});

// ---------------------------------------------------------------- pairing
test('brand-new server: the factory login only works on this computer', async () => {
  // Before setup the in-memory config carries admin / admin and the default
  // pattern. Another device on the network must not be able to use them to
  // skip the setup code.
  fs.rmSync(configModule.CONFIG_PATH, { force: true });
  const bcrypt = require('bcryptjs');
  const savedHash = memory.auth.passwordHash;
  memory.auth.passwordHash = bcrypt.hashSync('admin', 4);
  const ip = '192.168.1.66';
  resetLockouts(ip);
  resetLockouts('127.0.0.1');
  try {
    assert.equal(setupGuard.pending(), true);
    const factory = { username: 'admin', password: 'admin' };

    // Every sign-in step is refused from other devices, with or without the setup code.
    for (const [url, body] of [
      ['/api/auth/login', factory],
      ['/api/auth/grid', { challengeToken: 'x', pattern: [0, 1, 4, 5, 8, 9, 12, 13] }],
      ['/api/auth/second-factor', { challengeToken: 'x', code: '123456' }],
      ['/api/auth/pair', {}],
      ['/api/auth/pair/exchange', { code: 'ABCD' }],
    ]) {
      const res = await call('POST', url, { body, from: ip });
      assert.equal(res.status, 403, `${url} from another device before setup`);
      assert.equal(res.body.code, 'SETUP_REQUIRED');
    }
    const withCode = await call('POST', '/api/auth/login', { body: factory, from: ip, headers: { 'X-Vault-Setup-Code': setupGuard.code() } });
    assert.equal(withCode.status, 403, 'the setup code is for setup, not for the factory login');

    // A token (e.g. one issued on this computer with the factory login) only works here.
    const token = tokenFor('default');
    const away = await call('GET', '/api/remote', { token, from: ip });
    assert.equal(away.status, 403);
    assert.equal(away.body.code, 'SETUP_REQUIRED');
    const statusAway = await call('GET', '/api/setup/status', { token, from: ip });
    assert.equal(statusAway.body.needsSetup, true, 'other devices are never treated as signed in');
    assert.notEqual((await call('GET', '/api/remote', { token })).status, 403, 'this computer is unaffected');

    // This computer can still use the factory login (e.g. scripts, recovery).
    const here = await call('POST', '/api/auth/login', { body: factory });
    assert.equal(here.status, 200);
    assert.ok(here.body.challengeToken);

    // Once setup has saved a real account, other devices may sign in normally.
    markSetUp();
    assert.equal(setupGuard.pending(), false);
    const after = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' }, from: ip });
    assert.equal(after.status, 401, 'the guard steps aside after setup');
    assert.equal(after.body.code, 'INVALID_CREDENTIALS');
  } finally {
    fs.rmSync(configModule.CONFIG_PATH, { force: true });
    memory.auth.passwordHash = savedHash;
    resetLockouts(ip);
    resetLockouts('127.0.0.1');
  }
});

test('pairing: waiting codes are capped, show their origin, and links stay http(s)', async () => {
  authRouter._resetPairingForTests();
  markSetUp(); // other devices can only pair with a server that is set up
  const made = [];
  for (let i = 0; i < 3; i += 1) {
    const res = await call('POST', '/api/auth/pair', { body: {}, from: '203.0.113.50' });
    assert.equal(res.status, 200);
    assert.equal(res.body.approved, false);
    made.push(res.body.code);
  }
  const fourth = await call('POST', '/api/auth/pair', { body: {}, from: '203.0.113.50' });
  assert.equal(fourth.status, 429, 'one address cannot flood the code space');
  for (let i = 0; i < 17; i += 1) {
    assert.equal((await call('POST', '/api/auth/pair', { body: {}, from: `203.0.113.${100 + i}` })).status, 200);
  }
  assert.equal((await call('POST', '/api/auth/pair', { body: {}, from: '203.0.113.200' })).status, 429, 'at most 20 waiting codes overall');
  assert.equal(new Set(made).size, made.length);

  const admin = tokenFor('default');
  const state = await call('GET', `/api/auth/pair/${made[0]}/state`, { token: admin });
  assert.equal(state.body.status, 'pending');
  assert.deepEqual(state.body.requester, { ip: '203.0.113.50', network: 'internet' });

  // Signed-in devices are not capped (their codes are already approved).
  const own = await call('POST', '/api/auth/pair', { body: { baseUrl: 'javascript:alert(1)//' }, token: admin, from: '203.0.113.50' });
  assert.equal(own.status, 200);
  assert.equal(own.body.url, null, 'never a javascript: link in the QR');
  const good = await call('POST', '/api/auth/pair', { body: { baseUrl: 'https://vault.example.test/' }, token: admin });
  assert.match(good.body.url, /^https:\/\/vault\.example\.test\/\?pair=[\w-]+$/);
  const creds = await call('POST', '/api/auth/pair', { body: { baseUrl: 'https://user:pw@evil.test' }, token: admin });
  assert.equal(creds.body.url, null);
  authRouter._resetPairingForTests();
});

test('sessions remember when they came in through remote access', () => {
  const viaTunnel = sessions.create({ username: 'admin', req: { headers: { 'x-forwarded-for': '203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' }, ip: '203.0.113.9' } });
  const atHome = sessions.create({ username: 'admin', req: { headers: {}, socket: { remoteAddress: '192.168.1.4' }, ip: '192.168.1.4' } });
  assert.equal(viaTunnel.remote, true);
  assert.equal(atHome.remote, false);
});

// ---------------------------------------------------------------- transfer
test('transfer download links work once', async () => {
  transferRouter._internals.access.needsSetup = () => false;
  const ticket = crypto.randomBytes(24).toString('base64url');
  transferRouter._internals.tickets.set(ticket, { media: false, expires: Date.now() + 60_000 });
  const transfer = require('../services/transfer');
  const origPlan = transfer.planExport;
  transfer.planExport = async () => ({ entries: [{ name: 'vault/settings.json', data: Buffer.from('{}') }] });
  try {
    const first = await call('GET', `/api/transfer/download/${ticket}`);
    assert.equal(first.status, 200);
    const second = await call('GET', `/api/transfer/download/${ticket}`);
    assert.equal(second.status, 410, 'a copied link cannot be used again');
  } finally {
    transfer.planExport = origPlan;
  }
});

// ---------------------------------------------------------------- subsonic
test('Subsonic: off until it has its own password, never takes the main one, locks out guessers', async () => {
  const origValidate = authService.validateCredentials;
  authService.validateCredentials = (u, p) => u === 'admin' && p === 'main-password';
  const ip = '203.0.113.77';
  resetLockouts(ip);
  const ping = (u, p, from = ip) => call('GET', `/rest/ping?u=${u}&p=${encodeURIComponent(p)}&f=json`, { from }).then(r => r.body['subsonic-response']);
  try {
    delete memory.auth.subsonic;
    const off = await ping('admin', 'main-password');
    assert.equal(off.status, 'failed', 'the main password alone would skip the grid');
    assert.match(off.error.message, /off/);

    subsonic.setSubsonicPassword('music-only', 'admin');
    assert.equal((await ping('admin', 'main-password')).status, 'failed');
    assert.equal((await ping('admin', 'music-only')).status, 'ok');
    const salt = 'abc123';
    const t = crypto.createHash('md5').update(`music-only${salt}`).digest('hex');
    const tokenAuth = await call('GET', `/rest/ping?u=admin&t=${t}&s=${salt}&f=json`, { from: ip });
    assert.equal(tokenAuth.body['subsonic-response'].status, 'ok');

    for (let i = 0; i < memory.auth.maxAttempts; i += 1) await ping('admin', `guess-${i}`);
    const locked = await ping('admin', 'music-only');
    assert.equal(locked.status, 'failed');
    assert.match(locked.error.message, /Too many wrong passwords/);
    assert.equal((await ping('admin', 'music-only', '203.0.113.78')).status, 'ok', 'other devices are not affected');
  } finally {
    authService.validateCredentials = origValidate;
    delete memory.auth.subsonic;
    resetLockouts(ip);
  }
});

// ---------------------------------------------------------------- remote access
test('remote access: turns itself off by default and reports what protects it', async () => {
  memory.remoteAccess = {};
  assert.equal(remoteAccess.autoStopHours(), 8, 'safe default');
  memory.remoteAccess = { tunnelOnStartup: true };
  assert.equal(remoteAccess.autoStopHours(), 0, 'people who chose "always on" keep it');
  memory.remoteAccess = { tunnelOnStartup: true, autoStopHours: 4 };
  assert.equal(remoteAccess.autoStopHours(), 4);

  const admin = tokenFor('default');
  assert.equal((await call('PUT', '/api/remote/settings', { body: { autoStopHours: 3 }, token: admin })).status, 400);
  const saved = await call('PUT', '/api/remote/settings', { body: { autoStopHours: 1 }, token: admin });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.autoStopHours, 1);
  assert.equal(memory.remoteAccess.autoStopHours, 1);
  assert.equal((await call('PUT', '/api/remote/settings', { body: { autoStopHours: 1 }, token: tokenFor('kid') })).status, 403);

  const summary = remoteAccess.securitySummary();
  assert.equal(summary.totpEnabled, false);
  assert.equal(summary.secondFactor, 'grid');
  assert.deepEqual(summary.lockout, { maxAttempts: 5, minutes: 15 });
  assert.equal(typeof summary.signedInDevices, 'number');
  assert.ok(summary.remoteDevices >= 1, 'counts devices that came in through the tunnel');
  delete memory.remoteAccess;
});

// ---------------------------------------------------------------- URL tokens
test('links: only read-only media tokens are accepted in a URL, never the sign-in token', async () => {
  markSetUp();
  try {
    const full = tokenFor('default');
    const sid = authService.verifyToken(full).sid;
    const media = authService.generateMediaToken('admin', '12h', { sid, profileId: 'default' });

    // The sign-in token works in the header, but is refused in a URL, even for media.
    assert.equal((await call('GET', '/api/media/stream/x', { token: full })).status, 200);
    for (const url of ['/api/media/stream/x', '/api/events', '/api/remote']) {
      const res = await call('GET', `${url}?token=${encodeURIComponent(full)}`);
      assert.equal(res.status, 401, `${url} with the sign-in token in the URL`);
      assert.equal(res.body.code, 'QUERY_TOKEN_NOT_ALLOWED');
    }

    // The media token plays media and opens the events stream...
    const play = await call('GET', `/api/media/stream/x?token=${encodeURIComponent(media)}`);
    assert.equal(play.status, 200);
    assert.equal(play.body.scope, 'media');
    assert.equal((await call('GET', `/api/events?token=${encodeURIComponent(media)}`)).status, 200);

    // ...and nothing else: no other API, no writes, no new tokens.
    assert.equal((await call('GET', `/api/remote?token=${encodeURIComponent(media)}`)).status, 401);
    assert.equal((await call('GET', '/api/remote', { token: media })).status, 401, 'not in the header either');
    assert.equal((await call('POST', '/api/media/stream/x', { token: media, body: {} })).status, 401, 'read-only');
    assert.equal((await call('GET', '/api/auth/media-token', { token: media })).status, 401, 'cannot renew itself');
    assert.equal((await call('GET', `/api/media/stream/x?token=${encodeURIComponent(media)}`, { from: '203.0.113.9' })).status, 200, 'works through the tunnel');

    // Signing out the device revokes its media links too.
    sessions.revoke(sid);
    assert.equal((await call('GET', `/api/media/stream/x?token=${encodeURIComponent(media)}`)).status, 401);
  } finally {
    fs.rmSync(configModule.CONFIG_PATH, { force: true });
  }
});
