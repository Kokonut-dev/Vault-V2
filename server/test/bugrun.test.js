/**
 * Bug run (data layer + authorization) — one reproducing test per fixed bug.
 * Each of these failed before its fix:
 *
 *   1. PUT /api/settings was open to every profile and answered with the raw
 *      config (JWT secret + password hash). Credentials too.
 *   2. A password change left other devices signed in; tokens without a
 *      session were accepted forever.
 *   3. Kids profiles could empty the trash (permanent delete), wipe caches,
 *      manage podcast feeds, and write series-wide markers.
 *   4. Profile PINs could be guessed without limit.
 *   5. A scan deleted every item of a library folder that was offline.
 *   6. A corrupt JSON store was silently replaced with an empty one.
 *   7. Fuzzer 500s: type=__proto__, unknown podcast feed, missing Drive link.
 *   8. The subtitle route served any file next to a video.
 *   9. SyncPlay: the host got 403 changing the item, member ids were the only
 *      credential, room passwords were stored in plain text, chat was public.
 *  10. saveConfig dropped Google Drive and Remote access settings.
 *  11. The SQLite index ignored libraryId/rating and fuzzy-matched genres.
 *  12. Modal titles/labels were inserted as HTML (stored XSS).
 *
 * Config and every JSON store are in-memory fakes; temp files go to os.tmpdir().
 */
const os = require('node:os');
const fsp = require('node:fs/promises');
const nodePath = require('node:path');

const TMP = require('node:fs').mkdtempSync(nodePath.join(os.tmpdir(), 'vault-bugrun-'));
process.env.VAULT_INDEX_DB = nodePath.join(TMP, 'index.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pathToFileURL } = require('node:url');

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.auth = { ...memory.auth, username: 'owner', passwordHash: bcrypt.hashSync('old-password', 4), jwtSecret: 'bugrun-test-secret-'.padEnd(48, 'x') };
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const stores = new Map();
const jsonStore = require('../utils/jsonStore');
jsonStore.createJsonStore = (name, defaultValue) => {
  if (!stores.has(name)) stores.set(name, structuredClone(defaultValue));
  return {
    get: () => stores.get(name),
    set: (next) => { stores.set(name, next); return next; },
    update: (fn) => { const next = fn(stores.get(name)); if (next !== undefined) stores.set(name, next); return stores.get(name); },
    save: () => {},
    saveNow: async () => {},
    flush: async () => {},
  };
};

// ---- library fixture (subtitle files live in TMP) ---------------------------
const MOVIE_DIR = nodePath.join(TMP, 'Movie');
fs.mkdirSync(MOVIE_DIR);
fs.writeFileSync(nodePath.join(MOVIE_DIR, 'movie.mkv'), '');
fs.writeFileSync(nodePath.join(MOVIE_DIR, 'movie.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
fs.writeFileSync(nodePath.join(MOVIE_DIR, 'notes.txt'), 'private notes');
fs.mkdirSync(`${MOVIE_DIR}2`);
fs.writeFileSync(nodePath.join(`${MOVIE_DIR}2`, 'other.srt'), 'x');

const ITEMS = [
  { id: 'm_g', type: 'movie', title: 'Garden Friends', contentRating: 'G', path: nodePath.join(MOVIE_DIR, 'movie.mkv'), seriesKey: 'garden', subtitles: [{ id: 'evil', path: nodePath.join(`${MOVIE_DIR}2`, 'other.srt') }] },
  { id: 'm_r', type: 'movie', title: 'Hard Rain', contentRating: 'Rated R', path: '/nonexistent/r.mkv' },
];
const libraryService = require('../services/library');
libraryService.getAll = () => ITEMS;
libraryService.getById = (id) => ITEMS.find(i => i.id === id) || null;

const authService = require('../services/authService');
authService.recordFailedAttempt = () => {};
authService.resetAttempts = () => {};
authService.isLocked = () => false;

const profiles = require('../services/profiles');
const sessions = require('../services/sessions');
const syncplay = require('../services/syncplay');
const { authMiddleware } = require('../middleware/auth');

const P = (id, extra = {}) => ({ id, name: id, color: '#5B87C9', avatar: null, pinHash: null, isAdmin: false, kids: false, maxRating: null, ...extra });
function standardProfiles() {
  stores.set('profiles.json', {
    profiles: [
      P('default', { name: 'Sam', isAdmin: true }),
      P('p_adult', { name: 'Alex' }),
      P('p_kid', { name: 'Robin', kids: true, maxRating: 9, allowUnrated: false }),
    ],
  });
  profiles._pinAttempts?.clear();
}

function tokenFor(profileId) {
  const session = sessions.create({ username: 'owner', profileId, req: { headers: {}, ip: '127.0.0.1' }, label: 'test' });
  return { token: authService.generateAccessToken('owner', { sid: session.id, profileId }), sid: session.id };
}

let server;
let port;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', authMiddleware, require('../routes/settings'));
  app.use('/api/extras', authMiddleware, require('../routes/extras'));
  app.use('/api/transcode', authMiddleware, require('../routes/transcode'));
  app.use('/api/podcasts', authMiddleware, require('../routes/podcasts'));
  app.use('/api/profiles', authMiddleware, require('../routes/profiles'));
  app.use('/api/media', authMiddleware, require('../routes/media'));
  app.use('/api/syncplay', authMiddleware, require('../routes/syncplay'));
  app.get('/api/whoami', authMiddleware, (req, res) => res.json({ profileId: req.profileId }));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(async () => {
  await new Promise(r => server.close(r));
  await fsp.rm(TMP, { recursive: true, force: true });
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
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: json, text: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------ 1. settings

test('settings: only admins may change them, and secrets are never returned', async () => {
  standardProfiles();
  const kid = tokenFor('p_kid').token;
  const adult = tokenFor('p_adult').token;
  const owner = tokenFor('default').token;
  const secret = memory.auth.jwtSecret;

  for (const token of [kid, adult]) {
    const res = await call('PUT', '/api/settings', { token, body: { cors: { origins: ['https://evil.example'] } } });
    assert.equal(res.status, 403, 'non-admin profiles are refused');
    assert.ok(!res.text.includes(secret), 'and get no secrets');
    assert.equal((await call('PUT', '/api/settings/credentials', { token, body: { currentPassword: 'old-password', newPassword: 'hijacked-1' } })).status, 403);
  }
  assert.ok(bcrypt.compareSync('old-password', memory.auth.passwordHash), 'password unchanged');

  const ok = await call('PUT', '/api/settings', { token: owner, body: { notifications: { webhooks: ['http://169.254.169.254/'] } } });
  assert.equal(ok.status, 200);
  assert.ok(!ok.text.includes(secret), 'admin response has no JWT secret');
  assert.ok(!ok.text.includes(memory.auth.passwordHash), 'or password hash');
  assert.equal(ok.body.settings.auth.jwtSecret, undefined);
  assert.ok(!JSON.stringify(memory.notifications || {}).includes('169.254'), 'notification targets only go through the validated route');
});

// ------------------------------------------------------- 2. sessions/tokens

test('a new password signs out other devices, rotates the secret and keeps this one', async () => {
  standardProfiles();
  const other = tokenFor('default');
  const me = tokenFor('default');
  const oldSecret = memory.auth.jwtSecret;

  const res = await call('PUT', '/api/settings/credentials', { token: me.token, body: { currentPassword: 'old-password', newPassword: 'new-password-1' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token, 'this device gets a fresh token');
  assert.ok(res.body.signedOut >= 1);
  assert.notEqual(memory.auth.jwtSecret, oldSecret, 'signing secret rotated');

  assert.equal((await call('GET', '/api/whoami', { token: other.token })).status, 401, 'other device signed out');
  assert.equal((await call('GET', '/api/whoami', { token: me.token })).status, 401, 'old tokens (old secret) stop working');
  assert.equal((await call('GET', '/api/whoami', { token: res.body.token })).status, 200, 'the fresh token works');
  // restore for later tests
  memory.auth.passwordHash = bcrypt.hashSync('old-password', 4);
});

test('tokens without a device session are refused', async () => {
  const forged = authService.generateAccessToken('owner', { profileId: 'default' });
  const res = await call('GET', '/api/whoami', { token: forged });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'TOKEN_REVOKED');
});

// ------------------------------------------------- 3. kids can't destroy

test('age-limited and non-admin profiles cannot purge, wipe caches or manage feeds', async () => {
  standardProfiles();
  const kid = tokenFor('p_kid').token;
  const adult = tokenFor('p_adult').token;
  for (const token of [kid, adult]) {
    assert.equal((await call('DELETE', '/api/extras/trash', { token })).status, 403, 'empty trash');
    assert.equal((await call('DELETE', '/api/extras/trash/x', { token })).status, 403, 'purge');
    assert.equal((await call('POST', '/api/extras/trash/x/restore', { token })).status, 403, 'restore');
    assert.equal((await call('GET', '/api/extras/trash', { token })).status, 403, 'list');
    assert.equal((await call('DELETE', '/api/transcode/cache', { token })).status, 403);
    assert.equal((await call('DELETE', '/api/transcode/hls/cache', { token })).status, 403);
    assert.equal((await call('POST', '/api/podcasts/feeds', { token, body: { url: 'http://127.0.0.1:1/feed' } })).status, 403);
    assert.equal((await call('POST', '/api/podcasts/refresh', { token })).status, 403);
  }
  assert.equal((await call('PUT', '/api/extras/markers/m_g', { token: kid, body: { intro: { start: 0, end: 5 } } })).status, 403, 'markers are shared');
  assert.equal((await call('POST', '/api/extras/collections', { token: kid, body: { name: 'x' } })).status, 403);
  assert.equal((await call('GET', '/api/extras/markers/m_r', { token: kid })).status, 404, 'hidden items 404');
  assert.equal((await call('POST', '/api/extras/watched/m_r', { token: kid })).status, 404);
  assert.equal((await call('POST', '/api/extras/bookmarks', { token: kid, body: { itemId: 'm_r', time: 3 } })).status, 404);
});

// ---------------------------------------------------------------- 4. PINs

test('profile PINs lock after five wrong guesses', async () => {
  standardProfiles();
  profiles.update('p_adult', { pin: '4321' });
  const kid = tokenFor('p_kid').token;
  for (let i = 0; i < 5; i++) {
    const res = await call('POST', '/api/profiles/p_adult/switch', { token: kid, body: { pin: String(1000 + i) } });
    assert.equal(res.status, i < 4 ? 403 : 429, `guess ${i + 1}`);
  }
  const locked = await call('POST', '/api/profiles/p_adult/switch', { token: kid, body: { pin: '4321' } });
  assert.equal(locked.status, 429, 'even the right PIN waits out the lock');
  assert.equal(locked.body.code, 'PROFILE_PIN_LOCKED');
  assert.ok(locked.body.retryAfter > 0);

  profiles._pinAttempts?.clear();
  assert.equal((await call('POST', '/api/profiles/p_adult/switch', { token: kid, body: { pin: '4321' } })).status, 200);
  assert.equal((await call('POST', '/api/profiles/p_adult/switch', { token: kid, body: {} })).status, 403, 'a missing PIN is not a guess');
});

// ---------------------------------------------------------- 5. offline roots

test('a scan keeps the items of a library folder that is offline', async () => {
  const online = nodePath.join(TMP, 'online');
  const offline = nodePath.join(TMP, 'offline-drive');
  fs.mkdirSync(online);
  fs.writeFileSync(nodePath.join(online, 'readme.txt'), 'not media');
  const scanner = require('../services/scanner');
  const saved = { paths: memory.media.paths, libraries: memory.media.libraries };
  memory.media.paths = { movies: online, music: offline, videos: online };
  memory.media.libraries = [];
  const lib = [
    { id: 'gone', type: 'movie', title: 'Deleted', path: nodePath.join(online, 'deleted.mkv') },
    { id: 'away1', type: 'music', title: 'On the NAS', path: nodePath.join(offline, 'a.mp3') },
    { id: 'away2', type: 'music', title: 'Also there', path: nodePath.join(offline, 'sub', 'b.mp3') },
  ];
  const removed = [];
  const origAll = libraryService.getAll;
  const origRemove = libraryService.removeItem;
  libraryService.getAll = () => lib;
  libraryService.removeItem = (id) => { removed.push(id); return true; };
  try {
    const result = await scanner.scanAll();
    assert.deepEqual(removed, ['gone'], 'only the file that is really gone is removed');
    assert.equal(result.kept, 2);
    assert.ok(result.offline.includes(offline));
  } finally {
    libraryService.getAll = origAll;
    libraryService.removeItem = origRemove;
    Object.assign(memory.media, saved);
  }
  assert.equal(scanner.isUnder('/media/Movie2/x', '/media/Movie'), false);
  assert.equal(scanner.isUnder('/media/Movie/x', '/media/Movie'), true);
});

// ------------------------------------------------------------ 6. corrupt JSON

test('a corrupt data file is kept aside, not overwritten with an empty list', () => {
  const { readJsonOrQuarantine } = require('../utils/fileUtils');
  const file = nodePath.join(TMP, 'history.json');
  fs.writeFileSync(file, '[{"itemId":"a"},{"itemId":');
  const seen = [];
  assert.deepEqual(readJsonOrQuarantine(file, [], { onCorrupt: (i) => seen.push(i) }), []);
  assert.equal(fs.existsSync(file), false, 'moved aside');
  assert.ok(seen[0].backup && fs.readFileSync(seen[0].backup, 'utf8').includes('"itemId":"a"'), 'the original bytes survive');

  fs.writeFileSync(file, '{"not":"a list"}');
  assert.deepEqual(readJsonOrQuarantine(file, [], { onCorrupt: () => {} }), [], 'wrong shape counts as corrupt');
  fs.writeFileSync(file, '[1,2]');
  assert.deepEqual(readJsonOrQuarantine(file, []), [1, 2]);
  assert.equal(readJsonOrQuarantine(nodePath.join(TMP, 'missing.json'), 'fallback'), 'fallback');
});

// ------------------------------------------------------------ 7. fuzzer 500s

test('fuzzer findings: prototype keys, unknown feeds and missing Drive links', async () => {
  const realLibrary = require('../services/library');
  for (const type of ['__proto__', 'constructor', 'toString']) {
    const list = realLibrary.getByType(type);
    assert.ok(Array.isArray(list) && list.length === 0, type);
  }
  standardProfiles();
  const owner = tokenFor('default').token;
  const dl = await call('POST', '/api/podcasts/feeds/nope/episodes/x/download', { token: owner });
  assert.equal(dl.status, 404);

  const gdrive = require('../services/gdrive');
  for (const link of [undefined, null, '', {}]) {
    await assert.rejects(gdrive.inspect(link), (err) => err instanceof gdrive.DriveError && err.status === 400, String(link));
  }
});

// ------------------------------------------------------------- 8. subtitles

test('the subtitle route only serves subtitle files from the item folder', async () => {
  standardProfiles();
  const owner = tokenFor('default').token;
  const srt = await call('GET', '/api/media/subtitle/m_g/movie.srt', { token: owner });
  assert.equal(srt.status, 200);
  assert.match(srt.text, /^WEBVTT/);
  // Unknown ids fall back to the item's own subtitle (movie.srt) — but the
  // requested non-subtitle file itself is never handed out.
  const notes = await call('GET', '/api/media/subtitle/m_g/notes.txt', { token: owner });
  assert.ok(!notes.text.includes('private notes'), 'not any file in the folder');
  assert.match(notes.text, /Hello/);
  const evil = await call('GET', '/api/media/subtitle/m_g/evil', { token: owner });
  assert.match(evil.text, /Hello/, 'a sibling folder with the same name prefix is outside (other.srt not served)');
  fs.unlinkSync(nodePath.join(MOVIE_DIR, 'movie.srt'));
  assert.equal((await call('GET', '/api/media/subtitle/m_g/notes.txt', { token: owner })).status, 404);
});

// ------------------------------------------------------------- 9. SyncPlay

test('SyncPlay: the host can drive the room; members need their token', async () => {
  standardProfiles();
  const host = tokenFor('default');
  const guest = tokenFor('p_adult');
  const kid = tokenFor('p_kid');

  const created = await call('POST', '/api/syncplay/rooms', { token: host.token, body: { name: 'Movie night', password: 'popcorn' } });
  assert.equal(created.status, 200);
  const room = created.body.room;
  const hostToken = created.body.member.token;
  assert.ok(created.body.member.host, 'the creator is the host');
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  assert.equal(syncplay.getRoom(room.id).password, undefined, 'no plain-text password');
  assert.ok(!JSON.stringify(syncplay.publicRoom(syncplay.getRoom(room.id))).includes(hostToken), 'tokens are never public');

  const asHost = { 'X-SyncPlay-Member': hostToken };
  const item = await call('POST', `/api/syncplay/rooms/${room.id}/item`, { token: host.token, headers: asHost, body: { itemId: 'm_g' } });
  assert.equal(item.status, 200, 'the host can change the item (was 403)');

  assert.equal((await call('POST', `/api/syncplay/rooms/${room.code}/join`, { token: guest.token, body: {} })).status, 403, 'password needed');
  assert.equal((await call('POST', `/api/syncplay/rooms/${room.code}/join`, { token: guest.token, body: { password: 'nope' } })).status, 403);
  const joined = await call('POST', `/api/syncplay/rooms/${room.code}/join`, { token: guest.token, body: { password: 'popcorn', name: 'Alex' } });
  assert.equal(joined.status, 200);
  const asGuest = { 'X-SyncPlay-Member': joined.body.member.token };
  assert.equal(joined.body.member.host, false);

  // The member id is public and is no longer a credential.
  const hostMemberId = created.body.member.id;
  assert.equal((await call('POST', `/api/syncplay/rooms/${room.id}/item`, { token: guest.token, body: { itemId: 'm_g', memberId: hostMemberId } })).status, 403);
  assert.equal((await call('POST', `/api/syncplay/rooms/${room.id}/item`, { token: guest.token, headers: asGuest, body: { itemId: 'm_g' } })).status, 403, 'guests cannot command');

  const report = await call('POST', `/api/syncplay/rooms/${room.id}/state`, { token: guest.token, headers: asGuest, body: { position: 100 } });
  assert.equal(report.body.role, 'guest');
  assert.equal(report.body.action, 'seek');
  assert.equal(report.body.playing, true);

  await call('POST', `/api/syncplay/rooms/${room.id}/chat`, { token: guest.token, headers: asGuest, body: { text: 'hi' } });
  const outsider = await call('GET', `/api/syncplay/rooms/${room.id}`, { token: kid.token });
  assert.equal(outsider.body.chat, undefined, 'no chat for non-members');
  assert.equal((await call('POST', `/api/syncplay/rooms/${room.id}/chat`, { token: kid.token, body: { text: 'x' } })).status, 403);
  const member = await call('GET', `/api/syncplay/rooms/${room.id}`, { token: guest.token, headers: asGuest });
  assert.deepEqual(member.body.chat.map(m => m.text), ['hi']);

  // Pause from the host freezes the room clock.
  const paused = await call('POST', `/api/syncplay/rooms/${room.id}/state`, { token: host.token, headers: asHost, body: { playing: false, position: 42 } });
  assert.equal(paused.body.role, 'host');
  assert.equal(syncplay.currentPosition(syncplay.getRoom(room.id)), 42);

  // The host leaves: the guest takes over.
  assert.equal((await call('POST', `/api/syncplay/rooms/${room.id}/leave`, { token: host.token, headers: asHost })).status, 200);
  const after = await call('GET', `/api/syncplay/rooms/${room.id}`, { token: guest.token, headers: asGuest });
  assert.equal(after.body.member.host, true);

  // Active members are not swept (lastSeen moves with every request).
  syncplay.sweep(Date.now() + 60_000);
  assert.equal(syncplay.getRoom(room.id).members.length, 1);
});

// ---------------------------------------------------------- 10. saveConfig

test('saved config keeps Google Drive and Remote access settings', () => {
  const real = require('../config')._internals.persistedShape;
  const shape = real({ ...structuredClone(configModule.DEFAULT_CONFIG), integrations: { googleDrive: { apiKey: 'k' } }, remoteAccess: { tunnelOnStartup: true } });
  assert.deepEqual(shape.integrations, { googleDrive: { apiKey: 'k' } });
  assert.deepEqual(shape.remoteAccess, { tunnelOnStartup: true });
});

// ------------------------------------------------------------- 11. SQLite

test('the SQLite index filters like the in-memory path', (t) => {
  const sqlite = require('../services/sqliteIndex');
  if (!sqlite.tryLoad()) return t.skip('node:sqlite not available on this Node version');
  sqlite.sync([
    { id: 'a', type: 'music', title: 'alpha', genre: ['Rock', 'Pop'], libraryId: 'lib1', rating: 8, addedAt: '1' },
    { id: 'b', type: 'music', title: 'Beta', genre: 'Rock & Roll', libraryId: 'lib2', rating: 5, addedAt: '2' },
    { id: 'c', type: 'music', title: 'gamma', genre: 'Krautrock', libraryId: 'lib1', addedAt: '3' },
    { id: 'd', type: 'music', title: '100%', genre: 'Pop', libraryId: 'lib1', rating: 9, addedAt: '4' },
  ]);
  const ids = (q) => sqlite.query(q).items.map(i => i.id);
  assert.deepEqual(ids({ genre: 'Rock', sort: 'title', order: 'asc' }), ['a'], 'exact genre, not substring');
  assert.deepEqual(ids({ genre: '%', sort: 'title' }), [], '% is not a wildcard');
  assert.deepEqual(ids({ libraryId: 'lib2' }), ['b']);
  assert.deepEqual(ids({ rating: '8', sort: 'title', order: 'asc' }).sort(), ['a', 'd']);
  assert.deepEqual(ids({ sort: 'title', order: 'asc' }), ['d', 'a', 'b', 'c'], 'case-insensitive title sort');
  assert.equal(sqlite.query({ page: -3 }).page, 1);
});

// ------------------------------------------------------------- 12. XSS

test('modal titles, labels and messages are text, not HTML', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://vault.example.test/' });
  const saved = {};
  for (const key of ['window', 'document', 'CustomEvent', 'HTMLElement', 'Node']) {
    saved[key] = globalThis[key];
    globalThis[key] = key === 'window' ? dom.window : dom.window[key] || dom.window.document;
  }
  globalThis.document = dom.window.document;
  try {
    const docs = (...p) => pathToFileURL(nodePath.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
    const { createModal, promptModal } = await import(docs('components', 'modal.js'));
    const evil = '<img src=x onerror="window.__xss=1">';
    const { backdrop, close } = createModal({ title: `Delete "${evil}"?`, content: '<b>ok</b>' });
    assert.equal(backdrop.querySelector('img'), null, 'no element from the title');
    assert.equal(backdrop.querySelector('.modal-title').textContent, `Delete "${evil}"?`, 'shown literally');
    assert.ok(backdrop.querySelector('.modal-body b'), 'content stays HTML');
    close();

    const pending = promptModal({ title: evil, message: evil, label: evil, placeholder: `"${evil}`, value: evil, confirmLabel: evil });
    const modal = dom.window.document.querySelector('.modal-backdrop');
    assert.equal(modal.querySelector('img'), null);
    assert.equal(modal.querySelector('#prompt-input').getAttribute('placeholder'), `"${evil}`);
    assert.equal(modal.querySelector('#prompt-input').value, evil);
    modal.querySelector('[data-cancel]').click();
    assert.equal(await pending, null);
  } finally {
    for (const [key, value] of Object.entries(saved)) globalThis[key] = value;
  }
});
