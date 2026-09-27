/**
 * Music view — optimized with memoization and DocumentFragment
 */
import { store } from '../store.js';
import { renderMediaGrid } from '../components/mediaGrid.js';
import { renderMediaList } from '../components/mediaList.js';
import { api } from '../api.js';
import { escapeHtml } from '../utils/format.js';
import { subscribeView, onUnmount } from '../utils/lifecycle.js';

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
        <button class="active" data-view="grid">Grid</button>
        <button data-view="list">List</button>
      </div>
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
  const viewButtons = container.querySelectorAll('.view-toggle button');
  const filterButtons = container.querySelectorAll('[data-filter]');
  
  let viewMode = store.get('viewMode') || 'grid';
  let sort = 'addedAt';
  let order = 'desc';
  let filter = '';
  let groupBy = 'all';
  
  viewButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewMode);
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      viewButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.set('viewMode', viewMode, true);
      render();
    });
  });
  
  filterButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      groupBy = btn.dataset.filter;
      filterButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
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
      });
    }
  }
  
  function renderArtists() {
    const items = getFiltered();
    const artists = {};
    items.forEach(item => {
      const artist = item.artist || 'Unknown Artist';
      if (!artists[artist]) artists[artist] = [];
      artists[artist].push(item);
    });
    
    content.innerHTML = '';
    Object.entries(artists).sort((a, b) => a[0].localeCompare(b[0])).forEach(([artist, tracks]) => {
      const section = document.createElement('div');
      section.style.marginBottom = '32px';
      section.innerHTML = `
        <h3 style="font-size:18px; font-weight:700; margin-bottom:12px;">${escapeHtml(artist)} <span style="color:var(--text-tertiary); font-weight:400; font-size:14px;">${tracks.length} tracks</span></h3>
        <div class="artist-tracks"></div>
      `;
      const tracksContainer = section.querySelector('.artist-tracks');
      renderMediaList(tracksContainer, tracks, {
        onClick: (item) => window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue: tracks, index: tracks.findIndex(i => i.id === item.id) } }))
      });
      content.appendChild(section);
    });
  }
  
  function renderAlbums() {
    const items = getFiltered();
    const albums = {};
    items.forEach(item => {
      const album = item.album || 'Unknown Album';
      if (!albums[album]) albums[album] = [];
      albums[album].push(item);
    });
    
    content.innerHTML = '<div class="media-grid" id="albums-grid"></div>';
    const grid = content.querySelector('#albums-grid');
    
    Object.entries(albums).forEach(([album, tracks]) => {
      const card = document.createElement('div');
      card.className = 'media-card';
      const cover = tracks[0];
      card.innerHTML = `
        <div class="media-card-cover music">
          <img src="${api.getCoverUrl(cover.id)}" alt="" onerror="this.style.display='none'">
          <div class="media-card-overlay"><div class="media-card-play">▶</div></div>
        </div>
        <div class="media-card-info">
          <div class="media-card-title">${escapeHtml(album)}</div>
          <div class="media-card-meta">${escapeHtml(tracks[0].artist || '')} • ${tracks.length} tracks</div>
        </div>
      `;
      card.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: tracks[0], queue: tracks, index: 0 } }));
      });
      grid.appendChild(card);
    });
  }
  
  function renderGenres() {
    const items = getFiltered();
    const genres = {};
    items.forEach(item => {
      const genre = item.genre || 'Unknown';
      if (!genres[genre]) genres[genre] = [];
      genres[genre].push(item);
    });
    
    content.innerHTML = '';
    Object.entries(genres).forEach(([genre, tracks]) => {
      const section = document.createElement('div');
      section.style.marginBottom = '16px';
      section.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(var(--glass-tint),0.05); padding:12px 16px; border-radius:12px; cursor:pointer;">
          <span style="font-weight:600;">${escapeHtml(genre)}</span>
          <span style="color:var(--text-tertiary); font-size:13px;">${tracks.length} tracks</span>
        </div>
      `;
      section.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: tracks[0], queue: tracks, index: 0 } }));
      });
      content.appendChild(section);
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
