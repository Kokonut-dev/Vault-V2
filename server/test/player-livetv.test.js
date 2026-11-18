/**
 * The video player with Live TV / IPTV entries (runs docs/js/components/
 * videoPlayer.js in jsdom against a fake /api and a fake hls.js).
 *
 * Regression: an IPTV movie got the provider URL as <video src>; on failure
 * the player "fell back" to /api/transcode/live:… and /api/transcode/hls/
 * live:…, which can only 404, then showed "This file could not be played.
 * The codec may be unsupported or the server is unreachable." with no way
 * forward.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'index.html'), 'utf8');
const modal = html.slice(html.indexOf('<div id="video-modal"'), html.indexOf('<!-- ', html.indexOf('<div id="video-modal"')));
const dom = new JSDOM(`<!doctype html><html><body>${modal}<div id="toast-container"></div></body></html>`, {
  url: 'https://kokonut-dev.github.io/Vault-V2/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };
localStorage.setItem('vault_token', 'test-token');

// jsdom has no media pipeline.
const media = dom.window.HTMLMediaElement.prototype;
media.play = function play() { return Promise.resolve(); };
media.pause = function pause() {};
media.load = function load() {};
// Current Chrome: claims native HLS ("maybe") but can't play it — the
// player must still go through hls.js wherever MediaSource exists.
media.canPlayType = (type) => (/mpegurl/i.test(type) ? 'maybe' : '');
window.MediaSource = function MediaSource() {};

// Fake hls.js: records sources, lets the test fire fatal errors.
const hlsInstances = [];
window.Hls = class FakeHls {
  static isSupported() { return true; }
  constructor(config) { this.config = config; this.handlers = {}; this.destroyed = false; hlsInstances.push(this); }
  loadSource(url) { this.url = url; }
  attachMedia(el) { this.media = el; }
  on(event, fn) { this.handlers[event] = fn; }
  recoverMediaError() { this.recovered = true; }
  destroy() { this.destroyed = true; }
  fatal(data) { this.handlers.hlsError?.('hlsError', { fatal: true, ...data }); }
};
window.Hls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
window.Hls.ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };

const calls = [];
let playResponses = [];
let sessionCounter = 0;
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  const method = options.method || 'GET';
  calls.push({ method, path: u.pathname, body: options.body ? JSON.parse(options.body) : null, keepalive: options.keepalive });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (method === 'POST' && /^\/api\/livetv\/channels\/[^/]+\/play$/.test(u.pathname)) {
    const next = playResponses.shift() || 'ok';
    if (next !== 'ok') return json(next.status, next.body);
    sessionCounter += 1;
    return json(200, { sessionId: `s${sessionCounter}`, playlist: `/api/livetv/stream/s${sessionCounter}/index.m3u8`, live: false, plan: { video: 'transcode', audio: 'transcode', directPlayable: false } });
  }
  if (method === 'DELETE') return json(200, { ok: true });
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function settle() { for (let i = 0; i < 8; i++) await tick(5); }

const movie = () => ({ id: 'live:ch_3_Q29wcGVyIE', channelId: 'ch_3_Q29wcGVyIE', title: 'Copper Fields (2018)', type: 'video', live: false, external: true });
const errorText = () => document.querySelector('#video-error .video-error-msg').textContent;
const errorShown = () => document.getElementById('video-error').style.display === 'flex';
const retryBtn = () => document.getElementById('video-retry-transcode');

let player;
test.before(async () => {
  player = await import(docs('components', 'videoPlayer.js'));
  player.initVideoPlayer();
});

test.beforeEach(() => {
  player.closePlayer();
  calls.length = 0;
  hlsInstances.length = 0;
  playResponses = [];
});

test('an IPTV movie plays through a server restream, never library routes', async () => {
  window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: movie() } }));
  assert.match(document.querySelector('#video-status .video-status-msg').textContent, /Tuning in to Copper Fields/);
  await settle();

  const posts = calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/api/livetv/channels/ch_3_Q29wcGVyIE/play');
  assert.deepEqual(posts[0].body, { transcode: false });
  assert.equal(hlsInstances.length, 1);
  assert.equal(hlsInstances[0].url, `https://vault.example.test/api/livetv/stream/s${sessionCounter}/index.m3u8?token=test-token`);
  assert.equal(document.getElementById('video-element').getAttribute('src'), null, 'provider URL never reaches <video>');
  assert.ok(document.getElementById('video-player').classList.contains('is-external'), 'download/next hidden');
  assert.ok(!calls.some(c => /\/api\/(transcode|media)\//.test(c.path)), 'no library-only routes');
  assert.equal(errorShown(), false);
});

test('playback failure → forced conversion → explained error with a working retry', async () => {
  window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: movie() } }));
  await settle();
  const first = `s${sessionCounter}`;
  hlsInstances[0].fatal({ type: 'networkError', details: 'fragLoadError', response: { code: 500 } });
  await settle();

  const posts = calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts.map(p => p.body.transcode), [false, true], 'second attempt converts everything');
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path === `/api/livetv/stream/${first}`), 'first session released');
  const second = `s${sessionCounter}`;
  assert.equal(hlsInstances.length, 2);
  assert.equal(hlsInstances[0].destroyed, true);

  // A late <video> error for the torn-down stream must not count twice.
  document.getElementById('video-element').dispatchEvent(new window.Event('error'));
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 2);

  hlsInstances[1].fatal({ type: 'networkError', details: 'levelLoadError', response: { code: 404 } });
  await settle();
  assert.ok(errorShown());
  assert.match(errorText(), /ended on the server/);
  assert.doesNotMatch(errorText(), /codec may be unsupported/);
  assert.equal(retryBtn().textContent, 'Try again');
  assert.notEqual(retryBtn().style.display, 'none');
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path === `/api/livetv/stream/${second}`));

  retryBtn().click();
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 3);
  assert.equal(errorShown(), false);
});

test('provider errors are shown as-is; final ones offer Close, not a pointless retry', async () => {
  playResponses = [{ status: 502, body: { code: 'AUTH', error: 'The provider refused this stream (access denied). The subscription may have expired.' } }];
  window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: movie() } }));
  await settle();
  assert.ok(errorShown());
  assert.match(errorText(), /subscription may have expired/);
  assert.equal(retryBtn().style.display, 'none');
  assert.equal(document.activeElement?.id, 'video-error-close', 'focus moves to Close so keyboard users are not stranded');
  assert.equal(hlsInstances.length, 0);

  document.getElementById('video-error-close').click();
  assert.equal(document.getElementById('video-modal').hidden, true);
});

test('missing ffmpeg is explained; transient errors can be retried', async () => {
  playResponses = [{ status: 503, body: { code: 'NO_FFMPEG', error: "The Vault server can't convert this stream because ffmpeg isn't installed." } }];
  window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: movie() } }));
  await settle();
  assert.match(errorText(), /ffmpeg isn't installed/);
  assert.equal(retryBtn().style.display, 'none');

  playResponses = [{ status: 502, body: { code: 'UNREACHABLE', error: "The Vault server couldn't reach the provider." } }];
  window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: movie() } }));
  await settle();
  assert.match(errorText(), /couldn't reach the provider/);
  assert.notEqual(retryBtn().style.display, 'none');
});

test('closing the player stops the server-side stream (keepalive survives tab close)', async () => {
  window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: movie() } }));
  await settle();
  player.closePlayer();
  const del = calls.find(c => c.method === 'DELETE');
  assert.equal(del.path, '/api/livetv/stream/s' + sessionCounter);
  assert.equal(del.keepalive, true);
});

test('watch history is not written for Live TV entries', async () => {
  const { store } = await import(docs('store.js'));
  const before = JSON.stringify(store.get('history') || []);
  window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: movie() } }));
  await settle();
  const video = document.getElementById('video-element');
  Object.defineProperty(video, 'duration', { value: 100, configurable: true });
  Object.defineProperty(video, 'currentTime', { value: 50, configurable: true, writable: true });
  video.dispatchEvent(new window.Event('timeupdate'));
  video.dispatchEvent(new window.Event('ended'));
  await settle();
  assert.equal(JSON.stringify(store.get('history') || []), before);
  assert.ok(!calls.some(c => /completed|progress/.test(c.path)));
});
