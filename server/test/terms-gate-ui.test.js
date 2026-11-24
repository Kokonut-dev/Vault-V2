/**
 * Terms of Use in the web app (components/termsGate.js, onboarding.js):
 *   - the gate can't be dismissed; "Agree" stays off until the whole text has
 *     been scrolled through and every box is ticked;
 *   - a kids' profile needs the parent/guardian box;
 *   - declining signs out; a text that changed while open is shown again;
 *   - the setup wizard (signing up) has a Terms step that must be completed
 *     and sends back exactly what was accepted;
 *   - text from the server is sanitised;
 *   - a 403 TERMS_REQUIRED from any request asks the app to show the gate.
 * Runs the real modules in jsdom against a fake /api.
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
globalThis.DOMParser = dom.window.DOMParser;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', basePath: '' };

const termsService = require('../services/terms');
const REAL = termsService.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'terms.html'), 'utf8'));

// ---------------------------------------------------------------- fake /api
const server = {
  status: null,
  terms: { version: REAL.version, effective: REAL.effective, sha256: REAL.sha256, html: REAL.html },
  acceptResponses: [],
  accepted: [],
  setupBodies: [],
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  if (u.pathname === '/api/legal/status') return json(200, server.status);
  if (u.pathname === '/api/legal/terms') return json(200, server.terms);
  if (u.pathname === '/api/legal/terms/accept' && method === 'POST') {
    server.accepted.push(body);
    const next = server.acceptResponses.shift();
    return next ? json(next.status, next.body) : json(200, { accepted: true, version: body.version });
  }
  if (u.pathname === '/api/setup/status') return json(200, { needsSetup: true, hasConfig: false });
  if (u.pathname === '/api/setup/complete' && method === 'POST') {
    server.setupBodies.push(body);
    return json(200, { message: 'ok', config: { username: body.username }, token: null, enablement: true });
  }
  if (u.pathname === '/api/auth/logout') return json(200, {});
  if (u.pathname === '/api/library') return json(403, { error: 'Please read and accept the Terms of Use to continue.', code: 'TERMS_REQUIRED', terms: { version: REAL.version } });
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const $ = (sel) => document.querySelector(sel);
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await tick(15); // eslint-disable-line no-await-in-loop
  return check();
}

/** jsdom has no layout: give the scroll box a size and scroll it to `fraction`. */
function scrollTo(scroller, fraction) {
  Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
  scroller.scrollTop = Math.round(4500 * fraction);
  scroller.dispatchEvent(new window.Event('scroll'));
}

function statusFor({ accepted = false, kids = false, acceptedVersion = null } = {}) {
  return {
    available: true, version: REAL.version, effective: REAL.effective, sha256: REAL.sha256,
    accepted, acceptedVersion, acceptedAt: null, guardianRequired: kids,
    profile: { id: kids ? 'kid' : 'default', name: kids ? 'Little one' : 'Sam', kids },
  };
}

const boxes = () => [...document.querySelectorAll('#terms-gate [data-terms-check]')];
const agreeBtn = () => $('#terms-gate [data-terms-accept]');

// ---------------------------------------------------------------- tests
test('text from the server is sanitised before it is shown', async () => {
  const { sanitizeTermsHtml } = await import(docs('components', 'termsGate.js'));
  const holder = document.createElement('div');
  holder.appendChild(sanitizeTermsHtml(`
    <h2 id="s1" onclick="alert(1)" style="color:red">Title</h2>
    <p class="legal-meta evil">Meta <a href="javascript:alert(1)">bad</a> <a href="#s1">jump</a> <a href="https://example.org/x">ok</a></p>
    <script>window.pwned = true</script><img src=x onerror="window.pwned=true"><iframe src="https://evil"></iframe>
    <custom-tag>kept text</custom-tag><ol type="a"><li>one</li></ol>`));
  const html = holder.innerHTML;
  assert.doesNotMatch(html, /script|onerror|onclick|iframe|<img|style=|javascript:|evil/i);
  assert.match(html, /<h2 id="terms-s1">Title<\/h2>/);
  assert.match(html, /<p class="legal-meta">/);
  assert.match(html, /href="#terms-s1"/);
  assert.match(html, /href="https:\/\/example.org\/x" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /kept text/);
  assert.match(html, /<ol type="a">/);
  assert.equal(window.pwned, undefined);
});

test('the gate can’t be skipped: read to the end, tick every box, then agree', async () => {
  const { ensureTermsAccepted, termsGateOpen } = await import(docs('components', 'termsGate.js'));
  server.status = statusFor();
  server.accepted = [];
  let settled = null;
  const result = ensureTermsAccepted().then(v => { settled = v; return v; });
  assert.ok(await until(() => termsGateOpen()), 'the gate is shown');

  const gate = $('#terms-gate');
  assert.equal(gate.getAttribute('role'), 'dialog');
  assert.equal(gate.getAttribute('aria-modal'), 'true');
  assert.match($('#terms-gate-title').textContent, /^Terms of Use$/);
  assert.match(gate.textContent, /sole responsibility of the User who commits it/, 'the full text is in the gate');
  assert.match(gate.textContent, /all piracy is my responsibility, not the website's, the creator's or any contributor's/);
  assert.equal(boxes().length, 2, 'no guardian box for an adult profile');
  assert.equal(agreeBtn().disabled, true);
  assert.ok(boxes().every(b => b.disabled), 'boxes are locked until the text is read');

  // Escape doesn't close it.
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick();
  assert.ok(termsGateOpen());

  const scroller = gate.querySelector('.terms-reader-scroll');
  scrollTo(scroller, 0.5);
  assert.ok(boxes().every(b => b.disabled), 'half-way is not the end');
  assert.match(gate.querySelector('.terms-reader-progress').textContent, /50% read/);
  scrollTo(scroller, 1);
  assert.ok(boxes().every(b => !b.disabled), 'unlocked at the end');
  assert.match(gate.querySelector('.terms-reader-progress').textContent, /reached the end/);

  boxes()[0].click();
  assert.equal(agreeBtn().disabled, true, 'one box is not enough');
  boxes()[1].click();
  assert.equal(agreeBtn().disabled, false);

  agreeBtn().click();
  assert.equal(await result, true);
  assert.equal(settled, true);
  assert.equal(termsGateOpen(), false);
  assert.deepEqual(server.accepted, [{ version: REAL.version, sha256: REAL.sha256, readToEnd: true, guardian: false }]);
  assert.equal(document.body.classList.contains('terms-gate-open'), false);
});

test('already accepted: no gate', async () => {
  const { ensureTermsAccepted, termsGateOpen } = await import(docs('components', 'termsGate.js'));
  server.status = statusFor({ accepted: true });
  assert.equal(await ensureTermsAccepted(), true);
  assert.equal(termsGateOpen(), false);
});

test('a kids’ profile needs the parent or guardian box; updated terms say so', async () => {
  const { ensureTermsAccepted, termsGateOpen } = await import(docs('components', 'termsGate.js'));
  server.status = statusFor({ kids: true, acceptedVersion: '0.9' });
  server.accepted = [];
  const result = ensureTermsAccepted();
  assert.ok(await until(() => termsGateOpen()));
  assert.match($('#terms-gate-title').textContent, /have been updated/);
  assert.match($('#terms-gate-intro').innerHTML, /<strong>Little one<\/strong>/);
  assert.equal(boxes().length, 3);
  assert.match(boxes()[2].closest('label').textContent, /parent or legal guardian of the person who uses Little one/);
  scrollTo($('#terms-gate .terms-reader-scroll'), 1);
  boxes()[0].click();
  boxes()[1].click();
  assert.equal(agreeBtn().disabled, true, 'not without the guardian box');
  boxes()[2].click();
  agreeBtn().click();
  assert.equal(await result, true);
  assert.equal(server.accepted[0].guardian, true);
});

test('declining resolves false; a text that changed while open is shown again', async () => {
  const { ensureTermsAccepted, termsGateOpen } = await import(docs('components', 'termsGate.js'));
  server.status = statusFor();
  const declined = ensureTermsAccepted();
  assert.ok(await until(() => termsGateOpen()));
  $('#terms-gate [data-terms-decline]').click();
  assert.equal(await declined, false);
  assert.equal(termsGateOpen(), false);

  server.accepted = [];
  server.acceptResponses = [{ status: 409, body: { error: 'The Terms of Use have changed. Please read the current version.', code: 'TERMS_OUTDATED' } }];
  const result = ensureTermsAccepted();
  assert.ok(await until(() => termsGateOpen()));
  scrollTo($('#terms-gate .terms-reader-scroll'), 1);
  boxes().forEach(b => b.click());
  agreeBtn().click();
  // Shown again from the top: boxes locked and unticked.
  assert.ok(await until(() => termsGateOpen() && boxes().every(b => b.disabled && !b.checked)), 'the gate is shown again, unread');
  scrollTo($('#terms-gate .terms-reader-scroll'), 1);
  boxes().forEach(b => b.click());
  agreeBtn().click();
  assert.equal(await result, true);
  assert.equal(server.accepted.length, 2);
});

test('a server error keeps the gate open with a message', async () => {
  const { ensureTermsAccepted, termsGateOpen } = await import(docs('components', 'termsGate.js'));
  server.status = statusFor();
  server.acceptResponses = [{ status: 500, body: { error: 'Could not record your acceptance. Please try again.', code: 'TERMS_SAVE_FAILED' } }];
  const result = ensureTermsAccepted();
  assert.ok(await until(() => termsGateOpen()));
  scrollTo($('#terms-gate .terms-reader-scroll'), 1);
  boxes().forEach(b => b.click());
  agreeBtn().click();
  assert.ok(await until(() => /Could not record/.test($('#terms-gate .terms-gate-error').textContent)));
  assert.ok(termsGateOpen());
  assert.equal(agreeBtn().disabled, false, 'can try again');
  agreeBtn().click();
  assert.equal(await result, true);
});

test('any request answered 403 TERMS_REQUIRED asks the app to show the gate', async () => {
  const { api } = await import(docs('api.js'));
  let detail = null;
  window.addEventListener('vault:terms-required', (e) => { detail = e.detail; }, { once: true });
  await assert.rejects(api.request('/api/library'), (err) => err.status === 403 && err.code === 'TERMS_REQUIRED');
  assert.deepEqual(detail, { version: REAL.version });
});

test('signing up: the setup wizard’s Terms step must be completed and is sent with setup', async () => {
  const { OnboardingManager } = await import(docs('onboarding.js'));
  const wizard = new OnboardingManager();
  await wizard.init();
  wizard.render(document.getElementById('app'));
  assert.equal(wizard.totalSteps, 7);
  Object.assign(wizard.data, { username: 'sam', password: 'Correct-Horse-9', confirmPassword: 'Correct-Horse-9', gridPattern: [2, 3, 6, 7, 10, 11, 14, 15] });

  wizard.currentStep = 6;
  wizard.renderStep();
  assert.equal($('#onboarding-title').textContent, 'Terms of Use');
  assert.equal($('#onboarding-step-label').textContent, 'Step 6 of 7');
  assert.ok(await until(() => $('#ob-terms .terms-reader-scroll')), 'the terms load into the step');
  const next = $('#onboarding-next');
  assert.equal(next.disabled, true);
  assert.match($('#ob-terms').textContent, /sole responsibility of the User who commits it/);

  // Ctrl+Enter can't skip it either.
  await wizard.next();
  assert.equal(wizard.currentStep, 6);

  scrollTo($('#ob-terms .terms-reader-scroll'), 1);
  const stepBoxes = [...document.querySelectorAll('#ob-terms [data-terms-check]')];
  assert.equal(stepBoxes.length, 2);
  stepBoxes.forEach(b => b.click());
  assert.equal(next.disabled, false);

  await wizard.next();
  assert.equal(wizard.currentStep, 7, 'on to "Ready to Launch"');
  assert.match($('#onboarding-body').textContent, new RegExp(`accept the Vault Terms of Use \\(version ${REAL.version.replace('.', '\\.')}\\)`));

  // Back keeps what was read and ticked.
  wizard.back();
  assert.ok(await until(() => $('#ob-terms [data-terms-check]')));
  assert.ok([...document.querySelectorAll('#ob-terms [data-terms-check]')].every(b => b.checked && !b.disabled));
  assert.equal($('#onboarding-next').disabled, false);
  await wizard.next();

  server.setupBodies = [];
  await wizard.completeSetup();
  assert.deepEqual(server.setupBodies[0].acceptTerms, { version: REAL.version, sha256: REAL.sha256, readToEnd: true });
});

test('the sign-in screen and landing page link to the Terms of Use', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'index.html'), 'utf8');
  const landing = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'landing.html'), 'utf8');
  assert.match(index, /href="terms\.html"[^>]*>Terms of Use</);
  assert.match(landing, /href="terms\.html">Terms of Use</);
});
