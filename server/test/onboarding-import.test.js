/**
 * Setup wizard → "Import from another Vault". The setup screen covers the
 * whole page, so the import used to open in a dialog hidden behind it and
 * the button looked dead. It now opens inside the wizard. Runs the real
 * module in jsdom against a fake /api.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
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
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', basePath: '' };

let reachable = true;
const calls = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  calls.push(`${options.method || 'GET'} ${u.pathname}`);
  if (!reachable) throw new TypeError('Failed to fetch');
  if (u.pathname === '/api/setup/status') return json(200, { needsSetup: true, hasConfig: false });
  if (u.pathname === '/api/health') return json(200, { status: 'ok', version: '3.0.0', library: { total: 0 } });
  if (u.pathname === '/api/transfer') return json(200, { setupMode: true, job: null, defaults: { mediaDir: '/Users/sam/Vault/media' } });
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(20); // eslint-disable-line no-await-in-loop
  return check();
}

async function freshWizard() {
  const { OnboardingManager } = await import(docs('onboarding.js'));
  const wizard = new OnboardingManager();
  await wizard.init();
  wizard.render(document.getElementById('app'));
  return wizard;
}

test('the setup screen keeps toasts and dialogs in front of it', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'css', 'onboarding.css'), 'utf8');
  const gate = Number(css.match(/\.onboarding-gate\s*{[^}]*z-index:\s*(\d+)/)[1]);
  const toastZ = Number(css.match(/:has\(\.onboarding-gate\)\s*\.toast-container\s*{\s*z-index:\s*(\d+)/)[1]);
  const modalZ = Number(css.match(/:has\(\.onboarding-gate\)\s*\.modal-backdrop\s*{\s*z-index:\s*(\d+)/)[1]);
  assert.ok(toastZ > gate && modalZ > gate);
});

test('"Import from another Vault" opens the import form inside the wizard', async () => {
  const wizard = await freshWizard();
  const button = $('#onboarding-secondary');
  assert.equal(button.style.display, 'inline-flex');
  assert.match(button.textContent, /Import from another Vault/);

  button.click();
  await tick(60);
  const body = $('#onboarding-body');
  assert.ok(body.querySelector('form.transfer-form'), 'the import form is shown in the wizard');
  assert.equal(document.querySelector('.modal-backdrop'), null, 'no dialog hidden behind the setup screen');
  assert.equal($('#onboarding-title').textContent, 'Import from another Vault');
  assert.equal(body.querySelector('#tr-media-dir').value, '/Users/sam/Vault/media');
  assert.ok(calls.includes('GET /api/transfer'));
  assert.equal($('#onboarding-next').style.display, 'none', 'no "Get Started" under the import');
  assert.equal($('#onboarding-progress').hidden, true);

  // Keyboard shortcuts don't step the wizard underneath it.
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
  await tick();
  assert.equal(wizard.currentStep, 1);
  assert.ok(body.querySelector('form.transfer-form'));

  // Back to setup → the welcome step, with its buttons restored.
  assert.match(button.textContent, /Back to setup/);
  button.click();
  await tick();
  assert.equal(wizard.importing, false);
  assert.equal($('#onboarding-title').textContent, 'Welcome to Vault');
  assert.equal($('#onboarding-next').style.display, '');
  assert.equal($('#onboarding-progress').hidden, false);
  assert.equal(body.querySelector('form.transfer-form'), null);

  // The link in the welcome text works too.
  body.querySelector('#onboarding-import').click();
  await tick(60);
  assert.ok($('#onboarding-body form.transfer-form'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  assert.equal($('#onboarding-title').textContent, 'Welcome to Vault', 'Escape leaves the import');
});

test('not connected yet: goes to "Connect to Server", then opens the import once connected', async () => {
  reachable = false;
  const wizard = await freshWizard();
  $('#onboarding-secondary').click();
  assert.ok(await until(() => wizard.currentStep === 2), 'asks for the server first');
  assert.equal($('#onboarding-body form.transfer-form'), null);

  reachable = true;
  $('#ob-api-url').value = 'http://localhost:4000';
  $('#onboarding-next').click();
  assert.ok(await until(() => $('#onboarding-body form.transfer-form')), 'the import opens right after connecting');
  $('#onboarding-secondary').click();
  await tick();
  assert.equal(wizard.currentStep, 3, '"Back to setup" continues the normal wizard');
});
