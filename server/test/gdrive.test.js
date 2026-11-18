/**
 * Google Drive import (services/gdrive.js) against a local fake Google:
 *   - share-link parsing (files, folders, resource keys, Docs, junk),
 *   - Google's HTML pages (virus-scan confirm form, quota, private, 404),
 *   - public folder listing → import keeps the folder structure, sorts by
 *     library, keeps Unicode names, confirms big files, leaves no partials,
 *   - API-key + account (Bearer) modes, picked files, browsing,
 *   - size cap, cancel, expired token (never a 401 — the app treats any
 *     401 as "your Vault session ended").
 *
 * Config and the job/event bus are in-memory, so nothing touches config.json.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

// Listen like a browser would: a fake SSE client on the real event bus.
const events = require('../services/events');
const broadcasts = [];
events.addClient({
  write(payload) {
    const m = payload.match(/^event: (.+)\ndata: (.*)\n\n$/s);
    if (m) broadcasts.push({ event: m[1], data: JSON.parse(m[2]) });
  },
});

const gdrive = require('../services/gdrive');

// ---------------------------------------------------------------------------
// Fake Google
// ---------------------------------------------------------------------------
const FILES = {
  // id: { name, body, mime, parent }
  FOLDERroot0001: { name: 'Road Trip ✈', folder: true },
  FOLDERsub00001: { name: 'Disc 2', folder: true, parent: 'FOLDERroot0001' },
  FILEsong000001: { name: '01 - Beyoncé – Halo.mp3', body: Buffer.alloc(3000, 1), mime: 'audio/mpeg', parent: 'FOLDERroot0001' },
  FILEsong000002: { name: '02 - 坂本龍一.flac', body: Buffer.alloc(2000, 2), mime: 'audio/flac', parent: 'FOLDERsub00001' },
  FILEcover00001: { name: 'cover.jpg', body: Buffer.alloc(500, 3), mime: 'image/jpeg', parent: 'FOLDERroot0001' },
  FILEnotes00001: { name: 'notes.txt', body: Buffer.from('hello'), mime: 'text/plain', parent: 'FOLDERroot0001' },
  FILEbigfilm001: { name: 'Big Film (2020).mkv', body: Buffer.alloc(9000, 4), mime: 'video/x-matroska', confirm: true },
  FILEprivate001: { name: 'secret.mp4', private: true },
  FILEslowfilm01: { name: 'Slow.mp4', body: Buffer.alloc(200000, 5), mime: 'video/mp4', slow: true },
};

const seen = [];
let server;
let base;

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function sendFile(res, file) {
  const headers = {
    'Content-Type': file.mime,
    'Content-Length': file.body.length,
    'Content-Disposition': `attachment; filename="x"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  };
  res.writeHead(200, headers);
  if (!file.slow) return res.end(file.body);
  // Trickle so a test can cancel mid-download.
  let offset = 0;
  const timer = setInterval(() => {
    if (res.destroyed) return clearInterval(timer);
    res.write(file.body.subarray(offset, offset + 1000));
    offset += 1000;
    if (offset >= file.body.length) { clearInterval(timer); res.end(); }
  }, 20);
  res.on('close', () => clearInterval(timer));
}

function apiFile(id) {
  const f = FILES[id];
  return {
    id,
    name: f.name,
    mimeType: f.folder ? 'application/vnd.google-apps.folder' : f.mime,
    ...(f.body ? { size: String(f.body.length) } : {}),
  };
}

function handler(req, res) {
  const url = new URL(req.url, base);
  seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || null });

  // --- public web
  if (url.pathname === '/embeddedfolderview') {
    const id = url.searchParams.get('id');
    const folder = FILES[id];
    if (!folder?.folder) return html(res, 404, '<html><title>Not found</title>Sorry, the file you have requested does not exist.</html>');
    const entries = Object.entries(FILES).filter(([, f]) => f.parent === id).map(([cid, f]) => (
      `<div class="flip-entry" id="entry-${cid}" tabindex="0"><a href="https://drive.google.com/${f.folder ? `drive/folders/${cid}` : `file/d/${cid}/view?usp=drive_web`}" target="_blank"><div class="flip-entry-info"><div class="flip-entry-title">${f.name.replace(/&/g, '&amp;')}</div></div></a></div>`
    )).join('');
    return html(res, 200, `<html><head><title>${folder.name}</title></head><body><div class="flip-entries">${entries}</div></body></html>`);
  }
  if (url.pathname === '/download') {
    const id = url.searchParams.get('id');
    const file = FILES[id];
    if (!file) return html(res, 404, '<html>Not Found. Error 404.</html>');
    if (file.private) {
      res.writeHead(302, { Location: 'https://accounts.google.com/ServiceLogin?continue=x' });
      return res.end();
    }
    if (file.confirm && url.searchParams.get('uuid') !== 'u-123') {
      return html(res, 200, `<html><body><form id="download-form" action="${base}/download" method="get">
        <input type="hidden" name="id" value="${id}"><input type="hidden" name="export" value="download">
        <input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-123"></form>
        <span class="uc-name-size"><a href="/open?id=${id}">${file.name}</a> (9K)</span></body></html>`);
    }
    return sendFile(res, file);
  }

  // --- Drive API v3
  const m = url.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?$/);
  if (m) {
    const key = url.searchParams.get('key');
    const auth = req.headers.authorization;
    if (auth === 'Bearer expired-token-0000000000') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }));
    }
    if (!auth && key !== 'AIzaGoodKey000000000000000000000000') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 403, message: 'API key not valid', errors: [{ reason: 'keyInvalid' }] } }));
    }
    res.setHeader('Content-Type', 'application/json');
    if (m[1]) {
      const id = decodeURIComponent(m[1]);
      if (id === 'root') return res.end(JSON.stringify({ id: 'root', name: 'My Drive', mimeType: 'application/vnd.google-apps.folder' }));
      const f = FILES[id];
      if (!f || (f.private && !auth)) { res.statusCode = 404; return res.end(JSON.stringify({ error: { code: 404, message: 'File not found' } })); }
      if (url.searchParams.get('alt') === 'media') {
        res.removeHeader('Content-Type');
        return sendFile(res, f.private ? { ...f, body: Buffer.alloc(100, 9), mime: 'video/mp4' } : f);
      }
      return res.end(JSON.stringify(apiFile(id)));
    }
    const q = url.searchParams.get('q') || '';
    const parent = (q.match(/'([^']+)' in parents/) || [])[1];
    const nameHas = (q.match(/name contains '([^']+)'/) || [])[1];
    let ids = Object.keys(FILES);
    if (parent === 'root') ids = ['FOLDERroot0001', 'FILEbigfilm001'];
    else if (parent) ids = ids.filter(id => FILES[id].parent === parent);
    if (nameHas) ids = ids.filter(id => FILES[id].name.toLowerCase().includes(nameHas.toLowerCase()));
    return res.end(JSON.stringify({ files: ids.map(apiFile) }));
  }
  res.writeHead(404);
  res.end();
}

let mediaRoot;
test.before(async () => {
  server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(gdrive._endpoints, { web: base, usercontent: base, api: base, extraHosts: [new URL(base).host] });
  mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-gdrive-'));
  memory.media.paths = {};
  for (const lib of ['movies', 'music', 'videos', 'audiobooks', 'podcasts', 'comics']) {
    memory.media.paths[lib] = path.join(mediaRoot, lib);
    fs.mkdirSync(memory.media.paths[lib], { recursive: true });
  }
  memory.integrations = {};
});

test.after(() => {
  server.close();
  fs.rmSync(mediaRoot, { recursive: true, force: true });
});

function waitForJob(id, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const job = gdrive.getJob(id);
      if (job && job.status !== 'running') return resolve(job);
      if (Date.now() - started > timeoutMs) return reject(new Error(`job ${id} still running`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

// ---------------------------------------------------------------------------
test('parseDriveLink understands every share-link shape', () => {
  const p = gdrive.parseDriveLink;
  assert.deepEqual(p('https://drive.google.com/file/d/1AbCdEfGhIjK_lm-no/view?usp=sharing'), { kind: 'file', id: '1AbCdEfGhIjK_lm-no', resourceKey: null });
  assert.deepEqual(p('https://drive.google.com/drive/folders/1FolderIdXYZ123?resourcekey=0-abc'), { kind: 'folder', id: '1FolderIdXYZ123', resourceKey: '0-abc' });
  assert.deepEqual(p('drive.google.com/drive/u/1/folders/1FolderIdXYZ123'), { kind: 'folder', id: '1FolderIdXYZ123', resourceKey: null });
  assert.deepEqual(p('https://drive.google.com/open?id=1AbCdEfGhIjK'), { kind: 'file', id: '1AbCdEfGhIjK', resourceKey: null });
  assert.deepEqual(p('https://drive.google.com/uc?export=download&id=1AbCdEfGhIjK'), { kind: 'file', id: '1AbCdEfGhIjK', resourceKey: null });
  assert.deepEqual(p('https://drive.usercontent.google.com/download?id=1AbCdEfGhIjK&export=download'), { kind: 'file', id: '1AbCdEfGhIjK', resourceKey: null });
  assert.equal(p('https://docs.google.com/file/d/1AbCdEfGhIjK/edit').kind, 'file');
  assert.throws(() => p('https://docs.google.com/document/d/1AbCdEfGhIjK/edit'), { code: 'NOT_MEDIA' });
  assert.throws(() => p('https://dropbox.com/s/abc/file.mp4'), { code: 'INVALID_LINK' });
  assert.throws(() => p('https://drive.google.com.evil.example/file/d/1AbCdEfGhIjK/view'), { code: 'INVALID_LINK' });
  assert.throws(() => p('https://drive.google.com/drive/my-drive'), { code: 'INVALID_LINK' });
  assert.throws(() => p(''), { code: 'INVALID_LINK' });
});

test('classifyHtml reads the confirm form and Google error pages', () => {
  const confirm = gdrive.classifyHtml(`<form id="download-form" action="https://drive.usercontent.google.com/download" method="get">
    <input type="hidden" name="id" value="abc"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u&amp;1"></form>
    <span class="uc-name-size"><a href="/open?id=abc">Movie &amp; Co.mkv</a> (1.5G)</span>`);
  assert.equal(confirm.kind, 'confirm');
  assert.equal(confirm.params.get('uuid'), 'u&1');
  assert.equal(confirm.name, 'Movie & Co.mkv');
  assert.equal(confirm.size, Math.round(1.5 * 1024 ** 3));
  assert.equal(gdrive.classifyHtml('Sorry, you can\'t view or download this file at this time. Too many users have viewed or downloaded this file recently.').error.code, 'QUOTA_EXCEEDED');
  assert.equal(gdrive.classifyHtml('<a href="https://accounts.google.com/ServiceLogin">Sign in</a>').error.code, 'NOT_PUBLIC');
  assert.equal(gdrive.classifyHtml('<title>Not Found</title> Error 404').error.code, 'NOT_FOUND');
  assert.equal(gdrive.classifyHtml('<html>something else</html>').error.code, 'UNEXPECTED_RESPONSE');
});

test('filenameFromDisposition prefers the UTF-8 name', () => {
  assert.equal(gdrive.filenameFromDisposition(`attachment; filename="x"; filename*=UTF-8''Beyonc%C3%A9.mp3`), 'Beyoncé.mp3');
  assert.equal(gdrive.filenameFromDisposition('attachment; filename="Plain Name.mkv"'), 'Plain Name.mkv');
  assert.equal(gdrive.filenameFromDisposition(''), null);
});

test('public folder: inspect lists media, nested folders and skips the rest', async () => {
  const listing = await gdrive.inspect(`${base}/drive/folders/FOLDERroot0001`);
  assert.equal(listing.kind, 'folder');
  assert.equal(listing.name, 'Road Trip ✈');
  assert.equal(listing.mode, 'public');
  const byName = Object.fromEntries(listing.items.map(i => [i.name, i]));
  assert.equal(byName['01 - Beyoncé – Halo.mp3'].kind, 'audio');
  assert.equal(byName['02 - 坂本龍一.flac'].relDir, 'Disc 2');
  assert.equal(byName['cover.jpg'].kind, 'image');
  assert.equal(byName['notes.txt'].supported, false);
});

test('public folder import keeps structure + Unicode names and leaves no partial files', async () => {
  broadcasts.length = 0;
  const scanned = [];
  const job = await gdrive.startImport({
    link: `${base}/drive/folders/FOLDERroot0001`,
    destination: 'auto',
    scanFile: async (p) => { scanned.push(p); return { id: path.basename(p), title: path.basename(p) }; },
  });
  assert.equal(job.status, 'running');
  assert.equal(job.accessToken, undefined);
  const done = await waitForJob(job.id);
  assert.equal(done.status, 'done', JSON.stringify(done.files));
  assert.equal(done.imported, 3); // two songs + cover, notes.txt skipped
  const root = path.join(memory.media.paths.music, 'Road Trip ✈');
  assert.ok(fs.existsSync(path.join(root, '01 - Beyoncé – Halo.mp3')));
  assert.ok(fs.existsSync(path.join(root, 'Disc 2', '02 - 坂本龍一.flac')));
  assert.ok(fs.existsSync(path.join(root, 'cover.jpg')), 'artwork lands next to the music');
  assert.equal(fs.statSync(path.join(root, '01 - Beyoncé – Halo.mp3')).size, 3000);
  assert.deepEqual(walk(mediaRoot).filter(f => f.endsWith('.vault-part')), []);
  assert.equal(scanned.length, 2, 'only playable media is indexed');
  const progress = broadcasts.filter(b => b.event === 'import:progress');
  assert.ok(progress.length >= 2);
  assert.ok(progress.every(b => !('accessToken' in b.data) && !('_lastBroadcast' in b.data)));
  const finished = broadcasts.find(b => b.event === 'job:finished' && b.data.id === job.id);
  assert.equal(finished.data.imported, 3);
  assert.match(finished.data.name, /Road Trip/);
});

test('a second import of the same folder never overwrites — it numbers the copy', async () => {
  const job = await gdrive.startImport({ link: `${base}/file/d/FILEsong000001/view`, destination: 'music' });
  const done = await waitForJob(job.id);
  assert.equal(done.status, 'done');
  const again = await waitForJob((await gdrive.startImport({ link: `${base}/file/d/FILEsong000001/view`, destination: 'music' })).id);
  assert.equal(again.status, 'done');
  assert.ok(fs.existsSync(path.join(memory.media.paths.music, '01 - Beyoncé – Halo (1).mp3')));
});

test('big public files go through Google’s virus-scan confirmation', async () => {
  const listing = await gdrive.inspect(`${base}/file/d/FILEbigfilm001/view`);
  assert.equal(listing.items[0].name, 'Big Film (2020).mkv');
  assert.equal(listing.items[0].kind, 'video');
  const done = await waitForJob((await gdrive.startImport({ link: `${base}/file/d/FILEbigfilm001/view` })).id);
  assert.equal(done.status, 'done', JSON.stringify(done));
  const file = path.join(memory.media.paths.movies, 'Big Film (2020).mkv');
  assert.equal(fs.statSync(file).size, 9000);
  assert.ok(seen.some(s => s.path === '/download' && s.query.uuid === 'u-123'));
});

test('private files and missing folders give actionable errors', async () => {
  await assert.rejects(gdrive.inspect(`${base}/file/d/FILEprivate001/view`), { code: 'NOT_PUBLIC' });
  await assert.rejects(gdrive.inspect(`${base}/drive/folders/FOLDERmissing1`), { code: 'NOT_PUBLIC' });
  await assert.rejects(gdrive.startImport({ link: `${base}/file/d/FILEnotes00001/view` }), { code: 'NOTHING_TO_IMPORT' });
  await assert.rejects(gdrive.startImport({ link: `${base}/file/d/FILEsong000001/view`, destination: '../etc' }), { code: 'INVALID_DESTINATION' });
});

test('size cap: a file over media.maxUploadSizeMB fails without leaving a partial', async () => {
  const before = memory.media.maxUploadSizeMB;
  memory.media.maxUploadSizeMB = 0.001; // ~1 KB
  try {
    const done = await waitForJob((await gdrive.startImport({ link: `${base}/file/d/FILEbigfilm001/view`, destination: 'videos' })).id);
    assert.equal(done.status, 'error');
    assert.match(done.error, /limit/);
    assert.deepEqual(walk(memory.media.paths.videos), []);
  } finally {
    memory.media.maxUploadSizeMB = before;
  }
});

test('cancel stops a running download and removes the partial file', async () => {
  const job = await gdrive.startImport({ link: `${base}/file/d/FILEslowfilm01/view`, destination: 'videos' });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(gdrive.cancelImport(job.id), true);
  const done = await waitForJob(job.id);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.files[0].status, 'cancelled');
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(walk(memory.media.paths.videos), []);
  assert.equal(gdrive.cancelImport(job.id), false);
});

test('API-key mode lists with sizes; a bad key is reported clearly', async () => {
  memory.integrations.googleDrive = { apiKey: 'AIzaGoodKey000000000000000000000000' };
  try {
    const listing = await gdrive.inspect(`${base}/drive/folders/FOLDERroot0001`);
    assert.equal(listing.mode, 'apiKey');
    assert.equal(listing.name, 'Road Trip ✈');
    assert.ok(listing.items.every(i => i.size != null));
    assert.ok(seen.some(s => s.query.key === 'AIzaGoodKey000000000000000000000000'));
    memory.integrations.googleDrive = { apiKey: 'AIzaBadKey0000000000000000000000000' };
    await assert.rejects(gdrive.inspect(`${base}/drive/folders/FOLDERroot0001`), { code: 'BAD_API_KEY' });
  } finally {
    memory.integrations.googleDrive = {};
  }
});

test('account mode: private files, browsing, picked files; expired tokens are 400 not 401', async () => {
  const token = 'ya29.good-token-000000000000';
  const listing = await gdrive.inspect(`${base}/file/d/FILEprivate001/view`, { accessToken: token });
  assert.equal(listing.mode, 'account');
  assert.equal(listing.items[0].name, 'secret.mp4');

  const root = await gdrive.browse({ accessToken: token });
  assert.equal(root.folder.name, 'My Drive');
  assert.deepEqual(root.items.map(i => i.kind), ['folder', 'video']);
  const search = await gdrive.browse({ accessToken: token, query: "halo' or 'x" });
  assert.equal(search.items.length, 0, 'quotes are stripped from searches');
  await assert.rejects(gdrive.browse({}), { code: 'NO_TOKEN', status: 400 });

  const job = await gdrive.startImport({ files: ['FILEprivate001', 'FOLDERsub00001'], destination: 'auto', accessToken: token });
  assert.equal(job.accessToken, undefined);
  const done = await waitForJob(job.id);
  assert.equal(done.status, 'done', JSON.stringify(done.files));
  assert.ok(fs.existsSync(path.join(memory.media.paths.movies, 'secret.mp4')));
  assert.ok(fs.existsSync(path.join(memory.media.paths.music, 'Disc 2', '02 - 坂本龍一.flac')));
  assert.ok(seen.filter(s => s.query.alt === 'media').every(s => s.auth === `Bearer ${token}`));

  await assert.rejects(gdrive.inspect(`${base}/file/d/FILEsong000001/view`, { accessToken: 'expired-token-0000000000' }), (err) => {
    assert.equal(err.code, 'TOKEN_EXPIRED');
    assert.equal(err.status, 400);
    return true;
  });
  await assert.rejects(gdrive.inspectFiles(['FILEsong000001']), { code: 'NO_TOKEN' });
  await assert.rejects(gdrive.inspectFiles(['../../etc'], { accessToken: token }), { code: 'INVALID_SELECTION' });
});

test('only Google hosts are contacted', async () => {
  const saved = [...gdrive._endpoints.extraHosts];
  gdrive._endpoints.extraHosts.length = 0;
  try {
    await assert.rejects(gdrive.inspect({ kind: 'file', id: 'FILEsong000001' }), { code: 'BLOCKED_HOST' });
  } finally {
    gdrive._endpoints.extraHosts.push(...saved);
  }
});
