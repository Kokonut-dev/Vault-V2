/**
 * docs/js/components/hlsLoader.js — which HLS engine gets the stream.
 *
 * Regression: Chrome shipped a built-in HLS player in late 2025, so
 * canPlayType('application/vnd.apple.mpegurl') now answers "maybe" there.
 * The loader trusted that answer, handed the playlist to <video src>, never
 * loaded hls.js, and Chrome failed with MEDIA_ERR_SRC_NOT_SUPPORTED —
 * "Your browser can't play this stream's format." on every Live TV channel
 * and IPTV movie. hls.js must win wherever MediaSource exists; native HLS is
 * only for devices without it (older iPhones, some TV browsers).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://kokonut-dev.github.io/Vault-V2/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;

const media = dom.window.HTMLMediaElement.prototype;
let canPlayHls = '';
media.canPlayType = (type) => (/mpegurl/i.test(type) ? canPlayHls : '');
media.load = function load() {};

const instances = [];
let libSupported = true;
class FakeHls {
  static isSupported() { return libSupported; }
  constructor(config) { this.config = config; this.handlers = {}; instances.push(this); }
  loadSource(url) { this.url = url; }
  attachMedia(el) { this.media = el; }
  on(event, fn) { this.handlers[event] = fn; }
  recoverMediaError() { this.recovered = true; }
  destroy() { this.destroyed = true; }
}
FakeHls.Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' };
FakeHls.ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
window.Hls = FakeHls;

const loaderUrl = pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', 'components', 'hlsLoader.js')).href;
const URL_ = '/api/livetv/stream/s1/index.m3u8?token=t';

function setEnv({ native = '', mse = null, managed = null, lib = true }) {
  canPlayHls = native;
  libSupported = lib;
  delete window.MediaSource;
  delete window.ManagedMediaSource;
  delete window.WebKitMediaSource;
  if (mse) window.MediaSource = function MediaSource() {};
  if (managed) window.ManagedMediaSource = function ManagedMediaSource() {};
  instances.length = 0;
}

function freshVideo() {
  const v = document.createElement('video');
  document.body.appendChild(v);
  return v;
}

test('current Chrome: canPlayType says "maybe" but hls.js plays the stream', async () => {
  const { attachHls } = await import(loaderUrl);
  setEnv({ native: 'maybe', mse: true });
  const video = freshVideo();
  assert.equal(await attachHls(video, URL_), true);
  assert.equal(instances.length, 1, 'hls.js must be used');
  assert.equal(instances[0].url, URL_);
  assert.equal(instances[0].media, video);
  assert.equal(video.getAttribute('src'), null, 'the playlist must not go to <video src>');
  assert.equal(video._vaultHls, instances[0]);
});

test('Firefox / older Chrome (no native HLS) uses hls.js', async () => {
  const { attachHls } = await import(loaderUrl);
  setEnv({ native: '', mse: true });
  const video = freshVideo();
  assert.equal(await attachHls(video, URL_), true);
  assert.equal(instances.length, 1);
  assert.equal(video.getAttribute('src'), null);
});

test('iOS 17.1+ (ManagedMediaSource only) uses hls.js', async () => {
  const { attachHls } = await import(loaderUrl);
  setEnv({ native: 'maybe', managed: true });
  const video = freshVideo();
  assert.equal(await attachHls(video, URL_), true);
  assert.equal(instances.length, 1);
});

test('older iPhone (no MediaSource at all) plays natively', async () => {
  const { attachHls, hlsSupported } = await import(loaderUrl);
  setEnv({ native: 'maybe' });
  assert.equal(hlsSupported(), true);
  const video = freshVideo();
  assert.equal(await attachHls(video, URL_, { startPosition: 42 }), true);
  assert.equal(instances.length, 0, 'hls.js is not used without MediaSource');
  assert.equal(video.getAttribute('src'), URL_);
  // The resume position is applied once the browser knows the stream.
  video.dispatchEvent(new window.Event('loadedmetadata'));
  assert.equal(video.currentTime, 42);
});

test('hls.js unsupported but native HLS exists: falls back to native', async () => {
  const { attachHls } = await import(loaderUrl);
  setEnv({ native: 'maybe', mse: true, lib: false });
  const video = freshVideo();
  assert.equal(await attachHls(video, URL_), true);
  assert.equal(instances.length, 0);
  assert.equal(video.getAttribute('src'), URL_);
});

test('no MediaSource and no native HLS: reports failure so the player can fall back', async () => {
  const { attachHls, hlsSupported } = await import(loaderUrl);
  setEnv({ native: '' });
  assert.equal(hlsSupported(), false);
  const video = freshVideo();
  assert.equal(await attachHls(video, URL_), false);
  assert.equal(video.getAttribute('src'), null);
});

test('startPosition is applied by hls.js after the manifest is parsed', async () => {
  const { attachHls } = await import(loaderUrl);
  setEnv({ native: 'maybe', mse: true });
  const video = freshVideo();
  await attachHls(video, URL_, { startPosition: 30 });
  instances[0].handlers.hlsManifestParsed();
  assert.equal(video.currentTime, 30);
});

test('re-attaching destroys the previous hls.js instance', async () => {
  const { attachHls, detachHls } = await import(loaderUrl);
  setEnv({ native: 'maybe', mse: true });
  const video = freshVideo();
  await attachHls(video, URL_);
  const first = instances[0];
  await attachHls(video, URL_ + '&again=1');
  assert.equal(first.destroyed, true);
  assert.equal(video._vaultHls, instances[1]);
  detachHls(video);
  assert.equal(instances[1].destroyed, true);
  assert.equal(video._vaultHls, undefined);
});
