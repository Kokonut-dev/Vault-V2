/**
 * Terms of Use (docs/terms.html, services/terms.js):
 *   - the binding text is intact: the version file pins its exact wording,
 *     and the clauses the project relies on are present;
 *   - nobody can use a server without accepting the current version: every
 *     signed-in route, media link and Subsonic app is refused until then;
 *   - signing up (first-time setup) requires reading and accepting them;
 *   - an update to the terms makes everyone accept again;
 *   - a kids' profile needs a parent or guardian; evidence is recorded;
 *   - if the terms file is missing, the server fails closed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_DOCS = path.join(__dirname, '..', '..', 'docs');
const TERMS_SOURCE = fs.readFileSync(path.join(REPO_DOCS, 'terms.html'), 'utf8');

// A server of our own: its home, docs (a copy of terms.html we can change)
// and data all live in a temp folder.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-terms-'));
const DOCS = path.join(TMP, 'docs');
fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(path.join(DOCS, 'terms.html'), TERMS_SOURCE);
process.env.VAULT_HOME = TMP;
process.env.VAULT_DOCS_DIR = DOCS;

const express = require('express');
const configModule = require('../config');
configModule.CONFIG_PATH = path.join(TMP, 'config.json');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.auth = { ...memory.auth, username: 'owner', jwtSecret: 'terms-test-'.padEnd(48, 'x'), maxAttempts: 5, lockoutDurationMinutes: 15 };
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

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

const terms = require('../services/terms');
const profiles = require('../services/profiles');
const authService = require('../services/authService');
const sessions = require('../services/sessions');
const subsonic = require('../services/subsonic');
const { authMiddleware } = require('../middleware/auth');

let server;
let port;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/setup', require('../routes/setup'));
  app.use('/api/legal', require('../routes/legal'));
  app.use('/api/profiles', authMiddleware, require('../routes/profiles'));
  app.use('/api/auth', require('../routes/auth'));
  // Stand-ins for the rest of the signed-in API and for media links.
  app.use('/api/library', authMiddleware, (req, res) => res.json({ ok: true }));
  app.use('/api/settings', authMiddleware, (req, res) => res.json({ ok: true }));
  app.use('/api/media', authMiddleware, (req, res) => res.json({ ok: true }));
  app.get('/api/events', authMiddleware, (req, res) => res.json({ ok: true }));
  app.use('/rest', require('../routes/subsonic'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  return new Promise(r => server.close(r));
});

function call(method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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

function signIn(profileId) {
  const session = sessions.create({ username: 'owner', profileId, req: { headers: { 'user-agent': 'TermsTest/1.0' }, ip: '127.0.0.1' }, label: 'Terms test' });
  return {
    token: authService.generateAccessToken('owner', { sid: session.id, profileId }),
    media: authService.generateMediaToken('owner', '12h', { sid: session.id, profileId }),
    session,
  };
}

function setTermsFile(source) {
  fs.writeFileSync(path.join(DOCS, 'terms.html'), source);
  terms._resetCache();
}

const accept = (token, current, extra = {}) => call('POST', '/api/legal/terms/accept', {
  token,
  body: { version: current.version, sha256: current.sha256, readToEnd: true, ...extra },
});

// --------------------------------------------------------------- the text
test('the binding text is pinned: changing it needs a new version', () => {
  const current = terms.parse(TERMS_SOURCE);
  assert.ok(current, 'docs/terms.html has an <article id="terms-document"> with a version');
  const published = terms.publishedVersions();
  assert.ok(published[current.version], `server/legal/terms-versions.json lists version ${current.version}`);
  assert.equal(published[current.version].sha256, current.sha256,
    'docs/terms.html changed without a new data-version (bump it and add the version to server/legal/terms-versions.json)');
  assert.equal(published[current.version].effective, current.effective);
  assert.match(current.effective, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(TERMS_SOURCE.includes(`Version ${current.version} · Effective`), 'the visible version line matches data-version');
  // Line endings must not change the fingerprint (Windows checkouts).
  assert.equal(terms.fingerprint(current.html.replace(/\n/g, '\r\n')), current.sha256);
});

test('the terms say what the project relies on', () => {
  const text = terms.parse(TERMS_SOURCE).html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  for (const [what, pattern] of [
    ['piracy is the sole responsibility of the user', /All piracy, and any other infringement .* is the sole responsibility of the User who commits it/],
    ['not the website or the creator', /It is not the responsibility of the Website, the Creator or any other Vault Party/],
    ['the creator provides and controls no content', /do not host, store, cache, upload, transmit/],
    ['a definition of piracy', /"Piracy" means/],
    ['no circumvention of DRM', /circumvent, remove or disable any digital rights management/],
    ['users promise they hold the rights', /you represent and warrant/],
    ['no warranty', /"as is" and "as available"/],
    ['limitation of liability with mandatory carve-outs', /Nothing in these Terms excludes or limits liability/],
    ['the liability cap', /fifty euros \(EUR 50\)/],
    ['an indemnity', /you will indemnify, defend and hold harmless each Vault Party/],
    ['Dutch law', /governed by the laws of the Netherlands/],
    ['the court', /Rechtbank Midden-Nederland\), location Utrecht/],
    ['consumers keep their own law (Rome I)', /Article 6\(2\) of Regulation \(EC\) No 593\/2008/],
    ['age 18 / guardian acceptance', /at least 18 years old/],
    ['the MIT licence is respected', /Nothing in these Terms limits any right that the MIT License grants/],
    ['severability', /the rest remains in full force/],
    ['the creator is named', /"Creator" means Kokonut-dev/],
    ['changes need fresh acceptance', /Vault will ask you to read and accept the new version/],
    ['TMDB attribution', /This product uses the TMDB API but is not endorsed or certified by TMDB/],
  ]) {
    assert.match(text, pattern, `missing: ${what}`);
  }
});

// --------------------------------------------------------------- the gate
test('nothing works until the profile accepts the current terms', async () => {
  const current = terms.current();
  const owner = signIn('default');

  for (const [method, url, token] of [
    ['GET', '/api/library', owner.token],
    ['GET', '/api/settings', owner.token],
    ['GET', '/api/events', owner.token],
    ['GET', '/api/auth/media-token', owner.token],
    ['GET', '/api/auth/sessions', owner.token],
    ['GET', `/api/media/stream/x?token=${owner.media}`, null],
    ['GET', `/api/events?token=${owner.media}`, null],
  ]) {
    const res = await call(method, url, { token });
    assert.equal(res.status, 403, `${method} ${url.replace(/token=[^&]+/, 'token=…')} before accepting`);
    assert.equal(res.body.code, 'TERMS_REQUIRED');
    assert.equal(res.body.terms.version, current.version);
  }

  // What stays open: reading the terms, their status, accepting, switching profile.
  const pub = await call('GET', '/api/legal/terms');
  assert.equal(pub.status, 200, 'anyone can read the terms, signed in or not');
  assert.equal(pub.body.version, current.version);
  assert.equal(pub.body.sha256, current.sha256);
  assert.match(pub.body.html, /sole responsibility of the User who commits it/);
  const status = await call('GET', '/api/legal/status', { token: owner.token });
  assert.equal(status.status, 200);
  assert.equal(status.body.accepted, false);
  assert.equal(status.body.version, current.version);
  assert.equal(status.body.guardianRequired, false);
  assert.equal((await call('GET', '/api/profiles', { token: owner.token })).status, 200);
  assert.equal((await call('GET', '/api/legal/status')).status, 401, 'status needs a sign-in');

  // A media token can't accept on anyone's behalf.
  assert.equal((await call('POST', `/api/legal/terms/accept?token=${owner.media}`, { body: { version: current.version, sha256: current.sha256, readToEnd: true } })).status, 401);

  // Acceptance must match what was shown, and the text must have been read.
  assert.equal((await accept(owner.token, { ...current, sha256: 'f'.repeat(64) })).body.code, 'TERMS_OUTDATED');
  assert.equal((await accept(owner.token, { ...current, version: '0.9' })).status, 409);
  const unread = await accept(owner.token, current, { readToEnd: false });
  assert.equal(unread.status, 400);
  assert.equal(unread.body.code, 'TERMS_NOT_READ');
  assert.equal((await call('GET', '/api/library', { token: owner.token })).status, 403, 'still locked');

  const ok = await accept(owner.token, current);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.accepted, true);
  assert.equal(ok.body.version, current.version);

  for (const [url, token] of [['/api/library', owner.token], ['/api/settings', owner.token], [`/api/media/stream/x?token=${owner.media}`, null]]) {
    assert.equal((await call('GET', url, { token })).status, 200, `${url.replace(/token=[^&]+/, 'token=…')} after accepting`);
  }
  // Every device of that profile is through, not just this one.
  assert.equal((await call('GET', '/api/library', { token: signIn('default').token })).status, 200);

  // A profile edit can't fake or remove an acceptance.
  profiles.update('default', { terms: { version: '999' } });
  assert.equal(profiles.get('default').terms.version, current.version);

  // Evidence: who, which wording, when, from which device.
  const records = terms.records();
  assert.equal(records[0].profileId, 'default');
  assert.equal(records[0].version, current.version);
  assert.equal(records[0].sha256, current.sha256);
  assert.equal(records[0].readToEnd, true);
  assert.equal(records[0].device, 'Terms test');
  assert.equal(records[0].sessionId, owner.session.id);
  assert.ok(Date.parse(records[0].acceptedAt) > 0);
});

test('every person accepts for themselves; a guardian accepts for a kids’ profile', async () => {
  const current = terms.current();
  const owner = signIn('default');
  const partner = profiles.create({ name: 'Partner' });
  const kid = profiles.create({ name: 'Little one', kids: true });

  // The owner having accepted doesn't cover anyone else.
  const partnerSession = signIn(partner.id);
  assert.equal((await call('GET', '/api/library', { token: partnerSession.token })).body.code, 'TERMS_REQUIRED');

  // Switching profile works before accepting (so the right person can accept)...
  const switched = await call('POST', `/api/profiles/${kid.id}/switch`, { token: owner.token });
  assert.equal(switched.status, 200);
  // ...and the new profile meets the gate.
  const kidToken = switched.body.token;
  assert.equal((await call('GET', '/api/library', { token: kidToken })).body.code, 'TERMS_REQUIRED');
  const kidStatus = await call('GET', '/api/legal/status', { token: kidToken });
  assert.equal(kidStatus.body.guardianRequired, true);
  assert.equal(kidStatus.body.profile.name, 'Little one');

  const noGuardian = await accept(kidToken, current);
  assert.equal(noGuardian.status, 400);
  assert.equal(noGuardian.body.code, 'GUARDIAN_REQUIRED');
  assert.equal((await accept(kidToken, current, { guardian: true })).status, 200);
  assert.equal((await call('GET', '/api/library', { token: kidToken })).status, 200);
  assert.equal(terms.records()[0].acceptedByGuardian, true);

  assert.equal((await accept(partnerSession.token, current)).status, 200);
  assert.equal((await call('GET', '/api/library', { token: partnerSession.token })).status, 200);
});

test('only an admin can read the acceptance records', async () => {
  const kid = profiles.list().find(p => p.kids);
  const kidSession = signIn(kid.id);
  assert.equal((await call('GET', '/api/legal/acceptances', { token: kidSession.token })).status, 403);
  const admin = await call('GET', '/api/legal/acceptances', { token: signIn('default').token });
  assert.equal(admin.status, 200);
  assert.ok(admin.body.records.length >= 3);
});

test('Subsonic apps only work for a profile that accepted the terms', async () => {
  const origValidate = authService.validateCredentials;
  authService.validateCredentials = () => false;
  const stranger = profiles.create({ name: 'Never accepted' });
  try {
    subsonic.setSubsonicPassword('music-only', 'owner');
    subsonic.setSubsonicProfile(stranger.id);
    const refused = (await call('GET', '/rest/ping?u=owner&p=music-only&f=json')).body['subsonic-response'];
    assert.equal(refused.status, 'failed');
    assert.match(refused.error.message, /Terms of Use/);

    subsonic.setSubsonicProfile('default');
    const ok = (await call('GET', '/rest/ping?u=owner&p=music-only&f=json')).body['subsonic-response'];
    assert.equal(ok.status, 'ok', 'the owner accepted earlier');
  } finally {
    authService.validateCredentials = origValidate;
    delete memory.auth.subsonic;
  }
});

test('updated terms: everyone is asked again, and the old acceptance is kept on record', async () => {
  const before = terms.current();
  const owner = signIn('default');
  assert.equal((await call('GET', '/api/library', { token: owner.token })).status, 200);

  setTermsFile(TERMS_SOURCE
    .replace('data-version="1.0"', 'data-version="1.1"')
    .replace('Version 1.0 ·', 'Version 1.1 ·')
    .replace('<h2>14. General</h2>', '<h2>14. General</h2>\n<p>A new clause.</p>'));
  try {
    const next = terms.current();
    assert.equal(next.version, '1.1');
    assert.notEqual(next.sha256, before.sha256);
    const blocked = await call('GET', '/api/library', { token: owner.token });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'TERMS_REQUIRED');
    const status = (await call('GET', '/api/legal/status', { token: owner.token })).body;
    assert.equal(status.accepted, false);
    assert.equal(status.acceptedVersion, before.version, 'the app can say "updated"');

    assert.equal((await accept(owner.token, before)).body.code, 'TERMS_OUTDATED', 'the old text can’t be accepted any more');
    assert.equal((await accept(owner.token, next)).status, 200);
    assert.equal((await call('GET', '/api/library', { token: owner.token })).status, 200);
    const versions = terms.records().filter(r => r.profileId === 'default').map(r => r.version);
    assert.deepEqual(versions.slice(0, 2), ['1.1', before.version]);
  } finally {
    setTermsFile(TERMS_SOURCE);
  }
});

test('a missing or broken terms file locks everyone out (fails closed)', async () => {
  const owner = signIn('default');
  // (After the previous test the owner accepted 1.1; going back to 1.0 asks again.)
  assert.equal((await call('GET', '/api/library', { token: owner.token })).body.code, 'TERMS_REQUIRED');
  assert.equal((await accept(owner.token, terms.current())).status, 200);
  assert.equal((await call('GET', '/api/library', { token: owner.token })).status, 200);
  for (const broken of [null, '<html><body>No terms here</body></html>', TERMS_SOURCE.replace(/data-version="[^"]*"/, 'data-version=""')]) {
    if (broken === null) {
      fs.rmSync(path.join(DOCS, 'terms.html'));
      terms._resetCache();
    } else {
      setTermsFile(broken);
    }
    try {
      const res = await call('GET', '/api/library', { token: owner.token });
      assert.equal(res.status, 403);
      assert.equal(res.body.code, 'TERMS_UNAVAILABLE');
      assert.equal((await call('GET', '/api/legal/terms')).status, 503);
      assert.equal((await call('POST', '/api/legal/terms/accept', { token: owner.token, body: { version: '1.0', sha256: 'x', readToEnd: true } })).status, 503);
    } finally {
      setTermsFile(TERMS_SOURCE);
    }
  }
  assert.equal((await call('GET', '/api/library', { token: owner.token })).status, 200);
});

// --------------------------------------------------------------- signing up
test('first-time setup (signing up) requires reading and accepting the terms', async () => {
  const current = terms.current();
  // A brand-new server: no config file, and the owner's acceptance forgotten.
  fs.rmSync(configModule.CONFIG_PATH, { force: true });
  stores.set('profiles.json', { profiles: [] });
  const media = Object.fromEntries(Object.keys(configModule.DEFAULT_CONFIG.media.paths).map(k => [k, path.join(TMP, 'media', k)]));
  const body = { username: 'owner', password: 'Correct-Horse-9', confirmPassword: 'Correct-Horse-9', gridPattern: [2, 3, 6, 7, 10, 11, 14, 15], mediaPaths: media };

  const without = await call('POST', '/api/setup/complete', { body });
  assert.equal(without.status, 400);
  assert.equal(without.body.code, 'TERMS_NOT_ACCEPTED');
  assert.equal(without.body.terms.version, current.version);
  assert.equal(memory.auth.passwordHash, configModule.DEFAULT_CONFIG.auth.passwordHash, 'nothing was saved');

  const unread = await call('POST', '/api/setup/complete', { body: { ...body, acceptTerms: { version: current.version, sha256: current.sha256 } } });
  assert.equal(unread.body.code, 'TERMS_NOT_ACCEPTED');
  const stale = await call('POST', '/api/setup/complete', { body: { ...body, acceptTerms: { version: '0.1', sha256: current.sha256, readToEnd: true } } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'TERMS_OUTDATED');

  const done = await call('POST', '/api/setup/complete', { body: { ...body, acceptTerms: { version: current.version, sha256: current.sha256, readToEnd: true } } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.token);
  // The owner is straight in: their acceptance was recorded at sign-up.
  assert.equal((await call('GET', '/api/library', { token: done.body.token })).status, 200);
  assert.equal(profiles.get('default').terms.version, current.version);
  const record = terms.records()[0];
  assert.equal(record.profileId, 'default');
  assert.equal(record.username, 'owner');
  assert.equal(record.device, 'Setup');
});

test('the gate keeps a short allow-list', () => {
  const allowed = [['GET', '/api/legal/status'], ['GET', '/api/legal/terms'], ['POST', '/api/legal/terms/accept'], ['POST', '/api/auth/refresh'], ['GET', '/api/profiles'], ['POST', '/api/profiles/abc/switch'], ['HEAD', '/api/legal/status']];
  for (const [m, p] of allowed) assert.equal(terms.gateAllows(m, p), true, `${m} ${p}`);
  const refused = [['POST', '/api/profiles'], ['PUT', '/api/profiles/abc'], ['DELETE', '/api/profiles/abc'], ['GET', '/api/profiles/abc/summary'], ['POST', '/api/legal/acceptances/x'], ['GET', '/api/legalese'], ['GET', '/api/auth/media-token'], ['POST', '/api/settings'], ['GET', '/api/library']];
  for (const [m, p] of refused) assert.equal(terms.gateAllows(m, p), false, `${m} ${p}`);
});

test('acceptance ids are unique and the record keeps the device address', () => {
  const ids = terms.records().map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(terms.records().every(r => typeof r.ip === 'string' && r.ip.length > 0));
});
