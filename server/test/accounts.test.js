/**
 * "Create a new account" and "Forgot password?" (services/accounts.js,
 * services/recovery.js, services/mailer.js, routes/accounts.js and the
 * /api/auth/register + /api/auth/recover* endpoints):
 *
 *   - anyone can create an account and is signed in straight away; the
 *     owner can turn this off;
 *   - an account signs in with its own password + grid and only ever sees
 *     its own profile; it is never an admin and the household doesn't see it;
 *   - "Forgot password?" gives the same answer for every input, emails a
 *     one-time link (or shows it in the server window), and the link sets a
 *     new password + grid and signs out every device of that account;
 *   - the owner's authenticator app is still required after an email reset;
 *   - links only point at this server's own addresses or its CORS list;
 *   - deleting an account removes its profile, devices and links.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-accounts-'));
process.env.VAULT_HOME = TMP;

const express = require('express');
const bcrypt = require('bcryptjs');
const configModule = require('../config');
configModule.CONFIG_PATH = path.join(TMP, 'config.json');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.auth = {
  ...memory.auth,
  username: 'owner',
  passwordHash: bcrypt.hashSync('owner-password', 4),
  gridPattern: [0, 1, 2, 3, 4, 5, 6, 7],
  jwtSecret: 'accounts-test-'.padEnd(48, 'x'),
  maxAttempts: 50,
  lockoutDurationMinutes: 15,
};
memory.cors = { ...(memory.cors || {}), origins: ['https://kokonut-dev.github.io'] };
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);
// Setup is finished: the sign-up and recovery endpoints check the file.
fs.writeFileSync(configModule.CONFIG_PATH, JSON.stringify({ auth: { passwordHash: memory.auth.passwordHash } }));

const jsonStore = require('../utils/jsonStore');
const stores = new Map();
jsonStore.createJsonStore = (name, defaultValue) => {
  if (!stores.has(name)) stores.set(name, structuredClone(defaultValue));
  return {
    get: () => stores.get(name),
    set: (next) => { stores.set(name, next); return next; },
    update: (fn) => { const next = fn(stores.get(name)); if (next !== undefined) stores.set(name, next); return stores.get(name); },
    save: () => {}, saveNow: async () => {}, flush: async () => {},
  };
};

require('./helpers/terms').autoAcceptTerms();
const logger = require('../utils/logger');
const authService = require('../services/authService');
const sessions = require('../services/sessions');
const profiles = require('../services/profiles');
const accounts = require('../services/accounts');
const recovery = require('../services/recovery');
const mailer = require('../services/mailer');
const { authMiddleware } = require('../middleware/auth');
const authRouter = require('../routes/auth');

// Everything the server window would show.
const shown = [];
const realInfo = logger.info;
logger.info = (...args) => { shown.push(args.join(' ')); };

// Outgoing mail is captured, never sent.
const outbox = [];
let failSending = false;
mailer._setTransportFactory(() => ({
  sendMail: async (msg) => {
    if (failSending) throw Object.assign(new Error('Invalid login: 535 auth failed'), { code: 'EAUTH' });
    outbox.push(msg);
    return { messageId: 'x' };
  },
}));

let server;
let port;
test.before(async () => {
  const app = express();
  app.set('trust proxy', false);
  app.use(express.json());
  app.use('/api/setup', require('../routes/setup'));
  app.use('/api/auth', authRouter);
  app.use('/api/profiles', authMiddleware, require('../routes/profiles'));
  app.use('/api/accounts', authMiddleware, require('../routes/accounts'));
  app.use('/api/settings', authMiddleware, require('../middleware/requireAdmin').requireAdmin, (req, res) => res.json({ ok: true }));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => {
  logger.info = realInfo;
  mailer._setTransportFactory(null);
  fs.rmSync(TMP, { recursive: true, force: true });
  return new Promise(r => server.close(r));
});
test.beforeEach(() => {
  authRouter._resetPairingForTests();
  authService.resetAttempts('127.0.0.1');
  authService.resetAttempts('::ffff:127.0.0.1');
});

function call(method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const GRID = [15, 14, 13, 12, 11, 10, 9, 8];
let counter = 0;
function newAccount(extra = {}) {
  counter += 1;
  return {
    username: `friend${counter}`,
    email: `friend${counter}@example.com`,
    password: 'a long password',
    confirmPassword: 'a long password',
    gridPattern: GRID,
    ...extra,
  };
}

async function signInOwner() {
  const login = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'owner-password' } });
  assert.equal(login.status, 200, login.raw);
  const grid = await call('POST', '/api/auth/grid', { body: { challengeToken: login.body.challengeToken, pattern: memory.auth.gridPattern, profileId: 'default' } });
  assert.equal(grid.status, 200, grid.raw);
  return grid.body.token;
}

async function waitFor(fn, what) {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const linkIn = (text) => (String(text).match(/https?:\/\/\S+#reset=[^\s&]+(?:&\S+)?/) || [])[0];
const tokenOf = (link) => new URLSearchParams(link.split('#')[1]).get('reset');

// ------------------------------------------------------------------ sign-up
test('setup status tells the sign-in screen that sign-up and recovery work', async () => {
  const res = await call('GET', '/api/setup/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.needsSetup, false);
  assert.equal(res.body.signup, true);
  assert.equal(res.body.recovery, true);
});

test('creating an account signs in straight away, on its own profile', async () => {
  const body = newAccount();
  const res = await call('POST', '/api/auth/register', { body });
  assert.equal(res.status, 200, res.raw);
  assert.ok(res.body.token);
  assert.equal(res.body.user.username, body.username);
  assert.equal(res.body.user.owner, false);
  assert.equal(res.body.profileCount, 1);
  const account = accounts.findByUsername(body.username);
  assert.ok(account);
  assert.equal(res.body.profile.id, account.profileId);
  assert.equal(res.body.profile.isAdmin, false);
  assert.equal(profiles.get(account.profileId).accountId, account.id);
  assert.notEqual(account.passwordHash, body.password, 'password is hashed');

  // Signed in: the profile list holds only its own profile.
  const list = await call('GET', '/api/profiles', { token: res.body.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.profiles.map(p => p.id), [account.profileId]);
  assert.equal(list.body.separateAccount, true);
});

test('sign-up checks what it is given', async () => {
  const cases = [
    [{ username: 'x' }, 'username'],
    [{ username: 'owner' }, 'username'],
    [{ email: 'not-an-email' }, 'email'],
    [{ password: 'short', confirmPassword: 'short' }, 'password'],
    [{ confirmPassword: 'something else' }, 'confirmPassword'],
    [{ gridPattern: [1, 1, 2, 3, 4, 5, 6, 7] }, 'gridPattern'],
  ];
  for (const [change, field] of cases) {
    const res = await call('POST', '/api/auth/register', { body: newAccount(change) });
    assert.ok([400, 409].includes(res.status), `${field}: ${res.raw}`);
    assert.ok(res.body.fields?.[field], `${field} is flagged: ${res.raw}`);
  }
  // Taken username (any case) and email.
  const first = newAccount();
  assert.equal((await call('POST', '/api/auth/register', { body: first })).status, 200);
  authRouter._resetPairingForTests();
  const sameName = await call('POST', '/api/auth/register', { body: newAccount({ username: first.username.toUpperCase() }) });
  assert.equal(sameName.status, 409);
  assert.equal(sameName.body.code, 'USERNAME_TAKEN');
  const sameEmail = await call('POST', '/api/auth/register', { body: newAccount({ email: first.email.toUpperCase() }) });
  assert.equal(sameEmail.status, 409);
  assert.equal(sameEmail.body.code, 'EMAIL_TAKEN');
});

test('one address can only make a few accounts an hour', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await call('POST', '/api/auth/register', { body: newAccount() });
  assert.equal(last.status, 429);
  assert.equal(last.body.code, 'LOCKED_OUT');
});

test('the owner can turn sign-up off (and only the owner)', async () => {
  const friend = await call('POST', '/api/auth/register', { body: newAccount() });
  const asFriend = await call('PUT', '/api/accounts/signup', { token: friend.body.token, body: { enabled: false } });
  assert.equal(asFriend.status, 403);

  const owner = await signInOwner();
  const off = await call('PUT', '/api/accounts/signup', { token: owner, body: { enabled: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.signupEnabled, false);
  assert.equal((await call('GET', '/api/setup/status')).body.signup, false);
  const refused = await call('POST', '/api/auth/register', { body: newAccount() });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'SIGNUP_DISABLED');

  await call('PUT', '/api/accounts/signup', { token: owner, body: { enabled: true } });
  assert.equal((await call('GET', '/api/setup/status')).body.signup, true);
});

// ------------------------------------------------------------------ sign-in
test('an account signs in with its own password and grid', async () => {
  const body = newAccount();
  await call('POST', '/api/auth/register', { body });

  const login = await call('POST', '/api/auth/login', { body: { username: body.username, password: body.password } });
  assert.equal(login.status, 200, login.raw);
  assert.equal(login.body.step, 'grid');
  assert.equal(login.body.profiles.length, 1, 'only its own profile is listed');

  const wrong = await call('POST', '/api/auth/grid', { body: { challengeToken: login.body.challengeToken, pattern: memory.auth.gridPattern } });
  assert.equal(wrong.status, 401, 'the owner’s grid does not open the account');

  // Even asking for the owner's profile lands on its own.
  const ok = await call('POST', '/api/auth/grid', { body: { challengeToken: login.body.challengeToken, pattern: GRID, profileId: 'default' } });
  assert.equal(ok.status, 200, ok.raw);
  const account = accounts.findByUsername(body.username);
  assert.equal(ok.body.profile.id, account.profileId);
  assert.equal(sessions.get(authService.verifyToken(ok.body.token).sid).accountId, account.id);
  assert.ok(accounts.get(account.id).lastLoginAt);

  const badPassword = await call('POST', '/api/auth/login', { body: { username: body.username, password: 'nope nope nope' } });
  assert.equal(badPassword.status, 401);
});

test('an account is never an admin and can’t reach the household', async () => {
  const res = await call('POST', '/api/auth/register', { body: newAccount() });
  const token = res.body.token;
  const own = res.body.profile.id;

  assert.equal((await call('GET', '/api/settings', { token })).status, 403, 'no server settings');
  assert.equal((await call('POST', '/api/profiles/default/switch', { token, body: {} })).status, 403, 'no switching to the owner');
  assert.equal((await call('GET', '/api/profiles/default/summary', { token })).status, 403);
  assert.equal((await call('PUT', '/api/profiles/default', { token, body: { name: 'Hacked' } })).status, 403);
  const promote = await call('PUT', `/api/profiles/${own}`, { token, body: { isAdmin: true } });
  assert.equal(promote.status, 403);
  assert.equal(profiles.get(own).isAdmin, false);
  const rename = await call('PUT', `/api/profiles/${own}`, { token, body: { name: 'My name' } });
  assert.equal(rename.status, 200, rename.raw);

  // Its device list holds only its own devices.
  await signInOwner();
  const devices = await call('GET', '/api/auth/sessions', { token });
  assert.ok(devices.body.sessions.length >= 1);
  assert.ok(devices.body.sessions.every(s => s.accountId === res.body.profile.accountId));
  const ownerSession = sessions.list().find(s => !s.accountId);
  assert.equal((await call('DELETE', `/api/auth/sessions/${ownerSession.id}`, { token })).status, 404);
  assert.equal((await call('GET', '/api/auth/totp', { token })).status, 403);
});

test('the owner’s household doesn’t list or open accounts’ profiles', async () => {
  const friend = await call('POST', '/api/auth/register', { body: newAccount() });
  const owner = await signInOwner();
  const list = await call('GET', '/api/profiles', { token: owner });
  assert.ok(!list.body.profiles.some(p => p.accountId), 'no account profiles in the owner’s list');
  const sw = await call('POST', `/api/profiles/${friend.body.profile.id}/switch`, { token: owner, body: {} });
  assert.equal(sw.status, 403);
  assert.equal(sw.body.code, 'SEPARATE_ACCOUNT');
  const promote = await call('PUT', `/api/profiles/${friend.body.profile.id}`, { token: owner, body: { isAdmin: true } });
  assert.equal(promote.status, 403);

  // The owner's login offers only the household's profiles.
  const login = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'owner-password' } });
  assert.ok(!login.body.profiles.some(p => p.accountId));
  // ... and asking for an account's profile there doesn't open it.
  const grid = await call('POST', '/api/auth/grid', { body: { challengeToken: login.body.challengeToken, pattern: memory.auth.gridPattern, profileId: friend.body.profile.id } });
  assert.equal(grid.status, 200);
  assert.notEqual(grid.body.profile.id, friend.body.profile.id);
});

test('accounts don’t count towards the household’s profile limit', () => {
  const household = profiles.listHousehold().length;
  assert.ok(profiles.list().length > household, 'there are account profiles');
  assert.ok(household < profiles.MAX_HOUSEHOLD_PROFILES);
});

// ------------------------------------------------------------------ recovery
test('"Forgot password?" answers the same for every input', async () => {
  const body = newAccount();
  await call('POST', '/api/auth/register', { body });
  const known = await call('POST', '/api/auth/recover', { body: { identifier: body.email } });
  const unknown = await call('POST', '/api/auth/recover', { body: { identifier: 'nobody@example.com' } });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(known.body, unknown.body);
  const empty = await call('POST', '/api/auth/recover', { body: { identifier: '  ' } });
  assert.equal(empty.status, 400);
});

test('without mail set up, the reset link is shown in the server window', async () => {
  const body = newAccount();
  await call('POST', '/api/auth/register', { body });
  shown.length = 0;
  await call('POST', '/api/auth/recover', { body: { identifier: body.username, appUrl: 'https://kokonut-dev.github.io/Vault-V2/index.html' } });
  const line = await waitFor(() => shown.find(l => l.includes('#reset=')), 'the link in the server window');
  const link = linkIn(line);
  assert.ok(link.startsWith('https://kokonut-dev.github.io/Vault-V2/#reset='), link);
  assert.ok(shown.some(l => l.includes(body.username)));
  const check = await call('POST', '/api/auth/recover/check', { body: { token: tokenOf(link) } });
  assert.equal(check.status, 200, check.raw);
  assert.equal(check.body.username, body.username);
  assert.equal(check.body.totpRequired, false);
});

test('a reset link sets a new password and grid, signs every device out, and works once', async () => {
  const body = newAccount();
  const reg = await call('POST', '/api/auth/register', { body });
  const oldToken = reg.body.token;
  memory.mail = { enabled: true, host: 'smtp.example.com', port: 587, secure: false, user: 'u', passEnc: mailer.encrypt('p'), from: 'Vault <vault@example.com>' };
  try {
    outbox.length = 0;
    await call('POST', '/api/auth/recover', { body: { identifier: body.email.toUpperCase() } });
    const mail = await waitFor(() => outbox.find(m => m.to === body.email), 'the reset email');
    assert.match(mail.subject, /Reset your Vault password/);
    assert.ok(mail.text.includes(body.username), 'reminds of the username');
    const link = linkIn(mail.text);
    assert.ok(link, mail.text);
    const token = tokenOf(link);
    assert.ok(!JSON.stringify(stores.get('recovery.json')).includes(token), 'only a hash is stored');

    const weak = await call('POST', '/api/auth/recover/reset', { body: { token, password: 'short', gridPattern: [0, 2, 4, 6, 8, 10, 12, 14] } });
    assert.equal(weak.status, 400);
    assert.ok(weak.body.fields.password);

    const NEW_GRID = [0, 2, 4, 6, 8, 10, 12, 14];
    const reset = await call('POST', '/api/auth/recover/reset', { body: { token, password: 'a brand new password', confirmPassword: 'a brand new password', gridPattern: NEW_GRID } });
    assert.equal(reset.status, 200, reset.raw);
    assert.ok(reset.body.signedOut >= 1);

    // Signed out everywhere.
    assert.equal((await call('GET', '/api/profiles', { token: oldToken })).status, 401);
    // Old password gone, new one works with the new grid.
    assert.equal((await call('POST', '/api/auth/login', { body: { username: body.username, password: body.password } })).status, 401);
    const login = await call('POST', '/api/auth/login', { body: { username: body.username, password: 'a brand new password' } });
    assert.equal(login.status, 200);
    assert.equal((await call('POST', '/api/auth/grid', { body: { challengeToken: login.body.challengeToken, pattern: NEW_GRID } })).status, 200);

    // Once only.
    const again = await call('POST', '/api/auth/recover/reset', { body: { token, password: 'yet another password', gridPattern: NEW_GRID } });
    assert.equal(again.status, 410);
    assert.equal(again.body.code, 'RESET_USED');
    // A "password changed" email follows.
    await waitFor(() => outbox.find(m => m.to === body.email && /was changed/.test(m.subject)), 'the confirmation email');
  } finally {
    memory.mail = structuredClone(configModule.DEFAULT_CONFIG.mail);
  }
});

test('when sending fails, the link still appears in the server window', async () => {
  const body = newAccount();
  await call('POST', '/api/auth/register', { body });
  memory.mail = { enabled: true, host: 'smtp.example.com', port: 587, secure: false, user: 'u', passEnc: mailer.encrypt('p'), from: 'vault@example.com' };
  failSending = true;
  shown.length = 0;
  try {
    await call('POST', '/api/auth/recover', { body: { identifier: body.username } });
    const line = await waitFor(() => shown.find(l => l.includes('#reset=')), 'the fallback link');
    assert.ok(line);
    assert.ok(shown.some(l => /app password|username or password/.test(l)), 'says why');
  } finally {
    failSending = false;
    memory.mail = structuredClone(configModule.DEFAULT_CONFIG.mail);
  }
});

test('expired and made-up links are refused', async () => {
  const made = await call('POST', '/api/auth/recover/check', { body: { token: 'x'.repeat(43) } });
  assert.equal(made.status, 400);
  assert.equal(made.body.code, 'RESET_INVALID');

  const body = newAccount();
  await call('POST', '/api/auth/register', { body });
  shown.length = 0;
  await call('POST', '/api/auth/recover', { body: { identifier: body.username } });
  const token = tokenOf(linkIn(await waitFor(() => shown.find(l => l.includes('#reset=')), 'link')));
  for (const t of stores.get('recovery.json').tokens) t.expiresAt = new Date(Date.now() - 1000).toISOString();
  const expired = await call('POST', '/api/auth/recover/check', { body: { token } });
  assert.equal(expired.status, 410);
  assert.equal(expired.body.code, 'RESET_EXPIRED');
});

test('a few links per account, then no more for a while', async () => {
  const body = newAccount();
  await call('POST', '/api/auth/register', { body });
  for (let i = 0; i < recovery.PER_ACCOUNT_LIMIT + 1; i++) {
    authRouter._resetPairingForTests();
    await recovery.request({ identifier: body.username, ip: '203.0.113.9' });
  }
  const account = accounts.findByUsername(body.username);
  const made = stores.get('recovery.json').tokens.filter(t => t.target === account.id);
  assert.equal(made.length, recovery.PER_ACCOUNT_LIMIT);
  assert.equal(made.filter(t => !t.usedAt).length, 1, 'only the newest link works');
});

test('links never point at an address the request made up', () => {
  const evil = recovery.buildLink('tok', { appUrl: 'https://evil.example/phish', serverUrl: 'https://evil.example' });
  assert.ok(!evil.includes('evil.example'), evil);
  const ok = recovery.buildLink('tok', { appUrl: 'https://kokonut-dev.github.io/Vault-V2/', serverUrl: 'http://localhost:4000' });
  assert.equal(ok, 'https://kokonut-dev.github.io/Vault-V2/#reset=tok&server=http%3A%2F%2Flocalhost%3A4000');
  const js = recovery.buildLink('tok', { appUrl: 'javascript:alert(1)' });
  assert.match(js, /^https?:\/\//);
});

test('the owner can recover too; their authenticator app is still needed', async () => {
  const savedHash = memory.auth.passwordHash;
  const savedGrid = memory.auth.gridPattern.slice();
  const owner = await signInOwner();
  memory.auth.email = 'owner@example.com';
  memory.auth.totp = { enabled: true, secret: 'JBSWY3DPEHPK3PXP', recoveryCodes: [] };
  shown.length = 0;
  try {
    await call('POST', '/api/auth/recover', { body: { identifier: 'OWNER@example.com' } });
    const token = tokenOf(linkIn(await waitFor(() => shown.find(l => l.includes('#reset=')), 'link')));
    const check = await call('POST', '/api/auth/recover/check', { body: { token } });
    assert.equal(check.body.owner, true);
    assert.equal(check.body.totpRequired, true);

    const body = { token, password: 'owner new password', gridPattern: [3, 2, 1, 0, 7, 6, 5, 4] };
    const noCode = await call('POST', '/api/auth/recover/reset', { body });
    assert.equal(noCode.status, 400);
    assert.equal(noCode.body.code, 'TOTP_REQUIRED');
    const badCode = await call('POST', '/api/auth/recover/reset', { body: { ...body, totpCode: '000000' } });
    assert.equal(badCode.status, 400);
    assert.equal(memory.auth.passwordHash, savedHash, 'nothing changed');

    const realVerify = authService.verifyTotpCode;
    authService.verifyTotpCode = (c) => c === '424242';
    let done;
    try {
      done = await call('POST', '/api/auth/recover/reset', { body: { ...body, totpCode: '424242' } });
    } finally {
      authService.verifyTotpCode = realVerify;
    }
    assert.equal(done.status, 200, done.raw);
    assert.ok(bcrypt.compareSync('owner new password', memory.auth.passwordHash));
    assert.deepEqual(memory.auth.gridPattern, [3, 2, 1, 0, 7, 6, 5, 4]);
    assert.equal((await call('GET', '/api/profiles', { token: owner })).status, 401, 'the owner’s devices are signed out');
  } finally {
    memory.auth.passwordHash = savedHash;
    memory.auth.gridPattern = savedGrid;
    memory.auth.totp = { enabled: false };
    memory.auth.email = null;
  }
});

// ------------------------------------------------------------------ settings
test('an account manages its own email and sign-in, and can delete itself', async () => {
  const body = newAccount();
  const reg = await call('POST', '/api/auth/register', { body });
  const token = reg.body.token;
  const me = await call('GET', '/api/accounts/me', { token });
  assert.equal(me.body.owner, false);
  assert.equal(me.body.email, body.email);

  const wrong = await call('PUT', '/api/accounts/me/email', { token, body: { email: 'new@example.com', currentPassword: 'wrong password' } });
  assert.equal(wrong.status, 400, 'a typo is not a 401');
  const changed = await call('PUT', '/api/accounts/me/email', { token, body: { email: 'new-address@example.com', currentPassword: body.password } });
  assert.equal(changed.status, 200, changed.raw);
  assert.equal(accounts.findByUsername(body.username).email, 'new-address@example.com');

  const creds = await call('PUT', '/api/accounts/me/credentials', { token, body: { currentPassword: body.password, newPassword: 'changed password!' } });
  assert.equal(creds.status, 200, creds.raw);

  const account = accounts.findByUsername(body.username);
  const del = await call('DELETE', '/api/accounts/me', { token, body: { currentPassword: 'changed password!' } });
  assert.equal(del.status, 200, del.raw);
  assert.equal(accounts.get(account.id), null);
  assert.equal(profiles.get(account.profileId), null);
  assert.equal((await call('GET', '/api/accounts/me', { token })).status, 401);
});

test('the owner lists and deletes accounts and sets up email', async () => {
  const body = newAccount();
  const reg = await call('POST', '/api/auth/register', { body });
  const owner = await signInOwner();

  const list = await call('GET', '/api/accounts', { token: owner });
  assert.equal(list.status, 200);
  const entry = list.body.accounts.find(a => a.username === body.username);
  assert.ok(entry);
  assert.equal(entry.email, body.email);
  assert.ok(!('passwordHash' in entry) && !('gridPattern' in entry));
  assert.equal(list.body.mail.configured, false);

  const asFriend = await call('GET', '/api/accounts', { token: reg.body.token });
  assert.equal(asFriend.status, 403);

  // Mail settings: the password is stored encrypted and never shown.
  const bad = await call('PUT', '/api/accounts/mail', { token: owner, body: { enabled: true, host: 'not a host!', from: 'vault@example.com' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.host);
  const saved = await call('PUT', '/api/accounts/mail', { token: owner, body: { enabled: true, host: 'smtp.example.com', port: 587, user: 'me', password: 'secret-pass', from: 'vault@example.com' } });
  assert.equal(saved.status, 200, saved.raw);
  assert.equal(saved.body.hasPassword, true);
  assert.ok(!JSON.stringify(saved.body).includes('secret-pass'));
  assert.ok(!JSON.stringify(memory.mail).includes('secret-pass'), 'not in config.json in plain text');
  assert.equal(mailer.decrypt(memory.mail.passEnc), 'secret-pass');

  outbox.length = 0;
  const testMail = await call('POST', '/api/accounts/mail/test', { token: owner, body: { to: 'me@example.com' } });
  assert.equal(testMail.status, 200, testMail.raw);
  assert.equal(outbox[0].to, 'me@example.com');
  memory.mail = structuredClone(configModule.DEFAULT_CONFIG.mail);

  const ownerEmail = await call('PUT', '/api/accounts/owner-email', { token: owner, body: { email: body.email } });
  assert.equal(ownerEmail.status, 409, 'an account already uses that address');

  const account = accounts.findByUsername(body.username);
  const del = await call('DELETE', `/api/accounts/${account.id}`, { token: owner });
  assert.equal(del.status, 200, del.raw);
  assert.equal(accounts.get(account.id), null);
  assert.equal(profiles.get(account.profileId), null);
  assert.equal((await call('GET', '/api/profiles', { token: reg.body.token })).status, 401, 'its devices stop working');
});

test('the owner can’t take a username an account already has', async () => {
  const body = newAccount();
  await call('POST', '/api/auth/register', { body });
  assert.equal(accounts.usernameTaken(body.username), true);
  assert.equal(accounts.usernameTaken('owner'), true);
});
