/**
 * "Now playing" marker, shared by every page.
 *
 * Each view used to decide for itself whether to highlight the playing item,
 * so only the artist page did (album pages, the Music grid/list, playlists,
 * favourites, history, search… showed nothing). Now views only label what an
 * element stands for and this module does the marking for the whole app:
 *
 *   data-np-id="<item id>"         one song / episode / film (row, card)
 *   data-np-ids="<id> <id> …"      a group that contains it (album, artist,
 *                                   genre, playlist card)
 *   data-np-slot="cover|inline"    where the animated bars go inside that
 *                                   element (optional — without a slot the
 *                                   element only gets the classes)
 *
 * Matching elements get `.np-current` (and `.np-playing` while sound is
 * actually playing, so the bars stop when paused). Single items also get
 * aria-current="true". A MutationObserver re-marks after any re-render, so a
 * view never has to subscribe to the player itself.
 */
import { store } from '../store.js';

const CURRENT = 'np-current';
const PLAYING = 'np-playing';
const OWNER = '[data-np-id],[data-np-ids]';

let state = { id: null, ids: [], playing: false };
let videoId = null;
let scheduled = 0;
let started = false;

/** Attribute value for a group: the ids of everything in it. */
export function npIds(items) {
  return (items || []).map((item) => item?.id).filter((id) => id !== undefined && id !== null && id !== '')
    .map(String).join(' ');
}

function escapeValue(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

const norm = (value) => String(value ?? '').trim().toLowerCase();
const songKey = (item) => [norm(item.title), norm(item.artist || item.albumArtist), norm(item.album)].join('\u0001');

let aliasMemo = { track: null, library: null, ids: [] };

/**
 * Every id that stands for the playing track. Normally just its own id, but a
 * track restored from an older queue (or handed over from another device)
 * can carry an id the library no longer has — after a rescan, a moved music
 * folder or a re-import the same song gets a new id. Then the library copy
 * with the same file path, or the same title + artist + album, is marked
 * instead of nothing.
 */
function idsFor(track, id) {
  const library = store.get('library') || [];
  if (aliasMemo.track === track && aliasMemo.library === library && aliasMemo.ids[0] === id) return aliasMemo.ids;
  const ids = [id];
  if (library.length && !library.some((item) => String(item?.id) === id)) {
    const path = track.filePath || track.path || null;
    const key = track.title ? songKey(track) : null;
    for (const item of library) {
      if (!item || item.id === undefined || item.id === null) continue;
      const samePath = path && (item.filePath === path || item.path === path);
      const sameSong = key && item.type === track.type && songKey(item) === key;
      if (samePath || sameSong) ids.push(String(item.id));
    }
  }
  aliasMemo = { track, library, ids };
  return ids;
}

function videoOpen() {
  const modal = document.getElementById('video-modal');
  // No modal in the page (tests, embeds): trust the open/close events.
  return !modal || modal.classList.contains('active');
}

/** What is playing right now: the open video, otherwise the audio player's track. */
function readState() {
  // A video that was closed without its "closed" event must not hide the
  // music that is playing now.
  if (videoId && !videoOpen()) videoId = null;
  if (videoId) {
    const video = document.getElementById('video-element');
    return { id: videoId, ids: [videoId], playing: Boolean(video && !video.paused && !video.ended) };
  }
  const track = store.get('currentTrack');
  const id = track && track.id !== undefined && track.id !== null ? String(track.id) : null;
  return { id, ids: id ? idsFor(track, id) : [], playing: Boolean(id && store.get('isPlaying')) };
}

function matches(el, ids) {
  if (!ids || !ids.length) return false;
  if (el.dataset.npId !== undefined && ids.includes(el.dataset.npId)) return true;
  const group = (el.dataset.npIds || '').split(/\s+/);
  return ids.some((id) => group.includes(id));
}

/** The element's own slot — not one belonging to a nested item. */
function slotFor(el) {
  if (el.hasAttribute('data-np-slot')) return el;
  for (const slot of el.querySelectorAll('[data-np-slot]')) {
    if (slot.closest(OWNER) === el) return slot;
  }
  return null;
}

function badgeLabel(playing) {
  return playing ? 'Playing' : 'Paused';
}

function mark(el, playing) {
  el.classList.add(CURRENT);
  el.classList.toggle(PLAYING, playing);
  if (el.dataset.npId !== undefined && el.getAttribute('aria-current') !== 'true') {
    el.setAttribute('aria-current', 'true');
    el.dataset.npAria = '1';
  }
  const slot = slotFor(el);
  if (!slot) return;
  let badge = [...slot.children].find((child) => child.classList.contains('np-badge'));
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'np-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = '<span class="np-eq"><i></i><i></i><i></i></span><span class="np-label"></span>';
    if (slot.dataset.npSlot === 'start') slot.prepend(badge);
    else slot.append(badge);
  }
  badge.classList.toggle('is-playing', playing);
  const label = badge.querySelector('.np-label');
  const text = badgeLabel(playing);
  if (label && label.textContent !== text) label.textContent = text;
}

function unmark(el) {
  el.classList.remove(CURRENT, PLAYING);
  if (el.dataset.npAria) {
    el.removeAttribute('aria-current');
    delete el.dataset.npAria;
  }
  const slot = slotFor(el);
  if (slot) [...slot.children].forEach((child) => { if (child.classList.contains('np-badge')) child.remove(); });
}

/** Mark/unmark everything under `root` for the current state. */
export function markNowPlaying(root = document) {
  const { ids, playing } = state;
  root.querySelectorAll(`.${CURRENT}`).forEach((el) => { if (!matches(el, ids)) unmark(el); });
  if (!ids || !ids.length) return;
  const selector = ids.map((id) => {
    const value = escapeValue(id);
    return `[data-np-id="${value}"],[data-np-ids~="${value}"]`;
  }).join(',');
  root.querySelectorAll(selector).forEach((el) => mark(el, playing));
}

function refresh() {
  scheduled = 0;
  state = readState();
  markNowPlaying(document);
}

function schedule() {
  if (scheduled) return;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  scheduled = raf(refresh) || 1;
}

/** Elements were added (a view rendered) — ignore text-only updates like the player clock. */
function addsElements(records) {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType === 1) return true;
    }
  }
  return false;
}

export function initNowPlaying() {
  if (started) return;
  started = true;
  store.subscribe('currentTrack', schedule);
  store.subscribe('isPlaying', schedule);
  // A rescan can give the playing song a new id (see idsFor).
  store.subscribe('library', schedule);

  window.addEventListener('vault:video-opened', (event) => {
    const item = event.detail?.item;
    videoId = item?.id !== undefined && item?.id !== null && !item.live ? String(item.id) : null;
    schedule();
  });
  window.addEventListener('vault:video-closed', () => { videoId = null; schedule(); });
  const video = document.getElementById('video-element');
  if (video) ['play', 'playing', 'pause', 'ended', 'emptied'].forEach((type) => video.addEventListener(type, schedule));

  if (typeof MutationObserver === 'function' && document.body) {
    new MutationObserver((records) => { if (addsElements(records)) schedule(); })
      .observe(document.body, { childList: true, subtree: true });
  }
  schedule();
}

export default { initNowPlaying, markNowPlaying, npIds };
