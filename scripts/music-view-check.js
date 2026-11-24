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
const fs = require('node:fs');
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

  await test('album card includes cover image with loaded class and placeholder fallback', () => {
    const img = firstLight.querySelector('.media-card-cover img');
    assert(img, 'missing img inside .media-card-cover');
    assert(img.src.includes('/api/media/cover/t1'), `unexpected img src: ${img.src}`);
    assert(img.classList.contains('loaded'), 'img should have .loaded class so it is visible');
    const placeholder = firstLight.querySelector('.media-card-cover .media-card-placeholder');
    assert(placeholder, 'missing placeholder element inside .media-card-cover');
  });

  await test('CSS styles cover images with opacity 1 by default (not blanket opacity 0)', () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'css', 'components.css'), 'utf8');
    assert(!/\.media-card-cover\s+img\s*\{\s*[^}]*opacity:\s*0/i.test(css),
      'components.css must not set generic .media-card-cover img to opacity: 0');
  });

  await test('album card selects track with coverArtPath over first track without cover', async () => {
    const libWithCover = [
      { id: 'ca1', type: 'music', title: 'Song 1', artist: 'Artist', album: 'Art Album', track: 1 },
      { id: 'ca2', type: 'music', title: 'Song 2', artist: 'Artist', album: 'Art Album', track: 2, coverArtPath: '/covers/art.jpg', updatedAt: '2026-11-17T10:00:00.000Z' },
    ];
    store.setLibrary(libWithCover);
    const c = mount();
    chip('album').click();
    const artCard = c.querySelector('#albums-grid .media-card');
    assert(artCard, 'missing artCard');
    const artImg = artCard.querySelector('.media-card-cover img');
    assert(artImg.src.includes('/api/media/cover/ca2'), `expected cover url to use ca2 with coverArtPath, got ${artImg.src}`);
    assert(artImg.src.includes('&v='), `expected versioned cover url, got ${artImg.src}`);
    // Restore library
    store.setLibrary(lib);
    mount();
    chip('album').click();
  });

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
    const byline = c.querySelector('.album-header-sub').textContent;
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
    // The card is a focusable, named group (not role=button): it contains a
    // real Play <button>, and nesting interactive roles is invalid (axe
    // nested-interactive / WCAG 4.1.2). Enter/Space behaviour is tested below.
    assert(firstLight.getAttribute('role') === 'group' && firstLight.getAttribute('tabindex') === '0',
      'album card is not a focusable group');
    assert(firstLight.getAttribute('aria-label'), 'album card has no accessible name');
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
    // Cards in Grid mode, rows in List mode — either way the genre's songs.
    const rows = [...list.querySelectorAll('.media-card, .media-list-item')].map((r) => r.dataset.id);
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

  // ------------------------------------------------------- Grid / List
  console.log('[music-view-check] Grid / List works in every grouping');

  {
    localStorage.removeItem('vault_view_modes');
    store.set('viewModes', {});
    store.set('musicGroupBy', 'all');
    const c = mount();
    const pick = (name) => { c.querySelector(`[data-filter="${name}"]`).click(); };
    const layout = (mode) => { c.querySelector(`.view-toggle [data-view="${mode}"]`).click(); };
    const content = c.querySelector('#music-content');
    const count = (sel) => content.querySelectorAll(sel).length;

    await test('All Tracks: Grid shows cards, List shows rows', () => {
      pick('all'); layout('grid');
      assert(count('.media-card') === 6 && count('.media-list-item') === 0, `grid: ${count('.media-card')} cards / ${count('.media-list-item')} rows`);
      layout('list');
      assert(count('.media-list-item') === 6 && count('.media-card') === 0, `list: ${count('.media-card')} cards / ${count('.media-list-item')} rows`);
    });

    await test('Artists: the songs follow the Grid/List switch', () => {
      pick('artist'); layout('list');
      assert(count('.media-list-item') === 6 && count('.media-card') === 0, `list: ${count('.media-card')} cards / ${count('.media-list-item')} rows`);
      layout('grid');
      assert(count('.media-card') === 6 && count('.media-list-item') === 0, `grid: ${count('.media-card')} cards / ${count('.media-list-item')} rows`);
    });

    await test('Albums: Grid shows album cards, List shows album rows', () => {
      pick('album'); layout('grid');
      assert(count('#albums-grid .media-card') === 3, `grid: ${count('#albums-grid .media-card')} album cards`);
      layout('list');
      const rows = [...content.querySelectorAll('.media-list--albums .media-list-item')];
      assert(rows.length === 3 && count('.media-card') === 0, `list: ${rows.length} album rows, ${count('.media-card')} cards`);
      events.length = 0;
      rows.find((r) => r.textContent.includes('First Light')).click();
      assert(opened().length === 1 && played().length === 0, `row click: ${opened().length} opens, ${played().length} plays`);
      rows.find((r) => r.textContent.includes('First Light')).querySelector('.media-list-play').click();
      assert(played().length === 1 && played()[0].detail.queue.length === 3, 'album row Play should queue the 3 First Light tracks');
    });

    await test('Genres: an open genre redraws in the new layout and stays open', () => {
      pick('genre'); layout('list');
      const jazz = () => [...content.querySelectorAll('.genre-group')].find((g) => g.textContent.includes('Jazz'));
      jazz().querySelector('.genre-toggle').click();
      assert(jazz().querySelectorAll('.media-list-item').length === 2, 'list: Jazz should show 2 rows');
      layout('grid');
      assert(!jazz().querySelector('.genre-tracks').hidden, 'Jazz closed after switching layout');
      assert(jazz().querySelectorAll('.media-card').length === 2 && jazz().querySelectorAll('.media-list-item').length === 0, 'grid: Jazz should show 2 cards');
      jazz().querySelector('.genre-toggle').click();
    });

    await test('the choice is remembered per page', () => {
      assert(JSON.parse(localStorage.getItem('vault_view_modes') || '{}').music === 'grid', `vault_view_modes = ${localStorage.getItem('vault_view_modes')}`);
      const buttons = [...c.querySelectorAll('.view-toggle [data-view]')];
      assert(buttons.every((b) => b.getAttribute('aria-pressed') === String(b.classList.contains('active'))), 'aria-pressed out of sync');
    });
  }

  // ------------------------------------------------------ now playing
  console.log('[music-view-check] now-playing marks on every music view');

  {
    const raf = (fn) => setTimeout(fn, 0);
    if (typeof globalThis.requestAnimationFrame !== 'function') globalThis.requestAnimationFrame = raf;
    globalThis.MutationObserver = window.MutationObserver;
    if (typeof globalThis.CSS === 'undefined') globalThis.CSS = window.CSS || { escape: (v) => String(v) };
    const { initNowPlaying } = await import(`${DOCS}utils/nowPlaying.js`);
    initNowPlaying();
    const settle = () => new Promise((r) => setTimeout(r, 30));
    store.set('musicGroupBy', 'all');
    const c = mount();
    const content = c.querySelector('#music-content');
    const pick = (name) => c.querySelector(`[data-filter="${name}"]`).click();
    const layout = (mode) => c.querySelector(`.view-toggle [data-view="${mode}"]`).click();
    store.set('currentTrack', lib[2]); // t3 "Dusk" — Nova / Second Wind / Jazz
    store.set('isPlaying', true);

    const marked = () => [...content.querySelectorAll('.np-current')];

    await test('All Tracks marks the playing song (grid and list)', async () => {
      pick('all'); layout('grid'); await settle();
      let m = marked();
      assert(m.length === 1 && m[0].dataset.id === 't3' && m[0].querySelector('.np-badge'), `grid marks: ${m.map((e) => e.dataset.id)}`);
      layout('list'); await settle();
      m = marked();
      assert(m.length === 1 && m[0].dataset.id === 't3' && m[0].getAttribute('aria-current') === 'true', `list marks: ${m.map((e) => e.dataset.id)}`);
    });

    await test('Albums marks the album the song is on (grid and list)', async () => {
      pick('album'); layout('grid'); await settle();
      let m = marked();
      assert(m.length === 1 && m[0].textContent.includes('Second Wind') && m[0].querySelector('.np-badge'), `grid marks: ${m.length}`);
      layout('list'); await settle();
      m = marked();
      assert(m.length === 1 && m[0].textContent.includes('Second Wind'), `list marks: ${m.length}`);
    });

    await test('Artists and Genres mark the group and the song', async () => {
      pick('artist'); layout('list'); await settle();
      const titles = marked().filter((e) => e.classList.contains('music-group-title')).map((e) => e.textContent.trim());
      assert(titles.length === 1 && titles[0].startsWith('Nova'), `artist headings marked: ${JSON.stringify(titles)}`);
      assert(marked().some((e) => e.dataset.id === 't3'), 'the song row is not marked');
      pick('genre'); await settle();
      const heads = marked().map((e) => e.textContent.trim());
      assert(heads.length === 1 && heads[0].includes('Jazz'), `genre heads marked: ${JSON.stringify(heads)}`);
    });

    await test('pausing stops the bars, a new song moves the mark, stopping clears it', async () => {
      pick('all'); layout('list'); await settle();
      store.set('isPlaying', false); await settle();
      let m = marked();
      assert(m.length === 1 && !m[0].classList.contains('np-playing') && !m[0].querySelector('.np-badge.is-playing'), 'still animating while paused');
      store.set('currentTrack', lib[0]); store.set('isPlaying', true); await settle();
      m = marked();
      assert(m.length === 1 && m[0].dataset.id === 't1' && m[0].classList.contains('np-playing'), `after switching: ${m.map((e) => e.dataset.id)}`);
      assert(!content.querySelector('[data-id="t3"] .np-badge'), 'old song kept its badge');
      store.set('currentTrack', null); await settle();
      assert(marked().length === 0 && !content.querySelector('.np-badge'), 'marks left after stopping');
    });

    await test('the album page marks the playing track', async () => {
      store.set('currentTrack', lib[1]); store.set('isPlaying', true);
      const page = document.createElement('div');
      document.body.appendChild(page);
      await renderDetail(page, 't1');
      await nextTick(); await settle();
      const rows = [...page.querySelectorAll('.media-list-item.np-current')].map((r) => r.dataset.id);
      assert(rows.join(',') === 't2', `album page marked rows: ${rows.join(',') || '(none)'}`);
      assert(page.querySelector('.album-header-meta.np-current'), 'album header not marked');
      page.remove();
      store.set('currentTrack', null);
    });

    await test('one indicator everywhere: bars in front of the title, never on the artwork', async () => {
      store.set('currentTrack', lib[2]); store.set('isPlaying', true);
      for (const [group, mode] of [['all', 'grid'], ['all', 'list'], ['album', 'grid'], ['album', 'list']]) {
        pick(group); layout(mode); await settle();
        const badges = [...content.querySelectorAll('.np-badge')];
        assert(badges.length >= 1, `${group}/${mode}: no indicator`);
        for (const badge of badges) {
          assert(!badge.closest('.media-card-cover, .media-list-item-cover'), `${group}/${mode}: indicator drawn on the artwork`);
          assert(!badge.querySelector('.np-label'), `${group}/${mode}: indicator has a text label`);
          const title = badge.closest('.media-card-title, .media-list-item-title');
          assert(title && title.firstElementChild === badge, `${group}/${mode}: indicator is not in front of the title`);
        }
      }
      const page = document.createElement('div');
      document.body.appendChild(page);
      await renderDetail(page, 't3');
      await nextTick(); await settle();
      const row = page.querySelector('.media-list-item.np-current');
      assert(row && row.querySelector('.media-list-item-title > .np-badge:first-child'), 'album page row: indicator not in front of the title');
      assert(!page.querySelector('.media-list-item-cover .np-badge'), 'album page: indicator drawn on the cover');
      page.remove();
      store.set('currentTrack', null); await settle();
    });

    await test('a restored track with an outdated id still marks its library copy', async () => {
      // Same song, but the id it had before a rescan / moved folder.
      store.set('currentTrack', { ...lib[2], id: 'old-id-from-a-saved-queue' });
      store.set('isPlaying', false);
      pick('all'); layout('list'); await settle();
      const rows = marked().map((e) => e.dataset.id);
      assert(rows.join(',') === 't3', `marked: ${rows.join(',') || '(none)'}`);
      assert(!marked()[0].classList.contains('np-playing'), 'paused song shows the playing animation');
      store.set('currentTrack', null); await settle();
    });

    await test('a video closed without its event does not hide the music', async () => {
      const modal = document.createElement('div');
      modal.id = 'video-modal';
      modal.hidden = true;
      document.body.appendChild(modal);
      window.dispatchEvent(new CustomEvent('vault:video-opened', { detail: { item: lib[6] } }));
      store.set('currentTrack', lib[2]); store.set('isPlaying', true);
      pick('all'); layout('list'); await settle();
      assert(marked().map((e) => e.dataset.id).join(',') === 't3', 'stale video id hid the playing song');
      window.dispatchEvent(new CustomEvent('vault:video-closed'));
      modal.remove();
      store.set('currentTrack', null); await settle();
    });
  }

  // ------------------------------------------------------- liked songs
  console.log('[music-view-check] Liked Songs — a heart on every song');

  {
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const { api } = await import(`${DOCS}api.js`);
    const calls = [];
    api.addFavourite = async (id) => { calls.push(['add', id]); return {}; };
    api.removeFavourite = async (id) => { calls.push(['remove', id]); return {}; };
    const { initLikes, likedSongs } = await import(`${DOCS}utils/likes.js`);
    initLikes();
    store.set('favourites', [], true);
    store.set('musicGroupBy', 'all');
    const c = mount();
    c.querySelector('.view-toggle [data-view="list"]').click();
    await nextTick();
    const content = c.querySelector('#music-content');

    await test('every song row has a heart (and nothing else does)', () => {
      const rows = [...content.querySelectorAll('.media-list-item')];
      const songs = rows.filter((r) => lib.find((i) => i.id === r.dataset.id)?.type === 'music');
      assert(songs.length && songs.every((r) => r.querySelector('.like-btn[data-like-id]')), 'a song row has no heart');
      const film = rows.find((r) => r.dataset.id === 'm1');
      assert(!film || !film.querySelector('.like-btn'), 'the film got a heart');
    });

    await test('clicking a heart likes the song without playing it, and syncs to the server', async () => {
      events.length = 0;
      content.querySelector('[data-id="t2"] .like-btn').click();
      content.querySelector('[data-id="t5"] .like-btn').click();
      await settle();
      assert(played().length === 0, 'the heart click also played the song');
      assert(JSON.stringify(store.get('favourites')) === '["t2","t5"]', `favourites: ${JSON.stringify(store.get('favourites'))}`);
      assert(calls.filter((x) => x[0] === 'add').map((x) => x[1]).join(',') === 't2,t5', `server calls: ${JSON.stringify(calls)}`);
      const btn = content.querySelector('[data-id="t2"] .like-btn');
      assert(btn.classList.contains('is-liked') && btn.getAttribute('aria-pressed') === 'true', 'the heart did not fill');
      assert(JSON.parse(localStorage.getItem('vault_favourites')).length === 2, 'likes were not saved locally');
    });

    await test('Liked Songs lists them newest first and plays the list', async () => {
      assert(likedSongs().map((i) => i.id).join(',') === 't5,t2', `order: ${likedSongs().map((i) => i.id)}`);
      const { renderLiked } = await import(`${DOCS}views/liked.js`);
      const page = document.createElement('div');
      document.body.appendChild(page);
      renderLiked(page);
      await nextTick();
      const rows = [...page.querySelectorAll('.media-list-item')].map((r) => r.dataset.id);
      assert(rows.join(',') === 't5,t2', `liked rows: ${rows.join(',')}`);
      assert(/2 songs/.test(page.querySelector('.liked-meta').textContent), 'song count missing');
      events.length = 0;
      page.querySelector('#liked-play').click();
      const p = played();
      assert(p.length === 1 && p[0].detail.queue.map((i) => i.id).join(',') === 't5,t2', 'Play did not queue the liked songs');
      // Unliking on the page removes the row.
      page.querySelector('[data-id="t5"] .like-btn').click();
      await settle();
      const after = [...page.querySelectorAll('.media-list-item')].map((r) => r.dataset.id);
      assert(after.join(',') === 't2', `after unlike: ${after.join(',')}`);
      assert(calls.some((x) => x[0] === 'remove' && x[1] === 't5'), 'unlike was not sent to the server');
      // Other hearts for the same song repaint.
      const listBtn = content.querySelector('[data-id="t5"] .like-btn');
      assert(listBtn && !listBtn.classList.contains('is-liked'), 'the music list heart did not repaint');
      page.remove();
    });

    await test('the artist page has a heart on every track', async () => {
      const { renderArtist } = await import(`${DOCS}views/artists.js`);
      const page = document.createElement('div');
      document.body.appendChild(page);
      renderArtist(page, 'Nova');
      const rows = [...page.querySelectorAll('.track-row')];
      assert(rows.length === 3 && rows.every((r) => r.querySelector('.track-like')), `artist rows with hearts: ${rows.filter((r) => r.querySelector('.track-like')).length}/${rows.length}`);
      assert(page.querySelector('.track-row[data-track="t2"] .track-like.is-liked'), 'liked state not shown on the artist page');
      page.remove();
      store.set('favourites', [], true);
    });
  }

  // ------------------------------------------------ artist links
  console.log('[music-view-check] artist names lead to the artist page');

  await test('the album page byline links to the artist', async () => {
    store.setLibrary(lib);
    const page = document.createElement('div');
    document.body.appendChild(page);
    await renderDetail(page, 't3'); // Second Wind — Nova
    const link = page.querySelector('.album-header-sub .artist-link');
    assert(link, 'no artist link under the album title');
    assert(link.textContent.trim() === 'Nova', `link text: ${link.textContent}`);
    assert(link.getAttribute('data-route') === '/artist/Nova', `data-route: ${link.getAttribute('data-route')}`);
    page.remove();
  });

  await test('"Various Artists" stays plain text', async () => {
    const page = document.createElement('div');
    document.body.appendChild(page);
    await renderDetail(page, 't1'); // First Light — Nova + Guest
    const sub = page.querySelector('.album-header-sub');
    assert(/Various Artists/.test(sub.textContent), `byline: ${sub.textContent}`);
    assert(!sub.querySelector('a'), 'Various Artists was linked');
    page.remove();
  });

  await test('an album-artist tag without its own page falls back to the track artist', async () => {
    const tagged = lib.map((t) => (t.album === 'Second Wind' ? { ...t, albumArtist: 'Nova & Friends' } : t));
    store.setLibrary(tagged);
    const page = document.createElement('div');
    document.body.appendChild(page);
    await renderDetail(page, 't3');
    const link = page.querySelector('.album-header-sub .artist-link');
    assert(link && link.textContent.trim() === 'Nova & Friends', `link: ${link?.outerHTML}`);
    assert(link.getAttribute('data-route') === '/artist/Nova', `data-route: ${link?.getAttribute('data-route')}`);
    page.remove();
    store.setLibrary(lib);
  });

  await test('the artist on an album card links to the artist without opening the album', async () => {
    store.set('musicGroupBy', 'album');
    const c = mount();
    c.querySelector('.view-toggle [data-view="grid"]').click();
    const card = [...c.querySelectorAll('#albums-grid .media-card')]
      .find((el) => el.querySelector('.media-card-title').textContent.trim() === 'Second Wind');
    const link = card && card.querySelector('.media-card-meta .artist-link');
    assert(link && link.getAttribute('data-route') === '/artist/Nova', 'album card has no artist link');
    events.length = 0;
    link.click();
    assert(opened().length === 0, 'clicking the artist also opened the album');
    c.querySelector('.view-toggle [data-view="list"]').click();
    const row = [...c.querySelectorAll('.media-list--albums .media-list-item, .media-list-item')]
      .find((el) => /Second Wind/.test(el.textContent));
    assert(row && row.querySelector('.media-list-cell--artist .artist-link'), 'album list row has no artist link');
  });

  // -------------------------------------------- big library (windowed grid)
  console.log('[music-view-check] Grid → List on a big library');

  await test('switching to List stops the windowed grid', async () => {
    globalThis.getComputedStyle = window.getComputedStyle.bind(window);
    const big = Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, type: 'music', title: `Big ${i}`, artist: 'Many', album: 'Lots', genre: 'Pop', track: i + 1, duration: 60, filename: `b${i}.mp3`, path: `/m/b${i}.mp3`, fileSize: 1 }));
    store.setLibrary(big);
    store.set('musicGroupBy', 'all');
    const c = mount();
    const content = c.querySelector('#music-content');
    c.querySelector('.view-toggle [data-view="grid"]').click();
    assert(content._vaultVirtualGrid && content.classList.contains('virtual-grid'), 'expected a windowed grid for 200 songs');
    c.querySelector('.view-toggle [data-view="list"]').click();
    assert(!content._vaultVirtualGrid && !content.classList.contains('virtual-grid'), 'the windowed grid was left running under the list');
    assert(content.querySelectorAll('.media-list-item').length === 200, `list rows: ${content.querySelectorAll('.media-list-item').length}`);
    store.setLibrary(lib);
  });

  console.log(`\n[music-view-check] ${checks - failed}/${checks} checks OK`);
  process.exit(failed ? 1 : 0);
})();
