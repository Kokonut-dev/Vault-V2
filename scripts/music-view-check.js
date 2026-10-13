#!/usr/bin/env node
/**
 * Regression check for the Music view's grouping filters (docs/js/views/music.js)
 * and the album page they open (docs/js/views/detail.js).
 *
 *   node scripts/music-view-check.js        (or: npm run test:music from server/)
 *
 * Guards the bugs fixed in this pass — every one of them was a group that
 * started playing instead of opening:
 *   1. The Albums filter rendered cards whose click handler queued the album and
 *      started playback. The album page — which already lists the album's tracks
 *      with Play Album / Shuffle — was unreachable from that filter, and the
 *      card's play affordance was an unfocusable <div>, so the only thing a
 *      keyboard user could do with an album was play it.
 *   2. The Genres filter had the same shape: clicking the row played the genre.
 *      Genres have no page of their own, so the row now expands into its track
 *      list and playback lives on its own button.
 *   3. The album page grouped tracks with `i.album === item.album`, so opening
 *      the "Unknown Album" group (untagged tracks hold undefined, '' or null)
 *      rendered an empty heading and only the tracks with the identical value.
 *
 * Unlike keyboard-check.js this drives the modules inside a real DOM (jsdom)
 * rather than a hand-rolled stand-in: these views build their markup with
 * innerHTML and then querySelector into it, so a fake DOM would end up testing
 * the stand-in's parser instead of the views. jsdom is therefore a dependency —
 * but an optional one. Without it the check reports SKIPPED and exits 0 so it
 * can never break a build that doesn't need it; install it with
 * `npm i -D jsdom` in server/ (or `npm i --no-save jsdom` at the repo root).
 */
'use strict';

const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createRequire } = require('node:module');

const REPO_ROOT = path.join(__dirname, '..');
const DOCS = pathToFileURL(path.join(REPO_ROOT, 'docs', 'js')).href + '/';

// ------------------------------------------------------------- optional jsdom
function loadJsdom() {
  // scripts/ has no node_modules of its own: try the repo root, then server/.
  const candidates = [
    require,
    createRequire(path.join(REPO_ROOT, 'server', 'package.json')),
  ];
  for (const req of candidates) {
    try { return req('jsdom'); } catch { /* try the next location */ }
  }
  return null;
}

// ------------------------------------------------------------------ assertions
let failed = 0;
let checks = 0;

async function test(name, fn) {
  checks++;
  try {
    await fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.error(`  \u2717 ${name}\n      ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ----------------------------------------------------------------------- main
(async () => {
  const jsdom = loadJsdom();
  if (!jsdom) {
    console.log('[music-view-check] SKIPPED — jsdom is not installed.');
    console.log('                   Run `npm i -D jsdom` in server/ to enable it.');
    process.exit(0);
  }

  const { JSDOM } = jsdom;
  const dom = new JSDOM('<!doctype html><html><body><div id="view-container"></div></body></html>', {
    url: 'http://localhost:4000/',
    pretendToBeVisual: true,
  });

  // The modules read these at import time — set them before importing.
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.Event = dom.window.Event;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', appName: 'Vault', version: '2.0.0', basePath: '' };

  const events = [];
  const dispatch = window.dispatchEvent.bind(window);
  window.dispatchEvent = (ev) => {
    events.push({ type: ev.type, detail: ev.detail });
    return dispatch(ev);
  };
  const played = () => events.filter((e) => e.type === 'vault:play');
  const opened = () => events.filter((e) => e.type === 'vault:open-detail');

  const { store } = await import(`${DOCS}store.js`);

  // Two albums, one multi-artist album, two untagged tracks ('' and undefined).
  const lib = [
    { id: 't1', type: 'music', title: 'Dawn', artist: 'Nova', album: 'First Light', genre: 'Ambient', track: 1, duration: 200, filename: 'dawn.mp3', path: '/m/dawn.mp3', fileSize: 1 },
    { id: 't2', type: 'music', title: 'Noon', artist: 'Nova', album: 'First Light', genre: 'Ambient', track: 2, duration: 210, filename: 'noon.mp3', path: '/m/noon.mp3', fileSize: 1 },
    { id: 't3', type: 'music', title: 'Dusk', artist: 'Nova', album: 'Second Wind', genre: 'Jazz', track: 1, duration: 220, filename: 'dusk.mp3', path: '/m/dusk.mp3', fileSize: 1 },
    { id: 't4', type: 'music', title: 'Loose', artist: 'Solo', album: '', genre: 'Jazz', track: 0, duration: 90, filename: 'loose.mp3', path: '/m/loose.mp3', fileSize: 1 },
    { id: 't5', type: 'music', title: 'Looser', artist: 'Other', genre: 'Ambient', track: 0, duration: 95, filename: 'looser.mp3', path: '/m/looser.mp3', fileSize: 1 },
    { id: 't6', type: 'music', title: 'Feat', artist: 'Guest', album: 'First Light', genre: 'Ambient', track: 3, duration: 180, filename: 'feat.mp3', path: '/m/feat.mp3', fileSize: 1 },
    { id: 'm1', type: 'movie', title: 'Some Film', year: 2020, genre: 'Drama', filename: 'f.mp4', path: '/m/f.mp4', fileSize: 1 },
  ];
  store.setLibrary(lib);

  const { renderMusic } = await import(`${DOCS}views/music.js`);
  const { renderDetail } = await import(`${DOCS}views/detail.js`);
  const nextTick = () => new Promise((r) => setTimeout(r, 0)); // mediaList is imported dynamically

  function mount() {
    const container = document.getElementById('view-container');
    container.innerHTML = '';
    renderMusic(container);
    return container;
  }

  const container = mount();
  const chip = (name) => container.querySelector(`[data-filter="${name}"]`);

  // ------------------------------------------------------------------- albums
  console.log('[music-view-check] Albums filter — browsing vs playing');

  chip('album').click();
  const cards = [...container.querySelectorAll('#albums-grid .media-card')];
  const cardFor = (album) =>
    cards.find((c) => c.querySelector('.media-card-title').textContent.trim() === album);

  await test('renders one card per album, including an Unknown Album group', () => {
    const titles = cards.map((c) => c.querySelector('.media-card-title').textContent.trim());
    assert(cards.length === 3, `expected 3 album cards, got ${cards.length}: ${JSON.stringify(titles)}`);
    for (const t of ['First Light', 'Second Wind', 'Unknown Album']) {
      assert(titles.includes(t), `missing album "${t}" in ${JSON.stringify(titles)}`);
    }
  });

  const firstLight = cardFor('First Light');

  await test('clicking an album card opens the album instead of playing it', () => {
    events.length = 0;
    firstLight.querySelector('.media-card-title').click();
    assert(played().length === 0, `album click still started playback (${played().length} vault:play events)`);
    assert(opened().length === 1, `expected exactly one vault:open-detail, got ${opened().length}`);
    assert(opened()[0].detail.item.id === 't1', `opened the wrong item: ${opened()[0].detail.item.id}`);
  });

  await test('the album page it opens lists that album\u2019s tracks', async () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    await renderDetail(c, 't1');
    assert(c.querySelector('h1').textContent.trim() === 'First Light', `heading: "${c.querySelector('h1').textContent}"`);
    await nextTick();
    const rows = [...c.querySelectorAll('#track-list .media-list-item')].map((r) => r.dataset.id);
    assert(rows.join(',') === 't1,t2,t6', `expected t1,t2,t6 — got ${rows.join(',') || '(no rows)'}`);
    c.remove();
  });

  await test('a multi-artist album is not credited to the clicked track', async () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    await renderDetail(c, 't1'); // album also contains t6 by "Guest"
    const byline = c.querySelectorAll('.detail-layout > div:nth-child(2) > div')[0].textContent;
    assert(/Various Artists/.test(byline), `album byline: "${byline.trim()}"`);
    c.remove();
  });

  await test('opening the Unknown Album group is not a blank page', async () => {
    const c = document.createElement('div');
    document.body.appendChild(c);
    await renderDetail(c, 't5'); // no album tag at all
    assert(c.querySelector('h1').textContent.trim() === 'Unknown Album',
      `heading for untagged tracks: "${c.querySelector('h1').textContent}"`);
    await nextTick();
    const rows = [...c.querySelectorAll('#track-list .media-list-item')].map((r) => r.dataset.id);
    assert(rows.length === 2, `expected both untagged tracks listed, got ${rows.join(',') || '(none)'}`);
    c.remove();
  });

  await test('the card play control is a real, labelled button', () => {
    const btn = firstLight.querySelector('.media-card-play');
    assert(btn.tagName === 'BUTTON', `expected <button>, got <${btn.tagName}>`);
    assert(btn.getAttribute('aria-label') === 'Play First Light', `aria-label: ${btn.getAttribute('aria-label')}`);
    assert(firstLight.getAttribute('role') === 'button' && firstLight.getAttribute('tabindex') === '0',
      'album card is not focusable as a button');
  });

  await test('the card play button still plays the whole album', () => {
    events.length = 0;
    firstLight.querySelector('.media-card-play').click();
    assert(opened().length === 0, 'the play button also opened the detail view');
    assert(played().length === 1, `expected 1 vault:play, got ${played().length}`);
    assert(played()[0].detail.item.id === 't1', `playback started at ${played()[0].detail.item.id}`);
    assert(played()[0].detail.queue.length === 3, `queue should be the 3 album tracks, got ${played()[0].detail.queue.length}`);
  });

  await test('Enter/Space on the focused card opens the album', () => {
    for (const key of ['Enter', ' ']) {
      events.length = 0;
      firstLight.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
      assert(played().length === 0, `${key} on the card started playback`);
      assert(opened().length === 1, `${key} on the card produced ${opened().length} open events`);
    }
  });

  await test('Space on the card play button plays, and does not also open', () => {
    events.length = 0;
    firstLight.querySelector('.media-card-play')
      .dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    assert(opened().length === 0, `Space on the play button also opened the album (${opened().length} opens)`);
  });

  // ------------------------------------------------------------------- genres
  console.log('[music-view-check] Genres filter — expanding instead of playing');

  chip('genre').click();
  const groups = [...container.querySelectorAll('.genre-group')];
  const findGroup = (genre) => {
    const g = groups.find((row) => row.querySelector('.genre-toggle')?.textContent.includes(genre));
    assert(g, `no ".genre-group" row for ${genre} (${groups.length} rows rendered)`);
    return g;
  };

  await test('a genre row expands into its track list instead of playing', async () => {
    events.length = 0;
    const jazz = findGroup('Jazz');
    const list = jazz.querySelector('.genre-tracks');
    assert(list.hidden === true, 'genre track list should start collapsed');
    assert(list.children.length === 0, 'genre track list should be built on first open');

    jazz.querySelector('.genre-toggle').click();
    await nextTick();
    assert(played().length === 0, `expanding a genre started playback (${played().length} vault:play events)`);
    assert(list.hidden === false, 'genre track list did not expand');
    assert(jazz.querySelector('.genre-toggle').getAttribute('aria-expanded') === 'true', 'aria-expanded not updated');
    const rows = [...list.querySelectorAll('.media-list-item')].map((r) => r.dataset.id);
    assert(rows.join(',') === 't3,t4', `Jazz should list t3,t4 — got ${rows.join(',') || '(no rows)'}`);

    jazz.querySelector('.genre-toggle').click();
    assert(list.hidden === true, 'genre track list did not collapse again');
    assert(jazz.querySelector('.genre-toggle').getAttribute('aria-expanded') === 'false', 'aria-expanded not restored');
  });

  await test('the genre play button plays the genre without expanding it', async () => {
    events.length = 0;
    const jazz = findGroup('Jazz');
    jazz.querySelector('.genre-play').click();
    assert(played().length === 1, `expected 1 vault:play, got ${played().length}`);
    assert(played()[0].detail.queue.length === 2, `queue should be the 2 Jazz tracks, got ${played()[0].detail.queue.length}`);
    assert(jazz.querySelector('.genre-tracks').hidden === true, 'playing a genre should not force it open');
  });

  // ------------------------------------------------- grouping survives a nav
  console.log('[music-view-check] grouping survives navigating into an album');

  chip('album').click();
  await test('choosing a grouping persists it', () => {
    assert(localStorage.getItem('vault_music_group_by') === 'album',
      `vault_music_group_by = ${localStorage.getItem('vault_music_group_by')}`);
  });

  await test('a fresh Music mount restores the grouping', async () => {
    // A brand-new store must read the grouping back from localStorage...
    const storeMod = await import(`${DOCS}store.js?fresh=${Date.now()}`);
    assert(storeMod.store.get('musicGroupBy') === 'album',
      `fresh store read musicGroupBy = ${storeMod.store.get('musicGroupBy')}`);
    // ...and a brand-new mount must land on the album grid, not on All Tracks.
    const mod = await import(`${DOCS}views/music.js?fresh=${Date.now()}`);
    const c = document.createElement('div');
    document.body.appendChild(c);
    mod.renderMusic(c);
    const active = [...c.querySelectorAll('[data-filter]')]
      .filter((b) => b.classList.contains('active'))
      .map((b) => b.dataset.filter);
    assert(active.length === 1 && active[0] === 'album', `active chips after remount: ${JSON.stringify(active)}`);
    assert(c.querySelector('#albums-grid'), 'restored grouping did not render the album grid');
  });

  await test('a bogus stored grouping falls back to All Tracks', async () => {
    // A stale value in localStorage must not leave the page on a dead filter.
    store.set('musicGroupBy', 'nonsense');
    const mod = await import(`${DOCS}views/music.js?bogus=${Date.now()}`);
    const c = document.createElement('div');
    document.body.appendChild(c);
    mod.renderMusic(c);
    const active = [...c.querySelectorAll('[data-filter]')]
      .filter((b) => b.classList.contains('active'))
      .map((b) => b.dataset.filter);
    assert(active.join(',') === 'all', `active chips with a bogus grouping: ${JSON.stringify(active)}`);
    assert(!c.querySelector('#albums-grid') && !c.querySelector('.genre-group'),
      'a bogus grouping still rendered a grouped view');
    store.set('musicGroupBy', 'album', true); // leave the store as we found it
  });

  console.log(`\n[music-view-check] ${checks - failed}/${checks} checks OK`);
  process.exit(failed ? 1 : 0);
})();
