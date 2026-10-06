#!/usr/bin/env node
/**
 * Regression check for the global keyboard layer (docs/js/keyboard.js).
 *
 *   node scripts/keyboard-check.js        (no dependencies, no browser)
 *
 * Guards the bugs fixed in this pass:
 *   1. Space = play/pause used to run while a text field was focused, so no
 *      space could be typed into the upload metadata fields (title / artist /
 *      genre / description) or any other input.
 *   2. The player-active probe matched the always-present `.video-player` node
 *      inside the hidden video modal, so `s`, `n`, `c`, `f`, `m`, digits… stole
 *      keystrokes on every page with nothing playing.
 *
 * The module under test is ES, this script is CommonJS — it is pulled in with a
 * dynamic import() and driven through a minimal DOM stand-in, so the suite runs
 * in plain Node with zero dependencies (same philosophy as syntax-check.js).
 */
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.join(__dirname, '..');
const moduleUrl = (...parts) => pathToFileURL(path.join(REPO_ROOT, 'docs', 'js', ...parts)).href;
const KEYBOARD_MODULE = moduleUrl('keyboard.js');

// --------------------------------------------------------------- DOM stand-in
class El {
  constructor(tag, attrs = {}, id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._attrs = { ...attrs };
    this.isContentEditable = false;
    this.classList = {
      _s: new Set(String(attrs.class || '').split(/\s+/).filter(Boolean)),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    };
    this.dataset = {};
    this.children = [];
    this.style = {};
    this.listeners = {};
  }
  set innerHTML(html) { this._html = html; }
  get innerHTML() { return this._html || ''; }
  set className(name) { this._className = name; }
  get className() { return this._className || ''; }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child) { this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); }
  replaceChildren(...nodes) { this.children = nodes; }
  closest() { return null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  querySelector() { return new El('button'); }
  querySelectorAll() { return []; }
  getAttribute(name) {
    if (name === 'class') return [...this.classList._s].join(' ');
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  hasAttribute(name) { return this.getAttribute(name) !== null; }
  setAttribute(name, value) { this._attrs[name] = value; }
  /** faithful .click() for the component shim: runs registered click listeners */
  click() {
    const ev = { target: this, preventDefault() {}, stopPropagation() {} };
    for (const fn of this.listeners.click || []) fn(ev);
  }
  /** fire a keydown straight at the listeners this element registered */
  keydown(key, target) {
    let prevented = false;
    const ev = {
      key, code: key === ' ' ? 'Space' : key, target,
      shiftKey: false, altKey: false, metaKey: false, ctrlKey: false,
      stopPropagation() {},
      get defaultPrevented() { return prevented; },
      preventDefault() { prevented = true; },
    };
    for (const fn of this.listeners.keydown || []) fn(ev);
    return prevented;
  }
  /** supports compounds: "#video-modal.active" / ".mini-player.active" */
  matches(sel) {
    return sel.split(',').some((raw) =>
      (raw.trim().match(/[.#][^.#]+/g) || []).every((p) =>
        p[0] === '#' ? this.id === p.slice(1) : this.classList.contains(p.slice(1))
      )
    );
  }
}

class FakeDocument extends El {
  constructor(visible = []) {
    super('body');
    this.visible = visible;
    this.listeners = { keydown: [] };
    this.activeElement = null;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  querySelector(sel) { return this.visible.find((el) => el.matches(sel)) || null; }
  querySelectorAll() { return []; }
  createElement(tag) { return new El(tag); }
  createDocumentFragment() { return new El('fragment'); }
  dispatch({ key, code = '', target, shiftKey = false, altKey = false, metaKey = false, ctrlKey = false }) {
    let prevented = false;
    const ev = {
      key, code, shiftKey, altKey, metaKey, ctrlKey, target,
      get defaultPrevented() { return prevented; },
      preventDefault() { prevented = true; },
    };
    for (const fn of this.listeners.keydown) fn(ev);
    return prevented;
  }
}

const input = (id, type = 'text') => new El('input', { type }, id);
const HIDDEN_PLAYER = new El('div', { class: 'video-player paused' }, 'video-player'); // always in DOM
const OPEN_VIDEO = new El('div', { class: 'video-modal active' }, 'video-modal');
const MINI_PLAYER = new El('div', { class: 'mini-player glass active' }, 'mini-player');

// ------------------------------------------------------------------ assertions
let failed = 0;
let checks = 0;

function test(name, fn) {
  checks++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ----------------------------------------------------------------------- main
(async () => {
  const events = [];
  globalThis.localStorage = {
    _data: new Map(),
    getItem(key) { return this._data.has(key) ? this._data.get(key) : null; },
    setItem(key, value) { this._data.set(key, String(value)); },
    removeItem(key) { this._data.delete(key); },
  };
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  globalThis.window = {
    dispatchEvent: (ev) => events.push({ type: ev.type, detail: ev.detail }),
    addEventListener: () => {},
  };
  globalThis.CustomEvent = class {
    constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
  };

  const { keyboardManager } = await import(KEYBOARD_MODULE);

  const fired = (type, detail) =>
    events.some((e) => e.type === type && (!detail || Object.entries(detail).every(([k, v]) => e.detail?.[k] === v)));

  function setup({ visible = [HIDDEN_PLAYER], focused = null } = {}) {
    globalThis.document = new FakeDocument(visible);
    document.activeElement = focused;
    keyboardManager.init();
    keyboardManager.sequence = [];
    events.length = 0;
    return document;
  }

  console.log('[keyboard-check] typing in form fields');

  for (const [label, el] of [
    ['upload title', input('meta-title')],
    ['upload artist', input('meta-artist')],
    ['upload album', input('meta-album')],
    ['upload genre', input('meta-genre')],
    ['upload year', input('meta-year', 'number')],
    ['upload description', new El('textarea', {}, 'meta-desc')],
    ['settings password', input('current-pass', 'password')],
    ['onboarding server URL', input('ob-api-url')],
    ['search palette', input('search-input', 'search')],
  ]) {
    test(`space types into ${label}`, () => {
      const doc = setup({ focused: el });
      const prevented = doc.dispatch({ key: ' ', code: 'Space', target: el });
      assert(prevented === false, 'keydown was preventDefault()-ed — the field never receives the space');
      assert(!fired('vault:player-action'), 'a player action fired while typing');
    });
  }

  test('single-letter shortcuts do not fire while typing', () => {
    const el = input('meta-title');
    const doc = setup({ focused: el });
    for (const key of ['s', 'n', 'c', 'f', 'm', 'p', 't', 'r', 'k', 'j', 'l', '5']) {
      assert(doc.dispatch({ key, code: `Key${key.toUpperCase()}`, target: el }) === false, `"${key}" was swallowed`);
    }
    assert(!fired('vault:player-action'), 'a player action leaked out of a text field');
  });

  console.log('[keyboard-check] no player open (hidden video modal only)');

  test('space is inert', () => {
    const doc = setup();
    assert(doc.dispatch({ key: ' ', code: 'Space', target: document.body }) === false, 'Space was preventDefault()-ed');
    assert(!fired('vault:player-action'), 'play/pause fired with no player on screen');
  });

  test('media letters are inert', () => {
    const doc = setup();
    for (const [key, code] of [['m', 'KeyM'], ['n', 'KeyN'], ['s', 'KeyS'], ['c', 'KeyC'], ['f', 'KeyF'], ['7', 'Digit7']]) {
      assert(doc.dispatch({ key, code, target: document.body }) === false, `"${key}" was swallowed with no player`);
    }
    assert(!fired('vault:player-action'), 'a player action fired with no player on screen');
  });

  console.log('[keyboard-check] player open');

  test('space toggles play/pause', () => {
    const doc = setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO] });
    assert(doc.dispatch({ key: ' ', code: 'Space', target: document.body }) === true, 'Space was not handled');
    assert(fired('vault:player-action', { action: 'playPause' }), 'playPause was not dispatched');
  });

  test('mini player and now-playing also count as open', () => {
    for (const el of [MINI_PLAYER, new El('div', { class: 'now-playing active' }, 'now-playing')]) {
      const doc = setup({ visible: [HIDDEN_PLAYER, el] });
      doc.dispatch({ key: ' ', code: 'Space', target: document.body });
      assert(fired('vault:player-action', { action: 'playPause' }), `no action for ${el.id}`);
    }
  });

  test('documented media keys map through', () => {
    setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO] });
    for (const [[key, code], action] of [
      [['k', 'KeyK'], 'playPause'], [['j', 'KeyJ'], 'seekBack'], [['l', 'KeyL'], 'seekForward'],
      [['ArrowUp', 'ArrowUp'], 'volumeUp'], [['ArrowDown', 'ArrowDown'], 'volumeDown'],
      [['m', 'KeyM'], 'mute'], [['f', 'KeyF'], 'fullscreen'], [['t', 'KeyT'], 'theatre'],
      [['p', 'KeyP'], 'pip'], [['c', 'KeyC'], 'captions'], [['n', 'KeyN'], 'next'],
      [['s', 'KeyS'], 'shuffle'], [['r', 'KeyR'], 'repeat'],
    ]) {
      events.length = 0;
      document.dispatch({ key, code, target: document.body });
      assert(fired('vault:player-action', { action }), `${key} → ${action} did not fire`);
    }
  });

  test('Shift+N = previous, digits seek by percent', () => {
    const doc = setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO] });
    doc.dispatch({ key: 'N', code: 'KeyN', shiftKey: true, target: document.body });
    assert(fired('vault:player-action', { action: 'prev' }), 'Shift+N did not send prev');
    events.length = 0;
    doc.dispatch({ key: '7', code: 'Digit7', target: document.body });
    assert(fired('vault:player-action', { action: 'seekPercent', percent: 70 }), 'digit 7 did not seek to 70%');
  });

  test('a focused control keeps its own keys', () => {
    const btn = new El('button', {}, 'np-play');
    const doc = setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO], focused: btn });
    assert(doc.dispatch({ key: ' ', code: 'Space', target: btn }) === false, 'button Space was hijacked');
    assert(!fired('vault:player-action'), 'player action fired twice (button + global)');

    const range = input('video-volume', 'range');
    const doc2 = setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO], focused: range });
    assert(doc2.dispatch({ key: 'ArrowRight', code: 'ArrowRight', target: range }) === false, 'slider arrow was hijacked');

    const select = new El('select', {}, 'sort-select');
    const doc3 = setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO], focused: select });
    assert(doc3.dispatch({ key: 'ArrowDown', code: 'ArrowDown', target: select }) === false, 'select arrow was hijacked');
  });

  test('the seek slider still gets arrows (role="slider" has no native keys)', () => {
    const slider = new El('div', { class: 'video-progress', role: 'slider', tabindex: '0' }, 'video-progress');
    const doc = setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO], focused: slider });
    doc.dispatch({ key: 'ArrowRight', code: 'ArrowRight', target: slider });
    assert(fired('vault:player-action', { action: 'seekForward' }), 'arrows stopped seeking the progress bar');
  });

  console.log('[keyboard-check] other global keys');

  test('Alt/Option+Space opens search from inside a text field', () => {
    const el = input('meta-title');
    const doc = setup({ focused: el });
    assert(doc.dispatch({ key: ' ', code: 'Space', altKey: true, target: el }) === true, 'Space not handled');
    assert(fired('vault:open-search'), 'search did not open');
  });

  test('Escape still broadcasts while typing', () => {
    const el = input('meta-artist');
    const doc = setup({ focused: el });
    doc.dispatch({ key: 'Escape', code: 'Escape', target: el });
    assert(fired('vault:escape'), 'escape was not broadcast');
  });

  test('Cmd/Ctrl chords are left to the browser', () => {
    const doc = setup({ visible: [HIDDEN_PLAYER, OPEN_VIDEO] });
    for (const [key, code, mod] of [['p', 'KeyP', 'metaKey'], ['s', 'KeyS', 'metaKey'], ['r', 'KeyR', 'ctrlKey']]) {
      assert(doc.dispatch({ key, code, [mod]: true, target: document.body }) === false, `Cmd/Ctrl+${key} was swallowed`);
    }
    assert(!fired('vault:player-action'), 'a player action fired from a browser chord');
  });

  test('g-sequences navigate, but never from a text field', () => {
    const doc = setup();
    doc.dispatch({ key: 'g', code: 'KeyG', target: document.body });
    doc.dispatch({ key: 'm', code: 'KeyM', target: document.body });
    assert(fired('vault:navigate', { page: '/movies' }), 'g→m did not navigate');

    events.length = 0;
    const el = input('meta-genre');
    const doc2 = setup({ focused: el });
    doc2.dispatch({ key: 'g', code: 'KeyG', target: el });
    doc2.dispatch({ key: 'm', code: 'KeyM', target: el });
    assert(!fired('vault:navigate'), 'typing "gm" navigated away');
  });

  console.log('[keyboard-check] media cards / list rows (real modules)');

  const { createMediaCard } = await import(moduleUrl('components', 'mediaCard.js'));
  const { renderMediaList } = await import(moduleUrl('components', 'mediaList.js'));
  const ITEM = { id: 'm1', type: 'movie', title: 'Blade Runner', year: 1982 };

  test('a card handles Space when the card itself is focused', () => {
    let opened = 0;
    const card = createMediaCard(ITEM, { onClick: () => opened++ });
    assert(card.keydown(' ', card) === true, 'card did not handle its own Space');
    assert(opened === 1, 'onClick was not called');
  });

  test('Space bubbled from the card play button is not swallowed by the card', () => {
    let opened = 0;
    const card = createMediaCard(ITEM, { onClick: () => opened++ });
    const playButton = new El('button');            // stands in for .media-card-play
    assert(card.keydown(' ', playButton) === false, "card preventDefault()-ed the button's Space");
    assert(opened === 0, 'card opened instead of letting the button play');
    assert(card.keydown('Enter', playButton) === false, 'Enter on the button was swallowed too');
  });

  test('a list row activates itself, but not its nested play button', () => {
    const container = new El('div');
    let clicked = 0;
    renderMediaList(container, [ITEM], { onClick: () => clicked++ });

    const find = (el, pred) => {
      if (pred(el)) return el;
      for (const child of el.children || []) {
        const hit = find(child, pred);
        if (hit) return hit;
      }
      return null;
    };
    const row = find(container, (el) => el.className === 'media-list-item');
    assert(row, 'row was not rendered');

    assert(row.keydown(' ', row) === true, 'row did not handle its own Space');
    assert(clicked === 1, 'row onClick was not called');

    assert(row.keydown(' ', new El('button')) === false, 'row swallowed the play button Space');
    assert(clicked === 1, 'row opened instead of playing');
  });

  // ------------------------------------------------------------------- result
  if (failed) {
    console.error(`\n[keyboard-check] ${failed}/${checks} checks FAILED`);
    process.exit(1);
  }
  console.log(`\n[keyboard-check] ${checks}/${checks} checks OK`);
})().catch((err) => {
  console.error('[keyboard-check] crashed:', err);
  process.exit(1);
});
