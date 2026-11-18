/**
 * Bulk / folder upload.
 *
 * Before: the Upload page took loose files only (20 per request, flattened
 * into the library root), so a dropped album or season folder did nothing
 * useful. Now folders are read recursively, sorted into libraries, uploaded
 * in batches with their structure kept, already-uploaded files are skipped,
 * and the server's upload rate limit is waited out instead of failing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const express = require('express');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-folder-upload-'));
const mediaPaths = {
  movies: path.join(root, 'movies'),
  music: path.join(root, 'music'),
  videos: path.join(root, 'videos'),
};

const configModule = require('../config');
const testConfig = structuredClone(configModule.DEFAULT_CONFIG);
testConfig.media.paths = mediaPaths;
testConfig.media.maxUploadSizeMB = 10;
configModule.getConfig = () => testConfig;

// The scan itself is covered elsewhere; record what would be indexed.
const scanner = require('../services/scanner');
const scanned = [];
scanner.scanFile = async (filePath) => {
  scanned.push(filePath);
  return { id: `id_${scanned.length}`, path: filePath, title: path.basename(filePath) };
};
const library = require('../services/library');
library.updateItem = (id, updates) => ({ id, ...updates });

const uploadRouter = require('../routes/upload');

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/upload', uploadRouter);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server?.closeAllConnections?.();
  server?.close();
  fs.removeSync(root);
});

function form(files) {
  const fd = new FormData();
  for (const [name, content] of files) fd.append('files', new Blob([content]), name);
  fd.append('metadata', '{}');
  return fd;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
test('folder uploads keep Artist/Album folders (Unicode intact) and never escape the library', async () => {
  scanned.length = 0;
  const res = await fetch(`${base}/api/upload/music?keepFolders=1`, {
    method: 'POST',
    body: form([
      ['Björk/Homogenic/cover.jpg', 'img'],
      ['Björk/Homogenic/01 Hunter.mp3', 'audio-1'],
      ['Björk/Homogenic/02 Jóga.mp3', 'audio-2'],
      ['../../escape.mp3', 'sneaky'],
    ]),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const album = path.join(mediaPaths.music, 'Björk', 'Homogenic');
  assert.equal(fs.readFileSync(path.join(album, '01 Hunter.mp3'), 'utf8'), 'audio-1');
  assert.ok(fs.existsSync(path.join(album, '02 Jóga.mp3')), 'accented file name kept');
  assert.ok(fs.existsSync(path.join(album, 'cover.jpg')), 'cover sits next to the tracks');
  // "../../" is dropped — the file lands inside the library root.
  assert.ok(fs.existsSync(path.join(mediaPaths.music, 'escape.mp3')));
  assert.ok(!fs.existsSync(path.join(root, 'escape.mp3')));
  // Only media is indexed; the cover is a sidecar the metadata code reads.
  assert.deepEqual(scanned.map(p => path.basename(p)).sort(), ['01 Hunter.mp3', '02 Jóga.mp3', 'escape.mp3']);
  assert.equal(body.sidecars, 1);
});

test('without ?keepFolders a slashed name is flattened like before', async () => {
  const res = await fetch(`${base}/api/upload/video`, {
    method: 'POST',
    body: form([['Holiday/clip.mp4', 'video']]),
  });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(mediaPaths.videos, 'clip.mp4')));
  assert.ok(!fs.existsSync(path.join(mediaPaths.videos, 'Holiday')));
});

test('folder uploads refuse files Vault cannot use', async () => {
  const res = await fetch(`${base}/api/upload/music?keepFolders=1`, {
    method: 'POST',
    body: form([['Album/info.nfo', 'text']]),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Unsupported file type/);
});

test('/check reports files already in the library (same path and size)', async () => {
  const res = await fetch(`${base}/api/upload/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'music',
      files: [
        { path: 'Björk/Homogenic/01 Hunter.mp3', size: 7 },
        { path: 'Björk/Homogenic/02 Jóga.mp3', size: 999 }, // size differs → upload again
        { path: 'Björk/Homogenic/03 New.mp3', size: 5 },
      ],
    }),
  });
  const body = await res.json();
  assert.deepEqual(body.existing, [0]);
  assert.equal(body.maxFilesPerRequest, 50);
});

// ---------------------------------------------------------------------------
// Planner (docs/js/utils/folderUpload.js)
// ---------------------------------------------------------------------------
const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const fakeFile = (name, size = 10) => ({ name, size });

test('planUpload sorts dropped folders into libraries and lists what it leaves out', async () => {
  const { planUpload, typeForFile } = await import(docs('utils', 'folderUpload.js'));
  const entries = [
    'Homogenic/01 Hunter.flac', 'Homogenic/02 Joga.flac', 'Homogenic/folder.jpg', 'Homogenic/notes.txt',
    'Severance/Season 1/Severance S01E01.mkv', 'Severance/Season 1/Severance S01E01.en.srt',
    'Arrival (2016)/Arrival (2016).mp4', 'Arrival (2016)/Soundtrack/01 On the Nature of Daylight.mp3',
    'Phone clips/IMG_0001.mov', 'Phone clips/.DS_Store',
    'Scans/booklet.jpg',
    'loose-song.mp3',
  ].map(p => ({ file: fakeFile(p.split('/').pop()), path: p }));

  const { groups, skipped, ignored } = planUpload(entries, 'auto');
  const byLabel = Object.fromEntries(groups.map(g => [g.label, g]));
  assert.equal(byLabel.Homogenic.type, 'music');
  assert.equal(byLabel.Severance.type, 'movie', 'SxxEyy → Movies & Series');
  assert.equal(byLabel['Arrival (2016)'].type, 'movie', '"Title (year)" → Movies & Series');
  assert.equal(byLabel['Phone clips'].type, 'video');
  assert.equal(byLabel['Loose files'].type, 'music');
  assert.equal(groups.at(-1).label, 'Loose files', 'loose files listed last');
  assert.deepEqual(skipped.map(s => s.path).sort(), ['Homogenic/notes.txt', 'Scans/booklet.jpg']);
  assert.equal(ignored, 1, '.DS_Store is ignored silently');

  // A soundtrack inside a movie folder still goes to Music; the subtitle
  // follows its episode.
  const arrival = byLabel['Arrival (2016)'];
  assert.equal(typeForFile(arrival.files.find(f => f.kind === 'audio'), arrival), 'music');
  const sev = byLabel.Severance;
  assert.equal(typeForFile(sev.files.find(f => f.kind === 'subtitle'), sev), 'movie');

  // Picking a type forces it for everything.
  assert.ok(planUpload(entries, 'video').groups.every(g => g.type === 'video'));
});

test('batchesFor keeps folders together, never mixes libraries, and respects limits', async () => {
  const { planUpload, batchesFor } = await import(docs('utils', 'folderUpload.js'));
  const entries = [];
  for (let i = 1; i <= 70; i++) entries.push({ file: fakeFile(`t${i}.mp3`, 1000), path: `Big Album/t${i}.mp3` });
  entries.push({ file: fakeFile('cover.jpg', 5), path: 'Big Album/cover.jpg' });
  entries.push({ file: fakeFile('a.mkv', 50), path: 'Show/Season 1/Show S01E01.mkv' });
  entries.push({ file: fakeFile('a.srt', 1), path: 'Show/Season 1/Show S01E01.srt' });
  const { groups } = planUpload(entries, 'auto');

  const batches = batchesFor(groups, { maxFiles: 50 });
  assert.ok(batches.every(b => b.files.length <= 50));
  assert.ok(batches.every(b => new Set(b.files.map(f => (f.kind === 'audio' ? 'music' : b.type))).size === 1));
  const show = batches.find(b => b.type === 'movie');
  assert.deepEqual(show.files.map(f => f.kind), ['subtitle', 'video'], 'subtitle travels with (and before) its episode');
  const albumFirst = batches.find(b => b.files.some(f => f.path === 'Big Album/cover.jpg'));
  assert.equal(albumFirst.files[0].path, 'Big Album/cover.jpg', 'cover goes first so the first scan sees it');
  assert.equal(batches.reduce((n, b) => n + b.files.length, 0), 73);

  // Byte cap splits too.
  assert.ok(batchesFor(groups, { maxFiles: 50, maxBytes: 10 * 1000 }).filter(b => b.type === 'music').length >= 7);

  // Already-uploaded files are skipped; a folder left with only its cover is dropped.
  const skip = new Set(entries.filter(e => e.path.startsWith('Big Album/t')).map(e => e.path));
  const rest = batchesFor(groups, { skip });
  assert.deepEqual(rest.flatMap(b => b.files.map(f => f.path)).sort(), ['Show/Season 1/Show S01E01.mkv', 'Show/Season 1/Show S01E01.srt']);
});

test('entriesFromDataTransfer walks dropped folders, including >100-entry directories', async () => {
  const { entriesFromDataTransfer } = await import(docs('utils', 'folderUpload.js'));
  const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(fakeFile(name)) });
  const dirEntry = (name, children) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      // Real readers hand out at most ~100 entries per readEntries() call.
      let offset = 0;
      return { readEntries(ok) { const batch = children.slice(offset, offset + 100); offset += batch.length; setTimeout(() => ok(batch), 0); } };
    },
  });
  const tracks = Array.from({ length: 150 }, (_, i) => fileEntry(`${String(i + 1).padStart(3, '0')}.mp3`));
  const dt = {
    items: [
      { kind: 'file', webkitGetAsEntry: () => dirEntry('Box Set', [dirEntry('Disc 1', tracks), fileEntry('cover.jpg')]) },
      { kind: 'file', webkitGetAsEntry: () => fileEntry('single.mp3') },
    ],
    files: [],
  };
  const entries = await entriesFromDataTransfer(dt);
  assert.equal(entries.length, 152);
  assert.ok(entries.some(e => e.path === 'Box Set/Disc 1/150.mp3'), 'the 101st+ entries are not lost');
  assert.ok(entries.some(e => e.path === 'Box Set/cover.jpg'));
  assert.ok(entries.some(e => e.path === 'single.mp3'));
});

// ---------------------------------------------------------------------------
// The Upload page, end to end against the real route
// ---------------------------------------------------------------------------
test('Upload page: pick a folder → review → queue uploads it, skipping what exists and waiting out 429', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost:4000/', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.matchMedia = window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', basePath: '' };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const { api } = await import(docs('api.js'));
    const { renderUpload } = await import(docs('views', 'upload.js'));

    // The page's two server calls go to the real route (Node fetch), so this
    // checks the page's batches against what the server accepts.
    const sent = [];
    let rateLimitOnce = true;
    api.checkUploads = async (type, files) => (await realFetch(`${base}/api/upload/check`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, files }),
    })).json();
    api.uploadBatch = async (type, entries, { onProgress }) => {
      if (rateLimitOnce) {
        rateLimitOnce = false;
        throw Object.assign(new Error('Too many uploads'), { status: 429, code: 'UPLOAD_RATE_LIMITED', retryAfter: 1 });
      }
      sent.push({ type, paths: entries.map(e => e.path) });
      const fd = new FormData();
      for (const e of entries) fd.append('files', e.file, e.path);
      fd.append('metadata', '{}');
      const res = await realFetch(`${base}/api/upload/${type}?keepFolders=1`, { method: 'POST', body: fd });
      onProgress?.(1, 1);
      const body = await res.json();
      if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status });
      return body;
    };
    api.getLibrary = async () => ({ items: [] });

    const host = document.getElementById('host');
    renderUpload(host);
    host.querySelector('.upload-type-card[data-type="auto"]').click();

    // "Choose folder": files carry webkitRelativePath.
    const picked = [
      ['Mixtape/01 Intro.mp3', 'aa'],
      ['Mixtape/02 Song.mp3', 'bb'],
      ['Mixtape/cover.jpg', 'img'],
      ['Mixtape/readme.txt', 'txt'],
      // Uploaded by the first test (same size) → must be skipped.
      ['Björk/Homogenic/01 Hunter.mp3', 'audio-1'],
    ].map(([rel, content]) => {
      const file = new File([content], rel.split('/').pop());
      Object.defineProperty(file, 'webkitRelativePath', { value: rel });
      return file;
    });
    const folderInput = host.querySelector('#folder-input');
    Object.defineProperty(folderInput, 'files', { value: picked, configurable: true });
    folderInput.dispatchEvent(new window.Event('change'));

    const until = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      while (!fn()) {
        if (Date.now() > end) throw new Error(`timed out; review: ${host.querySelector('#folder-review').textContent.replace(/\s+/g, ' ').slice(0, 300)} | progress: ${host.querySelector('#progress-text').textContent} | button: ${host.querySelector('#start-upload').textContent}`);
        await new Promise(r => setTimeout(r, 20));
      }
    };
    const review = host.querySelector('#folder-review');
    await until(() => /already in your library/.test(review.textContent));
    assert.match(review.textContent, /2 folders/);
    assert.match(review.textContent, /1 file Vault can’t use/);
    const uploadBtn = host.querySelector('#start-upload');
    assert.equal(uploadBtn.textContent, 'Upload 3 files', 'the existing Hunter track is not counted');
    assert.equal(host.querySelector('#metadata-form').innerHTML, '', 'no single-file title form for folders');

    // Record every message the progress line shows (the rate-limit notice
    // only lasts as long as the wait).
    const seen = [];
    const progressText = host.querySelector('#progress-text');
    new window.MutationObserver(() => seen.push(progressText.textContent)).observe(progressText, { childList: true, characterData: true, subtree: true });
    uploadBtn.click();
    await until(() => seen.some(t => /upload limit/.test(t)));
    await until(() => sent.length === 1 && host.querySelector('#upload-progress').style.display === 'none');

    assert.deepEqual(sent, [{ type: 'music', paths: ['Mixtape/cover.jpg', 'Mixtape/01 Intro.mp3', 'Mixtape/02 Song.mp3'] }]);
    assert.ok(fs.existsSync(path.join(mediaPaths.music, 'Mixtape', '02 Song.mp3')));
    assert.ok(fs.existsSync(path.join(mediaPaths.music, 'Mixtape', 'cover.jpg')));
    assert.ok(!fs.existsSync(path.join(mediaPaths.music, 'Mixtape', 'readme.txt')));
    assert.ok(!fs.existsSync(path.join(mediaPaths.music, 'Björk', 'Homogenic', '01 Hunter_1.mp3')), 'no duplicate copy');
    assert.equal(host.querySelector('#folder-review').hidden, true, 'page resets after success');
    assert.ok(seen.every(t => !/\d\.\d{3,} B/.test(t)), `no raw float byte counts: ${seen.find(t => /\d\.\d{3,} B/.test(t))}`);
  } finally {
    globalThis.fetch = realFetch;
    dom.window.close();
  }
});
