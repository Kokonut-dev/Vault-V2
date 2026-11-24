/**
 * Liked Songs — the heart on every song (Spotify-style).
 *
 * Built on the existing favourites (store `favourites`, synced to
 * /api/playlists/favourites per profile), so a song liked here is also a
 * favourite and vice versa. The "Liked Songs" playlist (views/liked.js) is
 * the music part of that list, newest like first.
 *
 * Views only render `likeButton(item)`; one delegated click handler toggles
 * it (without also playing / opening the row it sits in) and one store
 * subscription repaints every heart on screen when the list changes, from
 * any source (another heart, the detail page, sign-in sync, keyboard).
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { icon, setIcon } from './icons.js';
import { escapeHtml } from './format.js';

const SELECTOR = '[data-like-id]';
let started = false;

/** Songs only: music tracks. Audiobooks, podcasts and films keep "Favourite". */
export function isSong(item) {
  return Boolean(item && item.type === 'music' && item.id !== undefined && item.id !== null && item.id !== '');
}

export function isLiked(id) {
  if (id === undefined || id === null) return false;
  return (store.get('favourites') || []).includes(String(id)) || (store.get('favourites') || []).includes(id);
}

/** Liked songs from the library, most recently liked first. */
export function likedSongs(library = store.get('library') || []) {
  const byId = new Map(library.filter(isSong).map((item) => [String(item.id), item]));
  const out = [];
  const favs = store.get('favourites') || [];
  for (let i = favs.length - 1; i >= 0; i -= 1) {
    const item = byId.get(String(favs[i]));
    if (item) out.push(item);
  }
  return out;
}

function labelFor(liked, title) {
  const name = title ? ` ${title}` : '';
  return liked ? `Remove${name} from Liked Songs` : `Save${name} to Liked Songs`;
}

/** Heart button markup for one song ('' for anything else). */
export function likeButton(item, { size = 16, className = '' } = {}) {
  if (!isSong(item)) return '';
  const liked = isLiked(item.id);
  const id = escapeHtml(String(item.id));
  const title = escapeHtml(item.title || '');
  return `<button type="button" class="like-btn${liked ? ' is-liked' : ''}${className ? ` ${className}` : ''}" data-like-id="${id}" data-like-title="${title}" data-like-size="${size}" aria-pressed="${liked}" aria-label="${labelFor(liked, title)}" title="${liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'}">${icon(liked ? 'heart-filled' : 'heart', { size })}</button>`;
}

/** Bring one heart in line with the store. */
export function paintLikeButton(btn) {
  if (!btn) return;
  const id = btn.dataset.likeId;
  const liked = Boolean(id) && isLiked(id);
  btn.classList.toggle('is-liked', liked);
  btn.setAttribute('aria-pressed', String(liked));
  btn.setAttribute('aria-label', labelFor(liked, btn.dataset.likeTitle || ''));
  btn.title = liked ? 'Remove from Liked Songs' : 'Save to Liked Songs';
  setIcon(btn, liked ? 'heart-filled' : 'heart', { size: Number(btn.dataset.likeSize) || 16 });
}

export function paintAllLikeButtons(root = document) {
  root.querySelectorAll(SELECTOR).forEach(paintLikeButton);
}

let toastMod = null;
async function notify(message) {
  try {
    toastMod = toastMod || await import('../components/toast.js');
    toastMod.toast.info(message);
  } catch { /* toasts are optional */ }
}

/**
 * Like / unlike. Local first (instant, works offline), then the server;
 * a failed request is retried by the sign-in merge in profileSession.js.
 */
export async function toggleLike(id, { quiet = false } = {}) {
  if (id === undefined || id === null || id === '') return false;
  const key = String(id);
  const favs = (store.get('favourites') || []).map(String);
  const liked = !favs.includes(key);
  store.set('favourites', liked ? [...favs, key] : favs.filter((f) => f !== key), true);
  if (!quiet) notify(liked ? 'Added to Liked Songs' : 'Removed from Liked Songs');
  try {
    if (liked) await api.addFavourite(key);
    else await api.removeFavourite(key);
  } catch { /* kept locally; synced on next sign-in */ }
  return liked;
}

export function initLikes() {
  if (started) return;
  started = true;
  // Capture phase: the heart sits inside rows/cards that play on click.
  document.addEventListener('click', (event) => {
    const btn = event.target?.closest?.(SELECTOR);
    if (!btn || btn.disabled || !btn.dataset.likeId) return;
    event.preventDefault();
    event.stopPropagation();
    toggleLike(btn.dataset.likeId);
  }, true);
  // Keyboard: Enter/Space on a focused heart must not reach the row's handler.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const btn = event.target?.closest?.(SELECTOR);
    if (!btn) return;
    event.stopPropagation();
  }, true);
  store.subscribe('favourites', () => paintAllLikeButtons());
}

export default { initLikes, likeButton, toggleLike, isLiked, likedSongs, isSong, paintAllLikeButtons };
