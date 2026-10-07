/**
 * Artists — browse by performer and open an artist page (Apple Music /
 * Spotify / Navidrome pattern). Data comes from the library store, so it works
 * offline and with zero extra requests.
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { renderSkeletonGrid } from '../components/mediaGrid.js';
import { subscribeView } from '../utils/lifecycle.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime, truncate } from '../utils/format.js';
import { toast } from '../components/toast.js';

function musicItems() {
  return (store.get('library') || []).filter(item => item.type === 'music');
}

function groupByArtist(items) {
  const map = new Map();
  for (const item of items) {
    const artist = item.artist || item.albumArtist || 'Unknown artist';
    if (!map.has(artist)) map.set(artist, []);
    map.get(artist).push(item);
  }
  return map;
}

export function renderArtists(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('headphones', { size: 26 })}<span>Artists</span></h1>
      <p class="page-subtitle">Your music library, grouped by artist</p>
    </div>
    <div id="artists-content"></div>
  `;
  const content = container.querySelector('#artists-content');
  renderSkeletonGrid(content, 8);

  function paint() {
    const items = musicItems();
    const grouped = groupByArtist(items);
    if (!grouped.size) {
      content.innerHTML = `<div class="empty-state">${icon('headphones', { size: 30 })}
        <div class="empty-state-title">No music yet</div>
        <div class="empty-state-message">Add audio files to a music library and run a scan.</div></div>`;
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'media-grid stagger';
    [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([artist, tracks]) => {
        const albums = new Set(tracks.map(t => t.album).filter(Boolean));
        const card = document.createElement('a');
        card.className = 'media-card';
        card.dataset.type = 'music';
        card.href = `#/artist/${encodeURIComponent(artist)}`;
        card.innerHTML = `
          <div class="media-card-cover music">
            <img loading="lazy" src="${api.getCoverUrl(tracks[0].id)}" alt="">
            <div class="media-card-placeholder" aria-hidden="true">${icon('headphones', { size: 34 })}</div>
          </div>
          <div class="media-card-info">
            <div class="media-card-title">${escapeHtml(truncate(artist, 40))}</div>
            <div class="media-card-meta">${albums.size || '—'} album(s) · ${tracks.length} track(s)</div>
          </div>
        `;
        grid.appendChild(card);
      });
    content.replaceChildren(grid);
  }

  paint();
  subscribeView(store, 'library', paint);
}

export async function renderArtist(container, name) {
  const artist = decodeURIComponent(name || '');
  container.className = 'page';
  const tracks = musicItems().filter(item => (item.artist || item.albumArtist || 'Unknown artist') === artist);

  if (!tracks.length) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-state-title">Nothing found for “${escapeHtml(artist)}”</div>
      <div class="empty-state-message">The library may still be scanning, or the artist name differs.</div>
      <a class="btn btn-primary" href="#/artists">Back to artists</a></div>`;
    return;
  }

  const albums = [...new Set(tracks.map(t => t.album).filter(Boolean))];
  const seconds = tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
  const coverId = tracks[0].id;

  container.innerHTML = `
    <div class="hero artist-hero">
      <img class="hero-backdrop" src="${api.getCoverUrl(coverId)}" alt="" onerror="this.style.display='none'">
      <div class="hero-meta">
        <span class="quality-badge">Artist</span>
        <span>${albums.length} album(s)</span>
        <span>${tracks.length} track(s)</span>
        <span>${formatTime(seconds)}</span>
      </div>
      <h1 class="hero-title">${escapeHtml(artist)}</h1>
      <div class="hero-actions">
        <button class="btn btn-primary" id="artist-play">${icon('play', { size: 16 })}<span>Play all</span></button>
        <button class="btn btn-secondary" id="artist-shuffle">${icon('shuffle', { size: 16 })}<span>Shuffle</span></button>
        <button class="btn btn-ghost" id="artist-queue">${icon('list', { size: 16 })}<span>Add to queue</span></button>
      </div>
    </div>
    ${albums.map(album => {
      const albumTracks = tracks.filter(t => t.album === album);
      return `
        <section class="section">
          <h2 class="section-title">${escapeHtml(album)} <span class="row-meta">· ${albumTracks.length} track(s) · ${formatTime(albumTracks.reduce((s, t) => s + (t.duration || 0), 0))}</span></h2>
          <div class="media-list">
            ${albumTracks.sort((a, b) => (a.track || 0) - (b.track || 0)).map(track => `
              <div class="media-list-item" data-track="${track.id}" role="button" tabindex="0">
                <div class="media-list-item-main">
                  <button class="media-list-play" type="button" aria-label="Play ${escapeHtml(track.title)}">${icon('play', { size: 13 })}</button>
                  <div style="min-width:0">
                    <div class="media-list-item-title">${escapeHtml(track.title)}</div>
                    <div class="media-list-item-artist">${track.track ? `Track ${track.track}` : ''}</div>
                  </div>
                </div>
                <div class="row-meta">${formatTime(track.duration || 0)}</div>
              </div>`).join('')}
          </div>
        </section>`;
    }).join('')}
  `;

  const queue = [...tracks];
  const playTrack = (track) => {
    window.dispatchEvent(new CustomEvent('vault:play', {
      detail: { item: track, queue, index: queue.findIndex(t => t.id === track.id) },
    }));
  };

  container.querySelector('#artist-play').addEventListener('click', () => playTrack(queue[0]));
  container.querySelector('#artist-shuffle').addEventListener('click', () => {
    const shuffled = [...queue].sort(() => Math.random() - 0.5);
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: shuffled[0], queue: shuffled, index: 0 } }));
  });
  container.querySelector('#artist-queue').addEventListener('click', () => {
    queue.forEach(item => store.addToQueue(item));
    toast.success(`Queued ${queue.length} track(s)`);
    window.dispatchEvent(new CustomEvent('vault:queue-refresh'));
  });
  container.querySelectorAll('[data-track]').forEach(row => {
    const track = tracks.find(t => t.id === row.dataset.track);
    row.querySelector('.media-list-play').addEventListener('click', (event) => {
      event.stopPropagation();
      playTrack(track);
    });
    row.addEventListener('click', () => playTrack(track));
  });
}

export default { renderArtists, renderArtist };
