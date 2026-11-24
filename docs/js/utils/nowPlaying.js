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

let state = { id: null, playing: false };
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

/** What is playing right now: the open video, otherwise the audio player's track. */
function readState() {
  if (videoId) {
    const video = document.getElementById('video-element');
    return { id: videoId, playing: Boolean(video && !video.paused && !video.ended) };
  }
  const track = store.get('currentTrack');
  const id = track && track.id !== undefined && track.id !== null ? String(track.id) : null;
  return { id, playing: Boolean(id && store.get('isPlaying')) };
}

function matches(el, id) {
  if (!id) return false;
  if (el.dataset.npId === id) return true;
  return (el.dataset.npIds || '').split(/\s+/).includes(id);
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
  const { id, playing } = state;
  root.querySelectorAll(`.${CURRENT}`).forEach((el) => { if (!matches(el, id)) unmark(el); });
  if (!id) return;
  const value = escapeValue(id);
  root.querySelectorAll(`[data-np-id="${value}"],[data-np-ids~="${value}"]`).forEach((el) => mark(el, playing));
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
