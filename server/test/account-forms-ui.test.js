/**
 * Sign-in screen: "Create a new account", "Forgot password?" and the page a
 * reset link opens (docs/js/components/accountForms.js), plus the markup in
 * docs/index.html. Runs the real module in jsdom against a fake /api.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="auth-gate"><div class="auth-container"><div id="login-step" class="auth-step active"></div></div></div></body></html>', {
  url: 'https://kokonut-dev.github.io/Vault-V2/index.html?x=1#reset=abc123abc123abc123abc123&server=http%3A%2F%2Flocalhost%3A4000',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.history = dom.window.history;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', basePath: '' };
window.confirm = () => true;

const calls = [];
const replies = {};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ path: u.pathname, method: options.method || 'GET', body });
  const reply = replies[u.pathname];
  if (typeof reply === 'function') return reply(body);
  if (reply) return json(reply.status, reply.body);
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(10); // eslint-disable-line no-await-in-loop
  return check();
}
function type(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function tapGrid(stepSel, cells) {
  const buttons = [...document.querySelectorAll(`${stepSel} .grid-picker-cell`)];
  for (const i of cells) buttons[i].click();
}
function submit(form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

let mod;
let forms;
const shown = [];
const signedIn = [];
const resetDone = [];
test.before(async () => {
  mod = await import(docs('components', 'accountForms.js'));
});

test('the sign-in page offers both links', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'index.html'), 'utf8');
  assert.match(html, /id="forgot-link"[^>]*>Forgot password\?</);
  assert.match(html, /id="signup-offer"[^>]*hidden/, 'hidden until the server says sign-up is on');
  assert.match(html, /Create a new account/);
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'js', 'main.js'), 'utf8');
  assert.match(main, /offer\.hidden = !status\?\.signup/);
  assert.match(main, /takeResetLink\(\)/);
});

test('a reset link is read from the address and removed from it at once', () => {
  const link = mod.takeResetLink();
  assert.deepEqual(link, { token: 'abc123abc123abc123abc123', server: 'http://localhost:4000' });
  assert.equal(location.hash, '');
  assert.ok(!location.href.includes('abc123'), location.href);
  assert.equal(location.search, '?x=1', 'other parameters stay');
  assert.equal(mod.takeResetLink(), null);
  assert.equal(mod.appUrl(), 'https://kokonut-dev.github.io/Vault-V2/index.html');
});

test('mounting adds the three steps', () => {
  forms = mod.mountAccountForms($('.auth-container'), {
    showStep: (name) => {
      shown.push(name);
      document.querySelectorAll('.auth-step').forEach(s => s.classList.toggle('active', s.id === `${name}-step`));
    },
    onSignedIn: (res) => signedIn.push(res),
    onResetDone: (username) => resetDone.push(username),
  });
  for (const id of ['register-step', 'forgot-step', 'reset-step']) assert.ok(document.getElementById(id), id);
});

test('"Create a new account" checks the form, then signs in', async () => {
  forms.openRegister();
  assert.equal(shown.at(-1), 'register');
  const form = $('#register-form');

  submit(form);
  await tick();
  assert.equal($('#register-username').getAttribute('aria-invalid'), 'true');
  assert.equal($('#register-email').getAttribute('aria-invalid'), 'true');
  assert.ok(!calls.some(c => c.path === '/api/auth/register'), 'nothing sent while the form is incomplete');

  type($('#register-username'), 'sam');
  type($('#register-email'), 'sam@example.com');
  type($('#register-password'), 'short');
  type($('#register-confirm'), 'short');
  submit(form);
  await tick();
  assert.equal($('#register-password').getAttribute('aria-invalid'), 'true', 'at least 8 characters');

  type($('#register-password'), 'long enough pw');
  type($('#register-confirm'), 'long enough px');
  submit(form);
  await tick();
  assert.equal($('#register-confirm').getAttribute('aria-invalid'), 'true', 'passwords must match');

  type($('#register-confirm'), 'long enough pw');
  submit(form);
  await tick();
  assert.equal($('#register-grid').getAttribute('aria-invalid'), 'true', 'grid is required');

  tapGrid('#register-step', [0, 1, 2, 3, 4, 5, 6, 7]);
  replies['/api/auth/register'] = { status: 409, body: { error: 'That username is already taken', code: 'USERNAME_TAKEN', fields: { username: 'That username is already taken' } } };
  submit(form);
  await until(() => $('#register-username').getAttribute('aria-invalid') === 'true');
  assert.match($('#register-username-error').textContent, /already taken/);

  replies['/api/auth/register'] = { status: 200, body: { token: 'tok', user: { username: 'sam2', owner: false }, profile: { id: 'p_1', name: 'sam2' }, profileCount: 1 } };
  type($('#register-username'), 'sam2');
  submit(form);
  await until(() => signedIn.length === 1);
  const sent = calls.filter(c => c.path === '/api/auth/register').at(-1).body;
  assert.deepEqual(sent.gridPattern, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(sent.username, 'sam2');
  assert.equal(sent.email, 'sam@example.com');
  assert.equal(localStorage.getItem('vault_token'), 'tok');
});

test('"Forgot password?" sends the address of this page and shows a neutral message', async () => {
  forms.openForgot('sam');
  assert.equal($('#forgot-identifier').value, 'sam');
  replies['/api/auth/recover'] = { status: 200, body: { message: 'If that matches an account, a reset link is on its way.' } };
  submit($('#forgot-form'));
  await until(() => !$('#forgot-sent').hidden);
  const sent = calls.filter(c => c.path === '/api/auth/recover').at(-1).body;
  assert.equal(sent.identifier, 'sam');
  assert.equal(sent.appUrl, 'https://kokonut-dev.github.io/Vault-V2/index.html');
  assert.equal(sent.serverUrl, 'http://localhost:4000');
  assert.match($('#forgot-sent').textContent, /on its way/);
  assert.ok($('#forgot-form').hidden);
});

test('the reset page asks for a new password and grid (and the app code when needed)', async () => {
  replies['/api/auth/recover/check'] = { status: 200, body: { valid: true, username: 'owner', owner: true, totpRequired: true } };
  await forms.openReset({ token: 'tok-reset-1234567890abcdef', server: null });
  await until(() => !$('#reset-form').hidden);
  assert.match($('#reset-subtitle').textContent, /For owner/);
  assert.equal($('#reset-totp-group').hidden, false);

  type($('#reset-password'), 'a new password');
  type($('#reset-confirm'), 'a new password');
  tapGrid('#reset-step', [8, 9, 10, 11, 12, 13, 14, 15]);
  submit($('#reset-form'));
  await tick();
  assert.equal($('#reset-totp').getAttribute('aria-invalid'), 'true', 'the authenticator code is required');

  replies['/api/auth/recover/reset'] = { status: 200, body: { message: 'ok', username: 'owner' } };
  type($('#reset-totp'), '123 456');
  submit($('#reset-form'));
  await until(() => resetDone.length === 1);
  const sent = calls.filter(c => c.path === '/api/auth/recover/reset').at(-1).body;
  assert.equal(sent.token, 'tok-reset-1234567890abcdef');
  assert.equal(sent.totpCode, '123456');
  assert.deepEqual(sent.gridPattern, [8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(resetDone[0], 'owner');
});

test('a used or expired link says so and offers a new one', async () => {
  replies['/api/auth/recover/check'] = { status: 410, body: { error: 'This reset link has expired. Ask for a new one.', code: 'RESET_EXPIRED' } };
  await forms.openReset({ token: 'expired-token-1234567890', server: null });
  await until(() => /expired/.test($('#reset-subtitle').textContent));
  assert.ok($('#reset-form').hidden);
  assert.equal($('#reset-step [data-forgot]').hidden, false);
  $('#reset-step [data-forgot]').click();
  assert.equal(shown.at(-1), 'forgot');
});
