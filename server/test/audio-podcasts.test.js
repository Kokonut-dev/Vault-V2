/**
 * Audio + podcast regressions from the audio bug sweep:
 *   - ffmpeg binary lookup must not point at a missing bundled binary,
 *   - audio conversion route only passes whitelisted codec/bitrate/start,
 *   - feed refreshes keep downloaded/played state, PATCH keeps the title,
 *   - downloaded episodes get a real file name (with its extension),
 *   - feed/episode fetches refuse link-local / metadata addresses (SSRF),
 *   - browser routing: podcasts/audiobooks never hit the video transcoder,
 *     and feed episodes play from their own URL.
 *
 * Config, the library and every JSON store are in-memory stand-ins, so the
 * tests never touch server/config.json or server/data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// --- in-memory stand-ins, installed BEFORE anything requires them ----------
const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const jsonStore = require('../utils/jsonStore');
jsonStore.createJsonStore = (_name, defaultValue) => {
  let data = structuredClone(defaultValue);
  return {
    get: () => data,
    set: (next) => { data = next; },
    update: (fn) => { data = fn(data) ?? data; return data; },
    save: () => {},
    flush: async () => {},
  };
};

const libraryService = require('../services/library');
const libraryItems = new Map();
libraryService.getById = (id) => libraryItems.get(id) || null;

const transcoder = require('../services/transcoder');
const transcodeCalls = [];
transcoder.transcodeAudioStream = (file, res, opts) => {
  transcodeCalls.push({ file, opts });
  res.end('ok');
};

const podcasts = require('../services/podcasts');
const extras = require('../services/extras');
const { blockedReason, safeFetchStream, safeFetchText } = require('../utils/safeFetch');
const { ffmpegBinary, ffprobeBinary } = require('../utils/ffmpegBinaries');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
test('ffmpeg lookup honours FFMPEG_PATH and never returns a missing bundled binary', () => {
  const saved = { ...process.env };
  try {
    process.env.FFMPEG_PATH = '/opt/custom/ffmpeg';
    process.env.FFPROBE_PATH = '/opt/custom/ffprobe';
    assert.equal(ffmpegBinary(), '/opt/custom/ffmpeg');
    assert.equal(ffprobeBinary(), '/opt/custom/ffprobe');
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    for (const bin of [ffmpegBinary(), ffprobeBinary()]) {
      // Either a bare name resolved through PATH, or a file that really exists.
      assert.ok(!bin.includes(path.sep) || fs.existsSync(bin), `${bin} does not exist`);
    }
  } finally {
    process.env = saved;
  }
});

test('audio conversion route whitelists codec and bitrate and clamps start', async () => {
  const tmp = path.join(os.tmpdir(), `vault-audio-${process.pid}.wma`);
  fs.writeFileSync(tmp, 'x');
  libraryItems.set('wma1', { id: 'wma1', path: tmp, type: 'music' });
  const express = require('express');
  const app = express();
  app.use('/api/transcode', require('../routes/transcode'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  try {
    transcodeCalls.length = 0;
    await get(port, '/api/transcode/audio/wma1?codec=opus&bitrate=128k&start=42.5');
    await get(port, '/api/transcode/audio/wma1?codec=-vf%20evil&bitrate=9999k&start=-5');
    await get(port, '/api/transcode/audio/wma1?start=99999999');
    assert.deepEqual(transcodeCalls.map(c => c.opts), [
      { codec: 'opus', bitrate: '128k', start: 42.5 },
      { codec: 'aac', bitrate: '192k', start: 0 },
      { codec: 'aac', bitrate: '192k', start: 86400 },
    ]);
    const missing = await get(port, '/api/transcode/audio/nope');
    assert.equal(missing.status, 404);
  } finally {
    server.close();
    fs.rmSync(tmp, { force: true });
  }
});

test('feed refresh keeps downloaded and played state of known episodes', () => {
  const previous = [
    { guid: 'a', title: 'Old A', localPath: '/m/a.mp3', downloadedAt: '2026-01-01', played: true, position: 33 },
    { guid: 'gone', title: 'Dropped from feed' },
  ];
  const fresh = [{ guid: 'b', title: 'New B' }, { guid: 'a', title: 'Renamed A' }];
  assert.deepEqual(podcasts.mergeEpisodes(previous, fresh), [
    { guid: 'b', title: 'New B' },
    { guid: 'a', title: 'Renamed A', localPath: '/m/a.mp3', downloadedAt: '2026-01-01', played: true, position: 33 },
  ]);
});

test('PATCHing one feed field does not wipe the others', () => {
  const feed = extras.addFeed({ url: 'https://pod.example/feed.xml', title: 'Harbour Talk', description: 'd', items: [{ guid: 'x' }] });
  extras.updateFeed(feed.id, { autoDownload: true, title: undefined, items: undefined });
  const after = extras.getFeeds().find(f => f.id === feed.id);
  assert.equal(after.title, 'Harbour Talk');
  assert.equal(after.autoDownload, true);
  assert.deepEqual(after.items, [{ guid: 'x' }]);
});

test('downloaded episodes get a dated file name that keeps its extension', () => {
  assert.equal(
    podcasts.episodeFileName({ url: 'https://cdn.example/a/ep1.MP3?token=1', published: 'Mon, 09 Nov 2026 08:00:00 GMT', title: 'Episode One: Boats' }),
    '2026-11-09 - Episode One_ Boats.mp3',
  );
  assert.equal(podcasts.episodeFileName({ url: 'https://cdn.example/book.m4b', title: 'Part 1' }), 'episode - Part 1.m4b');
  // No recognisable extension → .mp3, never "Boatsmp3".
  assert.equal(podcasts.episodeFileName({ url: 'https://cdn.example/media?id=7', title: 'T' }), 'episode - T.mp3');
});

test('feeds with .m4b / .oga enclosures are parsed as audio', () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>Books</title>
    <item><title>Ch 1</title><guid>c1</guid><enclosure url="https://x.example/c1.m4b" length="10"/></item>
    <item><title>Ch 2</title><guid>c2</guid><enclosure url="https://x.example/c2.oga" length="10"/></item>
  </channel></rss>`;
  const parsed = podcasts.parseFeed(xml);
  assert.deepEqual(parsed.items.map(i => i.guid), ['c1', 'c2']);
});

test('SSRF: link-local / cloud metadata addresses are always refused', async () => {
  for (const ip of ['169.254.169.254', '::ffff:169.254.169.254', 'fe80::1', '0.0.0.0']) {
    assert.ok(blockedReason(ip), `${ip} should be blocked`);
  }
  // Home-server use: the LAN stays reachable.
  assert.equal(blockedReason('192.168.1.20'), null);
  await assert.rejects(safeFetchStream('http://169.254.169.254/latest/meta-data/'), /blocked|reserved|link-local/i);
  await assert.rejects(safeFetchText('file:///etc/passwd'), /http/i);
});

// --- browser side -----------------------------------------------------------
async function loadBrowserModules() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://kokonut-dev.github.io/Vault-V2/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.HTMLElement = dom.window.HTMLElement;
  window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };
  const docs = path.join(__dirname, '..', '..', 'docs', 'js');
  const { api } = await import(pathToFileURL(path.join(docs, 'api.js')).href);
  const pod = await import(pathToFileURL(path.join(docs, 'views', 'podcasts.js')).href);
  return { api, pod, dom };
}

test('browser: audio items route to the audio converter, never the video transcoder', async () => {
  const { api, dom } = await loadBrowserModules();
  try {
    const wma = { id: 'w1', type: 'music', path: '/m/a.wma', filename: 'a.wma' };
    const m4b = { id: 'b1', type: 'audiobook', path: '/m/book.m4b', filename: 'book.m4b' };
    const mp3 = { id: 'p1', type: 'podcast', path: '/m/ep.mp3', filename: 'ep.mp3' };
    assert.match(api.getPlaybackUrl(wma), /\/api\/transcode\/audio\/w1\?codec=aac/);
    assert.match(api.getPlaybackUrl(mp3, { forceTranscode: true }), /\/api\/transcode\/audio\/p1/);
    assert.match(api.getPlaybackUrl(m4b), /\/api\/(media\/stream|transcode\/audio)\/b1/);
    assert.doesNotMatch(api.getPlaybackUrl(m4b, { forceTranscode: true }), /\/api\/transcode\/b1/);
    assert.match(api.getPlaybackUrl(mp3), /\/api\/media\/stream\/p1/);
    // Feed episodes are not library files: always their own URL.
    const ep = { id: 'podcast:g1', type: 'podcast', streamUrl: 'https://cdn.example/ep.mp3' };
    assert.equal(api.getPlaybackUrl(ep), 'https://cdn.example/ep.mp3');
    assert.equal(api.getPlaybackUrl(ep, { forceTranscode: true }), 'https://cdn.example/ep.mp3');
  } finally {
    dom.window.close();
  }
});

test('browser: feed episodes become playable items (durations, downloaded copy)', async () => {
  const { pod, dom } = await loadBrowserModules();
  try {
    assert.equal(pod.parseEpisodeDuration('1:02:03'), 3723);
    assert.equal(pod.parseEpisodeDuration('0:40'), 40);
    assert.equal(pod.parseEpisodeDuration('95'), 95);
    assert.equal(pod.parseEpisodeDuration('n/a'), 0);
    assert.equal(pod.parseEpisodeDuration(undefined), 0);
    const feed = { title: 'Harbour Talk', artwork: 'https://cdn.example/art.jpg' };
    const streaming = pod.episodeToPlayable({ guid: 'g2', title: 'Tides', url: 'https://cdn.example/ep2.mp3', duration: '0:40' }, feed);
    assert.deepEqual(
      { id: streaming.id, streamUrl: streaming.streamUrl, type: streaming.type, duration: streaming.duration, album: streaming.album },
      { id: 'podcast:g2', streamUrl: 'https://cdn.example/ep2.mp3', type: 'podcast', duration: 40, album: 'Harbour Talk' },
    );
    const local = pod.episodeToPlayable({ guid: 'g1', title: 'Boats', url: 'https://cdn.example/ep1.mp3', downloaded: true, localItemId: 'abc123' }, feed);
    assert.equal(local.id, 'abc123');
    assert.equal(local.streamUrl, undefined);
  } finally {
    dom.window.close();
  }
});
