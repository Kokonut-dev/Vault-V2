/**
 * Security details in the browser (jsdom, fake /api):
 *   - every place that shares access explains what protects it,
 *   - remote access offers an automatic switch-off and nudges towards an
 *     authenticator app,
 *   - a signed-in person opening a pairing code/link must confirm first, and
 *     sees where the waiting device is.
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
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
// QR codes draw on a canvas jsdom doesn't have; the fallback is fine here.
window.HTMLCanvasElement.prototype.getContext = () => null;
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };

const requests = [];
let remoteStatus = null;
let pairState = { status: 'pending', expiresIn: 280, requester: { ip: '203.0.113.50', network: 'internet' } };
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  const method = options.method || 'GET';
  requests.push({ method, path: u.pathname, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.pathname === '/api/remote' && method === 'GET') return json(200, remoteStatus);
  if (u.pathname === '/api/remote/settings') {
    const body = JSON.parse(options.body);
    remoteStatus.autoStopHours = body.autoStopHours ?? remoteStatus.autoStopHours;
    return json(200, { tunnelOnStartup: false, autoStopHours: remoteStatus.autoStopHours, tunnel: remoteStatus.tunnel });
  }
  if (u.pathname === '/api/auth/pair' && method === 'POST') return json(200, { code: '123456', token: 'tok', approved: true, expiresIn: 300, url: null });
  if (/^\/api\/auth\/pair\/\d+\/state$/.test(u.pathname)) return json(200, pairState);
  if (u.pathname === '/api/auth/pair/approve') return json(200, { message: 'Device paired' });
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const closeModals = () => document.querySelectorAll('.modal-backdrop').forEach(n => n.remove());

test.after(() => dom.window.close());

test('every kind of shared access lists its protections', async () => {
  const { securityNotes, securityPoints } = await import(docs('components', 'securityNotes.js'));
  const text = (kind, info) => {
    const host = document.createElement('div');
    host.innerHTML = securityNotes(kind, info);
    return host;
  };

  const lan = text('lan', { security: { totpEnabled: false, lockout: { maxAttempts: 5, minutes: 15 } } });
  assert.equal(lan.querySelector('summary').textContent.trim(), 'How this is protected');
  assert.match(lan.textContent, /never opens ports on your router/);
  assert.match(lan.textContent, /works once, for 5 minutes/);
  assert.match(lan.textContent, /After 5 wrong tries/);
  assert.match(lan.textContent, /public Wi-Fi/);
  assert.ok(lan.querySelector('a[data-route="/settings#devices"]'), 'links to the devices list');

  const remoteOff = text('remote', { security: { totpEnabled: false }, autoStopHours: 0 });
  assert.match(remoteOff.textContent, /https/);
  assert.match(remoteOff.textContent, /no ports are opened/);
  assert.match(remoteOff.textContent, /stays on until you turn it off/);
  assert.match(remoteOff.textContent, /authenticator app/);
  assert.ok(remoteOff.querySelector('a[data-route="/settings#security"]'));
  const remoteSafe = text('remote', { security: { totpEnabled: true }, autoStopHours: 8 });
  assert.match(remoteSafe.textContent, /turns itself off after 8 hours/);
  assert.match(remoteSafe.textContent, /code from your authenticator app/);
  assert.doesNotMatch(remoteSafe.textContent, /Recommended: turn on/);

  assert.match(text('pair').textContent, /once.*5 minutes/s);
  assert.match(text('approve').textContent, /If someone sent you this code/);
  assert.match(text('transfer').textContent, /one download/);
  assert.match(text('subsonic').textContent, /Vault password is never accepted/);
  assert.equal(securityPoints('nope').length, 0);
});

test('Anywhere tab: security details, authenticator nudge and automatic switch-off', async () => {
  remoteStatus = {
    tunnel: { status: 'off' },
    cloudflared: { installed: true, version: '2026.1.0' },
    tunnelOnStartup: false,
    autoStopHours: 8,
    autoStopChoices: [0, 1, 4, 8, 24],
    lan: { reachable: true, addresses: [{ url: 'http://192.168.1.5:4000', interface: 'en0' }] },
    security: { totpEnabled: false, secondFactor: 'grid', lockout: { maxAttempts: 5, minutes: 15 }, signedInDevices: 2, remoteDevices: 0 },
  };
  const { openShareDevice } = await import(docs('components', 'shareDevice.js'));
  const { close } = openShareDevice({ tab: 'remote' });
  const panel = await until(() => document.querySelector('#share-panel [data-action="tunnel-on"]') && document.querySelector('#share-panel'), 2000, 'remote panel');
  assert.ok(panel.querySelector('.security-notes[data-security="remote"][open]'), 'open before turning it on');
  assert.ok(panel.querySelector('.share-totp'), 'recommends an authenticator app');
  const select = panel.querySelector('#share-autostop');
  assert.equal(select.value, '8');
  assert.deepEqual([...select.options].map(o => o.textContent), ['never', 'after 1 hour', 'after 4 hours', 'after 8 hours', 'after 24 hours']);
  assert.equal(document.querySelector(`label[for="${select.id}"]`).textContent, 'Turn remote access off automatically');

  select.value = '1';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await until(() => requests.some(r => r.path === '/api/remote/settings'), 2000, 'settings saved');
  assert.deepEqual(requests.find(r => r.path === '/api/remote/settings').body, { autoStopHours: 1 });
  await until(() => /after 1 hour/.test(document.querySelector('#share-panel .security-notes')?.textContent || ''), 2000, 'notes updated');

  // Same Wi-Fi tab explains its protections too.
  document.querySelector('[data-tab="lan"]').click();
  await until(() => document.querySelector('#share-panel .security-notes[data-security="lan"]'), 2000, 'lan notes');
  close();
  closeModals();
});

test('the tunnel being on shows when it switches itself off', async () => {
  const stopsAt = new Date(Date.now() + 3600 * 1000).toISOString();
  remoteStatus.tunnel = { status: 'on', url: 'https://abc.trycloudflare.com', startedAt: new Date().toISOString(), stopsAt };
  remoteStatus.security.totpEnabled = true;
  const { openShareDevice } = await import(docs('components', 'shareDevice.js'));
  const { close } = openShareDevice({ tab: 'remote' });
  const stop = await until(() => document.querySelector('#share-panel .share-stop'), 2000, 'stop line');
  assert.match(stop.textContent, /Turns itself off at/);
  assert.match(stop.textContent, /authenticator code/);
  assert.equal(document.querySelector('#share-panel .share-totp'), null, 'no nudge once it is on');
  assert.ok(document.querySelector('#share-panel .security-notes[data-security="remote"]'));
  close();
  closeModals();
});

test('approving a pairing code needs an explicit yes and shows where the device is', async () => {
  localStorage.setItem('vault_token', 'test-token');
  const { joinWithPairingCode } = await import(docs('components', 'qrPair.js'));

  const declined = joinWithPairingCode('123456');
  const dialog = await until(() => document.querySelector('.pair-approve'), 2000, 'confirmation');
  assert.match(dialog.querySelector('.pair-requester').textContent, /a device on the internet \(203\.0\.113\.50\)/);
  assert.match(dialog.textContent, /If someone sent you this code/);
  dialog.querySelector('[data-pair="cancel"]').click();
  assert.equal(await declined, false);
  assert.equal(requests.filter(r => r.path === '/api/auth/pair/approve').length, 0, 'nothing approved');

  pairState = { status: 'pending', expiresIn: 200, requester: { ip: '192.168.1.30', network: 'your network' } };
  const accepted = joinWithPairingCode('123456');
  const again = await until(() => document.querySelector('.pair-approve'), 2000, 'confirmation 2');
  assert.match(again.querySelector('.pair-requester').textContent, /home network/);
  again.querySelector('[data-pair="ok"]').click();
  assert.equal(await accepted, true);
  assert.equal(requests.filter(r => r.path === '/api/auth/pair/approve').length, 1);

  pairState = { status: 'used' };
  assert.equal(await joinWithPairingCode('123456'), false, 'used codes are refused without a dialog');
  assert.equal(document.querySelector('.pair-approve'), null);
  closeModals();
});

test('the pairing panel and the setup code header', async () => {
  const { renderPairingPanel } = await import(docs('components', 'qrPair.js'));
  const host = document.createElement('div');
  document.body.append(host);
  await renderPairingPanel(host);
  assert.ok(host.querySelector('.security-notes[data-security="pair"]'));
  host.remove();

  const { api } = await import(docs('api.js'));
  api.setSetupCode('ABCD-EFGH');
  await api.checkSetupCode('ABCD-EFGH').catch(() => {});
  const sent = requests.filter(r => r.path === '/api/setup/check-code').pop();
  assert.equal(sent.headers['X-Vault-Setup-Code'], 'ABCD-EFGH');
  assert.deepEqual(sent.body, { setupCode: 'ABCD-EFGH' });
  api.setSetupCode('');
  assert.equal(api.getSetupCode(), '');
});
