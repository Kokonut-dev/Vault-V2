/**
 * What a person sees when they can't edit server settings, and the
 * Profiles page's admin controls. Runs the real browser modules in jsdom
 * against a fake /api.
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
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };
localStorage.setItem('vault_token', 'test-token');

let profileData = null;
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  calls.push(`${options.method || 'GET'} ${u.pathname}`);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/profiles' && (!options.method || options.method === 'GET')) return json(200, profileData);
  if (u.pathname.startsWith('/api/profiles/') && options.method === 'PUT') {
    return json(400, { error: 'Vault needs at least one admin profile. Make another profile an admin first.', code: 'LAST_ADMIN' });
  }
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

test('read-only notice explains an outdated server instead of blaming admin rights', async () => {
  const { readOnlyNotice } = await import(docs('views', 'settings', 'server.js'));
  const message = await readOnlyNotice({ status: 404 });
  assert.match(message, /older version/);
  assert.match(message, /restart/);
  assert.doesNotMatch(message, /admin/i);
});

test('read-only notice names the profile in use and who the admins are', async () => {
  const { readOnlyNotice } = await import(docs('views', 'settings', 'server.js'));
  profileData = {
    activeProfileId: 'p_kid',
    profiles: [
      { id: 'default', name: 'Sam', isAdmin: true },
      { id: 'p_kid', name: 'Robin <b>', isAdmin: false, kids: true },
      { id: 'p_alex', name: 'Alex', isAdmin: true },
    ],
  };
  const message = await readOnlyNotice();
  assert.match(message, /“Robin &lt;b&gt;” profile, which isn’t an admin/, 'names are escaped');
  assert.match(message, /Switch to “Sam” or “Alex”/);
  assert.match(message, /data-route="\/profiles"/);
});

test('Profiles page: admins get Manage controls; the last-admin refusal reverts the switch', async () => {
  const { store } = await import(docs('store.js'));
  const { renderProfiles } = await import(docs('views', 'profiles.js'));
  const container = document.getElementById('view-container');

  profileData = {
    activeProfileId: 'default',
    profiles: [
      { id: 'default', name: 'Sam', isAdmin: true, itemCount: 3 },
      { id: 'p_kid', name: 'Robin', isAdmin: false, kids: true, hasPin: true },
    ],
  };
  store.set('profileId', 'default', true);
  await renderProfiles(container);

  assert.ok(container.querySelector('#profile-new'), 'admins can add profiles');
  assert.ok(container.querySelector('.profile-manage'), 'admins see Manage profiles');
  assert.match(container.querySelector('[data-profile="default"] .profile-meta').textContent, /Admin/);
  assert.match(container.querySelector('[data-profile="p_kid"] .profile-meta').textContent, /Kids · PIN/, 'reads hasPin (the server never sends pin)');

  const samSwitch = container.querySelector('[data-admin="default"]');
  assert.equal(samSwitch.getAttribute('role'), 'switch');
  assert.match(samSwitch.getAttribute('aria-label'), /^Admin rights for Sam$/);
  assert.equal(samSwitch.checked, true);
  assert.equal(container.querySelector('[data-delete="default"]').disabled, true, 'cannot delete the profile in use');

  // Turning off the only admin: the server refuses, the switch flips back.
  samSwitch.checked = false;
  samSwitch.dispatchEvent(new window.Event('change'));
  await tick(20);
  assert.ok(calls.includes('PUT /api/profiles/default'));
  assert.equal(samSwitch.checked, true);
  assert.equal(samSwitch.disabled, false);
});

test('Profiles page: non-admins see who the admins are and no management controls', async () => {
  const { store } = await import(docs('store.js'));
  const { renderProfiles } = await import(docs('views', 'profiles.js'));
  const container = document.getElementById('view-container');

  profileData = {
    activeProfileId: 'p_kid',
    profiles: [
      { id: 'default', name: 'Sam', isAdmin: true },
      { id: 'p_kid', name: 'Robin', isAdmin: false },
    ],
  };
  store.set('profileId', 'p_kid', true);
  await renderProfiles(container);

  assert.equal(container.querySelector('#profile-new'), null);
  assert.equal(container.querySelector('.profile-manage'), null);
  assert.equal(container.querySelectorAll('[data-admin]').length, 0);
  const note = container.querySelector('.profile-note').textContent.replace(/\s+/g, ' ');
  assert.match(note, /Only an admin profile can/);
  assert.match(note, /Admin profile: Sam\./);
});
