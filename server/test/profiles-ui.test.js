/**
 * Profiles page and profile session in the browser modules (jsdom, fake
 * /api): the page trusts the server's activeProfileId, the editor sends the
 * fields each kind of profile may change, and a device never shows one
 * profile's favourites/history to another.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><main id="view-container"></main></body></html>', {
  url: 'https://kokonut-dev.github.io/Vault-V2/profiles',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };
localStorage.setItem('vault_token', 'test-token');

let profileData = null;
let serverFavourites = [];
let serverHistory = [];
const requests = [];
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : undefined;
  requests.push({ method, path: u.pathname, body });
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/profiles' && method === 'GET') return json(200, profileData);
  if (u.pathname === '/api/profiles' && method === 'POST') return json(200, { id: 'p_new', ...body, hasPin: !!body.pin });
  if (u.pathname.startsWith('/api/profiles/') && method === 'PUT') {
    const id = u.pathname.split('/').pop();
    return json(200, { ...profileData.profiles.find(p => p.id === id), ...body });
  }
  if (u.pathname === '/api/playlists/favourites') return json(200, { items: serverFavourites });
  if (u.pathname === '/api/playlists/history') return json(200, { history: serverHistory });
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

const PROFILES = () => ([
  { id: 'default', name: 'Sam', isAdmin: true, color: '#5B87C9', maxRating: null, allowUnrated: true },
  { id: 'p_kid', name: 'Robin <i>', isAdmin: false, kids: true, maxRating: 9, allowUnrated: false, hasPin: true, avatar: '🦊', color: '#4D9A8C' },
]);

test.after(() => dom.window.close());

test('the page uses the server’s activeProfileId, not a stale local value', async () => {
  const { store } = await import(docs('store.js'));
  const { renderProfiles } = await import(docs('views', 'profiles.js'));
  const container = document.getElementById('view-container');

  store.set('profileId', 'default'); // stale: this device switched elsewhere
  profileData = { activeProfileId: 'p_kid', profiles: PROFILES() };
  await renderProfiles(container);

  assert.equal(container.querySelector('.profile-card.current')?.dataset.profile, 'p_kid');
  assert.equal(container.querySelector('#profile-new'), null, 'a Kids profile gets no admin controls');
  assert.equal(container.querySelector('.profile-manage'), null);
  assert.ok(container.querySelector('.profile-self [data-edit="p_kid"]'), 'but can edit itself');
  assert.equal(store.get('profileId'), 'p_kid', 'the store is corrected');
  assert.equal(localStorage.getItem('vault_last_profile'), 'p_kid');

  const meta = container.querySelector('[data-profile="p_kid"] .profile-meta').textContent;
  assert.equal(meta, 'Kids · Up to 9 · PIN');
  assert.doesNotMatch(container.textContent, /\d+ items/, 'no made-up item counts');
  assert.match(container.querySelector('[data-profile="p_kid"] .profile-name').innerHTML, /Robin &lt;i&gt;/);
});

test('admins edit age limits; Kids switches on a limit and hides unrated films', async () => {
  const { renderProfiles } = await import(docs('views', 'profiles.js'));
  const container = document.getElementById('view-container');
  profileData = { activeProfileId: 'default', profiles: PROFILES(), ageLimits: [{ age: 0, label: 'All ages' }, { age: 9, label: 'Up to 9' }, { age: 12, label: 'Up to 12' }] };
  await renderProfiles(container);

  container.querySelector('[data-edit="p_kid"]').click();
  const form = await until(() => document.querySelector('.profile-editor'));
  assert.equal(form.elements.kids.checked, true);
  assert.equal(form.elements.maxRating.value, '9');
  assert.equal(form.elements.allowUnrated.checked, false);
  assert.ok(form.querySelector('input[name="avatar"][value="🦊"]').checked);

  form.elements.maxRating.value = '12';
  form.elements.allowUnrated.checked = true;
  form.elements.name.value = 'Robin';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => !document.querySelector('.profile-editor'));
  const put = lastRequest('PUT', '/api/profiles/p_kid');
  assert.deepEqual(
    { name: put.body.name, kids: put.body.kids, maxRating: put.body.maxRating, allowUnrated: put.body.allowUnrated },
    { name: 'Robin', kids: true, maxRating: 12, allowUnrated: true },
  );
  assert.equal(put.body.pin, undefined, 'an empty PIN field keeps the PIN');

  // Create a Kids profile.
  await until(() => container.querySelector('#profile-new'));
  container.querySelector('#profile-new').click();
  const create = await until(() => document.querySelector('.profile-editor'));
  create.elements.name.value = 'Mo';
  create.elements.kids.checked = true;
  create.elements.kids.dispatchEvent(new window.Event('change'));
  assert.equal(create.elements.maxRating.value, '9', 'Kids picks a limit');
  assert.equal(create.elements.allowUnrated.checked, false);
  create.elements.pin.value = '12';
  create.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await tick(10);
  assert.match(create.querySelector('[data-error]').textContent, /4 to 8 digits/, 'checked before sending');
  create.elements.pin.value = '4321';
  create.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => !document.querySelector('.profile-editor'));
  const post = lastRequest('POST', '/api/profiles');
  assert.deepEqual(
    { name: post.body.name, kids: post.body.kids, maxRating: post.body.maxRating, allowUnrated: post.body.allowUnrated, pin: post.body.pin },
    { name: 'Mo', kids: true, maxRating: 9, allowUnrated: false, pin: '4321' },
  );
});

test('non-admins edit only their own name, picture, colour and PIN', async () => {
  const { renderProfiles } = await import(docs('views', 'profiles.js'));
  const container = document.getElementById('view-container');
  profileData = { activeProfileId: 'p_kid', profiles: PROFILES() };
  await renderProfiles(container);

  container.querySelector('[data-edit="p_kid"]').click();
  const form = await until(() => document.querySelector('.profile-editor'));
  assert.equal(form.elements.kids, undefined, 'no age-limit controls');
  assert.equal(form.elements.maxRating, undefined);
  assert.ok(form.elements.currentPin, 'changing an existing PIN asks for the current one');
  form.elements.pin.value = '8642';
  form.elements.currentPin.value = '1111';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => !document.querySelector('.profile-editor'));
  const put = lastRequest('PUT', '/api/profiles/p_kid');
  assert.equal(put.body.pin, '8642');
  assert.equal(put.body.currentPin, '1111');
  for (const key of ['kids', 'maxRating', 'allowUnrated', 'isAdmin']) assert.equal(put.body[key], undefined, key);
});

test('a device never shows another profile’s favourites or history', async () => {
  const { store } = await import(docs('store.js'));
  const { hydrateProfileData, prepareProfileSwitch } = await import(docs('profileSession.js'));

  // Cached data on this device belongs to the owner.
  localStorage.setItem('vault_data_profile', 'default');
  store.set('favourites', ['owner-fav'], true);
  store.set('history', [{ itemId: 'owner-film', progress: 40, watchedAt: '2026-11-01T10:00:00Z' }], true);

  serverFavourites = [{ id: 'kid-fav' }];
  serverHistory = [{ itemId: 'cartoon', progress: 20, watchedAt: '2026-11-02T10:00:00Z' }];
  await hydrateProfileData('p_kid');
  assert.deepEqual(store.get('favourites'), ['kid-fav']);
  assert.deepEqual(store.get('history').map(h => h.itemId), ['cartoon']);
  assert.equal(localStorage.getItem('vault_data_profile'), 'p_kid');

  // Same profile again: a newer local resume point wins over the server's.
  store.set('history', [{ itemId: 'cartoon', progress: 70, watchedAt: '2026-11-03T10:00:00Z' }], true);
  await hydrateProfileData('p_kid');
  assert.equal(store.get('history')[0].progress, 70);

  // Switching away clears the device caches before the reload.
  store.set('queue', [{ id: 'cartoon' }], true);
  prepareProfileSwitch({ id: 'default' }, 'new-token');
  assert.deepEqual(store.get('favourites'), []);
  assert.deepEqual(store.get('queue'), []);
  assert.equal(localStorage.getItem('vault_favourites'), null);
  assert.equal(localStorage.getItem('vault_token'), 'new-token');
  assert.equal(localStorage.getItem('vault_last_profile'), 'default');
});
