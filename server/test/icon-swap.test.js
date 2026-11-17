/**
 * Tests for icon rendering and setIcon glyph swapping.
 * Regression test for the play button bug where play and pause icons
 * were both rendered side-by-side in the button.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const ICONS_URL = pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', 'utils', 'icons.js')).href;

async function loadIconsModule() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://kokonut-dev.github.io/Vault-V2/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.SVGElement = dom.window.SVGElement;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window) || (cb => setTimeout(cb, 0));

  const iconsModule = await import(`${ICONS_URL}?test=${Date.now()}-${Math.random()}`);
  return { ...iconsModule, dom };
}

test('hydrateIcons populates [data-icon] elements with exactly one SVG', async () => {
  const { hydrateIcons, dom } = await loadIconsModule();
  const doc = dom.window.document;
  const container = doc.createElement('div');
  container.innerHTML = `
    <button id="test-play" data-icon="play" data-icon-size="16"></button>
    <button id="test-pause" data-icon="pause" data-icon-size="22"></button>
  `;
  doc.body.appendChild(container);

  hydrateIcons(container);

  const playBtn = container.querySelector('#test-play');
  const pauseBtn = container.querySelector('#test-pause');

  assert.equal(playBtn.querySelectorAll('svg').length, 1);
  assert.equal(playBtn.dataset.currentIcon, 'play');
  assert.equal(pauseBtn.querySelectorAll('svg').length, 1);
  assert.equal(pauseBtn.dataset.currentIcon, 'pause');

  dom.window.close();
});

test('setIcon cleanly swaps icons without leaving previous SVGs behind', async () => {
  const { setIcon, hydrateIcons, dom } = await loadIconsModule();
  const doc = dom.window.document;
  const btn = doc.createElement('button');
  btn.setAttribute('data-icon', 'play');
  btn.setAttribute('data-icon-size', '16');
  doc.body.appendChild(btn);

  hydrateIcons(doc.body);
  assert.equal(btn.querySelectorAll('svg').length, 1);
  assert.equal(btn.dataset.currentIcon, 'play');

  // Swap to pause
  setIcon(btn, 'pause', { size: 16 });
  assert.equal(btn.querySelectorAll('svg').length, 1, 'must have exactly one SVG after swapping to pause');
  assert.equal(btn.dataset.currentIcon, 'pause');

  // Calling setIcon with the same icon is a no-op
  setIcon(btn, 'pause', { size: 16 });
  assert.equal(btn.querySelectorAll('svg').length, 1, 'idempotent call must not duplicate SVG');
  assert.equal(btn.dataset.currentIcon, 'pause');

  // Swap back to play
  setIcon(btn, 'play', { size: 16 });
  assert.equal(btn.querySelectorAll('svg').length, 1, 'must have exactly one SVG after swapping to play');
  assert.equal(btn.dataset.currentIcon, 'play');

  dom.window.close();
});

test('rapid alternating setIcon calls never leave duplicate icons', async () => {
  const { setIcon, dom } = await loadIconsModule();
  const doc = dom.window.document;
  const playBtn = doc.createElement('button');
  playBtn.id = 'mini-play';
  doc.body.appendChild(playBtn);

  // Simulate rapid play/pause events (e.g. track change + play + pause events firing rapidly)
  const states = ['play', 'pause', 'play', 'pause', 'play', 'pause', 'pause', 'play', 'pause'];
  for (const state of states) {
    setIcon(playBtn, state, { size: 16 });
    assert.equal(playBtn.querySelectorAll('svg').length, 1, `must have exactly 1 SVG after state '${state}'`);
  }

  assert.equal(playBtn.querySelectorAll('svg').length, 1);
  assert.equal(playBtn.dataset.currentIcon, 'pause');

  dom.window.close();
});
