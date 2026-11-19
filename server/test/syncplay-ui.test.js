/**
 * SyncPlay page (jsdom) against the real /api/syncplay router: creating a
 * room keeps the member token, the room view reads its chat with it, a
 * refresh reopens the same membership instead of adding a ghost member, and
 * leaving hands the room to the next member. (Before the bug run the page
 * read `room.code`/`room.memberId` from the wrong place, so chat 404'd and
 * leaving never worked.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');
const { JSDOM } = require('jsdom');

// ---- real server routes behind a stub auth (token -> device session) -------
const profiles = require('../services/profiles');
profiles.get = (id) => ({ id, name: id === 'default' ? 'Sam' : 'Alex' });
profiles.canAccess = () => true;
const libraryService = require('../services/library');
libraryService.getById = () => null;
const syncplay = require('../services/syncplay');

const DEVICES = { 'host-token': { sid: 's_host', profileId: 'default' }, 'guest-token': { sid: 's_guest', profileId: 'p_alex' } };
let server;
let base;

const dom = new JSDOM('<!doctype html><html><body><main id="view-container"></main></body></html>', {
  url: 'https://kokonut-dev.github.io/Vault-V2/syncplay',
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
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
localStorage.setItem('vault_token', 'host-token');

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await tick(10);
  }
  throw new Error('timed out');
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const device = DEVICES[(req.get('authorization') || '').replace('Bearer ', '')];
    if (!device) return res.status(401).json({ error: 'no' });
    req.user = { username: 'owner', sid: device.sid };
    req.profileId = device.profileId;
    return next();
  });
  app.use('/api/syncplay', require('../routes/syncplay'));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  window.VAULT_CONFIG = { apiBaseUrl: base, basePath: '/Vault-V2' };
});
test.after(async () => {
  await new Promise(r => server.close(r));
  dom.window.close();
});

const asGuest = (method, p, body, memberToken) => fetch(base + p, {
  method,
  headers: { 'content-type': 'application/json', authorization: 'Bearer guest-token', ...(memberToken ? { 'x-syncplay-member': memberToken } : {}) },
  body: body ? JSON.stringify(body) : undefined,
}).then(r => r.json());

test('create, chat, refresh and leave a watch party from the SyncPlay page', async (t) => {
  const { renderSyncPlay } = await import(docs('views', 'syncplay.js'));
  const { runViewCleanups } = await import(docs('utils', 'lifecycle.js'));
  t.after(() => runViewCleanups()); // stops the room refresh timer even on failure
  const container = document.getElementById('view-container');

  await renderSyncPlay(container);
  container.querySelector('#room-create').click();
  const input = await until(() => document.querySelector('#prompt-input'));
  input.value = 'Movie night';
  document.querySelector('[data-confirm]').click();

  const code = await until(() => container.querySelector('.room-header .room-code')?.textContent);
  const session = JSON.parse(sessionStorage.getItem('vault_syncplay'));
  assert.equal(session.code, code);
  assert.equal(session.host, true);
  assert.ok(session.token && session.token.length >= 32, 'the member token is kept for this tab');
  assert.match(container.querySelector('#room-members').textContent, /Sam · host \(you\)/);

  // A guest joins on another device and says something (as HTML, shown as text).
  const joined = await asGuest('POST', `/api/syncplay/rooms/${code}/join`, { name: 'Alex' });
  await asGuest('POST', `/api/syncplay/rooms/${session.roomId}/chat`, { text: '<b>hi</b>' }, joined.member.token);
  window.dispatchEvent(new CustomEvent('vault:syncplay-chat', { detail: { roomId: session.roomId } }));
  const line = await until(() => container.querySelector('#chat-log .chat-line'));
  assert.equal(line.textContent, 'Alex: <b>hi</b>');
  assert.equal(line.querySelector('b'), null);

  // The host replies through the form (with the member token).
  container.querySelector('#chat-input').value = 'welcome';
  container.querySelector('#chat-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await until(() => container.querySelectorAll('#chat-log .chat-line').length === 2);

  // Refresh: the same membership is reopened — no ghost member.
  runViewCleanups();
  await renderSyncPlay(container);
  await until(() => container.querySelector('.room-header'));
  assert.equal(syncplay.getRoom(session.roomId).members.length, 2);

  // Leave: the session is cleared and the guest becomes host.
  container.querySelector('#room-leave').click();
  await until(() => !sessionStorage.getItem('vault_syncplay'));
  const room = syncplay.getRoom(session.roomId);
  assert.equal(room.members.length, 1);
  assert.equal(room.hostMemberId, joined.member.id);
  await until(() => container.querySelector('#room-create'));
  runViewCleanups();
});
