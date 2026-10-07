/**
 * Home view — dashboard with continue watching, recently added, etc. — optimized
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { renderMediaGrid, renderSkeletonGrid } from '../components/mediaGrid.js';
import { router } from '../router.js';
import { formatRelativeTime, escapeHtml } from '../utils/format.js';
import { icon } from '../utils/icons.js';

export function renderHome(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Home</h1>
      <p class="page-subtitle">Welcome back, ${escapeHtml(store.get('user')?.username || 'user')} — here's what's new</p>
    </div>
    <div id="home-content"></div>
  `;
  
  const content = container.querySelector('#home-content');
  renderSkeletonGrid(content, 8);
  
  setTimeout(() => loadHomeContent(content), 300);
}

async function loadHomeContent(container) {
  const library = store.get('library') || [];
  const history = store.get('history') || [];
  const favourites = store.get('favourites') || [];
  
  // Continue watching/listening — from history with progress
  const continueItems = history
    .filter(h => h.progress > 5 && h.progress < 95)
    .map(h => library.find(i => i.id === h.itemId))
    .filter(Boolean)
    .slice(0, 8);
  
  // Recently added — sorted by addedAt
  const recentlyAdded = [...library]
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .slice(0, 12);
  
  const recentlyAddedMovies = recentlyAdded.filter(i => i.type === 'movie').slice(0, 8);
  const recentlyAddedMusic = recentlyAdded.filter(i => i.type === 'music').slice(0, 8);
  const recentlyAddedVideos = recentlyAdded.filter(i => i.type === 'video').slice(0, 8);
  
  // Random pick
  const randomPick = library.length > 0 ? library[Math.floor(Math.random() * library.length)] : null;
  
  // Top rated
  const topRated = [...library]
    .filter(i => i.rating > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 8);
  
  // Favourites
  const favItems = favourites.map(id => library.find(i => i.id === id)).filter(Boolean).slice(0, 8);
  
  container.innerHTML = '';

  // Hero: the most relevant in-progress (or newest) item.
  const heroSeed = continueItems[0] || recentlyAdded[0];
  if (heroSeed) {
    const heroProgress = history.find(h => h.itemId === heroSeed.id)?.progress || 0;
    container.appendChild(createHero(heroSeed, heroProgress));
  }

  if (continueItems.length > 0) {
    const section = createSection('Continue Watching', continueItems, (item) => {
      if (item.type === 'music') {
        window.dispatchEvent(new CustomEvent('vault:play', { detail: { item } }));
      } else {
        window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
      }
    });
    container.appendChild(section);
  }
  
  // Next up across TV shows (server computed: next unwatched episode per show).
  api.getNextUp(12).then(next => {
    const items = next.items || [];
    if (!items.length) return;
    const row = createSection('Next up in your shows', items, item => {
      window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
    });
    const target = container.querySelector('.home-section') || container;
    target.after(row);
  }).catch(() => {});

  // Smart row: because you watched <seed>.
  const seed = continueItems[0] || history[0];
  const seedItem = seed ? library.find(i => i.id === (seed.itemId || seed.id)) : null;
  const similar = similarItems(library, seedItem, 10).filter(i => !continueItems.some(c => c.id === i.id));
  if (similar.length >= 4) {
    const row = createSection(`Because you watched ${escapeHtml(seedItem.title)}`, similar, handleItemClick);
    container.appendChild(row);
  }

  if (recentlyAdded.length > 0) {
    const section = createSection('Recently Added', recentlyAdded, handleItemClick);
    container.appendChild(section);
  }
  
  if (recentlyAddedMovies.length > 0) {
    const section = createSection('New Movies & Series', recentlyAddedMovies, handleItemClick);
    container.appendChild(section);
  }
  
  if (recentlyAddedMusic.length > 0) {
    const section = createSection('New Music', recentlyAddedMusic, handleItemClick);
    container.appendChild(section);
  }
  
  if (recentlyAddedVideos.length > 0) {
    const section = createSection('New Videos', recentlyAddedVideos, handleItemClick);
    container.appendChild(section);
  }
  
  if (favItems.length > 0) {
    const section = createSection('Your Favourites', favItems, handleItemClick);
    container.appendChild(section);
  }
  
  if (topRated.length > 0) {
    const section = createSection('Top Rated', topRated, handleItemClick);
    container.appendChild(section);
  }
  
  if (randomPick) {
    const randomSection = document.createElement('div');
    randomSection.className = 'home-section';
    randomSection.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
        <h2>Random Pick</h2>
        <button class="btn btn-secondary btn-sm" id="shuffle-pick">Shuffle</button>
      </div>
      <div class="home-hero">
        <div class="home-hero-art">
          <img src="${api.getThumbnailUrl(randomPick.id)}" alt="" onerror="this.style.display='none'">
        </div>
        <div style="flex:1; min-width:0;">
          <div style="font-weight:700; font-size:18px; margin-bottom:4px;">${escapeHtml(randomPick.title)}</div>
          <div style="color:var(--text-secondary); font-size:14px; margin-bottom:12px;">${escapeHtml(randomPick.artist || randomPick.genre || '')} ${randomPick.year ? `• ${randomPick.year}` : ''}</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn btn-primary" id="play-random">${icon('play', { size: 16 })}<span>Play Now</span></button>
            <button class="btn btn-secondary" id="open-random">Details</button>
          </div>
        </div>
      </div>
    `;
    container.appendChild(randomSection);
    
    randomSection.querySelector('#shuffle-pick').addEventListener('click', () => {
      const newPick = library[Math.floor(Math.random() * library.length)];
      if (newPick) {
        randomSection.querySelector('img').src = api.getThumbnailUrl(newPick.id);
        randomSection.querySelector('div div div').textContent = newPick.title;
        randomSection.querySelector('#play-random').onclick = () => handleItemClick(newPick);
      }
    });
    
    randomSection.querySelector('#play-random').addEventListener('click', () => handleItemClick(randomPick));
    randomSection.querySelector('#open-random')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item: randomPick } }));
    });
  }
  
  if (library.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('layout-grid', { size: 30 })}</div>
        <div class="empty-state-title">Your vault is empty</div>
        <div class="empty-state-message">Upload some movies, music, or videos to get started. Your media will appear here.</div>
        <button class="btn btn-primary" onclick="window.Vault.router.navigate('/upload')">Upload Media</button>
      </div>
    `;
  }
}

/**
 * Hero — big backdrop + resume button + progress (Netflix/Disney+ pattern).
 */
function createHero(item, progress) {
  const hero = document.createElement('section');
  hero.className = 'hero';
  const art = item.backdrop || item.poster || item.coverArtPath ? api.getBackdropUrl?.(item.id) || api.getCoverUrl(item.id) : null;
  const backdropUrl = item.backdrop
    ? (item.backdrop.startsWith('http') ? item.backdrop : `${api.baseUrl}${item.backdrop}`)
    : (item.type === 'music' ? api.getCoverUrl(item.id) : api.getThumbnailUrl(item.id));

  hero.innerHTML = `
    <img class="hero-backdrop" src="${backdropUrl}" alt="" onerror="this.style.display='none'">
    <div class="hero-meta">
      <span class="quality-badge">${item.type === 'music' ? 'Music' : item.type === 'video' ? 'Video' : 'Movie'}</span>
      ${item.year ? `<span>${item.year}</span>` : ''}
      ${item.artist ? `<span>${escapeHtml(item.artist)}</span>` : ''}
      ${item.rating ? `<span>${icon('star-filled', { size: 13 })} ${item.rating}</span>` : ''}
      ${progress ? `<span>${Math.round(progress)}% watched</span>` : ''}
    </div>
    <h1 class="hero-title">${escapeHtml(item.title)}</h1>
    ${progress ? `<div class="hero-progress"><span style="width:${Math.round(progress)}%"></span></div>` : ''}
    <div class="hero-actions">
      <button class="btn btn-primary" data-hero-play>${icon('play', { size: 16 })}<span>${progress ? 'Resume' : 'Play'}</span></button>
      <button class="btn btn-secondary" data-hero-info>${icon('info', { size: 16 })}<span>Details</span></button>
      <button class="btn btn-ghost" data-hero-list>${icon('bookmark', { size: 16 })}<span>My list</span></button>
    </div>
    <div class="row-meta">${escapeHtml(item.overview || item.genre || item.album || '')}</div>
  `;
  void art;

  hero.querySelector('[data-hero-play]').addEventListener('click', () => {
    if (item.type === 'music') window.dispatchEvent(new CustomEvent('vault:play', { detail: { item } }));
    else window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
  });
  hero.querySelector('[data-hero-info]').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
  });
  hero.querySelector('[data-hero-list]').addEventListener('click', async () => {
    const { api: apiClient } = await import('../api.js');
    try {
      await apiClient.addToWatchlist(item.id);
      window.dispatchEvent(new CustomEvent('vault:watchlist-changed', { detail: { item, added: true } }));
    } catch { /* offline */ }
  });
  return hero;
}

/**
 * Smart row: "Because you watched X" — same genre, unwatched first.
 */
function similarItems(library, seed, limit = 10) {
  if (!seed) return [];
  const genres = new Set(Array.isArray(seed.genre) ? seed.genre : [seed.genre].filter(Boolean));
  return library
    .filter(item => item.id !== seed.id && genres.size)
    .map(item => {
      const itemGenres = Array.isArray(item.genre) ? item.genre : [item.genre].filter(Boolean);
      const overlap = itemGenres.filter(genre => genres.has(genre)).length;
      return { item, overlap };
    })
    .filter(entry => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map(entry => entry.item);
}

function createSection(title, items, onClick) {
  const section = document.createElement('div');
  section.className = 'home-section';

  section.innerHTML = `
    <h2>${escapeHtml(title)}</h2>
    <div class="section-content"></div>
  `;

  const content = section.querySelector('.section-content');
  renderMediaGrid(content, items, {
    onClick: (item) => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } })),
    onPlay: onClick,
  });

  return section;
}

function handleItemClick(item) {
  if (item.type === 'music') {
    const musicLibrary = store.get('library').filter(i => i.type === 'music');
    const idx = musicLibrary.findIndex(i => i.id === item.id);
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue: musicLibrary, index: idx } }));
  } else {
    window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
  }
}
