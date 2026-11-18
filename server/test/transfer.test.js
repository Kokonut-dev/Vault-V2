/**
 * Move to another server: a library exported on one "computer" and imported
 * on another with different folders must come out with the same folder
 * structure, and every playlist, favourite, watched flag, marker, profile
 * history entry and cover must still point at the right item (item ids are
 * md5(path), so they all change).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const transfer = require('../services/transfer');
const { applyPendingTransfer, stagingDir } = require('../services/transferApply');
const zip = require('../utils/zipStream');

const md5 = s => crypto.createHash('md5').update(s).digest('hex');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const quiet = { log() {}, error() {} };

function makeOldComputer(root) {
  const serverDir = path.join(root, 'old', 'Vault-V2', 'server');
  const movies = path.join(root, 'old', 'Movies');
  const music = path.join(root, 'old', 'Music');
  const film = path.join(movies, 'Inception (2010)', 'Inception.mkv');
  const track = path.join(music, 'Daft Punk', 'Discovery', '01 One More Time.flac');
  const stray = path.join(root, 'old', 'Downloads', 'clip.mp4');
  write(film, Buffer.alloc(4096, 1));
  write(path.join(movies, 'Inception (2010)', 'poster.jpg'), 'poster');
  write(path.join(movies, 'Inception (2010)', 'Inception.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHi\n');
  write(path.join(movies, '.DS_Store'), 'junk');
  write(track, Buffer.alloc(2048, 2));
  write(stray, Buffer.alloc(100, 3));
  const filmId = md5(film);
  const trackId = md5(track);
  const strayId = md5(stray);
  const cover = path.join(serverDir, 'cache', 'covers', `${trackId}.jpg`);
  write(cover, 'cover-bytes');
  write(path.join(serverDir, 'cache', 'thumbnails', `${filmId}.jpg`), 'thumb'); // regenerable: not exported
  write(path.join(serverDir, 'data', 'library.json'), JSON.stringify([
    { id: filmId, path: film, type: 'movie', title: 'Inception', mtime: 123, trickplay: { sheets: 3 }, posterPath: path.join(movies, 'Inception (2010)', 'poster.jpg') },
    { id: trackId, path: track, type: 'music', title: 'One More Time', coverArtPath: cover, manualFields: ['title'] },
    { id: strayId, path: stray, type: 'video', title: 'Clip' },
  ]));
  write(path.join(serverDir, 'data', 'playlists.json'), JSON.stringify([{ id: 'pl1', name: 'Party', items: [trackId, filmId] }]));
  write(path.join(serverDir, 'data', 'favourites.json'), JSON.stringify([trackId]));
  write(path.join(serverDir, 'data', 'watched.json'), JSON.stringify({ [filmId]: true }));
  write(path.join(serverDir, 'data', 'markers.json'), JSON.stringify({ [filmId]: { intro: [10, 70] } }));
  write(path.join(serverDir, 'data', 'profiles', 'kid', 'history.json'), JSON.stringify([{ itemId: filmId, position: 42, key: `kid:${filmId}` }]));
  write(path.join(serverDir, 'data', 'trash.json'), JSON.stringify([{ id: 'x' }]));
  write(path.join(serverDir, 'data', 'trash', 'deleted.mkv'), 'gone');
  write(path.join(serverDir, 'data', 'backups', 'old.zip'), 'zip');
  write(path.join(serverDir, 'data', 'library.db'), 'sqlite');
  const config = {
    server: { port: 4000, host: '0.0.0.0' },
    auth: { username: 'koko', passwordHash: '$2a$10$oldhash', jwtSecret: 'a'.repeat(128), gridPattern: [1, 2, 3, 4, 5, 6, 7, 8] },
    media: {
      paths: { movies, music },
      libraries: [],
      transcoding: { cacheDir: path.join(serverDir, 'cache', 'transcoded') },
    },
    cors: { origins: ['https://kokonut-dev.github.io'] },
  };
  write(path.join(serverDir, 'config.json'), JSON.stringify(config));
  return { serverDir, config, movies, music, film, track, stray, filmId, trackId, strayId };
}

function makeNewComputer(root) {
  const serverDir = path.join(root, 'new', 'Vault-V2', 'server');
  write(path.join(serverDir, 'config.json'), JSON.stringify({ server: { port: 5005, host: '127.0.0.1' }, auth: { username: 'fresh', passwordHash: '$2a$10$newhash' }, cors: { origins: ['http://localhost:9999'] } }));
  write(path.join(serverDir, 'data', 'library.json'), '[]');
  write(path.join(serverDir, 'data', 'backups', 'mine.zip'), 'keep me');
  return { serverDir, mediaDir: path.join(root, 'new', 'My Media') };
}

async function exportZip(old, file, includeMedia = true) {
  const { entries, manifest } = await transfer.planExport({ includeMedia, serverDir: old.serverDir, config: old.config });
  const plan = zip.layout(entries);
  const out = fs.createWriteStream(file);
  await zip.writeZip(plan, out);
  await new Promise(r => out.end(r));
  assert.equal(fs.statSync(file).size, plan.totalBytes, 'Content-Length must match the bytes written');
  return manifest;
}

test('export keeps folder structure and leaves caches, trash and backups behind', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-transfer-'));
  const old = makeOldComputer(root);
  const file = path.join(root, 'out.zip');
  const manifest = await exportZip(old, file);
  const names = (await zip.listZip(file)).map(e => e.name).sort();

  assert.ok(names.includes('vault-transfer.json'));
  assert.ok(names.includes('README.txt'));
  assert.ok(names.includes('media/Movies/Inception (2010)/Inception.mkv'));
  assert.ok(names.includes('media/Movies/Inception (2010)/poster.jpg'));
  assert.ok(names.includes('media/Movies/Inception (2010)/Inception.en.srt'));
  assert.ok(names.includes('media/Music/Daft Punk/Discovery/01 One More Time.flac'));
  assert.ok(names.includes('media/Other/Downloads/clip.mp4'), 'files outside the library folders travel too');
  assert.ok(names.includes(`cache/covers/${old.trackId}.jpg`));
  assert.ok(names.includes('config/config.json'));
  assert.ok(names.includes('data/profiles/kid/history.json'));
  for (const left of ['data/trash.json', 'data/trash/deleted.mkv', 'data/backups/old.zip', 'data/library.db', 'media/Movies/.DS_Store', `cache/thumbnails/${old.filmId}.jpg`]) {
    assert.ok(!names.includes(left), `${left} should not be exported`);
  }
  assert.equal(manifest.counts.mediaFiles, 5);
  assert.equal(manifest.counts.libraryItems, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test('import onto a computer with different folders relinks everything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-transfer-'));
  const old = makeOldComputer(root);
  const file = path.join(root, 'Vault transfer.zip');
  await exportZip(old, file);
  const fresh = makeNewComputer(root);

  const info = await transfer.inspect(file);
  assert.equal(info.counts.libraryItems, 3);
  assert.equal(info.includesMedia, true);

  const progress = [];
  const result = await transfer.importTransfer({ source: file, mediaDir: fresh.mediaDir, serverDir: fresh.serverDir, onProgress: p => progress.push(p.phase) });
  assert.equal(result.restartRequired, true);
  assert.equal(result.media.copied, 5);
  assert.ok(progress.includes('media') && progress.includes('done'));

  const newFilm = path.join(fresh.mediaDir, 'Movies', 'Inception (2010)', 'Inception.mkv');
  const newTrack = path.join(fresh.mediaDir, 'Music', 'Daft Punk', 'Discovery', '01 One More Time.flac');
  const newStray = path.join(fresh.mediaDir, 'Other', 'Downloads', 'clip.mp4');
  assert.deepEqual(fs.readFileSync(newFilm), Buffer.alloc(4096, 1));
  assert.ok(fs.existsSync(path.join(fresh.mediaDir, 'Movies', 'Inception (2010)', 'Inception.en.srt')));
  assert.ok(fs.existsSync(newTrack) && fs.existsSync(newStray));

  // Nothing is live until the next start.
  assert.deepEqual(readJson(path.join(fresh.serverDir, 'data', 'library.json')), []);
  assert.ok(transfer.hasPendingImport(fresh.serverDir));

  const applied = applyPendingTransfer(fresh.serverDir, quiet);
  assert.ok(applied && fs.existsSync(path.join(applied.backupDir, 'data', 'library.json')), 'previous data is backed up');
  assert.ok(!fs.existsSync(stagingDir(fresh.serverDir)));

  const data = path.join(fresh.serverDir, 'data');
  const filmId = md5(newFilm);
  const trackId = md5(newTrack);
  const library = readJson(path.join(data, 'library.json'));
  const film = library.find(i => i.title === 'Inception');
  const track = library.find(i => i.title === 'One More Time');
  assert.equal(film.path, newFilm);
  assert.equal(film.id, filmId);
  assert.equal(film.posterPath, path.join(fresh.mediaDir, 'Movies', 'Inception (2010)', 'poster.jpg'));
  assert.equal(film.mtime, null, 'forces one rescan on the new machine');
  assert.equal(film.trickplay, undefined);
  assert.equal(track.id, trackId);
  assert.deepEqual(track.manualFields, ['title'], 'hand edits survive');
  assert.equal(track.coverArtPath, path.join(fresh.serverDir, 'cache', 'covers', `${trackId}.jpg`));
  assert.equal(fs.readFileSync(track.coverArtPath, 'utf8'), 'cover-bytes', 'cover renamed to the new id');

  assert.deepEqual(readJson(path.join(data, 'playlists.json'))[0].items, [trackId, filmId]);
  assert.deepEqual(readJson(path.join(data, 'favourites.json')), [trackId]);
  assert.deepEqual(readJson(path.join(data, 'watched.json')), { [filmId]: true });
  assert.deepEqual(readJson(path.join(data, 'markers.json')), { [filmId]: { intro: [10, 70] } });
  assert.deepEqual(readJson(path.join(data, 'profiles', 'kid', 'history.json')), [{ itemId: filmId, position: 42, key: `kid:${filmId}` }]);
  assert.deepEqual(readJson(path.join(data, 'trash.json')), []);
  assert.equal(fs.readFileSync(path.join(data, 'backups', 'mine.zip'), 'utf8'), 'keep me', 'this server’s own backups stay');

  const config = readJson(path.join(fresh.serverDir, 'config.json'));
  assert.equal(config.media.paths.movies, path.join(fresh.mediaDir, 'Movies'));
  assert.equal(config.media.paths.music, path.join(fresh.mediaDir, 'Music'));
  assert.equal(config.media.transcoding.cacheDir, path.join(fresh.serverDir, 'cache', 'transcoded'));
  assert.deepEqual(config.server, { port: 5005, host: '127.0.0.1' }, 'network settings belong to the new machine');
  assert.equal(config.auth.username, 'koko', 'sign in with the old account');
  assert.equal(config.auth.jwtSecret, 'a'.repeat(128), 'long hex secrets are never mistaken for ids');
  assert.deepEqual(config.cors.origins.sort(), ['http://localhost:9999', 'https://kokonut-dev.github.io']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('folder export, in-place import and resuming skip work already done', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-transfer-'));
  const old = makeOldComputer(root);
  const drive = path.join(root, 'USB');
  fs.mkdirSync(drive);
  const exported = await transfer.exportToFolder({ dir: drive, serverDir: old.serverDir, config: old.config });
  assert.ok(fs.existsSync(path.join(exported.folder, 'vault-transfer.json')));
  assert.ok(fs.existsSync(path.join(exported.folder, 'media', 'Movies', 'Inception (2010)', 'Inception.mkv')));

  // In place: the library keeps living on the drive.
  const fresh = makeNewComputer(root);
  const result = await transfer.importTransfer({ source: exported.folder, mediaDir: fresh.mediaDir, copyMedia: false, serverDir: fresh.serverDir });
  assert.equal(result.media.inPlace, true);
  assert.equal(result.media.copied, 0);
  applyPendingTransfer(fresh.serverDir, quiet);
  const film = readJson(path.join(fresh.serverDir, 'data', 'library.json')).find(i => i.title === 'Inception');
  assert.equal(film.path, path.join(exported.folder, 'media', 'Movies', 'Inception (2010)', 'Inception.mkv'));
  assert.equal(film.id, md5(film.path));

  // Copy twice: the second run finds every file already in place.
  const again = makeNewComputer(path.join(root, 'second'));
  await transfer.importTransfer({ source: exported.folder, mediaDir: again.mediaDir, serverDir: again.serverDir });
  const rerun = await transfer.importTransfer({ source: exported.folder, mediaDir: again.mediaDir, serverDir: again.serverDir });
  assert.equal(rerun.media.copied, 0);
  assert.equal(rerun.media.skipped, 5);
  fs.rmSync(root, { recursive: true, force: true });
});

test('settings-only package, bad packages and zip-slip names are refused safely', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-transfer-'));
  const old = makeOldComputer(root);
  const file = path.join(root, 'settings.zip');
  await exportZip(old, file, false);
  const names = (await zip.listZip(file)).map(e => e.name);
  assert.ok(!names.some(n => n.startsWith('media/')));

  // Without media: folders that exist at the old location are reused.
  const fresh = makeNewComputer(root);
  const result = await transfer.importTransfer({ source: file, mediaDir: fresh.mediaDir, serverDir: fresh.serverDir });
  assert.equal(result.folders.find(f => f.label === 'Movies').path, old.movies);

  const notVault = path.join(root, 'random.zip');
  const plan = zip.layout([{ name: 'hello.txt', data: Buffer.from('hi') }]);
  const out = fs.createWriteStream(notVault);
  await zip.writeZip(plan, out);
  await new Promise(r => out.end(r));
  await assert.rejects(transfer.inspect(notVault), e => e.code === 'NOT_A_TRANSFER');
  await assert.rejects(transfer.inspect(path.join(root, 'missing.zip')), e => e.code === 'NOT_FOUND');
  await assert.rejects(transfer.inspect('relative/path.zip'), e => e.code === 'INVALID');

  const { cleanRel } = transfer._internals;
  assert.equal(cleanRel('media/../../etc/passwd'), null);
  assert.equal(cleanRel('C:/Windows/x'), null);
  assert.equal(cleanRel('media/Movies/a.mkv'), 'media/Movies/a.mkv');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a failed apply puts the old data back and never boot-loops', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-transfer-'));
  const serverDir = path.join(root, 'server');
  write(path.join(serverDir, 'data', 'library.json'), '["mine"]');
  const staging = stagingDir(serverDir);
  // A staged "data" that is a file, not a folder → the swap succeeds, then
  // the config copy fails because staged config.json is a directory.
  write(path.join(staging, 'data', 'library.json'), '["theirs"]');
  fs.mkdirSync(path.join(staging, 'config.json'), { recursive: true });
  write(path.join(staging, 'READY'), 'now');
  assert.equal(applyPendingTransfer(serverDir, quiet), null);
  assert.equal(fs.readFileSync(path.join(serverDir, 'data', 'library.json'), 'utf8'), '["mine"]');
  assert.ok(!fs.existsSync(staging), 'staging moved aside so the next start is normal');
  assert.equal(applyPendingTransfer(serverDir, quiet), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('nested library folders are exported once', () => {
  const { collectRoots } = transfer._internals;
  const base = path.resolve('/srv/media');
  const roots = collectRoots({ media: { paths: { movies: path.join(base, 'Movies') }, libraries: [{ name: 'Everything', type: 'video', paths: [base] }, { name: 'Movies', type: 'movie', paths: [path.join(base, 'Movies')] }] } });
  const top = roots.filter(r => !r.parent);
  assert.equal(top.length, 1);
  assert.equal(top[0].archive, 'media/Everything');
  assert.equal(roots.find(r => r.parent).archive, 'media/Everything/Movies');
});

test('a library in a built-in default folder (not written in config.json) still points at its files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-transfer-'));
  const old = makeOldComputer(root);
  // The running config merges defaults: videos lives in server/media/videos
  // even though the user's config.json never mentions it.
  const videos = path.join(old.serverDir, 'media', 'videos');
  write(path.join(videos, 'Holiday', 'beach.mp4'), Buffer.alloc(300, 9));
  fs.mkdirSync(path.join(old.serverDir, 'media', 'comics'), { recursive: true }); // empty default library
  const merged = { ...old.config, media: { ...old.config.media, paths: { ...old.config.media.paths, videos, comics: path.join(old.serverDir, 'media', 'comics') } } };
  const { entries } = await transfer.planExport({ includeMedia: true, serverDir: old.serverDir, config: merged });
  const file = path.join(root, 'out.zip');
  const out = fs.createWriteStream(file);
  await zip.writeZip(zip.layout(entries), out);
  await new Promise(r => out.end(r));
  assert.ok((await zip.listZip(file)).some(e => e.name === 'media/Videos/Holiday/beach.mp4'));

  const fresh = makeNewComputer(root);
  const result = await transfer.importTransfer({ source: file, mediaDir: fresh.mediaDir, serverDir: fresh.serverDir });
  assert.deepEqual(result.folders.map(f => f.label).sort(), ['Downloads', 'Movies', 'Music', 'Videos']);
  assert.ok(!result.folders.some(f => f.label === 'Comics'), 'empty libraries are not reported or created');
  assert.ok(!fs.existsSync(path.join(fresh.mediaDir, 'Comics')));
  const staged = readJson(path.join(stagingDir(fresh.serverDir), 'config.json'));
  assert.equal(staged.media.paths.videos, path.join(fresh.mediaDir, 'Videos'));
  assert.equal(staged.media.paths.comics, undefined, 'falls back to the new computer’s own default');
  assert.ok(fs.existsSync(path.join(fresh.mediaDir, 'Videos', 'Holiday', 'beach.mp4')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a package from Windows relinks onto a Mac or Linux (backslashes, any letter case)', () => {
  const { createRemapper } = transfer._internals;
  const film = 'C:\\Users\\Sam\\Movies\\Film\\a.mkv';
  const manifest = { source: { sep: '\\', platform: 'win32', serverDir: 'C:\\Vault\\server' }, roots: [{ archive: 'media/Movies', original: 'C:\\Users\\Sam\\Movies', label: 'Movies', files: 1 }] };
  const targets = new Map([['media/Movies', '/home/sam/Media/Movies']]);
  const library = [{ id: md5(film), path: film }];
  const remap = createRemapper(manifest, targets, '/srv/vault/server', library);
  const out = remap.remapValue({ library, poster: 'c:\\users\\sam\\movies\\Film\\poster.jpg', favourites: [md5(film)] });
  const moved = path.join('/home/sam/Media/Movies', 'Film', 'a.mkv');
  assert.equal(out.library[0].path, moved);
  assert.equal(out.library[0].id, md5(moved), 'ids follow the new path, as the scanner computes them');
  assert.deepEqual(out.favourites, [md5(moved)]);
  assert.equal(out.poster, path.join('/home/sam/Media/Movies', 'Film', 'poster.jpg'));
});
