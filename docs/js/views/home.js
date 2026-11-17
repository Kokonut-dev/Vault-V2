/**
 * Home view — dashboard with continue watching, recently added, etc. — optimized
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { renderMediaGrid, renderSkeletonGrid } from '../components/mediaGrid.js';
import { router } from '../router.js';
import { escapeHtml } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { toast } from '../components/toast.js';

export function renderHome(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${greeting()}, ${escapeHtml(store.get('user')?.username || 'friend')}</h1>
      <p class="page-subtitle">Here's what's waiting in your vault</p>
    </div>
    <div id="home-content"></div>
  `;
  
  const content = container.querySelector('#home-content');
  renderSkeletonGrid(content, 8);
  
  setTimeout(() => loadHomeContent(content), 300);
}

/** Best artwork URL for an item: real cover/poster first, video frame last
 *  (thumbnails only exist for video files — music used to 404 here). */
function pickArtUrl(item) {
  if (item.type === 'music' || item.coverArtPath || item.posterPath) return api.getCoverUrl(item.id);
  return item.thumbnailPath ? api.getThumbnailUrl(item.id) : api.getCoverUrl(item.id);
}

/** Time-of-day greeting — a small human touch for the home page H1. */
function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
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
  
  // Recently added — sorted by addedAt descending
  const recentlyAdded = [...library]
    .sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  
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

  // Hero: the most relevant in-progress item, else the newest item that has
  // real artwork (a frame-grab of a home video makes a poor first impression).
  const hasArt = i => i.backdropPath || i.posterPath || i.coverArtPath || i.backdrop || i.poster;
  const heroSeed = continueItems[0]
    || recentlyAdded.find(i => i.type === 'movie' && (i.backdropPath || i.backdrop))
    || recentlyAdded.find(hasArt)
    || recentlyAdded[0];
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
    const section = createRecentlyAddedSection(recentlyAdded, handleItemClick);
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
          <img src="${pickArtUrl(randomPick)}" alt="" onerror="this.style.display='none'">
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
        randomSection.querySelector('img').src = pickArtUrl(newPick);
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
  hero.setAttribute('aria-labelledby', 'hero-title');
  const isMusic = item.type === 'music';
  const isFilm = item.type === 'movie';
  // Backdrop endpoint falls back server-side: backdrop → cover → poster → frame.
  const backdropUrl = item.backdrop && item.backdrop.startsWith('http')
    ? item.backdrop
    : (isMusic ? api.getCoverUrl(item.id) : api.getBackdropUrl(item.id));
  const posterUrl = (isFilm && (item.posterPath || item.poster)) || isMusic ? api.getCoverUrl(item.id) : null;
  const isEpisode = (item.season != null && item.season !== '') || (item.episode != null && item.episode !== '');
  const kind = isMusic ? 'Music' : item.type === 'video' ? 'Video' : (isEpisode ? 'Series' : 'Film');
  const overline = progress ? `Continue ${isMusic ? 'listening' : 'watching'}` : 'Newly added';
  const genre = Array.isArray(item.genre) ? item.genre[0] : item.genre;

  hero.innerHTML = `
    <img class="hero-backdrop${isMusic ? ' is-cover' : ''}" src="${backdropUrl}" alt="" onerror="this.style.display='none'">
    <div class="hero-body">
      <p class="hero-overline">${overline}</p>
      <h2 class="hero-title" id="hero-title">${escapeHtml(item.title)}</h2>
      <div class="hero-meta">
        <span>${kind}</span>
        ${item.year ? `<span>${item.year}</span>` : ''}
        ${genre ? `<span>${escapeHtml(genre)}</span>` : ''}
        ${item.artist ? `<span>${escapeHtml(item.artist)}</span>` : ''}
        ${item.rating ? `<span>${icon('star-filled', { size: 13 })} ${item.rating}</span>` : ''}
      </div>
      ${item.overview ? `<p class="hero-overview">${escapeHtml(item.overview)}</p>` : ''}
      ${progress ? `<div class="hero-progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${Math.round(progress)}%"></span></div><p class="hero-progress-label">${Math.round(progress)}% ${isMusic ? 'played' : 'watched'}</p>` : ''}
      <div class="hero-actions">
        <button class="btn btn-primary btn-lg" type="button" data-hero-play>${icon('play', { size: 18 })}<span>${progress ? 'Resume' : 'Play'}</span></button>
        <button class="btn hero-btn" type="button" data-hero-info>${icon('info', { size: 16 })}<span>Details</span></button>
        <button class="btn hero-btn hero-btn-quiet" type="button" data-hero-list>${icon('bookmark', { size: 16 })}<span>My list</span></button>
      </div>
    </div>
    ${posterUrl ? `<img class="hero-poster${isMusic ? ' is-square' : ''}" src="${posterUrl}" alt="" onerror="this.remove()">` : ''}
  `;

  hero.querySelector('[data-hero-play]').addEventListener('click', () => {
    if (item.type === 'music') window.dispatchEvent(new CustomEvent('vault:play', { detail: { item } }));
    else window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
  });
  hero.querySelector('[data-hero-info]').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
  });
  const listBtn = hero.querySelector('[data-hero-list]');
  listBtn.setAttribute('aria-pressed', 'false');
  listBtn.addEventListener('click', async () => {
    if (listBtn.getAttribute('aria-pressed') === 'true') return;
    listBtn.disabled = true;
    try {
      await api.addToWatchlist(item.id);
      listBtn.setAttribute('aria-pressed', 'true');
      listBtn.innerHTML = `${icon('bookmark-filled', { size: 16 })}<span>On my list</span>`;
      toast.success(`${item.title || 'Title'} added to My List`, 'Saved');
      window.dispatchEvent(new CustomEvent('vault:watchlist-changed', { detail: { item, added: true } }));
    } catch {
      toast.error('Could not add to My List. Check your connection.');
    } finally {
      listBtn.disabled = false;
    }
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

function createRecentlyAddedSection(sortedLibrary, onClick) {
  const section = document.createElement('div');
  section.className = 'home-section';

  // The scanner sets seriesKey on every film (it is a grouping key), so only
  // a season/episode number marks an episode — films were all filed as Series.
  const isSeries = item => item.type === 'movie' && ((item.season != null && item.season !== '') || (item.episode != null && item.episode !== ''));
  const isMovie = item => item.type === 'movie' && !isSeries(item);

  const hasSeries = sortedLibrary.some(isSeries);
  const hasMovies = sortedLibrary.some(isMovie);
  const hasMusic = sortedLibrary.some(i => i.type === 'music');
  const hasVideos = sortedLibrary.some(i => i.type === 'video');
  const hasAudiobooks = sortedLibrary.some(i => i.type === 'audiobook');
  const hasComics = sortedLibrary.some(i => i.type === 'comic');

  const categories = [
    { key: 'all', label: 'All', filter: () => true },
    ...(hasMovies ? [{ key: 'movies', label: hasSeries ? 'Movies' : 'Movies & Series', filter: isMovie }] : []),
    ...(hasSeries ? [{ key: 'series', label: 'Series', filter: isSeries }] : []),
    ...(hasMusic ? [{ key: 'music', label: 'Music', filter: i => i.type === 'music' }] : []),
    ...(hasVideos ? [{ key: 'videos', label: 'Videos', filter: i => i.type === 'video' }] : []),
    ...(hasAudiobooks ? [{ key: 'audiobooks', label: 'Audiobooks', filter: i => i.type === 'audiobook' }] : []),
    ...(hasComics ? [{ key: 'comics', label: 'Comics', filter: i => i.type === 'comic' }] : []),
  ];

  let currentCategory = 'all';

  function getItems() {
    const activeDef = categories.find(c => c.key === currentCategory) || categories[0];
    return sortedLibrary.filter(activeDef.filter).slice(0, 12);
  }

  // Only render filter tabs if there is more than 1 distinct category
  const showChips = categories.length > 2;

  section.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:16px;">
      <h2 style="margin-bottom:0;">Recently Added</h2>
      ${showChips ? `
        <div class="filter-chips" role="tablist" aria-label="Filter recently added media" style="margin-bottom:0;">
          ${categories.map(c => `
            <button type="button" 
                    class="btn btn-secondary btn-sm ${c.key === currentCategory ? 'active' : ''}" 
                    role="tab" 
                    aria-selected="${c.key === currentCategory ? 'true' : 'false'}"
                    data-category="${c.key}">
              ${escapeHtml(c.label)}
            </button>
          `).join('')}
        </div>
      ` : ''}
    </div>
    <div class="section-content"></div>
  `;

  const content = section.querySelector('.section-content');

  // I-5: one grid mixing 2:3 posters, 1:1 sleeves and 16:9 frames left
  // ragged gaps. "All" is now shelved by artwork shape (films & series,
  // music, videos), each shelf a clean grid; a single-kind filter is one grid.
  const SHELVES = [
    { label: 'Films & Series', test: i => i.type === 'movie' },
    { label: 'Music', test: i => i.type === 'music' },
    { label: 'Books & Podcasts', test: i => i.type === 'audiobook' || i.type === 'podcast' || i.type === 'comic' },
    { label: 'Videos', test: i => !['movie', 'music', 'audiobook', 'podcast', 'comic'].includes(i.type) },
  ];
  const gridOptions = {
    onClick: (item) => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } })),
    onPlay: onClick,
  };

  function renderGrid() {
    content.innerHTML = '';
    if (currentCategory !== 'all') {
      renderMediaGrid(content, getItems(), gridOptions);
      return;
    }
    const shelves = SHELVES
      .map(shelf => ({ ...shelf, items: sortedLibrary.filter(shelf.test).slice(0, 6) }))
      .filter(shelf => shelf.items.length);
    if (shelves.length <= 1) {
      renderMediaGrid(content, getItems(), gridOptions);
      return;
    }
    shelves.forEach(shelf => {
      const block = document.createElement('div');
      block.className = 'shelf';
      block.innerHTML = `<h3 class="shelf-title">${escapeHtml(shelf.label)}</h3><div class="shelf-grid"></div>`;
      renderMediaGrid(block.querySelector('.shelf-grid'), shelf.items, gridOptions);
      content.appendChild(block);
    });
  }

  if (showChips) {
    section.querySelectorAll('.filter-chips button').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.getAttribute('data-category');
        if (cat === currentCategory) return;
        currentCategory = cat;
        section.querySelectorAll('.filter-chips button').forEach(b => {
          const isActive = b.getAttribute('data-category') === currentCategory;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        renderGrid();
      });
    });
  }

  renderGrid();
  return section;
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
