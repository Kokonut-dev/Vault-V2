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

test('the player’s SyncPlay control starts a party for the playing video, shows the code and leaves', async (t) => {
  const film = { id: 'film-1', title: 'Film', type: 'movie' };
  const origGetById = libraryService.getById;
  libraryService.getById = (id) => (id === film.id ? film : null);
  t.after(() => { libraryService.getById = origGetById; });
  sessionStorage.removeItem('vault_syncplay');

  // The player's controls row (index.html) with the captions button the control sits next to.
  const controls = document.createElement('div');
  controls.className = 'video-controls-right';
  controls.innerHTML = '<button id="video-captions"></button>';
  document.body.appendChild(controls);
  t.after(() => controls.remove());

  const { initSyncPlayControl } = await import(docs('components', 'syncplayControl.js'));
  const { store } = await import(docs('store.js'));
  initSyncPlayControl();
  const button = await until(() => document.getElementById('video-syncplay'));
  assert.equal(button.nextElementSibling.id, 'video-captions');
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  // Not playing anything: only "join" is offered.
  button.click();
  const menu = document.getElementById('video-syncplay-menu');
  await until(() => menu.classList.contains('active'));
  assert.equal(menu.querySelector('[data-sync-action="start"]'), null);
  assert.ok(menu.querySelector('[data-sync-action="join"]'));
  document.body.click();
  assert.equal(menu.classList.contains('active'), false);

  // Playing a film: start a party with it.
  window.dispatchEvent(new CustomEvent('vault:video-opened', { detail: { item: film } }));
  assert.equal(store.get('currentVideoId'), film.id, 'the SyncPlay page can now see what is playing');
  button.click();
  (await until(() => menu.querySelector('[data-sync-action="start"]'))).click();
  const session = await until(() => JSON.parse(sessionStorage.getItem('vault_syncplay') || 'null'));
  assert.equal(session.host, true);
  const room = syncplay.getRoom(session.roomId);
  assert.equal(room.itemId, film.id, 'the room starts on the playing video');
  assert.equal(room.members[0].name, 'Sam');
  await until(() => button.getAttribute('aria-pressed') === 'true');
  assert.match(button.textContent, new RegExp(session.code));

  // A guest joins; the menu shows the code and the head count.
  const joined = await asGuest('POST', `/api/syncplay/rooms/${session.code}/join`, { name: 'Alex' });
  assert.equal(joined.item.id, film.id);
  button.click();
  await until(() => /2 people · Film/.test(menu.querySelector('[data-sync-members]')?.textContent || ''));
  assert.match(menu.textContent, new RegExp(`Watch party ${session.code}`));

  // Leave: the session is gone and the room passes to the guest.
  menu.querySelector('[data-sync-action="leave"]').click();
  await until(() => !sessionStorage.getItem('vault_syncplay'));
  await until(() => button.getAttribute('aria-pressed') === 'false');
  assert.equal(syncplay.getRoom(session.roomId).hostMemberId, joined.member.id);

  window.dispatchEvent(new CustomEvent('vault:video-closed'));
  assert.equal(store.get('currentVideoId'), null);
});
