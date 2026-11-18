/**
 * The theme picked in the setup wizard must survive "Enter Vault". The app
 * starts with themeManager.init(), which used to read the store's copy of the
 * theme — loaded with the page, before the wizard ran — and put it back.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="app"></div></body></html>', {
  url: 'http://localhost:4000/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', basePath: '' };
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/setup/status') return json({ needsSetup: true, hasConfig: false });
  if (u.pathname === '/api/health') return json({ status: 'ok', version: '3.0.0' });
  return json({});
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test('a theme picked in the setup wizard is still there when the app starts', async () => {
  // First visit: nothing saved, so the page loads with the default theme and
  // the store caches that.
  const { store } = await import(docs('store.js'));
  const { themeManager } = await import(docs('themes.js'));
  const { OnboardingManager } = await import(docs('onboarding.js'));
  assert.equal(store.get('theme'), 'dark');

  const wizard = new OnboardingManager();
  assert.equal(wizard.data.theme, 'dark', 'starts from the theme on screen');
  wizard.render(document.getElementById('app'));
  wizard.currentStep = 5;
  wizard.renderStep();
  await tick();
  document.querySelector('[data-theme-option="warm"]').click();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'warm', 'applied live');
  assert.equal(localStorage.getItem('vault_theme'), 'warm');
  assert.equal(store.get('theme'), 'warm', 'the store knows too');

  // "Enter Vault" → index.html's initApp() → themeManager.init().
  themeManager.init();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'warm');
  assert.equal(localStorage.getItem('vault_theme'), 'warm');
});

test('init prefers the newest saved theme over the copy loaded with the page', async () => {
  const { store } = await import(docs('store.js'));
  const { ThemeManager } = await import(docs('themes.js'));
  store.state.theme = 'dark'; // stale copy, as if read before something else saved a theme
  localStorage.setItem('vault_theme', 'cold');
  new ThemeManager().init();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'cold');
  assert.equal(store.get('theme'), 'cold');

  localStorage.setItem('vault_theme', 'not-a-theme');
  store.state.theme = 'light';
  new ThemeManager().init();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light', 'ignores junk in storage');
});
