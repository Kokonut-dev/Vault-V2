/**
 * Liked Songs — the playlist of every song you hearted (Spotify-style).
 *
 * The hearts live on every song (utils/likes.js); this page lists the music
 * among your favourites, most recently liked first. Unliking a song here
 * removes it straight away. Play / Shuffle queue the whole list.
 */
import { store } from '../store.js';
import { renderMediaList } from '../components/mediaList.js';
import { subscribeView } from '../utils/lifecycle.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, durationSeconds, formatTotalDuration } from '../utils/format.js';
import { likedSongs } from '../utils/likes.js';
import { npIds } from '../utils/nowPlaying.js';

const SORTS = {
  title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }),
  artist: (a, b) => String(a.artist || '').localeCompare(String(b.artist || ''), undefined, { sensitivity: 'base' })
    || String(a.album || '').localeCompare(String(b.album || '')) || (Number(a.track) || 0) - (Number(b.track) || 0),
  duration: (a, b) => durationSeconds(a.duration) - durationSeconds(b.duration),
  year: (a, b) => (Number(a.year) || 0) - (Number(b.year) || 0),
};

function play(queue, item) {
  if (!queue.length) return;
  const index = Math.max(0, queue.findIndex((i) => i.id === item?.id));
  window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: queue[index], queue, index } }));
}

function shuffled(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function renderLiked(container) {
  container.className = 'page liked-page';
  // null = the order you liked them in (newest first).
  let sortField = null;
  let sortOrder = 'asc';

  const ordered = () => {
    const songs = likedSongs();
    if (!sortField || !SORTS[sortField]) return songs;
    const sorted = [...songs].sort(SORTS[sortField]);
    return sortOrder === 'desc' ? sorted.reverse() : sorted;
  };

  function render() {
    const songs = ordered();
    const seconds = songs.reduce((sum, s) => sum + durationSeconds(s.duration), 0);
    const meta = [
      `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`,
      songs.length ? formatTotalDuration(seconds) : null,
    ].filter(Boolean);

    container.innerHTML = `
      <header class="liked-hero">
        <div class="liked-cover" aria-hidden="true">${icon('heart-filled', { size: 56 })}</div>
        <div class="liked-hero-body">
          <p class="hero-overline">Playlist</p>
          <h1 class="page-title liked-title" data-np-ids="${escapeHtml(npIds(songs))}">Liked Songs<span class="np-slot" data-np-slot="inline"></span></h1>
          <div class="liked-meta">${meta.map((m) => `<span>${escapeHtml(m)}</span>`).join('')}</div>
          <div class="liked-actions">
            <button type="button" class="btn btn-primary" id="liked-play" ${songs.length ? '' : 'disabled'}>${icon('play', { size: 16 })}<span>Play</span></button>
            <button type="button" class="btn btn-secondary" id="liked-shuffle" ${songs.length ? '' : 'disabled'}>${icon('shuffle', { size: 16 })}<span>Shuffle</span></button>
            ${sortField ? `<button type="button" class="btn btn-ghost btn-sm" id="liked-unsort">Recently liked first</button>` : ''}
          </div>
        </div>
      </header>
      <div id="liked-list"></div>
    `;

    const list = container.querySelector('#liked-list');
    if (!songs.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('heart', { size: 30 })}</div>
          <div class="empty-state-title">Songs you like will appear here</div>
          <div class="empty-state-message">Tap the heart next to any song — in Music, on an album or artist page, or in the player — to save it here.</div>
          <a class="btn btn-primary" href="/music" data-route="/music">Browse music</a>
        </div>`;
    } else {
      renderMediaList(list, songs, {
        // Clicking a song plays the rest of the list after it.
        onPlay: (item) => play(songs, item),
        sortField: sortField || '',
        sortOrder,
        onSort: (field, order) => { sortField = field; sortOrder = order; render(); },
      });
    }

    container.querySelector('#liked-play')?.addEventListener('click', () => play(songs, songs[0]));
    container.querySelector('#liked-shuffle')?.addEventListener('click', () => {
      const queue = shuffled(songs);
      play(queue, queue[0]);
    });
    container.querySelector('#liked-unsort')?.addEventListener('click', () => { sortField = null; render(); });
  }

  render();
  subscribeView(store, 'favourites', render);
  subscribeView(store, 'library', render);
}

export default { renderLiked };
