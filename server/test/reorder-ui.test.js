/**
 * End-to-end DOM checks for album and playlist order controls.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const JS_ROOT = pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js')).href + '/';

async function waitFor(predicate, message, timeout = 1000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost:4000/music',
    pretendToBeVisual: true,
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.Event = dom.window.Event;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', basePath: '' };
  return dom;
}

const tracks = [
  { id: 't1', type: 'music', title: 'One', artist: 'Artist', album: 'Album', track: 1, duration: 60, filename: 'one.mp3', path: '/music/one.mp3' },
  { id: 't2', type: 'music', title: 'Two', artist: 'Artist', album: 'Album', track: 2, duration: 70, filename: 'two.mp3', path: '/music/two.mp3' },
  { id: 't3', type: 'music', title: 'Three', artist: 'Artist', album: 'Album', track: 3, duration: 80, filename: 'three.mp3', path: '/music/three.mp3' },
];

test('album and playlist move buttons persist and render the new order', async () => {
  const dom = installDom();
  const { store } = await import(`${JS_ROOT}store.js`);
  const { api } = await import(`${JS_ROOT}api.js`);
  const { renderDetail } = await import(`${JS_ROOT}views/detail.js`);
  const { renderPlaylists } = await import(`${JS_ROOT}views/playlists.js`);
  store.setLibrary(tracks);
  const playlist = {
    id: 'playlist-1',
    name: 'Test playlist',
    description: '',
    type: 'playlist',
    items: ['t1', 't2', 't3'],
    itemCount: 3,
    coverArt: '/cache/playlist.jpg',
  };
  let playlistPayload = null;

  // Album order -------------------------------------------------------------
  let albumIds = null;
  let unexpectedRefreshes = 0;
  // Reproduce an already-installed PWA whose cached api.js predates the named
  // reorder helpers. The views must fall back to api.request and still work.
  api.updateAlbumOrder = undefined;
  api.reorderPlaylist = undefined;
  api.getCoverUrlVersioned = undefined;
  api.playlistCoverUrl = undefined;
  api.exportPlaylistUrl = undefined;
  api.request = async (requestPath, options) => {
    const body = JSON.parse(options.body);
    if (requestPath === '/api/library/albums/order') {
      albumIds = body.ids;
      return {
        items: body.ids.map((id, index) => ({ ...tracks.find(track => track.id === id), track: index + 1 })),
        missing: [],
      };
    }
    if (requestPath === '/api/playlists/playlist-1/order') {
      playlistPayload = body;
      return { ...playlist, items: body.items, updatedAt: '2026-10-13T20:00:00.000Z' };
    }
    throw new Error(`Unexpected API request: ${requestPath}`);
  };
  api.getLibrary = async () => {
    unexpectedRefreshes += 1;
    throw new Error('album reorder should merge its mutation response');
  };

  const albumContainer = document.createElement('main');
  document.body.appendChild(albumContainer);
  await renderDetail(albumContainer, 't1');
  await waitFor(
    () => albumContainer.querySelectorAll('#track-list .media-list-item').length === 3,
    'album rows did not render',
  );
  await waitFor(
    () => albumContainer.querySelector('#track-list .media-list-item [data-move="1"]'),
    'album move buttons did not render',
  );
  albumContainer.querySelector('#track-list .media-list-item [data-move="1"]').click();
  await waitFor(() => Array.isArray(albumIds), 'album reorder API was not called');
  await waitFor(
    () => [...albumContainer.querySelectorAll('#track-list .media-list-item')].map(row => row.dataset.id).join(',') === 't2,t1,t3',
    'album did not render its saved order',
  );
  assert.deepEqual(albumIds, ['t2', 't1', 't3']);
  assert.equal(unexpectedRefreshes, 0, 'album reorder started a racing library refresh');
  assert.deepEqual(
    store.get('library').filter(track => track.album === 'Album')
      .sort((a, b) => a.track - b.track).map(track => track.id),
    ['t2', 't1', 't3'],
  );

  // Playlist order ----------------------------------------------------------
  api.getPlaylists = async () => ({ playlists: [playlist] });

  const playlistContainer = document.createElement('main');
  document.body.appendChild(playlistContainer);
  renderPlaylists(playlistContainer);
  await waitFor(() => playlistContainer.querySelector('.media-card'), 'playlist card did not render');
  playlistContainer.querySelector('.media-card').click();
  await waitFor(
    () => playlistContainer.querySelectorAll('#pl-items .media-list-item').length === 3,
    'playlist rows did not render',
  );
  await waitFor(
    () => playlistContainer.querySelector('#pl-items .media-list-item [data-move="1"]'),
    'playlist move buttons did not render',
  );
  playlistContainer.querySelector('#pl-items .media-list-item [data-move="1"]').click();
  await waitFor(() => playlistPayload, 'playlist reorder API was not called');
  await waitFor(
    () => [...playlistContainer.querySelectorAll('#pl-items .media-list-item')].map(row => row.dataset.id).join(',') === 't2,t1,t3',
    'playlist did not render its saved order',
  );
  assert.deepEqual(playlistPayload, { items: ['t2', 't1', 't3'] });

  dom.window.close();
});
