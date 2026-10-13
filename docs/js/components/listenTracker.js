/**
 * Listen tracker — turns real playback into the listen-time data the Stats
 * page reads from /api/extras/listens.
 *
 * Both players already emit `vault:timeupdate` while media is playing. We add
 * up the *media-time* delta between ticks (so pauses and buffering cost
 * nothing), ignore large jumps (seeks), and report in batches of at least
 * FLUSH_SECONDS. The server rounds to whole seconds, so sending tiny deltas
 * would be dropped.
 */
import { api } from '../api.js';
import { store } from '../store.js';

const FLUSH_SECONDS = 15;
const MAX_TICK_GAP = 2; // larger jumps are seeks, not listening

let activeId = null;
let lastTime = null;
let pending = 0;

function flush() {
  if (!activeId || pending < 1) return;
  const seconds = Math.round(pending);
  const itemId = activeId;
  pending = 0;
  api.recordListen(itemId, seconds).catch(() => {});
}

function resolveItemId(detail) {
  // Video ticks carry the item; audio ticks don't, so use the current track.
  if ('item' in detail) return detail.item?.id || null;
  return store.get('currentTrack')?.id || null;
}

function onTimeUpdate(event) {
  const detail = event.detail || {};
  const time = Number(detail.currentTime);
  if (!Number.isFinite(time)) return;

  const id = resolveItemId(detail);
  if (!id) {
    flush();
    activeId = null;
    lastTime = null;
    return;
  }

  if (id !== activeId) {
    flush();
    activeId = id;
    lastTime = time;
    return;
  }

  const delta = time - (lastTime ?? time);
  lastTime = time;
  if (delta > 0 && delta <= MAX_TICK_GAP) {
    pending += delta;
    if (pending >= FLUSH_SECONDS) flush();
  }
}

export function initListenTracker() {
  window.addEventListener('vault:timeupdate', onTimeUpdate);
  // Track changes and ends hand the remainder to the server before the item changes.
  window.addEventListener('vault:track-changed', flush);
}
