/**
 * Media links in the web client (docs/js/api.js, run in jsdom).
 *
 * <video>, <img>, <track> and EventSource can't send an Authorization header,
 * so their URLs carry `?token=`. That must be the read-only media token from
 * GET /api/auth/media-token, never the sign-in token (the server refuses it
 * in a URL). The media token is tied to the session and profile it was issued
 * for, and is renewed before it gets old.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://kokonut-dev.github.io/Vault-V2/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };

/** A JWT-shaped sign-in token (the client only reads its payload). */
function signInToken(sid, profileId = 'default') {
  const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ username: 'admin', sid, profileId })}.signature`;
}

let issued = 0;
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), auth: options.headers?.Authorization || null });
  if (String(url).endsWith('/api/auth/media-token')) {
    issued += 1;
    return new Response(JSON.stringify({ token: `media-${issued}`, expiresIn: 12 * 60 * 60 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
};

let api;
let store;
test.before(async () => {
  const docs = path.join(__dirname, '..', '..', 'docs', 'js');
  ({ store } = await import(pathToFileURL(path.join(docs, 'store.js')).href));
  ({ api } = await import(pathToFileURL(path.join(docs, 'api.js')).href));
});

function signIn(token) {
  localStorage.setItem('vault_token', token);
  store.set('token', token);
  api.clearTokenCache();
}

test('every media URL carries the media token, never the sign-in token', async () => {
  const access = signInToken('s1');
  signIn(access);
  assert.equal(await api.ensureMediaToken(), 'media-1');
  const mediaCall = requests.find(r => r.url.endsWith('/api/auth/media-token'));
  assert.equal(mediaCall.auth, `Bearer ${access}`, 'the media token is fetched with the sign-in token in the header');

  const urls = [
    api.getStreamUrl('a'), api.getDownloadUrl('a'), api.getCoverUrl('a', 'small'), api.getBackdropUrl('a'),
    api.getThumbnailUrl('a', 5), api.getTranscodeUrl('a'), api.getAudioTranscodeUrl('a', 'aac', 3),
    api.getSubtitleUrl('a', 'en'), api.comicPageUrl('a', 1), api.playlistCoverUrl('p'), api.exportPlaylistUrl('p'),
    api.trailerUrl('a'), api.extraUrl('a', 0), api.hlsMasterUrl('a'), api.getEventsUrl(),
    api.liveStreamUrl('/api/livetv/stream/s1/index.m3u8'), api.withMediaToken('/api/media/trickplay/a/0'),
  ];
  for (const url of urls) {
    const token = new URL(url).searchParams.get('token');
    assert.equal(token, 'media-1', url);
    assert.ok(!url.includes(encodeURIComponent(access)) && !url.includes(access), `no sign-in token in ${url}`);
  }
  assert.equal(api.withMediaToken('https://elsewhere.example/x.jpg'), 'https://elsewhere.example/x.jpg', 'never sent to another host');
});

test('the media token is reused, renewed when old, and replaced for another session', async () => {
  const before = issued;
  assert.equal(await api.ensureMediaToken(), `media-${before}`, 'still fresh: no new request');
  assert.equal(issued, before);

  // Less than 4 hours left: renewed.
  const saved = JSON.parse(localStorage.getItem('vault_media_token'));
  api._media = { ...saved, expiresAt: Date.now() + 60 * 60 * 1000 };
  assert.equal(await api.ensureMediaToken(), `media-${before + 1}`);

  // Another session (sign-out and in again, or another account): a new media token.
  signIn(signInToken('s2'));
  assert.equal(api._currentMediaToken(), null, "the old session's media token is not used");
  assert.equal(await api.ensureMediaToken(), `media-${before + 2}`);
  assert.equal(new URL(api.getStreamUrl('a')).searchParams.get('token'), `media-${before + 2}`);

  // Signed out: nothing is kept.
  localStorage.removeItem('vault_token');
  store.set('token', null);
  api.clearTokenCache();
  assert.equal(await api.ensureMediaToken(), null);
  assert.equal(localStorage.getItem('vault_media_token'), null);
});
