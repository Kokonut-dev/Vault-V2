/**
 * Browser-client compatibility and diagnostics for cover uploads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const API_URL = pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', 'api.js')).href;

function missingRoute(pathname = '/missing') {
  const error = new Error('Not found');
  error.status = 404;
  error.code = 'NOT_FOUND';
  error.path = pathname;
  return error;
}

async function loadApi() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://kokonut-dev.github.io/Vault-V2/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.CustomEvent = dom.window.CustomEvent;
  window.VAULT_CONFIG = {
    apiBaseUrl: 'https://vault.example.test',
    basePath: '/Vault-V2',
  };
  const imported = await import(`${API_URL}?cover=${Date.now()}-${Math.random()}`);
  return { api: imported.api, dom };
}

test('cover API retries compatibility aliases only for a missing endpoint', async () => {
  const { api, dom } = await loadApi();
  const cover = new Blob(['image'], { type: 'image/png' });

  const albumPaths = [];
  api.request = async (pathname, options) => {
    albumPaths.push(pathname);
    assert.equal(options.method, 'POST');
    assert.ok(options.body instanceof FormData);
    if (albumPaths.length === 1) throw missingRoute(pathname);
    return { items: [{ id: 'track-1' }] };
  };
  const album = await api.uploadAlbumCover(['track-1'], cover);
  assert.deepEqual(album.items, [{ id: 'track-1' }]);
  assert.deepEqual(albumPaths, ['/api/library/albums/cover', '/api/library/cover']);

  const playlistPaths = [];
  api.request = async pathname => {
    playlistPaths.push(pathname);
    if (playlistPaths.length === 1) throw missingRoute(pathname);
    return { id: 'playlist-1' };
  };
  const playlist = await api.uploadPlaylistCover('playlist-1', cover);
  assert.equal(playlist.id, 'playlist-1');
  assert.deepEqual(playlistPaths, [
    '/api/playlists/playlist-1/cover',
    '/api/playlists/cover/playlist-1',
  ]);

  let calls = 0;
  api.request = async () => {
    calls += 1;
    const error = new Error('Playlist not found');
    error.status = 404;
    error.code = 'NOT_FOUND';
    throw error;
  };
  await assert.rejects(
    api.uploadPlaylistCover('deleted-playlist', cover),
    /Playlist not found/,
  );
  assert.equal(calls, 1, 'resource 404s must not be mistaken for missing routes');
  dom.window.close();
});

test('missing cover endpoints report an actionable server update instead of Not Found', async () => {
  const { api, dom } = await loadApi();
  const cover = new Blob(['image'], { type: 'image/png' });
  api.request = async pathname => { throw missingRoute(pathname); };

  await assert.rejects(
    api.uploadAlbumCover(['track-1'], cover),
    error => error.code === 'COVER_UPLOAD_UNAVAILABLE'
      && /\/api\/library\/albums\/cover/.test(error.message)
      && /Check that the Server URL/.test(error.message)
      && /update and restart the server/.test(error.message),
  );

  class MissingUploadXHR {
    constructor() { this.upload = {}; }
    open() {}
    setRequestHeader() {}
    send() {
      this.status = 404;
      this.responseText = JSON.stringify({
        error: 'Not found',
        code: 'NOT_FOUND',
        path: '/api/upload/music',
      });
      queueMicrotask(() => this.onload());
    }
  }
  globalThis.XMLHttpRequest = MissingUploadXHR;
  await assert.rejects(
    api.upload('music', [new Blob(['audio'], { type: 'audio/mpeg' })], { cover }),
    error => error.status === 404
      && error.code === 'UPLOAD_UNAVAILABLE'
      && /Media and cover upload/.test(error.message)
      && /\/api\/upload\/music/.test(error.message)
      && /Check that the Server URL/.test(error.message)
      && /update and restart the server/.test(error.message),
  );

  dom.window.close();
});
