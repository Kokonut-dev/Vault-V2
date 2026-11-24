/**
 * The profiles system end to end:
 *   - age ratings (contentRating) and the Kids / age-limit filter on every
 *     route that hands out items, including streaming by id;
 *   - age-limited profiles can't edit the library (or re-rate items);
 *   - the session decides the profile, so an older token follows a switch,
 *     and a deleted profile's devices are signed out with its data gone;
 *   - signing in never bypasses a profile PIN;
 *   - profile input validation and private summaries.
 *
 * Config and every JSON store are in-memory fakes, and the library is a
 * fixed list, so nothing here touches server/data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.auth = { ...memory.auth, username: 'owner', jwtSecret: 'profiles-test-secret-'.padEnd(48, 'x') };
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

// ---- a fixed library -------------------------------------------------------
const ITEMS = [
  { id: 'm_g', type: 'movie', title: 'Garden Friends', genre: 'Family', contentRating: 'G', path: '/nonexistent/a.mkv' },
  { id: 'm_pg', type: 'movie', title: 'Sky Pirates', contentRating: 'PG', path: '/nonexistent/b.mkv' },
  { id: 'm_pg13', type: 'movie', title: 'Night Heist', contentRating: 'PG-13', path: '/nonexistent/c.mkv' },
  { id: 'm_r', type: 'movie', title: 'Hard Rain', genre: ['Thriller', 'Family'], contentRating: 'Rated R', path: '/nonexistent/d.mkv' },
  { id: 'm_nl12', type: 'movie', title: 'Polder', contentRating: 'NL:12', path: '/nonexistent/e.mkv' },
  { id: 'm_unrated', type: 'movie', title: 'Mystery Reel', path: '/nonexistent/f.mkv' },
  { id: 's_ep', type: 'movie', title: 'Show S01E01', seriesKey: 'show', season: 1, episode: 1, contentRating: 'TV-MA', path: '/nonexistent/g.mkv' },
  { id: 's_ep_kids', type: 'movie', title: 'Cartoon S01E01', seriesKey: 'cartoon', season: 1, episode: 1, contentRating: 'TV-Y', path: '/nonexistent/h.mkv' },
  { id: 'song', type: 'music', title: 'Lullaby', path: '/nonexistent/i.mp3' },
];
const libraryService = require('../services/library');
const updates = [];
const removedData = [];
libraryService.getAll = () => ITEMS;
libraryService.getById = (id) => ITEMS.find(i => i.id === id) || null;
libraryService.search = (q) => ITEMS.filter(i => i.title.toLowerCase().includes(String(q).toLowerCase()));
libraryService.updateItem = (id, patch) => { updates.push({ id, patch }); return { ...libraryService.getById(id), ...patch }; };
libraryService.removeProfileData = async (id) => { removedData.push(id); return true; };
// Scoped favourites resolve ids through the service's private index, which
// the fixed list above bypasses; resolve them through getById instead.
const realForProfile = libraryService.forProfile;
libraryService.forProfile = (id) => {
  const scoped = realForProfile(id);
  const favIds = () => stores.get(require('node:path').join('profiles', id, 'favourites.json')) || [];
  return { ...scoped, getFavourites: () => favIds().map(libraryService.getById).filter(Boolean) };
};

const authService = require('../services/authService');
authService.validateGridPattern = (pattern) => pattern.join(',') === '0,1,2,3,4,5,6,7';
authService.recordFailedAttempt = () => {};
authService.resetAttempts = () => {};
authService.isLocked = () => false;

const profiles = require('../services/profiles');
const contentRating = require('../services/contentRating');
const sessions = require('../services/sessions');
const extras = require('../services/extras');
const { authMiddleware } = require('../middleware/auth');
require('./helpers/terms').autoAcceptTerms(); // not a Terms of Use test (see test/terms.test.js)

const P = (id, extra = {}) => ({ id, name: id, color: '#5B87C9', avatar: null, pinHash: null, isAdmin: false, kids: false, maxRating: null, ...extra });
function seed(list) {
  stores.set('profiles.json', { profiles: structuredClone(list) });
}
function standardProfiles() {
  seed([
    P('default', { name: 'Sam', isAdmin: true }),
    P('p_adult', { name: 'Alex' }),
    P('p_kid', { name: 'Robin', kids: true, maxRating: 9, allowUnrated: false }),
  ]);
}

function tokenFor(profileId, extra = {}) {
  const session = sessions.create({ username: 'owner', profileId, req: { headers: {}, ip: '127.0.0.1' }, label: 'test' });
  return { token: authService.generateAccessToken('owner', { sid: session.id, profileId, ...extra }), sid: session.id };
}

let server;
let port;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/library', authMiddleware, require('../routes/library'));
  app.use('/api/media', authMiddleware, require('../routes/media'));
  app.use('/api/series', authMiddleware, require('../routes/series'));
  app.use('/api/playlists', authMiddleware, require('../routes/playlists'));
  app.use('/api/extras', authMiddleware, require('../routes/extras'));
  app.use('/api/profiles', authMiddleware, require('../routes/profiles'));
  app.get('/api/whoami', authMiddleware, (req, res) => res.json({ profileId: req.profileId }));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => new Promise(r => server.close(r)));

function call(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ids = (items) => items.map(i => i.id).sort();

// ------------------------------------------------------------ age ratings

test('age ratings from any country map to a minimum age', () => {
  const cases = {
    G: 0, PG: 8, 'PG-13': 13, R: 17, 'Rated R': 17, 'NC-17': 18,
    'TV-Y': 0, 'TV-Y7': 7, 'TV-PG': 8, 'TV-14': 14, 'TV-MA': 17,
    U: 0, '12A': 12, 15: 15, 18: 18, AL: 0, 'NL:12': 12, 'US:PG-13': 13, 'de/16': 16,
    'FSK 16': 16, 'FSK 0': 0, '16+': 16, '6 Jahre': 6,
  };
  for (const [label, age] of Object.entries(cases)) assert.equal(contentRating.ageFor(label), age, label);
  for (const unrated of [null, '', 'NR', 'Not Rated', 'Unrated', 'banana', '99']) {
    assert.equal(contentRating.ageFor(unrated), null, String(unrated));
  }
});

test('Kids profiles see only what fits their limit; adults see everything', () => {
  standardProfiles();
  assert.equal(profiles.restrictionFor('default'), null);
  assert.equal(profiles.restrictionFor('p_adult'), null);
  assert.deepEqual(profiles.restrictionFor('p_kid'), { maxAge: 9, allowUnrated: false });

  assert.deepEqual(ids(profiles.filterItems('p_kid', ITEMS)), ['m_g', 'm_pg', 's_ep_kids', 'song'],
    'PG (8) fits a 9 limit; PG-13, R, NL:12, TV-MA and the unrated film do not; unrated music does');
  assert.equal(profiles.filterItems('default', ITEMS), ITEMS, 'unrestricted lists are passed through untouched');

  profiles.update('p_kid', { allowUnrated: true });
  assert.ok(ids(profiles.filterItems('p_kid', ITEMS)).includes('m_unrated'), 'unrated films can be allowed');

  profiles.update('p_adult', { maxRating: 12 });
  assert.deepEqual(profiles.restrictionFor('p_adult'), { maxAge: 12, allowUnrated: true }, 'a grown-up limit lets unrated items through');
  assert.equal(profiles.canAccess('p_adult', ITEMS.find(i => i.id === 'm_nl12')), true);
  assert.equal(profiles.canAccess('p_adult', ITEMS.find(i => i.id === 'm_pg13')), false);
});

// ---------------------------------------------------------------- routes

test('library, search, recent, series, favourites and watchlist apply the limit', async () => {
  standardProfiles();
  const kid = tokenFor('p_kid').token;
  const owner = tokenFor('default').token;

  const all = await call('GET', '/api/library?limit=100', { token: owner });
  assert.equal(all.body.total, ITEMS.length);

  const list = await call('GET', '/api/library?limit=100', { token: kid });
  assert.equal(list.status, 200);
  assert.deepEqual(ids(list.body.items), ['m_g', 'm_pg', 's_ep_kids', 'song']);
  assert.equal(list.body.total, 4, 'totals count only visible items');

  const search = await call('GET', '/api/library/search?q=e', { token: kid });
  assert.ok(!search.body.results.movies.some(i => i.id === 'm_r' || i.id === 'm_pg13'));

  const shows = await call('GET', '/api/series/shows', { token: kid });
  assert.deepEqual(shows.body.shows.map(s => s.key), ['cartoon'], 'TV-MA shows are hidden');
  assert.equal((await call('GET', '/api/series/shows/show', { token: kid })).status, 404);

  // Favourites/watchlist added by id still don't show a hidden item.
  await call('POST', '/api/playlists/favourites/m_r', { token: kid });
  await call('POST', '/api/playlists/favourites/m_g', { token: kid });
  const favs = await call('GET', '/api/playlists/favourites', { token: kid });
  assert.deepEqual(ids(favs.body.items), ['m_g']);
  extras.addToWatchlist('m_r', 'p_kid');
  extras.addToWatchlist('m_pg', 'p_kid');
  const list2 = await call('GET', '/api/extras/watchlist', { token: kid });
  assert.deepEqual(ids(list2.body.items), ['m_pg']);
});

test('stats, genres and playlists only describe what the profile can see', async () => {
  standardProfiles();
  const kid = tokenFor('p_kid').token;

  const stats = await call('GET', '/api/library/stats', { token: kid });
  assert.equal(stats.body.totalItems, 4);
  assert.equal(stats.body.totalMovies, 3);
  assert.ok(!stats.body.recentlyAdded.some(i => i.id === 'm_r'));
  assert.deepEqual((await call('GET', '/api/library/genres', { token: kid })).body.genres, ['Family'],
    'a genre only an R-rated film has is not listed');

  // A playlist holding an item the profile can't see (e.g. made before the
  // limit was set): reordering and saving keep the hidden entry.
  const made = await call('POST', '/api/playlists', { token: kid, body: { name: 'Mix', items: ['m_r', 'm_g', 'm_pg'] } });
  const id = made.body.id;
  const shown = await call('GET', `/api/playlists/${id}`, { token: kid });
  assert.deepEqual(shown.body.itemsExpanded.map(i => i.id), ['m_g', 'm_pg']);

  const reordered = await call('PUT', `/api/playlists/${id}/order`, { token: kid, body: { from: 1, to: 0 } });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.body.items, ['m_pg', 'm_g', 'm_r'], 'indexes refer to the visible list');
  assert.deepEqual(reordered.body.itemsExpanded.map(i => i.id), ['m_pg', 'm_g']);

  const saved = await call('PUT', `/api/playlists/${id}`, { token: kid, body: { items: ['m_g'] } });
  assert.deepEqual(saved.body.items, ['m_g', 'm_r'], 'removing visible items never drops hidden ones');

  const m3u = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: `/api/playlists/${id}/export`, headers: { Authorization: `Bearer ${kid}` } }, (res) => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve(data));
    });
  });
  assert.match(m3u, /Garden Friends/);
  assert.doesNotMatch(m3u, /Hard Rain/);
  assert.equal((await call('GET', `/api/playlists/${id}/stats`, { token: kid })).body.count, 1);
});

test('hidden items 404 by id — details and streams alike', async () => {
  standardProfiles();
  const kid = tokenFor('p_kid').token;
  const owner = tokenFor('default').token;

  const hidden = await call('GET', '/api/library/m_r', { token: kid });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.code, 'NOT_FOUND');
  assert.equal((await call('GET', '/api/library/m_g', { token: kid })).status, 200);
  assert.equal((await call('GET', '/api/library/m_r', { token: owner })).status, 200);

  const stream = await call('GET', '/api/media/stream/m_r', { token: kid });
  assert.equal(stream.status, 404);
  assert.equal(stream.body.error, 'Item not found', 'same answer as an id that does not exist');
  const allowed = await call('GET', '/api/media/stream/m_g', { token: kid });
  assert.equal(allowed.body.error, 'File not found on disk', 'allowed items get through to the file check');
});

test('age-limited profiles cannot edit the library; only admins set age ratings', async () => {
  standardProfiles();
  updates.length = 0;
  const kid = tokenFor('p_kid').token;
  const adult = tokenFor('p_adult').token;
  const owner = tokenFor('default').token;

  const rerate = await call('PUT', '/api/library/m_g', { token: kid, body: { contentRating: 'G', title: 'x' } });
  assert.equal(rerate.status, 403);
  assert.equal(rerate.body.code, 'PROFILE_RESTRICTED');
  assert.equal((await call('DELETE', '/api/library/m_g', { token: kid })).status, 403);

  const notAdmin = await call('PUT', '/api/library/m_r', { token: adult, body: { contentRating: 'G' } });
  assert.equal(notAdmin.status, 403);
  assert.equal(notAdmin.body.code, 'ADMIN_REQUIRED');

  const ok = await call('PUT', '/api/library/m_r', { token: owner, body: { contentRating: '  PG-13 ' } });
  assert.equal(ok.status, 200);
  assert.equal(updates.at(-1).patch.contentRating, 'PG-13');
  await call('PUT', '/api/library/m_r', { token: owner, body: { contentRating: '' } });
  assert.equal(updates.at(-1).patch.contentRating, null, 'empty clears the rating');
});

// ------------------------------------------------------------ sessions

test('the session decides the profile: an older token follows a switch', async () => {
  standardProfiles();
  const { token, sid } = tokenFor('default');
  assert.equal((await call('GET', '/api/whoami', { token })).body.profileId, 'default');

  const switched = await call('POST', '/api/profiles/p_kid/switch', { token });
  assert.equal(switched.status, 200);
  assert.equal(sessions.get(sid).profileId, 'p_kid');
  assert.equal((await call('GET', '/api/whoami', { token })).body.profileId, 'p_kid',
    'the pre-switch token is not a way back to the admin profile');
  assert.equal((await call('GET', '/api/whoami', { token: switched.body.token })).body.profileId, 'p_kid');

  // A page reload asks /verify which profile this device is on.
  const verified = await call('GET', '/api/auth/verify', { token });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.profile.id, 'p_kid', '/verify reports the session profile, not the one in the token');
  assert.equal(verified.body.profile.pinHash, undefined);
});

test('media tokens carry the profile and only open media', async () => {
  standardProfiles();
  const kid = tokenFor('p_kid').token;
  const media = await call('GET', '/api/auth/media-token', { token: kid });
  assert.equal(media.status, 200);
  assert.equal((await call('GET', '/api/media/stream/m_r', { token: media.body.token })).status, 404, 'still age-limited');
  assert.equal((await call('GET', '/api/whoami', { token: media.body.token })).status, 401, 'not a general API token');
  assert.equal((await call('GET', '/api/profiles', { token: media.body.token })).status, 401);
});

test('deleting a profile signs its devices out and removes its data', async () => {
  standardProfiles();
  removedData.length = 0;
  const owner = tokenFor('default').token;
  const kidDevice = tokenFor('p_kid');
  extras.addToWatchlist('m_g', 'p_kid');
  extras.addToWatchlist('m_g', 'default');

  const del = await call('DELETE', '/api/profiles/p_kid', { token: owner });
  assert.equal(del.status, 200);
  assert.ok(del.body.signedOut >= 1);
  assert.equal(sessions.get(kidDevice.sid), null);
  assert.deepEqual(removedData, ['p_kid']);
  assert.ok(!extras.getWatchlist().some(w => w.profileId === 'p_kid'));
  assert.ok(extras.getWatchlist().some(w => w.profileId === 'default'), 'other profiles keep theirs');

  const ghost = await call('GET', '/api/whoami', { token: kidDevice.token });
  assert.equal(ghost.status, 401);

  // A sid-less token for a profile that no longer exists is refused too,
  // rather than falling back to (admin) "default". (Since the bug run every
  // sid-less token is refused outright.)
  const stale = authService.generateAccessToken('owner', { profileId: 'p_kid' });
  const refused = await call('GET', '/api/whoami', { token: stale });
  assert.equal(refused.status, 401);
  assert.ok(['PROFILE_REMOVED', 'TOKEN_REVOKED'].includes(refused.body.code));
});

test('a missing "default" profile is never treated as admin', () => {
  seed([P('p_owner', { isAdmin: true }), P('p_other')]);
  const { isAdminProfile } = require('../middleware/requireAdmin');
  assert.equal(isAdminProfile('default'), false);
  assert.equal(isAdminProfile('p_owner'), true);
});

// --------------------------------------------------------------- sign-in

async function challenge() {
  return authService.generateChallengeToken('owner');
}
const GOOD = [0, 1, 2, 3, 4, 5, 6, 7];

test('signing in never bypasses a profile PIN', async () => {
  seed([P('default', { name: 'Sam', isAdmin: true }), P('p_free', { name: 'Guest' })]);
  profiles.update('default', { pin: '2468' });

  // No profile asked for: the owner has a PIN, so land on one without.
  const fallback = await call('POST', '/api/auth/grid', { body: { challengeToken: await challenge(), pattern: GOOD } });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.profile.id, 'p_free');
  assert.equal(fallback.body.profileCount, 2);

  // Asking for the owner without the PIN: 403 before the grid is even checked.
  const missing = await call('POST', '/api/auth/grid', { body: { challengeToken: await challenge(), pattern: [9, 9, 9, 9, 9, 9, 9, 9], profileId: 'default' } });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.code, 'PROFILE_PIN_REQUIRED');
  assert.equal(missing.body.profile.name, 'Sam');
  assert.equal(missing.body.profile.pinHash, undefined);

  // A PIN is only checked after the grid: wrong grid + any PIN = grid error.
  const badGrid = await call('POST', '/api/auth/grid', { body: { challengeToken: await challenge(), pattern: [9, 9, 9, 9, 9, 9, 9, 9], profileId: 'default', profilePin: '0000' } });
  assert.equal(badGrid.status, 401);
  assert.equal(badGrid.body.code, 'INVALID_GRID');

  const wrongPin = await call('POST', '/api/auth/grid', { body: { challengeToken: await challenge(), pattern: GOOD, profileId: 'default', profilePin: '0000' } });
  assert.equal(wrongPin.status, 403, 'a 403, so the client stays on the sign-in screen');

  const ok = await call('POST', '/api/auth/grid', { body: { challengeToken: await challenge(), pattern: GOOD, profileId: 'default', profilePin: '2468' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.profile.id, 'default');
  assert.equal((await call('GET', '/api/whoami', { token: ok.body.token })).body.profileId, 'default');

  // A profile that no longer exists falls back, and the response says where.
  const gone = await call('POST', '/api/auth/grid', { body: { challengeToken: await challenge(), pattern: GOOD, profileId: 'p_deleted' } });
  assert.equal(gone.status, 200);
  assert.equal(gone.body.profile.id, 'p_free', 'the response names the profile actually used (it used to be null)');
});

// ------------------------------------------------------------ validation

test('profile input is validated', async () => {
  standardProfiles();
  const owner = tokenFor('default').token;

  const bad = async (body, code) => {
    const res = await call('POST', '/api/profiles', { token: owner, body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, code, JSON.stringify(body));
  };
  await bad({ name: '   ' }, 'NAME_REQUIRED');
  await bad({ name: 'X', color: 'red; background:url(x)' }, 'INVALID_COLOR');
  await bad({ name: 'X', avatar: '<img src=x onerror=alert(1)>' }, 'INVALID_AVATAR');
  await bad({ name: 'X', avatar: 'https://tracker.example/pixel.png' }, 'INVALID_AVATAR');
  await bad({ name: 'X', pin: '12' }, 'INVALID_PIN');
  await bad({ name: 'X', pin: 'abcd' }, 'INVALID_PIN');
  await bad({ name: 'X', maxRating: 'lots' }, 'INVALID_RATING');
  await bad({ name: 'X', maxRating: 40 }, 'INVALID_RATING');

  const kid = await call('POST', '/api/profiles', { token: owner, body: { name: 'Kiddo', kids: true, avatar: '🦊', pin: '1234' } });
  assert.equal(kid.status, 200);
  assert.equal(kid.body.maxRating, contentRating.KIDS_DEFAULT_AGE, 'Kids profiles get a limit by default');
  assert.equal(kid.body.allowUnrated, false, 'and hide unrated films by default');
  assert.equal(kid.body.hasPin, true);
  assert.equal(kid.body.pinHash, undefined, 'the hash never leaves the server');
  assert.equal(kid.body.avatar, '🦊');

  // Turning Kids on later also sets a limit.
  const adult = await call('PUT', '/api/profiles/p_adult', { token: owner, body: { kids: true } });
  assert.equal(adult.body.maxRating, contentRating.KIDS_DEFAULT_AGE);
  assert.equal(adult.body.allowUnrated, false);
  const cleared = await call('PUT', '/api/profiles/p_adult', { token: owner, body: { kids: false, maxRating: null, allowUnrated: true } });
  assert.equal(cleared.body.maxRating, null);
  assert.equal(profiles.restrictionFor('p_adult'), null);

  const list = await call('GET', '/api/profiles', { token: owner });
  assert.equal(list.body.activeProfileId, 'default');
  assert.ok(Array.isArray(list.body.colors) && list.body.colors.length >= 8);
  assert.ok(list.body.ageLimits.some(l => l.age === contentRating.KIDS_DEFAULT_AGE));
});

test('changing your own PIN needs the current one; summaries are private', async () => {
  standardProfiles();
  profiles.update('p_adult', { pin: '1357' });
  const adult = tokenFor('p_adult').token;
  const kid = tokenFor('p_kid').token;
  const owner = tokenFor('default').token;

  const noCurrent = await call('PUT', '/api/profiles/p_adult', { token: adult, body: { pin: null } });
  assert.equal(noCurrent.status, 403);
  assert.equal(noCurrent.body.code, 'PROFILE_PIN_REQUIRED');
  const changed = await call('PUT', '/api/profiles/p_adult', { token: adult, body: { pin: '9999', currentPin: '1357' } });
  assert.equal(changed.status, 200);
  assert.equal(profiles.checkPin('p_adult', '9999'), true);

  assert.equal((await call('GET', '/api/profiles/default/summary', { token: kid })).status, 403, 'a Kids profile cannot read the owner’s history');
  assert.equal((await call('GET', '/api/profiles/p_kid/summary', { token: kid })).status, 200);
  assert.equal((await call('GET', '/api/profiles/p_kid/summary', { token: owner })).status, 200, 'admins can');
  assert.equal((await call('GET', '/api/profiles/nope/summary', { token: owner })).status, 404);
});
