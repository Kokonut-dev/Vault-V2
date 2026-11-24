/**
 * Music view — optimized with memoization and DocumentFragment
 */
import { store } from '../store.js';
import { renderMediaGrid } from '../components/mediaGrid.js';
import { renderMediaList } from '../components/mediaList.js';
import { api } from '../api.js';
import { escapeHtml, escapeAttr, durationSeconds, formatTotalDuration } from '../utils/format.js';
import { subscribeView, onUnmount } from '../utils/lifecycle.js';
import { icon } from '../utils/icons.js';
import { wireViewToggle } from '../utils/viewMode.js';
import { releaseVirtualGrid } from '../utils/virtualGrid.js';
import { npIds } from '../utils/nowPlaying.js';

export function renderMusic(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Music</h1>
      <p class="page-subtitle">Your music collection</p>
    </div>
    <div class="filter-chips">
      <button class="btn btn-secondary btn-sm active" data-filter="all">All Tracks</button>
      <button class="btn btn-secondary btn-sm" data-filter="artist">Artists</button>
      <button class="btn btn-secondary btn-sm" data-filter="album">Albums</button>
      <button class="btn btn-secondary btn-sm" data-filter="genre">Genres</button>
    </div>
    <div class="view-controls">
      <div class="view-toggle">
        <button type="button" class="active" data-view="grid">Grid</button>
        <button type="button" data-view="list">List</button>
      </div>
      <label class="sr-only" for="sort-select">Sort by</label>
      <select class="form-select" id="sort-select" style="width:auto;">
        <option value="addedAt-desc">Recently Added</option>
        <option value="title-asc">Title A-Z</option>
        <option value="artist-asc">Artist A-Z</option>
        <option value="album-asc">Album A-Z</option>
        <option value="year-desc">Year</option>
      </select>
      <input type="text" class="form-input" id="filter-input" placeholder="Filter music..." style="width:200px;">
      <button class="btn btn-primary btn-sm" id="play-all">Play All</button>
      <button class="btn btn-secondary btn-sm" id="shuffle-all">Shuffle</button>
    </div>
    <div id="music-content"></div>
  `;
  
  const content = container.querySelector('#music-content');
  const sortSelect = container.querySelector('#sort-select');
  const filterInput = container.querySelector('#filter-input');
  const filterButtons = container.querySelectorAll('[data-filter]');
  
  // Grid/List applies to every grouping: All Tracks, Artists, Albums and
  // Genres (it used to change only All Tracks and did nothing on the others).
  let viewMode = wireViewToggle(container, 'music', (mode) => { viewMode = mode; render(); });
  let sort = 'addedAt';
  let order = 'desc';
  let filter = '';
  // Opening an album/artist/genre navigates away, so the grouping is
  // remembered: Back from an album page lands on the same list, not on
  // "All Tracks". A stale localStorage value falls back to 'all'.
  const GROUPS = ['all', 'artist', 'album', 'genre'];
  const savedGroupBy = store.get('musicGroupBy');
  let groupBy = GROUPS.includes(savedGroupBy) ? savedGroupBy : 'all';
  
  filterButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === groupBy);
    btn.addEventListener('click', () => {
      groupBy = btn.dataset.filter;
      filterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.set('musicGroupBy', groupBy, true);
      render();
    });
  });
  
  sortSelect.addEventListener('change', (e) => {
    const [s, o] = e.target.value.split('-');
    sort = s;
    order = o;
    render();
  });
  
  filterInput.addEventListener('input', (e) => {
    filter = e.target.value.toLowerCase();
    render();
  });
  
  container.querySelector('#play-all').addEventListener('click', () => {
    const items = getFiltered();
    if (items.length > 0) {
      window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: items[0], queue: items, index: 0 } }));
    }
  });
  
  container.querySelector('#shuffle-all').addEventListener('click', () => {
    const items = [...getFiltered()].sort(() => Math.random() - 0.5);
    if (items.length > 0) {
      window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: items[0], queue: items, index: 0 } }));
    }
  });
  
  function getFiltered() {
    let items = store.get('library').filter(i => i.type === 'music');
    
    if (filter) {
      items = items.filter(i => 
        i.title.toLowerCase().includes(filter) ||
        (i.artist && i.artist.toLowerCase().includes(filter)) ||
        (i.album && i.album.toLowerCase().includes(filter))
      );
    }
    
    items.sort((a, b) => {
      let aVal = a[sort] || '';
      let bVal = b[sort] || '';
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return order === 'asc' ? -1 : 1;
      if (aVal > bVal) return order === 'asc' ? 1 : -1;
      return 0;
    });
    
    return items;
  }
  
  function render() {
    // Whatever was drawn before (a windowed grid included) is replaced.
    releaseVirtualGrid(content);
    if (groupBy === 'artist') {
      renderArtists();
      return;
    }
    if (groupBy === 'album') {
      renderAlbums();
      return;
    }
    if (groupBy === 'genre') {
      renderGenres();
      return;
    }
    
    const items = getFiltered();
    
    const play = (item) => {
      window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue: items, index: items.findIndex(i => i.id === item.id) } }));
    };
    const open = (item) => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
    if (viewMode === 'grid') {
      renderMediaGrid(content, items, {
        onClick: open,
        onPlay: play,
        emptyMessage: 'No music found. Upload some tracks to get started.'
      });
    } else {
      renderMediaList(content, items, {
        onClick: open,
        onPlay: play,
        sortField: sort,
        sortOrder: order,
        onSort: (field, next) => {
          sort = field;
          order = next;
          syncSortSelect();
          render();
        },
      });
    }
  }

  // Keep the sort <select> truthful when a header sort picks a field the
  // select has no option for — insert a dynamic option instead of lying.
  function syncSortSelect() {
    const value = `${sort}-${order}`;
    sortSelect.querySelectorAll('option[data-dynamic]').forEach((o) => {
      if (o.value !== value) o.remove();
    });
    if (![...sortSelect.options].some((o) => o.value === value)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.dataset.dynamic = '1';
      const labels = {'title': 'Title', 'artist': 'Artist', 'album': 'Album', 'duration': 'Duration', 'year': 'Year', 'addedAt': 'Recently Added'};
      // Native <option> can't hold an SVG — the arrow is a text affordance
      // for the sort direction, not an icon slot (see utils/icons.js).
      opt.textContent = `${labels[sort] || sort} ${order === 'asc' ? '↑' : '↓'}`;
      sortSelect.prepend(opt);
    }
    sortSelect.value = value;
  }

  
  const openDetail = (item) => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
  const playFrom = (tracks, item) => window.dispatchEvent(new CustomEvent('vault:play', {
    detail: { item, queue: tracks, index: Math.max(0, tracks.findIndex(i => i.id === item.id)) },
  }));

  /** Same grouping for artists / albums / genres; first-seen order. */
  function groupTracks(items, keyOf) {
    const groups = new Map();
    items.forEach((item) => {
      const key = keyOf(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return [...groups.entries()];
  }

  function showEmpty() {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('music', { size: 30 })}</div>
        <div class="empty-state-title">${filter ? 'No matches' : 'No music yet'}</div>
        <div class="empty-state-message">${filter ? 'Nothing matches that filter.' : 'Upload some tracks to get started.'}</div>
      </div>`;
  }

  /**
   * The songs of one artist or genre, drawn the way the Grid/List switch says.
   * Grid cards open the song and their Play button plays it; list rows play
   * on click. Either way the group is the queue.
   */
  function renderGroupTracks(el, tracks) {
    if (viewMode === 'grid') {
      renderMediaGrid(el, tracks, { onClick: openDetail, onPlay: (item) => playFrom(tracks, item) });
    } else {
      renderMediaList(el, tracks, { onClick: (item) => playFrom(tracks, item), onPlay: (item) => playFrom(tracks, item) });
    }
  }

  function renderArtists() {
    const artists = groupTracks(getFiltered(), item => item.artist || 'Unknown Artist')
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (!artists.length) { showEmpty(); return; }

    content.innerHTML = '';
    artists.forEach(([artist, tracks]) => {
      const section = document.createElement('section');
      section.className = 'music-group';
      const known = artist !== 'Unknown Artist';
      const artistPath = `/artist/${encodeURIComponent(artist)}`;
      section.innerHTML = `
        <h3 class="music-group-title" data-np-ids="${escapeAttr(npIds(tracks))}">
          <span class="music-group-name" data-np-slot="inline">${known
            ? `<a href="${escapeAttr(artistPath.slice(1))}" data-route="${escapeAttr(artistPath)}">${escapeHtml(artist)}</a>`
            : escapeHtml(artist)}</span>
          <span class="music-group-count">${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}</span>
        </h3>
        <div class="music-group-tracks"></div>
      `;
      renderGroupTracks(section.querySelector('.music-group-tracks'), tracks);
      content.appendChild(section);
    });
  }

  /** "Album artist" as the album page names it. */
  function albumArtistOf(tracks) {
    const tags = [...new Set(tracks.map(t => t.albumArtist).filter(Boolean))];
    if (tags.length === 1) return tags[0];
    const artists = [...new Set(tracks.map(t => t.artist).filter(Boolean))];
    return artists.length > 1 ? 'Various Artists' : (artists[0] || '');
  }

  function albumCoverUrl(tracks) {
    const cover = tracks.find(t => t.coverArtPath || t.posterPath) || tracks[0];
    const albumVersion = Math.max(0, ...tracks.map(t => new Date(t.updatedAt || 0).getTime() || 0));
    return (typeof api.getCoverUrlVersioned === 'function' && albumVersion)
      ? api.getCoverUrlVersioned(cover.id, albumVersion)
      : api.getCoverUrl(cover.id);
  }

  // An album is a collection, not a track: activating it opens the album
  // page, which lists its tracks. Playback stays behind the explicit Play
  // button so a click to browse can't start audio by surprise.
  function albumActions(tracks) {
    const cover = tracks.find(t => t.coverArtPath || t.posterPath) || tracks[0];
    return {
      open: () => openDetail(cover),
      play: () => playFrom(tracks, tracks[0]),
    };
  }

  function wireAlbumElement(el, playButton, { open, play }) {
    playButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      play();
    });
    el.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      open();
    });
    el.addEventListener('keydown', (e) => {
      // Only when the card/row itself has focus, so Enter/Space on the nested
      // Play button doesn't also open the album.
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }

  function renderAlbums() {
    const albums = groupTracks(getFiltered(), item => item.album || 'Unknown Album');
    if (!albums.length) { showEmpty(); return; }
    if (viewMode === 'list') renderAlbumList(albums);
    else renderAlbumGrid(albums);
  }

  function renderAlbumGrid(albums) {
    content.innerHTML = '<div class="media-grid" id="albums-grid"></div>';
    const grid = content.querySelector('#albums-grid');

    albums.forEach(([album, tracks]) => {
      const card = document.createElement('div');
      card.className = 'media-card';
      card.dataset.type = 'music';
      card.dataset.npIds = npIds(tracks);
      const artist = albumArtistOf(tracks);
      card.innerHTML = `
        <div class="media-card-cover music" data-np-slot="cover">
          <img src="${albumCoverUrl(tracks)}" alt="" loading="lazy" class="loaded" data-img-fallback="placeholder">
          <div class="media-card-placeholder" aria-hidden="true">${icon('music', { size: 34 })}</div>
          <div class="media-card-overlay"><button class="media-card-play" type="button" aria-label="Play ${escapeAttr(album)}">${icon('play', { size: 20 })}</button></div>
        </div>
        <div class="media-card-info">
          <div class="media-card-title">${escapeHtml(album)}</div>
          <div class="media-card-meta">${artist ? `${escapeHtml(artist)} • ` : ''}${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}</div>
        </div>
      `;
      // role=group, not button: the card contains a real Play <button>, and
      // a button inside a button is invalid (axe nested-interactive, C-11).
      card.setAttribute('role', 'group');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `${album} — ${tracks.length} tracks`);
      card.setAttribute('aria-description', 'Press Enter to open the album');
      card.dataset.art = 'square';

      const img = card.querySelector('.media-card-cover img');
      if (img) {
        img.addEventListener('load', () => img.classList.add('loaded'));
        img.addEventListener('error', () => {
          img.style.display = 'none';
          const ph = card.querySelector('.media-card-placeholder');
          if (ph) ph.classList.add('visible');
        });
        if (img.complete && img.naturalWidth > 0) {
          img.classList.add('loaded');
        }
      }

      wireAlbumElement(card, card.querySelector('.media-card-play'), albumActions(tracks));
      grid.appendChild(card);
    });
  }

  function renderAlbumList(albums) {
    const list = document.createElement('div');
    list.className = 'media-list media-list--library media-list--albums';
    list.innerHTML = `
      <div class="media-list-header">
        <span class="media-list-col media-list-col--title">Album</span>
        <span class="media-list-col media-list-col--artist">Artist</span>
        <span class="media-list-col media-list-col--duration">Tracks</span>
        <span class="media-list-col media-list-col--year">Year</span>
      </div>`;

    albums.forEach(([album, tracks]) => {
      const artist = albumArtistOf(tracks);
      const years = tracks.map(t => Number(t.year)).filter(Boolean);
      const year = years.length ? Math.max(...years) : '';
      const seconds = tracks.reduce((sum, t) => sum + durationSeconds(t.duration), 0);
      const row = document.createElement('div');
      row.className = 'media-list-item';
      row.dataset.npIds = npIds(tracks);
      row.setAttribute('role', 'group');
      row.setAttribute('tabindex', '0');
      row.setAttribute('aria-label', [album, artist, `${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}`].filter(Boolean).join(', '));
      row.setAttribute('aria-description', 'Press Enter to open the album');
      row.innerHTML = `
        <div class="media-list-item-main">
          <button class="media-list-play" type="button" aria-label="Play ${escapeAttr(album)}">${icon('play', { size: 13 })}</button>
          <div class="media-list-item-cover" data-np-slot="cover">
            <img src="${albumCoverUrl(tracks)}" alt="" loading="lazy" data-img-fallback="hide">
          </div>
          <div class="media-list-item-text">
            <div class="media-list-item-title">${escapeHtml(album)}</div>
            ${seconds ? `<div class="media-list-item-artist">${escapeHtml(formatTotalDuration(seconds))}</div>` : ''}
          </div>
        </div>
        <div class="media-list-cell media-list-cell--artist" title="${escapeAttr(artist)}">${escapeHtml(artist) || '<span class="media-list-none">—</span>'}</div>
        <div class="media-list-cell media-list-cell--duration">${tracks.length}</div>
        <div class="media-list-cell media-list-cell--year">${year || '<span class="media-list-none">—</span>'}</div>
      `;
      wireAlbumElement(row, row.querySelector('.media-list-play'), albumActions(tracks));
      list.appendChild(row);
    });

    content.replaceChildren(list);
  }

  // Genres have no page of their own, so a genre row expands into its track
  // list instead of navigating. Same rule as the album cards: browsing a group
  // never starts audio by surprise — playback is the explicit button. Open
  // genres stay open when the list is redrawn (Grid/List switch, new scan).
  let genreUid = 0;
  const openGenres = new Set();
  function renderGenres() {
    const genres = groupTracks(getFiltered(), item => item.genre || 'Unknown')
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (!genres.length) { showEmpty(); return; }

    content.innerHTML = '';
    genres.forEach(([genre, tracks]) => {
      const listId = `genre-tracks-${++genreUid}`;
      const section = document.createElement('div');
      section.className = 'genre-group';
      section.innerHTML = `
        <div class="genre-head" data-np-ids="${escapeAttr(npIds(tracks))}">
          <button class="btn btn-ghost btn-sm genre-toggle" type="button" aria-expanded="false" aria-controls="${listId}">
            <span class="genre-caret" aria-hidden="true">${icon('chevron-right', { size: 14 })}</span>
            <span class="genre-name" data-np-slot="inline">${escapeHtml(genre)}</span>
          </button>
          <span class="music-group-count">${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'}</span>
          <button class="btn btn-secondary btn-sm genre-play" type="button" aria-label="Play ${escapeAttr(genre)}">${icon('play', { size: 14 })}<span>Play</span></button>
        </div>
        <div id="${listId}" class="genre-tracks" hidden></div>
      `;

      const toggle = section.querySelector('.genre-toggle');
      const listEl = section.querySelector('.genre-tracks');
      let built = false;

      const setOpen = (open) => {
        listEl.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        section.classList.toggle('is-open', open);
        if (open) openGenres.add(genre); else openGenres.delete(genre);
        // Build the songs on first open only — one genre can hold the whole library.
        if (open && !built) {
          built = true;
          renderGroupTracks(listEl, tracks);
        }
      };

      toggle.addEventListener('click', () => setOpen(listEl.hidden));
      section.querySelector('.genre-play').addEventListener('click', () => playFrom(tracks, tracks[0]));

      content.appendChild(section);
      if (openGenres.has(genre)) setOpen(true);
    });
  }
  
  render();
  // Debounce library subscription to avoid thrashing
  let renderTimeout;
  subscribeView(store, 'library', () => {
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(render, 100);
  });
  onUnmount(() => clearTimeout(renderTimeout));
}
