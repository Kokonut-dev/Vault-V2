/**
 * Metadata typed in by hand must survive a rescan.
 *
 * Reported as "artist and album aren't shown from my Linux computer": songs
 * uploaded on the Mac with title/artist/album/cover typed into the upload form
 * looked right in the Mac's open tab, but the folder watcher re-read the files
 * a moment later (the duration couldn't be read, so the file counted as
 * "needs retry") and replaced everything with the files' own empty tags —
 * "Unknown Artist", the filename as title, no cover. The watcher then didn't
 * broadcast (size and mtime were unchanged), so only a fresh browser — the
 * Linux one — saw the wiped data.
 *
 * Test items are removed again at the end, so a developer's real library
 * (server/data/library.json) is left untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const express = require('express');
const jwt = require('jsonwebtoken');

/** A short, valid, untagged mono PCM WAV. */
function untaggedWav(seconds = 1, rate = 8000) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(3000 * Math.sin(i / 5)), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-manual-meta-'));
  const mediaPaths = {
    movies: path.join(root, 'movies'),
    music: path.join(root, 'music'),
    videos: path.join(root, 'videos'),
  };
  const jwtSecret = 'manual-metadata-secret';

  // Route and service modules capture getConfig when they load, so install
  // the isolated configuration before requiring them.
  const configModule = require('../config');
  const originalGetConfig = configModule.getConfig;
  configModule.getConfig = () => ({
    auth: { jwtSecret },
    media: {
      paths: mediaPaths,
      maxUploadSizeMB: 10,
      supportedExtensions: {
        video: ['.mp4'],
        audio: ['.mp3', '.wav', '.flac'],
        subtitle: ['.srt', '.vtt'],
      },
    },
  });

  const library = require('../services/library');
  const scanner = require('../services/scanner');
  const events = require('../services/events');
  const originalBroadcast = events.broadcast;
  events.broadcast = () => {};
  library.init();

  const { authMiddleware } = require('../middleware/auth');
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use('/api/library', require('../routes/library'));
  app.use('/api/upload', require('../routes/upload'));
  app.use('/api/series', require('../routes/series'));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Tokens must belong to a device session; a stub session keeps this test
  // away from the real sessions store.
  const sessions = require('../services/sessions');
  const realSessions = { isValid: sessions.isValid, touch: sessions.touch, get: sessions.get };
  sessions.isValid = (sid) => sid === 'test-session' || realSessions.isValid(sid);
  sessions.touch = (sid) => (sid === 'test-session' ? null : realSessions.touch(sid));
  sessions.get = (sid) => (sid === 'test-session' ? { id: sid, profileId: 'default' } : realSessions.get(sid));
  t.after(() => Object.assign(sessions, realSessions));
  const token = jwt.sign({ profileId: 'default', sid: 'test-session' }, jwtSecret, { expiresIn: '5m' });
  const created = { ids: new Set(), files: new Set() };

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    for (const id of created.ids) {
      const item = library.getById(id);
      if (item?.coverArtPath && item.coverArtPath.includes(`${path.sep}cache${path.sep}covers${path.sep}upload-`)) {
        created.files.add(item.coverArtPath);
      }
      library.removeItem(id);
    }
    for (const file of created.files) await fs.remove(file);
    await library.flush?.();
    await fs.remove(root);
    events.broadcast = originalBroadcast;
    configModule.getConfig = originalGetConfig;
  });

  async function upload(filename, metadata, cover) {
    const form = new FormData();
    form.append('files', new Blob([untaggedWav()], { type: 'audio/wav' }), filename);
    if (cover) form.append('cover', new Blob([Buffer.from('cover-bytes')], { type: 'image/png' }), 'cover.png');
    form.append('metadata', JSON.stringify(metadata));
    const res = await fetch(`${baseUrl}/api/upload/music`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(res.status, 200, 'upload succeeds');
    const body = await res.json();
    for (const item of body.items) created.ids.add(item.id);
    return body.items[0];
  }

  /** Force a real re-read of the file, like a changed mtime or a retry would. */
  async function rescan(item) {
    const later = new Date(Date.now() + 60_000);
    await fs.utimes(item.path, later, later);
    const rescanned = await scanner.scanFile(item.path);
    assert.ok(rescanned, 'the file was rescanned');
    return library.getById(item.id);
  }

  /** A video item backed by a placeholder file (no real stream needed). */
  async function addVideo(relative, fields) {
    const file = path.join(mediaPaths.movies, relative);
    await fs.ensureDir(path.dirname(file));
    await fs.writeFile(file, 'not a real video');
    const item = library.addItem({
      id: scanner.generateId(file), path: file, filename: path.basename(file), type: 'movie',
      addedAt: new Date().toISOString(), ...fields,
    });
    created.ids.add(item.id);
    return item;
  }

  const api = async (method, url, body) => {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  return { baseUrl, token, library, scanner, upload, rescan, addVideo, api, events };
}

test('upload-form title, artist, album, year and cover survive a rescan', async (t) => {
  const { upload, rescan } = await setup(t);
  const item = await upload('untagged song.wav', {
    title: 'Typed Title', artist: 'Typed Artist', album: 'Typed Album', year: '2024', genre: '', tags: [],
  }, true);
  assert.equal(item.title, 'Typed Title');
  assert.equal(item.artist, 'Typed Artist');
  assert.ok(item.coverArtPath && await fs.pathExists(item.coverArtPath), 'uploaded cover stored');

  const after = await rescan(item);
  assert.equal(after.title, 'Typed Title', 'title kept');
  assert.equal(after.artist, 'Typed Artist', 'artist kept (was "Unknown Artist")');
  assert.equal(after.album, 'Typed Album', 'album kept (was "Unknown Album")');
  assert.equal(after.year, 2024, 'year kept');
  assert.equal(after.coverArtPath, item.coverArtPath, 'uploaded cover kept');
  assert.equal(after.posterPath, item.coverArtPath, 'poster follows the cover');
  assert.ok(after.duration > 0, 'technical fields still come from the file');
});

test('an upload without typed metadata still follows the file tags', async (t) => {
  const { upload, rescan } = await setup(t);
  const item = await upload('plain song.wav', { title: '', artist: '', album: '', tags: [] });
  assert.equal(item.title, 'plain song');
  assert.ok(!item.manualFields || item.manualFields.length === 0, 'nothing marked as hand-set');
  const after = await rescan(item);
  assert.equal(after.title, 'plain song');
  assert.equal(after.artist, 'Unknown Artist');
});

test('detail-dialog and album edits survive a rescan; untouched fields stay unlocked', async (t) => {
  const { baseUrl, token, upload, rescan, library } = await setup(t);
  const item = await upload('edit me.wav', { title: '', artist: '', album: '', tags: [] });

  // The edit dialog sends every field back; only the changed ones get locked.
  let res = await fetch(`${baseUrl}/api/library/${item.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: item.title, artist: 'Edited Artist', album: item.album, rating: 4 }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(library.getById(item.id).manualFields, ['artist']);

  res = await fetch(`${baseUrl}/api/library/albums/metadata`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [item.id], album: 'Edited Album' }),
  });
  assert.equal(res.status, 200);

  const after = await rescan(item);
  assert.equal(after.artist, 'Edited Artist');
  assert.equal(after.album, 'Edited Album');
  assert.equal(after.title, 'edit me', 'an untouched title still comes from the file');
  assert.equal(after.rating, 4, 'rating kept');
});

test('a hand-picked cover that was deleted falls back to the file artwork', async (t) => {
  const { upload, rescan } = await setup(t);
  const item = await upload('cover gone.wav', { title: 'Cover Gone', tags: [] }, true);
  await fs.remove(item.coverArtPath);
  const after = await rescan(item);
  assert.equal(after.title, 'Cover Gone');
  assert.equal(after.coverArtPath, null, 'missing cover not resurrected');
});

test('applyManualFields only copies the recorded, non-empty fields', () => {
  const { applyManualFields } = require('../services/scanner');
  const scanned = { title: 'file', artist: 'Unknown Artist', album: 'Unknown Album', duration: 3 };
  const existing = { title: 'Mine', artist: '', album: 'Kept', duration: 0, manualFields: ['title', 'artist', 'album'] };
  applyManualFields(scanned, existing);
  assert.equal(scanned.title, 'Mine');
  assert.equal(scanned.artist, 'Unknown Artist', 'empty hand value does not blank the tag');
  assert.equal(scanned.album, 'Kept');
  assert.equal(scanned.duration, 3);
  assert.deepEqual(scanned.manualFields, ['title', 'artist', 'album']);
  assert.deepEqual(applyManualFields({ title: 'x' }, null), { title: 'x' });
});

test('songs edited before manualFields existed keep their values when the file has none', async (t) => {
  const { upload, rescan, library } = await setup(t);
  const item = await upload('legacy song.wav', { title: 'Legacy Title', artist: 'Legacy Artist', album: 'Legacy Album', tags: [] }, true);
  // What an older server left behind: the values, but no marker.
  delete library.getById(item.id).manualFields;

  const after = await rescan(item);
  assert.equal(after.title, 'Legacy Title');
  assert.equal(after.artist, 'Legacy Artist');
  assert.equal(after.album, 'Legacy Album');
  assert.equal(after.coverArtPath, item.coverArtPath, 'uploaded cover kept');
  assert.ok(after.manualFields.includes('artist'), 'now remembered as hand-set');
});

test('the placeholder guard never overrides real tags or extracted artwork', () => {
  const { applyManualFields } = require('../services/scanner');
  const scanned = { type: 'music', path: '/m/a.flac', title: 'Real Tag', artist: 'Tag Artist', album: 'Unknown Album', coverArtPath: null };
  const existing = { type: 'music', title: 'Old', artist: 'Old Artist', album: 'Old Album', coverArtPath: '/somewhere/else.jpg' };
  applyManualFields(scanned, existing);
  assert.equal(scanned.title, 'Real Tag', 'real tag wins without a marker');
  assert.equal(scanned.artist, 'Tag Artist');
  assert.equal(scanned.album, 'Old Album', 'placeholder replaced by the known value');
  assert.equal(scanned.coverArtPath, null, 'only uploaded covers are carried over');
});

// ---------------------------------------------------------------------------
// "Edit details": every field for songs and other types, plain-text storage,
// validation, revert to the file's value.
// ---------------------------------------------------------------------------

test('a song’s title, artist, album artist, album, track, disc, year, genre and composer can all be typed in', async (t) => {
  const { upload, rescan, api, events, library } = await setup(t);
  const item = await upload('wrong tags.wav', { title: '', artist: '', album: '', tags: [] });
  const seen = [];
  events.broadcast = (type, data) => seen.push({ type, data });

  const res = await api('PUT', `/api/library/${item.id}`, {
    title: 'Rock & Roll Ain’t <Noise>',
    artist: 'AC/DC',
    albumArtist: 'AC/DC',
    album: 'Let There Be Rock',
    track: '3',
    disc: 1,
    year: '1977',
    genre: 'Hard rock',
    composer: 'Young, Young & Scott',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'Rock & Roll Ain’t <Noise>', 'stored as plain text, not HTML-escaped');
  assert.equal(res.body.artist, 'AC/DC', 'no &#x2F; in the artist');
  assert.equal(res.body.track, 3);
  assert.equal(res.body.year, 1977);
  assert.deepEqual(
    [...library.getById(item.id).manualFields].sort(),
    ['album', 'albumArtist', 'artist', 'composer', 'disc', 'genre', 'title', 'track', 'year'],
  );
  assert.ok(seen.some(e => e.type === 'library:changed' && e.data.id === item.id), 'other devices are told');

  const after = await rescan(item);
  assert.equal(after.title, 'Rock & Roll Ain’t <Noise>');
  assert.equal(after.albumArtist, 'AC/DC');
  assert.equal(after.album, 'Let There Be Rock');
  assert.equal(after.track, 3);
  assert.equal(after.disc, 1);
  assert.equal(after.year, 1977);
  assert.equal(after.genre, 'Hard rock');
  assert.equal(after.composer, 'Young, Young & Scott');
});

test('bad values are rejected per field and nothing is half-saved', async (t) => {
  const { upload, api, library } = await setup(t);
  const item = await upload('validate me.wav', { title: 'Keep', tags: [] });

  let res = await api('PUT', `/api/library/${item.id}`, { title: '   ', artist: 'Changed', year: 'last year', track: -1 });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INVALID_METADATA');
  assert.ok(res.body.fields.title && res.body.fields.year && res.body.fields.track, JSON.stringify(res.body.fields));
  assert.equal(library.getById(item.id).artist, 'Unknown Artist', 'valid fields in a rejected request are not saved');

  res = await api('PUT', `/api/library/${item.id}`, { year: 1500 });
  assert.equal(res.status, 400);
  assert.match(res.body.fields.year, /1800 to 2100/);

  // An empty number clears it.
  await api('PUT', `/api/library/${item.id}`, { year: 2001, track: 4 });
  res = await api('PUT', `/api/library/${item.id}`, { year: '', track: null });
  assert.equal(res.status, 200);
  assert.equal(res.body.year, null);
  assert.equal(res.body.track, null);

  res = await api('PUT', '/api/library/does-not-exist', { title: 'x' });
  assert.equal(res.status, 404);
});

test('revert puts one field or all of them back to the file’s value and unlocks them', async (t) => {
  const { upload, rescan, api, library } = await setup(t);
  const item = await upload('revert me.wav', { title: '', artist: '', album: '', tags: [] });
  await api('PUT', `/api/library/${item.id}`, { title: 'Hand Title', artist: 'Hand Artist', album: 'Hand Album', rating: 4, description: 'Notes' });

  let res = await api('POST', `/api/library/${item.id}/metadata/reset`, { fields: ['title'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.title, 'revert me', 'title from the file name again');
  assert.equal(res.body.artist, 'Hand Artist', 'other fields untouched');
  assert.ok(!res.body.manualFields.includes('title'));
  assert.ok(res.body.manualFields.includes('artist'));

  res = await api('POST', `/api/library/${item.id}/metadata/reset`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.artist, 'Unknown Artist');
  assert.equal(res.body.album, 'Unknown Album');
  assert.equal(res.body.rating, 4, 'rating has no file value, so it is kept');
  assert.equal(res.body.description, 'Notes');
  assert.deepEqual(res.body.manualFields.filter(f => ['title', 'artist', 'album'].includes(f)), []);

  // …and a rescan no longer brings the old hand values back.
  const after = await rescan(item);
  assert.equal(after.title, 'revert me');
  assert.equal(after.artist, 'Unknown Artist');

  res = await api('POST', `/api/library/${item.id}/metadata/reset`, { fields: 'title' });
  assert.equal(res.status, 400);

  await api('PUT', `/api/library/${item.id}`, { title: 'Again' });
  await fs.remove(library.getById(item.id).path);
  res = await api('POST', `/api/library/${item.id}/metadata/reset`, { fields: ['title'] });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'FILE_MISSING');
  assert.equal(library.getById(item.id).title, 'Again', 'nothing changed when the file is gone');
});

test('album edits set album artist, artist, year and genre on every track', async (t) => {
  const { upload, rescan, api } = await setup(t);
  const one = await upload('album one.wav', { title: 'One', tags: [] });
  const two = await upload('album two.wav', { title: 'Two', tags: [] });
  const ids = [one.id, two.id];

  let res = await api('PUT', '/api/library/albums/metadata', { ids, album: 'Shared', albumArtist: 'Band', year: 1999, genre: 'Indie' });
  assert.equal(res.status, 200);
  assert.ok(res.body.items.every(i => i.album === 'Shared' && i.albumArtist === 'Band' && i.year === 1999 && i.genre === 'Indie'));
  assert.equal(res.body.items[0].title, 'One', 'per-track fields are left alone');

  res = await api('PUT', '/api/library/albums/metadata', { ids, year: 'soon' });
  assert.equal(res.status, 400);
  assert.ok(res.body.fields.year);
  res = await api('PUT', '/api/library/albums/metadata', { ids, album: '' });
  assert.equal(res.status, 400);
  res = await api('PUT', '/api/library/albums/metadata', { ids, title: 'not an album field' });
  assert.equal(res.status, 400, 'nothing album-wide to change');

  const after = await rescan(two);
  assert.equal(after.albumArtist, 'Band');
  assert.equal(after.year, 1999);
});

test('an episode can be given its show, season and episode; a film can be un-filed from Shows', async (t) => {
  const { api, library, scanner, addVideo } = await setup(t);
  const ep = await addVideo('Some Folder/Some.Show.S01E02.mkv', { title: 'Some Show S01E02', season: 1, episode: 2, seriesKey: 'some folder' });
  const film = await addVideo('Films/Heat.1995.S01E01.mkv', { title: 'Heat', season: 1, episode: 1, seriesKey: 'heat' });

  let res = await api('PUT', `/api/library/${ep.id}`, { seriesTitle: 'The Real Show', season: 2, episode: '7' });
  assert.equal(res.status, 200);
  assert.equal(res.body.seriesKey, 'the real show');
  assert.equal(res.body.season, 2);
  assert.equal(res.body.episode, 7);

  res = await api('GET', '/api/series/shows');
  const show = (res.body.shows || res.body).find(s => s.key === 'the real show');
  assert.ok(show, 'grouped under the typed show');
  assert.equal(show.title, 'The Real Show', 'and named after it');

  res = await api('PUT', `/api/library/${film.id}`, { season: '', episode: '' });
  assert.equal(res.body.season, null);
  // A rescan reads S01E01 from the file name again, but the cleared numbers stay cleared.
  const rescanned = { type: 'movie', title: 'Heat', season: 1, episode: 1, seriesKey: 'films' };
  scanner.applyManualFields(rescanned, library.getById(film.id));
  assert.equal(rescanned.season, null);
  assert.equal(rescanned.episode, null);

  res = await api('POST', `/api/library/${ep.id}/metadata/reset`, { fields: ['seriesTitle', 'season'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.seriesTitle, null);
  assert.equal(res.body.seriesKey, 'some folder', 'grouping key from the folder again');
  assert.equal(res.body.season, 1, 'season from the file name again');
  assert.equal(res.body.episode, 7, 'episode not asked for, still the typed one');
});

test('comic and audiobook fields (series, issue, author, narrator) are accepted', () => {
  const { parseEdits } = require('../services/metadataEdit');
  const { updates, errors } = parseEdits({
    series: ' Saga ', issue: '12a', author: 'Brian K. Vaughan', narrator: 'Someone\nElse', notAField: 'x', tags: 'a, b, a',
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(updates, { series: 'Saga', issue: '12a', author: 'Brian K. Vaughan', narrator: 'Someone Else', tags: ['a', 'b'] });
  assert.ok(parseEdits({ title: { evil: true } }).errors.title);
  assert.ok(parseEdits({ rating: 9 }).errors.rating);
  assert.deepEqual(parseEdits({ title: 'x', year: 2000 }, { allowed: ['year'] }).updates, { year: 2000 });
});
