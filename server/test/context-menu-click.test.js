/**
 * A plain left click on a song (list row) or a card plays/opens it, and
 * nothing else. The right-click menu used to pop up on every left click
 * too: the global "More button" handler matched data-context-menu-for,
 * which every card and row carries as its item marker.
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
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };
globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const menu = () => document.querySelector('.context-menu');
const frame = () => new Promise(r => setTimeout(r, 5)); // the menu fades in on the next animation frame

const song = { id: 'song-1', type: 'music', title: 'Clair de Lune', artist: 'Debussy', album: 'Suite', duration: 300 };
const movie = { id: 'movie-1', type: 'movie', title: 'Arrival', year: 2016 };

let mod;
test.before(async () => {
  const { store } = await import(docs('store.js'));
  store.set('library', [song, movie]);
  const contextMenu = await import(docs('components', 'contextMenu.js'));
  contextMenu.initContextMenu(); // the real global listeners, as app-extras.js installs them
  mod = {
    ...contextMenu,
    ...(await import(docs('components', 'mediaList.js'))),
    ...(await import(docs('components', 'mediaCard.js'))),
  };
});

const click = (el, init = {}) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
const rightClick = (el) => el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }));

test('left-clicking a song row plays it without opening the right-click menu', () => {
  const host = document.getElementById('view-container');
  const clicked = [];
  mod.renderMediaList(host, [song], { onClick: (item) => clicked.push(item.id) });
  const row = host.querySelector('[data-item-id="song-1"]');
  assert.ok(row, 'song row rendered');

  click(row);
  assert.deepEqual(clicked, ['song-1']);
  assert.equal(menu(), null, 'no context menu after a left click on the row');

  // …nor when the click lands on text inside the row.
  click(row.querySelector('*') || row);
  assert.equal(menu(), null);
});

test('left-clicking a card opens it without the menu', () => {
  const host = document.getElementById('view-container');
  host.innerHTML = '';
  const opened = [];
  const card = mod.createMediaCard(movie, { onClick: (item) => opened.push(item.id) });
  host.appendChild(card);
  click(card);
  assert.deepEqual(opened, ['movie-1']);
  assert.equal(menu(), null);
});

test('right-click still opens the menu, and a left click elsewhere closes it', async () => {
  const host = document.getElementById('view-container');
  mod.renderMediaList(host, [song], { onClick() {} });
  const row = host.querySelector('[data-item-id="song-1"]');
  rightClick(row);
  await frame();
  assert.ok(menu()?.classList.contains('active'), 'menu open after right-click');
  assert.match(menu().textContent, /Play next/);
  click(document.body);
  assert.equal(document.querySelector('.context-menu.active'), null, 'closed by the next click');
});

test('explicit "More" buttons (data-context-menu-trigger) still open it', async () => {
  await new Promise(r => setTimeout(r, 150)); // let the closing menu leave the DOM
  const host = document.getElementById('view-container');
  host.innerHTML = '<button type="button" data-context-menu-trigger="song-1">More</button>';
  click(host.querySelector('button'));
  await frame();
  assert.ok(menu()?.classList.contains('active'));
  mod.closeContextMenu();
});
