/**
 * Second bug run + features:
 *   - removing an item cleans every profile's data (not only the default
 *     profile's), plus watched marks, watchlist, collections, markers,
 *     bookmarks and listening stats;
 *   - bookmarks belong to the profile that made them;
 *   - a file that disappears is flagged "missing" (kept with its history)
 *     and a moved/renamed file keeps its history, favourites and playlists;
 *   - Subsonic browses as one chosen profile, with its age limits;
 *   - ASS/SSA (and SRT) subtitles are served as WebVTT;
 *   - /api/media/info shows the file path to admins only.
 *
 * Runs against the real JSON stores in a temp VAULT_DATA_DIR.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-features-'));
process.env.VAULT_DATA_DIR = path.join(TMP, 'data');
process.env.VAULT_INDEX_DB = path.join(TMP, 'data', 'library.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.auth = { ...memory.auth, username: 'admin', jwtSecret: 'test-secret-'.padEnd(48, 'x') };
const COMICS = path.join(TMP, 'comics');
const MOVIES = path.join(TMP, 'movies');
fs.mkdirSync(COMICS, { recursive: true });
fs.mkdirSync(MOVIES, { recursive: true });
memory.media = {
  ...memory.media,
  paths: { comics: COMICS, movies: MOVIES },
  libraries: [{ id: 'lib_comics', name: 'Comics', type: 'comic', paths: [COMICS] }],
  thumbnail: { ...memory.media.thumbnail, enabled: false },
  trickplay: { ...memory.media.trickplay, enabled: false },
};
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const profiles = require('../services/profiles');
const ALEX = profiles.create({ name: 'Alex' }).id;
const KID = profiles.create({ name: 'Kid', kids: true, maxRating: 12, allowUnrated: true }).id;

const libraryService = require('../services/library');
const extras = require('../services/extras');
const scanner = require('../services/scanner');
libraryService.init();

test.after(async () => {
  await Promise.all([libraryService.flush?.(), libraryService.flushScoped?.(), extras.flush()].map(p => Promise.resolve(p).catch(() => {})));
  fs.rmSync(TMP, { recursive: true, force: true });
});

function call(port, method, urlPath, { body, profile, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { 'Content-Type': 'application/json', ...(profile ? { 'X-Profile': profile } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, raw, type: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function startApp(mount) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.profileId = req.headers['x-profile'] || 'default'; req.user = { sid: 's1' }; next(); });
  mount(app);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { port: server.address().port, close: () => new Promise(r => server.close(r)) };
}

function addItem(id, extra = {}) {
  return libraryService.addItem({ id, type: 'movie', title: id, path: path.join(MOVIES, `${id}.mkv`), fileSize: 1000, ...extra });
}

// ------------------------------------------------------------ orphaned data

test('removing an item cleans every profile’s favourites, history, playlists and watched marks, and the extras', async () => {
  addItem('ep1', { seriesKey: 'show' });
  addItem('ep2', { seriesKey: 'show' });
  for (const profileId of ['default', ALEX]) {
    const scoped = libraryService.forProfile(profileId);
    scoped.addFavourite('ep1');
    scoped.addHistoryEntry({ itemId: 'ep1', progress: 40 });
    scoped.createPlaylist({ name: `${profileId} list`, items: ['ep1', 'ep2'] });
    libraryService.setWatched('ep1', true, profileId);
    extras.addToWatchlist('ep1', profileId);
    extras.addBookmark({ itemId: 'ep1', time: 5 }, profileId);
  }
  const collection = extras.createCollection({ name: 'Faves', items: ['ep1', 'ep2'] });
  extras.setMarkers('ep1', { intro: { start: 0, end: 30 } });
  extras.setSeriesMarker('show', { start: 0, end: 30 }, null);
  extras.recordListen('ep1', 120);

  assert.equal(libraryService.removeItem('ep1'), true);

  for (const profileId of ['default', ALEX]) {
    const scoped = libraryService.forProfile(profileId);
    assert.equal(scoped.isFavourite('ep1'), false, `${profileId} favourite`);
    assert.ok(!scoped.getHistory().some(h => h.itemId === 'ep1'), `${profileId} history`);
    assert.deepEqual(scoped.getPlaylists()[0].items, ['ep2'], `${profileId} playlist`);
    assert.equal(libraryService.isWatched('ep1', profileId), false, `${profileId} watched`);
    assert.equal(extras.isInWatchlist('ep1', profileId), false, `${profileId} watchlist`);
  }
  assert.deepEqual(extras.getCollection(collection.id).items, ['ep2']);
  assert.equal(extras.getMarkers('ep1').intro, null);
  assert.deepEqual(extras.getBookmarks('ep1'), []);
  assert.equal(extras.getListens().total.ep1, undefined);
  assert.ok(extras.getListens().daily[new Date().toISOString().slice(0, 10)].seconds >= 120, 'the listening time itself stays');
  assert.ok(extras.getSeriesMarkers('show'), 'the show still has an episode');

  libraryService.removeItem('ep2');
  assert.equal(extras.getSeriesMarkers('show'), null, 'intro memory goes with the last episode');
});

// ---------------------------------------------------------- bookmarks

test('bookmarks belong to the profile that made them', async () => {
  addItem('film');
  const app = await startApp(a => a.use('/api/extras', require('../routes/extras')));
  try {
    const mine = await call(app.port, 'POST', '/api/extras/bookmarks', { body: { itemId: 'film', time: 12, label: 'Sam’s' } });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.profileId, 'default');
    await call(app.port, 'POST', '/api/extras/bookmarks', { profile: ALEX, body: { itemId: 'film', time: 40, label: 'Alex’s' } });

    const forAlex = await call(app.port, 'GET', '/api/extras/bookmarks?itemId=film', { profile: ALEX });
    assert.deepEqual(forAlex.body.bookmarks.map(b => b.label), ['Alex’s']);
    const forSam = await call(app.port, 'GET', '/api/extras/bookmarks?itemId=film');
    assert.deepEqual(forSam.body.bookmarks.map(b => b.label), ['Sam’s']);

    // Alex can't delete Sam's bookmark (looks like it doesn't exist).
    assert.equal((await call(app.port, 'DELETE', `/api/extras/bookmarks/${mine.body.id}`, { profile: ALEX })).status, 404);
    assert.equal(extras.getBookmarks('film', 'default').length, 1);
    assert.equal((await call(app.port, 'DELETE', `/api/extras/bookmarks/${mine.body.id}`)).status, 200);

    // Bookmarks saved before this change (no profileId) are the default profile's.
    const legacy = extras.addBookmark({ itemId: 'film', time: 1, label: 'old' }, 'default');
    delete extras.getBookmarks().find(b => b.id === legacy.id).profileId; // as stored before
    assert.deepEqual(extras.getBookmarks('film', 'default').map(b => b.id), [legacy.id]);
    assert.equal(extras.removeProfileBookmarks(ALEX), 1);
    assert.deepEqual(extras.getBookmarks('film', ALEX), []);
  } finally {
    await app.close();
  }
});

// ---------------------------------------------------- missing + moved files

test('a moved file keeps its history, favourites and playlists; a vanished one is flagged missing first', async () => {
  const bytes = Buffer.alloc(80 * 1024, 7);
  const oldPath = path.join(COMICS, 'Issue 1.cbz');
  fs.writeFileSync(oldPath, bytes);
  const before = await scanner.scanFile(oldPath);
  assert.ok(before?.id, 'scanned');
  libraryService.updateItem(before.id, { rating: 5, title: 'My title' }, { manual: true });
  libraryService.forProfile(ALEX).addFavourite(before.id);
  libraryService.forProfile('default').createPlaylist({ name: 'Read', items: [before.id] });
  libraryService.forProfile(ALEX).addHistoryEntry({ itemId: before.id, progress: 50 });
  extras.addBookmark({ itemId: before.id, time: 3 }, ALEX);

  // Moved (and renamed) into a sub folder.
  fs.mkdirSync(path.join(COMICS, 'Series'));
  const newPath = path.join(COMICS, 'Series', 'Issue #1.cbz');
  fs.renameSync(oldPath, newPath);
  const result = await scanner.scanAll();
  assert.equal(result.removed, 0, JSON.stringify(result));

  assert.equal(libraryService.getById(before.id), null, 'old entry is gone');
  const moved = libraryService.getAll().find(i => i.path === newPath);
  assert.ok(moved, 'new entry exists');
  assert.equal(moved.rating, 5);
  assert.equal(moved.title, 'My title', 'hand-edited title is kept');
  assert.equal(moved.addedAt, before.addedAt);
  assert.equal(moved.movedFrom, oldPath);
  assert.equal(libraryService.forProfile(ALEX).isFavourite(moved.id), true);
  assert.deepEqual(libraryService.forProfile('default').getPlaylists().find(p => p.name === 'Read').items, [moved.id]);
  assert.equal(libraryService.forProfile(ALEX).getHistory()[0].itemId, moved.id);
  assert.equal(extras.getBookmarks(moved.id, ALEX).length, 1);

  // Deleted outside Vault: flagged missing, data kept.
  fs.rmSync(newPath);
  fs.writeFileSync(path.join(COMICS, 'Series', 'other.cbz'), Buffer.alloc(70 * 1024, 1)); // keep the folder "online"
  const second = await scanner.scanAll();
  assert.equal(second.removed, 0);
  const flagged = libraryService.getById(moved.id);
  assert.equal(flagged.missing, true);
  assert.ok(flagged.missingSince);
  assert.equal(libraryService.forProfile(ALEX).isFavourite(moved.id), true, 'favourite kept while missing');

  // It comes back: no longer missing.
  fs.writeFileSync(newPath, bytes);
  await scanner.scanAll();
  assert.equal(libraryService.getById(moved.id).missing, false);

  // Gone for longer than the grace period: removed for good, with its data.
  fs.rmSync(newPath);
  await scanner.scanAll();
  libraryService.updateItem(moved.id, { missingSince: new Date(Date.now() - 31 * 86400000).toISOString() });
  const third = await scanner.scanAll();
  assert.ok(third.removed >= 1);
  assert.equal(libraryService.getById(moved.id), null);
  assert.equal(libraryService.forProfile(ALEX).isFavourite(moved.id), false);
});

test('moved-file detection refuses to guess', async () => {
  const a = libraryService.addItem({ id: 'a', type: 'comic', path: path.join(COMICS, 'gone-a.cbz'), fileSize: 90000 });
  libraryService.addItem({ id: 'b', type: 'comic', path: path.join(COMICS, 'gone-b.cbz'), fileSize: 90000 });
  const fresh = { id: 'new', type: 'comic', path: path.join(COMICS, 'renamed.cbz'), fileSize: 90000 };
  assert.equal(await scanner.findMovedFrom(fresh), null, 'two candidates, neither with the same name');
  assert.equal((await scanner.findMovedFrom({ ...fresh, path: path.join(COMICS, 'x', 'gone-a.cbz') }))?.id, a.id, 'the same file name decides');
  assert.equal(await scanner.findMovedFrom({ ...fresh, fileSize: 1000 }), null, 'tiny files are not matched by size');
  assert.equal(await scanner.findMovedFrom({ ...fresh, type: 'movie' }), null, 'type must match');
  libraryService.removeItem('a');
  libraryService.removeItem('b');
});

// ------------------------------------------------------------- Subsonic

test('Subsonic browses as the chosen profile, with its age limits', async () => {
  require('./helpers/terms').autoAcceptTerms(); // not a Terms of Use test (see test/terms.test.js)
  const authService = require('../services/authService');
  const origValidate = authService.validateCredentials;
  authService.validateCredentials = (u, p) => u === 'admin' && p === 'pw';
  // Subsonic only takes its own password (never the main one).
  require('../services/subsonic').setSubsonicPassword('pw', 'admin');
  for (const name of ['clean', 'explicit']) fs.writeFileSync(path.join(TMP, `${name}.mp3`), 'x');
  libraryService.addItem({ id: 'clean', type: 'music', title: 'Clean song', album: 'A', artist: 'X', path: path.join(TMP, 'clean.mp3'), contentRating: '6' });
  libraryService.addItem({ id: 'explicit', type: 'music', title: 'Explicit song', album: 'B', artist: 'X', path: path.join(TMP, 'explicit.mp3'), contentRating: '18' });
  const app = await startApp(a => a.use('/rest', require('../routes/subsonic')));
  const q = (endpoint, extra = '') => call(app.port, 'GET', `/rest/${endpoint}?u=admin&p=pw&f=json${extra}`).then(r => r.body['subsonic-response']);
  try {
    const titles = async () => (await q('search3', '&query=song')).searchResult3.song.map(s => s.title).sort();
    assert.deepEqual(await titles(), ['Clean song', 'Explicit song'], 'main profile: everything');

    memory.auth.subsonic = { ...(memory.auth.subsonic || {}), profileId: KID };
    assert.deepEqual(await titles(), ['Clean song']);
    assert.deepEqual((await q('getAlbumList2', '&type=alphabeticalByName')).albumList2.album.map(a => a.name), ['A']);
    assert.equal((await q('getAlbum', '&id=album:B')).status, 'failed');
    assert.equal((await q('stream', '&id=explicit')).status, 'failed');
    assert.equal((await q('download', '&id=explicit')).status, 'failed');
    assert.equal((await q('startScan')).error.code, 50, 'scans are for admins');

    // Starring goes to that profile's favourites, and only for what it can see.
    await q('star', '&id=clean');
    await q('star', '&id=explicit');
    assert.deepEqual(libraryService.forProfile(KID).getFavourites().map(i => i.id), ['clean']);
    assert.equal(libraryService.forProfile('default').isFavourite('clean'), false);

    // The chosen profile was deleted: refuse, don't fall back to no limits.
    memory.auth.subsonic.profileId = 'p_gone';
    const refused = await q('search3', '&query=song');
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error.code, 50);
  } finally {
    authService.validateCredentials = origValidate;
    delete memory.auth.subsonic;
    await app.close();
  }
});

test('the Subsonic profile is chosen by an admin', async () => {
  const subsonic = require('../services/subsonic');
  assert.equal(subsonic.setSubsonicProfile(KID).profileId, KID);
  assert.equal(subsonic.subsonicStatus().profileName, 'Kid');
  assert.throws(() => subsonic.setSubsonicProfile('nope'), /Profile not found/);
  // Setting a password keeps the chosen profile.
  subsonic.setSubsonicPassword('secret1');
  assert.equal(memory.auth.subsonic.profileId, KID);
  memory.auth.subsonic = { profileId: 'p_gone', enabled: true };
  assert.equal(subsonic.subsonicStatus().profileMissing, true);
  delete memory.auth.subsonic;
});

// ------------------------------------------------------------- subtitles

test('ASS/SSA subtitles become WebVTT', () => {
  const { assToVtt, srtToVtt } = require('../utils/subtitleConvert');
  const ass = [
    '\uFEFF[Script Info]', 'ScriptType: v4.00+', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
    'Style: Sign,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,8,10,10,10,1',
    '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:05.10,0:00:07.50,Default,,0,0,0,,Hello, {\\i1}world{\\i0}!\\NA <tag> & --> arrow',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Sign,,0,0,0,,A sign',
    'Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,not shown',
    'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}',
    'Dialogue: 0,1:02:03.45,1:02:04.00,Default,,0,0,0,,{\\an7\\b1\\c&H00FF00&}Top left',
    'Dialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,{\\k20}Ka{\\k30}ra{\\k10}oke',
  ].join('\r\n');
  const vtt = assToVtt(ass);
  assert.equal(vtt, [
    'WEBVTT', '',
    '00:00:01.000 --> 00:00:02.000 line:5%', 'A sign', '',
    '00:00:05.100 --> 00:00:07.500', 'Hello, <i>world</i>!', 'A &lt;tag&gt; &amp; --&gt; arrow', '',
    '00:00:10.000 --> 00:00:11.000', 'Karaoke', '',
    '01:02:03.450 --> 01:02:04.000 line:5% position:10% align:start', '<b>Top left</b>', '',
  ].join('\n'));
  // Legacy SSA ("Marked=" format, v4 styles) still yields the words.
  const ssa = '[Script Info]\nScriptType: v4.00\n\n[V4 Styles]\nFormat: Name, Fontname, Alignment\nStyle: Top,Arial,6\n\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Top,,0,0,0,,Old style\n';
  assert.match(assToVtt(ssa), /00:00:01\.000 --> 00:00:02\.000 line:5%\nOld style/);
  assert.equal(srtToVtt('\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHi\r\n'), 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHi\n');
});

test('the subtitle route serves .ass as text/vtt; media info hides the path from non-admins', async () => {
  const dir = path.join(TMP, 'anime');
  fs.mkdirSync(dir, { recursive: true });
  const video = path.join(dir, 'Episode 1.mkv');
  fs.writeFileSync(video, 'x');
  fs.writeFileSync(path.join(dir, 'Episode 1.ass'), '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Konnichiwa\n');
  libraryService.addItem({ id: 'anime1', type: 'music', title: 'Episode 1', path: video, codec: 'aac', duration: 60 });
  libraryService.updateItem('anime1', { subtitles: [{ id: 'sub0', path: path.join(dir, 'Episode 1.ass') }] });
  const app = await startApp(a => a.use('/api/media', require('../routes/media')));
  try {
    const sub = await call(app.port, 'GET', '/api/media/subtitle/anime1/sub0');
    assert.equal(sub.status, 200);
    assert.match(sub.type, /^text\/vtt/);
    assert.match(sub.raw, /^WEBVTT\n\n00:00:01\.000 --> 00:00:02\.000\nKonnichiwa\n/);

    const asAdmin = await call(app.port, 'GET', '/api/media/info/anime1');
    assert.equal(asAdmin.body.filePath, video);
    const asAlex = await call(app.port, 'GET', '/api/media/info/anime1', { profile: ALEX });
    assert.equal(asAlex.status, 200);
    assert.equal(asAlex.body.filePath, undefined);
    assert.equal(asAlex.body.title, 'Episode 1');
  } finally {
    await app.close();
  }
});
