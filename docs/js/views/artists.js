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
import { escapeHtml, formatDuration, durationSeconds, truncate, plural, formatTotalDuration } from '../utils/format.js';
import { attachContextMenu } from '../components/contextMenu.js';
import { toast } from '../components/toast.js';
import { npIds } from '../utils/nowPlaying.js';

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
      <h1 class="page-title">${icon('mic', { size: 26 })}<span>Artists</span></h1>
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
      content.innerHTML = `<div class="empty-state">${icon('mic', { size: 30 })}
        <div class="empty-state-title">No music yet</div>
        <div class="empty-state-message">Add audio files to a music library and run a scan.</div></div>`;
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'media-grid stagger';
    [...grouped.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .forEach(([artist, tracks]) => {
        const albums = new Set(tracks.map(t => t.album).filter(a => a && a !== 'Unknown Album'));
        const card = document.createElement('a');
        card.className = 'media-card';
        card.dataset.type = 'music';
        // History-router route, NOT a "#/…" hash link: the router only treats
        // hashes as routes when the page was opened with one, so hash hrefs
        // silently changed the URL without ever rendering the artist page.
        // data-route is intercepted by the router's click handler.
        const artistPath = `/artist/${encodeURIComponent(artist)}`;
        card.href = artistPath;
        card.dataset.route = artistPath;
        // "Playing" badge on the artist whose song is playing (utils/nowPlaying.js).
        card.dataset.npIds = npIds(tracks);
        const coverTrack = tracks.find(t => t.coverArtPath || t.posterPath) || tracks[0];
        const artistVersion = Math.max(0, ...tracks.map(t => new Date(t.updatedAt || 0).getTime() || 0));
        const coverUrl = (typeof api.getCoverUrlVersioned === 'function' && artistVersion)
          ? api.getCoverUrlVersioned(coverTrack.id, artistVersion)
          : api.getCoverUrl(coverTrack.id);
        card.innerHTML = `
          <div class="media-card-cover music" data-np-slot="cover">
            <img loading="lazy" src="${coverUrl}" alt="" class="loaded" data-img-fallback="placeholder">
            <div class="media-card-placeholder" aria-hidden="true">${icon('mic', { size: 34 })}</div>
          </div>
          <div class="media-card-info">
            <div class="media-card-title">${escapeHtml(truncate(artist, 40))}</div>
            <div class="media-card-meta">${[albums.size ? plural(albums.size, 'album') : null, plural(tracks.length, 'track')].filter(Boolean).join(' · ')}</div>
          </div>
        `;
        grid.appendChild(card);
      });
    content.replaceChildren(grid);
  }

  paint();
  subscribeView(store, 'library', paint);
}

const NO_ALBUM = '\u0000other';

function coverUrlFor(track, version) {
  return (typeof api.getCoverUrlVersioned === 'function' && version)
    ? api.getCoverUrlVersioned(track.id, version)
    : api.getCoverUrl(track.id);
}

function newest(tracks) {
  return Math.max(0, ...tracks.map(t => new Date(t.updatedAt || 0).getTime() || 0));
}

function sortTracks(list) {
  return [...list].sort((a, b) => (a.disc || 1) - (b.disc || 1)
    || (a.track || 9999) - (b.track || 9999)
    || String(a.title).localeCompare(String(b.title)));
}

/** Albums newest first (unknown years last), loose tracks at the very end. */
function groupAlbums(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const key = t.album && t.album !== 'Unknown Album' ? t.album : NO_ALBUM;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return [...map.entries()]
    .map(([name, list]) => {
      const sorted = sortTracks(list);
      const years = sorted.map(t => Number(t.year)).filter(Boolean);
      const genres = [...new Set(sorted.map(t => t.genre).filter(Boolean))];
      return {
        name,
        tracks: sorted,
        year: years.length ? Math.max(...years) : null,
        genres,
        seconds: sorted.reduce((sum, t) => sum + durationSeconds(t.duration), 0),
        coverTrack: sorted.find(t => t.coverArtPath || t.posterPath) || sorted[0],
      };
    })
    .sort((a, b) => (a.name === NO_ALBUM) - (b.name === NO_ALBUM)
      || (b.year || 0) - (a.year || 0)
      || a.name.localeCompare(b.name));
}

function albumBlock(album, artist, index) {
  const loose = album.name === NO_ALBUM;
  const title = loose ? 'Other tracks' : album.name;
  const albumHref = `/album/${encodeURIComponent(album.tracks[0].id)}`;
  const meta = [
    loose ? null : (album.tracks.length === 1 ? 'Single' : 'Album'),
    album.year,
    plural(album.tracks.length, 'track'),
    formatTotalDuration(album.seconds),
    album.genres.slice(0, 2).join(', '),
  ].filter(Boolean);
  const cover = `
    <img src="${coverUrlFor(album.coverTrack, newest(album.tracks))}" alt="" loading="lazy"
      data-img-loaded="parent-art" data-img-fallback="remove">`;
  return `
    <section class="artist-album" data-album="${index}" aria-labelledby="artist-album-${index}">
      <header class="artist-album-head">
        ${loose
          ? `<div class="artist-album-cover" aria-hidden="true">${cover}</div>`
          : `<a class="artist-album-cover" href="${albumHref}" data-route="${albumHref}" tabindex="-1" aria-hidden="true">${cover}</a>`}
        <div class="artist-album-info">
          <h2 class="artist-album-title" id="artist-album-${index}" data-np-ids="${escapeHtml(npIds(album.tracks))}">
            ${loose ? escapeHtml(title) : `<a href="${albumHref}" data-route="${albumHref}">${escapeHtml(title)}</a>`}<span class="np-slot" data-np-slot="inline"></span>
          </h2>
          <div class="artist-album-meta">${meta.map(m => `<span>${escapeHtml(String(m))}</span>`).join('')}</div>
          <div class="artist-album-actions">
            <button type="button" class="btn btn-primary btn-sm" data-album-play>${icon('play', { size: 14 })}<span>Play</span></button>
            <button type="button" class="btn btn-secondary btn-sm" data-album-shuffle aria-label="Shuffle ${escapeHtml(title)}">${icon('shuffle', { size: 14 })}<span>Shuffle</span></button>
          </div>
        </div>
      </header>
      <ol class="track-table" aria-label="${escapeHtml(title)} tracks">
        ${album.tracks.map((track, i) => {
          const sub = [
            track.artist && track.artist !== artist ? track.artist : null,
            loose && track.album && track.album !== 'Unknown Album' ? track.album : null,
          ].filter(Boolean).join(' · ');
          return `
          <li class="track-row" data-track="${track.id}" data-np-id="${escapeHtml(String(track.id))}" tabindex="0" aria-label="${escapeHtml(track.title)}${track.duration ? `, ${formatDuration(track.duration)}` : ''}">
            <span class="track-num">
              <span class="track-num-n" aria-hidden="true">${track.track || i + 1}</span>
              <span class="track-eq" aria-hidden="true"><i></i><i></i><i></i></span>
              <button type="button" class="track-play" aria-label="Play ${escapeHtml(track.title)}">${icon('play', { size: 13 })}</button>
            </span>
            <span class="track-main">
              <span class="track-title">${escapeHtml(track.title)}</span>
              ${sub ? `<span class="track-sub">${escapeHtml(sub)}</span>` : ''}
            </span>
            <span class="track-dur">${formatDuration(track.duration)}</span>
          </li>`;
        }).join('')}
      </ol>
    </section>`;
}

export async function renderArtist(container, name) {
  // The router already URL-decodes dynamic segments; decoding again throws
  // on names containing a literal "%". Decode only if it still looks encoded.
  let artist = name || '';
  try { artist = decodeURIComponent(artist); } catch { /* already decoded */ }
  container.className = 'page';

  const paint = () => {
    const tracks = musicItems().filter(item => (item.artist || item.albumArtist || 'Unknown artist') === artist);
    if (!tracks.length) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-state-title">Nothing found for “${escapeHtml(artist)}”</div>
        <div class="empty-state-message">The library may still be scanning, or the artist name differs.</div>
        <a class="btn btn-primary" href="/artists" data-route="/artists">Back to artists</a></div>`;
      return;
    }

    const albums = groupAlbums(tracks);
    const realAlbums = albums.filter(a => a.name !== NO_ALBUM);
    const seconds = tracks.reduce((sum, track) => sum + durationSeconds(track.duration), 0);
    const coverTrack = tracks.find(t => t.coverArtPath || t.posterPath) || tracks[0];
    const coverUrl = coverUrlFor(coverTrack, newest(tracks));
    const years = tracks.map(t => Number(t.year)).filter(Boolean);
    const span = years.length ? (Math.min(...years) === Math.max(...years) ? `${years[0]}` : `${Math.min(...years)}–${Math.max(...years)}`) : '';
    const genres = [...new Set(tracks.map(t => t.genre).filter(Boolean))].slice(0, 3).join(', ');
    const metaBits = [
      realAlbums.length ? plural(realAlbums.length, 'album') : null,
      plural(tracks.length, 'track'),
      formatTotalDuration(seconds),
      span,
      genres,
    ].filter(Boolean);

    // Play order = the page order (albums newest first, tracks by number).
    const queue = albums.flatMap(a => a.tracks);

    container.innerHTML = `
      <div class="hero artist-hero">
        <img class="hero-backdrop is-cover" src="${coverUrl}" alt="" data-img-fallback="remove">
        <div class="artist-hero-avatar" aria-hidden="true">
          <img src="${coverUrl}" alt="" data-img-loaded="parent-art" data-img-fallback="remove">
          ${icon('mic', { size: 40 })}
        </div>
        <div class="hero-body">
          <p class="hero-overline">Artist</p>
          <h1 class="hero-title">${escapeHtml(artist)}</h1>
          <div class="hero-meta">${metaBits.map(b => `<span>${escapeHtml(String(b))}</span>`).join('')}</div>
          <div class="hero-actions">
            <button class="btn btn-primary" id="artist-play">${icon('play', { size: 16 })}<span>Play all</span></button>
            <button class="btn btn-secondary hero-btn" id="artist-shuffle">${icon('shuffle', { size: 16 })}<span>Shuffle</span></button>
            <button class="btn btn-ghost hero-btn hero-btn-quiet" id="artist-queue">${icon('list', { size: 16 })}<span>Add to queue</span></button>
          </div>
        </div>
      </div>
      <div class="artist-albums">
        ${albums.map((album, i) => albumBlock(album, artist, i)).join('')}
      </div>
    `;

    const play = (list, track) => {
      window.dispatchEvent(new CustomEvent('vault:play', {
        detail: { item: track, queue: list, index: Math.max(0, list.findIndex(t => t.id === track.id)) },
      }));
    };
    const shuffle = (list) => {
      const shuffled = [...list];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      play(shuffled, shuffled[0]);
    };

    container.querySelector('#artist-play').addEventListener('click', () => play(queue, queue[0]));
    container.querySelector('#artist-shuffle').addEventListener('click', () => shuffle(queue));
    container.querySelector('#artist-queue').addEventListener('click', () => {
      queue.forEach(item => store.addToQueue(item));
      toast.success(`Added ${plural(queue.length, 'track')} to the queue`);
      window.dispatchEvent(new CustomEvent('vault:queue-refresh'));
    });

    container.querySelectorAll('.artist-album').forEach((section) => {
      const album = albums[Number(section.dataset.album)];
      section.querySelector('[data-album-play]').addEventListener('click', () => play(album.tracks, album.tracks[0]));
      section.querySelector('[data-album-shuffle]').addEventListener('click', () => shuffle(album.tracks));
      section.querySelectorAll('[data-track]').forEach((row) => {
        const track = album.tracks.find(t => t.id === row.dataset.track);
        // Clicking a track plays on through the rest of the artist's music.
        row.addEventListener('click', () => play(queue, track));
        row.addEventListener('keydown', (e) => {
          if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          play(queue, track);
        });
        attachContextMenu(row, track);
      });
    });
  };

  paint();
  subscribeView(store, 'library', paint);
}

export default { renderArtists, renderArtist };
