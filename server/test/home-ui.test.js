/**
 * The Home screen in the browser modules (jsdom, fake /api): an empty
 * library shows the getting-started welcome, a stocked one shows the hero,
 * library tiles, per-type "new" rows, next up and "your week", and the
 * library arriving after the first paint re-draws the page.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><main id="view-container"></main></body></html>', {
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
globalThis.Event = dom.window.Event;
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };
localStorage.setItem('vault_token', 'test-token');

const requests = [];
let nextUp = { items: [] };
let recap = { summary: {} };
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  requests.push({ method: options.method || 'GET', path: u.pathname, search: u.search });
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/series/next-up') return json(200, nextUp);
  if (u.pathname === '/api/extras/stats/recap') return json(200, recap);
  if (u.pathname === '/api/library/scan') return json(200, { message: 'ok' });
  if (u.pathname === '/api/library') return json(200, { items: [] });
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await tick(10);
  }
  throw new Error('timed out');
}

test.after(() => dom.window.close());

const day = (n) => new Date(Date.UTC(2026, 10, n)).toISOString();
const library = () => [
  { id: 'f1', type: 'movie', title: 'Small Hours', year: 2020, genre: 'Romance', addedAt: day(10), posterPath: '/p.jpg', backdropPath: '/b.jpg', rating: 8 },
  { id: 'f2', type: 'movie', title: 'Long Days', year: 2019, genre: 'Romance', addedAt: day(9), rating: 7 },
  { id: 'f3', type: 'movie', title: 'Night Bus', genre: 'Romance', addedAt: day(3) },
  { id: 'f4', type: 'movie', title: 'Harbour', genre: 'Romance', addedAt: day(2) },
  { id: 'f5', type: 'movie', title: 'Kiln', genre: 'Romance', addedAt: day(1) },
  { id: 'e1', type: 'movie', title: 'Pilot', seriesKey: 'the-show', seriesTitle: 'The Show', season: 1, episode: 1, addedAt: day(12) },
  { id: 'e2', type: 'movie', title: 'Second', seriesKey: 'the-show', seriesTitle: 'The Show', season: 1, episode: 2, addedAt: day(12) },
  { id: 'e3', type: 'movie', title: 'Other Pilot', seriesKey: 'other', seriesTitle: 'Other', season: 1, episode: 1, addedAt: day(4) },
  { id: 's1', type: 'music', title: 'Sunday, Late', artist: 'Wren', album: 'Slow Weather', addedAt: day(15) },
  { id: 's2', type: 'music', title: 'Wool Coat', artist: 'Wren', album: 'Slow Weather', addedAt: day(15) },
  { id: 's3', type: 'music', title: 'Lower Deck', artist: 'The Lanterns', album: 'Night Ferry', addedAt: day(14) },
];

test('helpers: tiles count shows once per series, rows group by type, newest type first', async () => {
  const home = await import(docs('views', 'home.js'));
  const tiles = home.libraryTiles(library());
  assert.deepEqual(tiles.map(t => [t.key, t.count]), [['films', 5], ['shows', 2], ['music', 3]]);
  assert.equal(tiles.find(t => t.key === 'shows').countLabel, '2 shows');
  assert.equal(home.librarySummary(tiles), '5 films · 3 songs · 2 shows');

  const sorted = [...library()].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  const groups = home.recentlyAddedGroups(sorted);
  assert.deepEqual(groups.map(g => g.key), ['music', 'shows', 'films'], 'ordered by newest arrival');
  assert.deepEqual(groups.find(g => g.key === 'music').items.map(i => i.id), ['s1', 's3'], 'one song per album');
  assert.deepEqual(groups.find(g => g.key === 'shows').items.map(i => i.id), ['e1', 'e3'], 'newest episode per show');
  assert.equal(groups.find(g => g.key === 'films').title, 'New films');

  const history = [
    { itemId: 'f2', progress: 40, watchedAt: day(16) },
    { itemId: 's1', progress: 50, watchedAt: day(16) },
    { itemId: 'f1', progress: 99, watchedAt: day(15) },
    { itemId: 'f2', progress: 20, watchedAt: day(14) },
  ];
  assert.deepEqual(home.continueItems(library(), history).map(i => [i.id, i.progress]), [['f2', 40]],
    'finished, duplicate and music entries are left out');
  assert.deepEqual(home.recentMusic(library(), history).map(i => i.id), ['s1']);
  assert.deepEqual(home.similarItems(library(), library()[0], { playedIds: new Set(['f2']) }).map(i => i.id),
    ['f3', 'f4', 'f5', 'f2'], 'same genre, unplayed first, never the seed itself');
  assert.equal(home.isEpisode(library()[5]), true);
  assert.equal(home.isFilm(library()[5]), false);
  assert.equal(home.greeting(new Date(2026, 0, 1, 9)), 'Good morning');
  assert.equal(home.greeting(new Date(2026, 0, 1, 21)), 'Good evening');
});

test('helpers: "your week" shows totals, a split and seven bars; nothing played says so', async () => {
  const { weekHtml } = await import(docs('views', 'home.js'));
  assert.match(weekHtml({ summary: { totalSeconds: 0 } }), /Nothing played this week yet/);
  const daily = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-1${i}`, seconds: i * 600 }));
  const html = weekHtml({ summary: { totalSeconds: 5400, activeDays: 3, watchSeconds: 3600, listenSeconds: 1800, videoItems: 2, musicTracks: 5 }, watching: { daily } });
  const host = document.createElement('div');
  host.innerHTML = html;
  assert.equal(host.querySelector('.home-week-number').textContent, '1 h 30 min');
  assert.match(host.textContent, /played on 3 days/);
  assert.equal(host.querySelectorAll('.home-week-bars > li').length, 7);
  assert.deepEqual([...host.querySelectorAll('.home-week-split dd')].map(d => d.textContent), ['1 h', '30 min', '7']);
});

test('an empty library shows the welcome with three steps; Scan now calls the server', async () => {
  const { store } = await import(docs('store.js'));
  const { renderHome } = await import(docs('views', 'home.js'));
  store.set('profile', { id: 'p1', name: 'Sam', isAdmin: true });
  store.set('library', []);
  store.set('history', []);
  const view = document.getElementById('view-container');
  renderHome(view);
  await until(() => view.querySelector('.home-welcome'));
  assert.match(view.querySelector('.home-title').textContent, /, Sam$/);
  assert.equal(view.querySelector('#home-summary').textContent, 'Your vault is ready for its first files');
  assert.equal(view.querySelectorAll('.home-welcome .home-step').length, 3);
  assert.equal(view.querySelector('.hero'), null, 'no hero without media');
  assert.equal(view.querySelector('[data-surprise]'), null, 'no "Surprise me" without media');
  assert.ok(view.querySelector('.home-welcome a[data-route="/upload"]'));
  view.querySelector('[data-start-scan]').click();
  await until(() => requests.some(r => r.method === 'POST' && r.path === '/api/library/scan'));

  store.set('profile', { id: 'p2', name: 'Kid', isAdmin: false });
  renderHome(view);
  await until(() => view.querySelector('.home-welcome'));
  assert.equal(view.querySelectorAll('.home-welcome .home-step').length, 1, 'a non-admin profile cannot add files');
  assert.match(view.querySelector('.home-welcome').textContent, /Ask whoever runs this Vault/);
});

test('a stocked library: hero resumes, tiles link to libraries, rows and panels render', async () => {
  const { store } = await import(docs('store.js'));
  const { renderHome } = await import(docs('views', 'home.js'));
  store.set('profile', { id: 'p1', name: 'Sam', isAdmin: true });
  store.set('library', library());
  store.set('history', [{ itemId: 'f2', progress: 40, watchedAt: day(16) }, { itemId: 's3', progress: 100, watchedAt: day(15) }, { itemId: 's1', progress: 100, watchedAt: day(14) }]);
  store.set('favourites', ['s3']);
  nextUp = { items: [{ ...library()[6], showTitle: 'The Show' }] };
  recap = { summary: { totalSeconds: 3600, activeDays: 1, watchSeconds: 3600, listenSeconds: 0 }, watching: { daily: [{ date: '2026-11-17', seconds: 3600 }] } };

  const view = document.getElementById('view-container');
  renderHome(view);
  await until(() => view.querySelector('.hero'));
  assert.equal(view.querySelector('#home-summary').textContent, '5 films · 3 songs · 2 shows in your vault');
  assert.equal(view.querySelector('.hero-overline').textContent, 'Continue watching');
  assert.equal(view.querySelector('.hero-title').textContent, 'Long Days');
  assert.equal(view.querySelector('[data-hero-play]').textContent.trim(), 'Resume');
  assert.deepEqual([...view.querySelectorAll('.home-library')].map(a => a.dataset.route), ['/movies', '/shows', '/music']);

  const rows = () => [...view.querySelectorAll('.home-row')].map(r => r.dataset.row);
  await until(() => rows().includes('next-up'));
  assert.deepEqual(rows(), ['continue', 'next-up', 'recent-music', 'similar', 'recent', 'favourites'],
    'a small library gets one mixed "Recently added" row');
  assert.equal(view.querySelector('[data-row="similar"] .home-row-title').textContent, 'More like Long Days');
  assert.deepEqual([...view.querySelectorAll('[data-row="recent"] .media-card')].map(c => c.dataset.id).slice(0, 4), ['s1', 's3', 'e1', 'f1']);
  // Episode cards lead with the show.
  const episodeCard = view.querySelector('[data-row="recent"] .media-card[data-id="e1"]');
  assert.equal(episodeCard.querySelector('.media-card-title').textContent, 'The Show');
  assert.equal(episodeCard.querySelector('.media-card-meta').textContent, 'S1 · E1 · Pilot');
  assert.equal(view.querySelector('[data-row="top-rated"]'), null, 'top rated needs at least four rated titles');
  assert.ok(view.querySelector('.home-start'), 'a small library keeps the getting-started tips');
  await until(() => view.querySelector('.home-week-number'));
  assert.equal(view.querySelector('.home-week-number').textContent, '1 h');

  // Play on a song plays it inside its row as the queue.
  let played = null;
  window.addEventListener('vault:play', (e) => { played = e.detail; }, { once: true });
  view.querySelector('[data-row="recent-music"] .media-card-play').click();
  assert.equal(played.item.id, 's3');
  assert.deepEqual(played.queue.map(i => i.id), ['s3', 's1']);

  // Clicking a card opens its details.
  let opened = null;
  window.addEventListener('vault:open-detail', (e) => { opened = e.detail.item; }, { once: true });
  view.querySelector('[data-row="favourites"] .media-card').click();
  assert.equal(opened.id, 's3');
});

test('a bigger library gets one "new" row per media type, newest type first', async () => {
  const { store } = await import(docs('store.js'));
  const { renderHome } = await import(docs('views', 'home.js'));
  const extra = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, type: 'video', title: `Clip ${i}`, addedAt: day(1) }));
  store.set('library', [...library(), ...extra]);
  store.set('history', []);
  store.set('favourites', []);
  nextUp = { items: [] };
  const view = document.getElementById('view-container');
  renderHome(view);
  await until(() => view.querySelector('[data-row^="new-"]'));
  assert.deepEqual([...view.querySelectorAll('.home-row')].map(r => r.dataset.row), ['new-music', 'new-shows', 'new-films', 'new-videos']);
  assert.equal(view.querySelector('[data-row="new-films"] .home-row-all').dataset.route, '/movies');
  assert.ok(view.querySelector('.home-shortcuts'), 'past the first steps the getting-started panel gives way to shortcuts');
  assert.equal(view.querySelector('.home-start'), null);
});

test('the library arriving after the first paint replaces the welcome', async () => {
  const { store } = await import(docs('store.js'));
  const { renderHome } = await import(docs('views', 'home.js'));
  store.set('library', []);
  store.set('history', []);
  const view = document.getElementById('view-container');
  renderHome(view);
  await until(() => view.querySelector('.home-welcome'));
  store.set('library', library());
  await until(() => view.querySelector('.hero'));
  assert.equal(view.querySelector('.home-welcome'), null);
  assert.equal(view.querySelector('.hero-overline').textContent, 'Newly added');
  assert.equal(view.querySelector('.hero-title').textContent, 'Small Hours', 'newest film with a backdrop');
});

test('opened before the first library response: the skeleton stays (no empty-vault flash), then the library draws at once', async () => {
  const { store } = await import(docs('store.js'));
  const { renderHome } = await import(docs('views', 'home.js'));
  // As at start-up: nothing has set the library yet.
  store.libraryLoaded = false;
  store.state.library = [];
  store.set('history', []);
  const view = document.getElementById('view-container');
  renderHome(view);
  await new Promise(r => setTimeout(r, 300));
  assert.ok(view.querySelector('#home-content[aria-busy="true"] .skeleton'), 'the skeleton is still up');
  assert.equal(view.querySelector('.home-welcome'), null, 'no "ready for its first files" while loading');
  assert.equal(view.querySelector('#home-summary').textContent, 'Loading your library…');
  const at = Date.now();
  store.set('library', library());
  await until(() => view.querySelector('.hero'));
  assert.ok(Date.now() - at < 200, 'the first library replaces the skeleton without the 250 ms batching delay');
  assert.equal(view.querySelector('#home-content').hasAttribute('aria-busy'), false);
});
