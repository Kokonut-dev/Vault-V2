/**
 * The "Edit details" dialog in the browser modules (jsdom, fake /api): each
 * media type gets its own fields, only changed fields are sent, mistakes are
 * shown next to the field, and "Revert" reads the file's value again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><main id="view-container"></main></body></html>', {
  url: 'https://kokonut-dev.github.io/Vault-V2/music',
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
let putResponse = null; // (body) => [status, data]
let resetResponse = null;
let albumResponse = null;
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  const method = options.method || 'GET';
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
  requests.push({ method, path: u.pathname, body });
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (/^\/api\/library\/[^/]+\/metadata\/reset$/.test(u.pathname) && method === 'POST') {
    const [status, data] = resetResponse(body);
    return json(status, data);
  }
  if (u.pathname === '/api/library/albums/metadata' && method === 'PUT') {
    const [status, data] = albumResponse(body);
    return json(status, data);
  }
  if (u.pathname.startsWith('/api/library/') && method === 'PUT') {
    const [status, data] = putResponse(body);
    return json(status, data);
  }
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
const lastRequest = (method, prefix) => [...requests].reverse().find(r => r.method === method && r.path.startsWith(prefix));
const dialog = () => document.querySelector('.edit-details-modal');
const field = (key) => document.getElementById(`ed-${key}`);
const type = (input, value) => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); };
const submit = () => dialog().querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

test.after(() => dom.window.close());
test.afterEach(() => { document.querySelectorAll('.modal-backdrop').forEach(n => n.remove()); });

const song = () => ({
  id: 'song-1', type: 'music', title: 'Rock &amp; Roll', artist: 'Wrong Artist', albumArtist: '', album: 'Album',
  track: 2, disc: null, year: 1999, genre: 'Rock', composer: '', manualFields: ['title'],
});

test('a song gets song fields; only what changed is sent and the store is updated', async () => {
  const { store } = await import(docs('store.js'));
  const { openEditDetails } = await import(docs('components', 'editDetails.js'));
  store.set('profile', { id: 'default', isAdmin: true });
  const item = song();
  store.set('library', [item]);
  putResponse = (body) => [200, { ...item, ...body, manualFields: ['title', ...Object.keys(body)] }];

  let saved = null;
  openEditDetails(item, { onSaved: (u) => { saved = u; } });
  for (const key of ['title', 'artist', 'albumArtist', 'album', 'track', 'disc', 'year', 'genre', 'composer']) {
    assert.ok(field(key), `${key} field shown`);
  }
  assert.equal(field('contentRating'), null, 'no age rating on songs');
  assert.equal(field('season'), null, 'no TV fields on songs');
  assert.ok(document.getElementById('ed-cover'), 'cover art can be replaced');
  assert.equal(field('title').value, 'Rock & Roll', 'an old HTML-escaped value is shown as text');

  type(field('artist'), 'Right Artist');
  type(field('albumArtist'), 'Right Artist');
  type(field('year'), '2001');
  type(field('disc'), '1');
  submit();
  await until(() => saved);

  const put = lastRequest('PUT', '/api/library/song-1');
  assert.deepEqual(put.body, { title: 'Rock & Roll', artist: 'Right Artist', albumArtist: 'Right Artist', year: 2001, disc: 1 });
  assert.equal(store.get('library')[0].artist, 'Right Artist');
  assert.equal(dialog(), null, 'dialog closed after saving');
});

test('nothing changed: Save just closes without a request', async () => {
  const { openEditDetails } = await import(docs('components', 'editDetails.js'));
  const before = requests.length;
  openEditDetails({ ...song(), title: 'Plain' });
  submit();
  await until(() => !dialog());
  assert.equal(requests.length, before);
});

test('mistakes are shown next to the field, by the client and from the server', async () => {
  const { openEditDetails } = await import(docs('components', 'editDetails.js'));
  const before = requests.length;
  openEditDetails(song());
  type(field('title'), '   ');
  type(field('year'), '1500');
  submit();
  await tick(20);
  assert.equal(requests.length, before, 'not sent');
  assert.match(document.getElementById('ed-title-error').textContent, /can’t be empty/);
  assert.match(document.getElementById('ed-year-error').textContent, /1800 to 2100/);
  assert.equal(field('year').getAttribute('aria-invalid'), 'true');

  type(field('title'), 'Fine');
  assert.equal(document.getElementById('ed-title-error'), null, 'typing clears the message');
  type(field('year'), '2000');
  putResponse = () => [400, { error: 'Genre is odd', code: 'INVALID_METADATA', fields: { genre: 'Genre is odd' } }];
  type(field('genre'), 'Odd');
  submit();
  await until(() => document.getElementById('ed-genre-error'));
  assert.match(document.getElementById('ed-genre-error').textContent, /Genre is odd/);
  assert.ok(dialog(), 'stays open to fix it');
});

test('a hand-edited field shows Edited + Revert, which reads the file value back', async () => {
  const { openEditDetails } = await import(docs('components', 'editDetails.js'));
  const item = song();
  resetResponse = (body) => [200, { ...item, title: 'file name title', manualFields: [] , _asked: body }];
  let saved = 0;
  openEditDetails(item, { onSaved: () => { saved++; } });
  const status = dialog().querySelector('[data-status="title"]');
  assert.match(status.textContent, /Edited/);
  assert.equal(dialog().querySelector('[data-status="artist"]').textContent.trim(), '', 'untouched fields have no marker');
  assert.equal(dialog().querySelector('[data-revert-all]').hidden, false);

  status.querySelector('[data-revert="title"]').click();
  await until(() => field('title').value === 'file name title');
  assert.deepEqual(lastRequest('POST', '/api/library/song-1/metadata/reset').body, { fields: ['title'] });
  assert.equal(dialog().querySelector('[data-status="title"]').textContent.trim(), '');
  assert.equal(dialog().querySelector('[data-revert-all]').hidden, true, 'nothing left to revert');
  assert.equal(saved, 1, 'the view behind is told');
});

test('each media type gets its own fields; age rating only for admins; Kids profiles can’t edit', async () => {
  const { store } = await import(docs('store.js'));
  const { fieldsFor, canEditDetails, openEditDetails } = await import(docs('components', 'editDetails.js'));
  const keys = (type) => fieldsFor({ type }).map(f => f.key).filter(Boolean);
  assert.deepEqual(keys('movie').filter(k => ['seriesTitle', 'season', 'episode'].includes(k)), ['seriesTitle', 'season', 'episode']);
  assert.ok(keys('comic').includes('series') && keys('comic').includes('issue') && keys('comic').includes('author'));
  assert.ok(keys('audiobook').includes('narrator'));
  assert.ok(keys('podcast').includes('album'));
  assert.ok(keys('video').includes('description') && !keys('video').includes('season'));

  store.set('profile', { id: 'default', isAdmin: true });
  openEditDetails({ id: 'm1', type: 'movie', title: 'Heat', seriesKey: 'heat', season: 1, episode: 1 });
  assert.ok(field('contentRating'), 'admins can set the age rating');
  assert.equal(field('season').value, '1');
  assert.match(field('seriesTitle').placeholder, /heat/);
  document.querySelectorAll('.modal-backdrop').forEach(n => n.remove());

  store.set('profile', { id: 'p2', isAdmin: false });
  openEditDetails({ id: 'm1', type: 'movie', title: 'Heat' });
  assert.equal(field('contentRating'), null, 'not for other profiles');
  assert.equal(canEditDetails(), true);
  store.set('profile', { id: 'kid', isAdmin: false, kids: true, maxRating: 9 });
  assert.equal(canEditDetails(), false);
  store.set('profile', { id: 'default', isAdmin: true });
});

test('Edit album writes album artist and year to every track and the header shows the album artist', async () => {
  const { store } = await import(docs('store.js'));
  const { renderDetail } = await import(docs('views', 'detail.js'));
  store.set('profile', { id: 'default', isAdmin: true });
  const tracks = [
    { id: 'a1', type: 'music', title: 'One', artist: 'Singer', album: 'Duets', track: 1, year: 2010, duration: 60, filename: 'one.mp3', path: '/m/one.mp3' },
    { id: 'a2', type: 'music', title: 'Two', artist: 'Guest', album: 'Duets', track: 2, year: 2010, duration: 60, filename: 'two.mp3', path: '/m/two.mp3' },
  ];
  store.setLibrary(tracks.map(t => ({ ...t })));
  albumResponse = (body) => [200, { items: tracks.map(t => ({ ...t, ...body, ids: undefined })) }];
  const container = document.getElementById('view-container');
  await renderDetail(container, 'a1');
  assert.match(container.querySelector('.album-header-sub').textContent, /Various Artists/);

  (await until(() => container.querySelector('#edit-album-btn'))).click();
  const artist = document.getElementById('album-artist');
  assert.equal(artist.value, '', 'tracks disagree on the artist');
  assert.equal(artist.placeholder, 'Mixed');
  assert.equal(document.getElementById('album-year').value, '2010', 'shared value prefilled');

  document.getElementById('album-albumArtist').value = 'Singer & Friends';
  document.getElementById('album-year').value = '2011';
  document.getElementById('album-save').click();
  await until(() => lastRequest('PUT', '/api/library/albums/metadata'));
  const sent = lastRequest('PUT', '/api/library/albums/metadata').body;
  assert.deepEqual(sent, { ids: ['a1', 'a2'], albumArtist: 'Singer & Friends', year: 2011 }, 'a mixed field left empty is not sent');
  await until(() => /Singer & Friends/.test(container.querySelector('.album-header-sub')?.textContent || ''));
});
