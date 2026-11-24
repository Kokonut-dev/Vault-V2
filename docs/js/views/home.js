/**
 * Home — the first screen after signing in.
 *
 * Top to bottom:
 *   header       date, greeting, what's in the library, "Surprise me"
 *   hero         what you were in the middle of, else the newest title
 *   libraries    one tile per media type present, with a count
 *   rows         continue watching · next up · recently played music ·
 *                more like … · new films / episodes / music / … (one
 *                mixed "Recently added" row for a small library) ·
 *                favourites · top rated — horizontal strips with "See all"
 *   panels       your week (listening/watching time) and getting started
 *
 * An empty library gets a getting-started screen instead of empty rows; a
 * small one (under ~20 titles) keeps the getting-started tips at the bottom.
 * All styling lives in css/home.css.
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { createMediaCard } from '../components/mediaCard.js';
import { escapeHtml, plural } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { toast } from '../components/toast.js';
import { subscribeView } from '../utils/lifecycle.js';

const ROW_LIMIT = 18;
const SMALL_LIBRARY = 20;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const hasValue = v => v !== null && v !== undefined && v !== '';
/** Films and episodes are both "movie" items; a season/episode number marks an episode. */
export const isEpisode = item => item?.type === 'movie' && (hasValue(item.season) || hasValue(item.episode));
export const isFilm = item => item?.type === 'movie' && !isEpisode(item);

/** Library tiles: label, route, icon and how to count each media type. */
export const LIBRARY_TILES = [
  { key: 'films', label: 'Films', route: '/movies', icon: 'film', test: isFilm, unit: ['film', 'films'] },
  { key: 'shows', label: 'TV shows', route: '/shows', icon: 'tv', test: isEpisode, unit: ['show', 'shows'], countShows: true },
  { key: 'music', label: 'Music', route: '/music', icon: 'music', test: i => i.type === 'music', unit: ['song', 'songs'] },
  { key: 'audiobooks', label: 'Audiobooks', route: '/audiobooks', icon: 'headphones', test: i => i.type === 'audiobook', unit: ['book', 'books'] },
  { key: 'podcasts', label: 'Podcasts', route: '/podcasts', icon: 'rss', test: i => i.type === 'podcast', unit: ['episode', 'episodes'] },
  { key: 'comics', label: 'Comics', route: '/comics', icon: 'book', test: i => i.type === 'comic', unit: ['comic', 'comics'] },
  { key: 'videos', label: 'Videos', route: '/videos', icon: 'video', test: i => i.type === 'video', unit: ['video', 'videos'] },
];

const showKeyOf = item => item.seriesKey || String(item.title || '').replace(/\s*[sS]\d+[eE]\d+.*$/, '').toLowerCase();

/** `{ key, label, route, icon, count, countLabel }` for each type in the library. */
export function libraryTiles(library) {
  return LIBRARY_TILES.map(tile => {
    const items = library.filter(tile.test);
    const count = tile.countShows ? new Set(items.map(showKeyOf)).size : items.length;
    return { ...tile, count, countLabel: plural(count, tile.unit[0], tile.unit[1]) };
  }).filter(tile => tile.count > 0);
}

/** "1,204 songs · 48 films · 6 shows" — the biggest three. */
export function librarySummary(tiles) {
  return [...tiles].sort((a, b) => b.count - a.count).slice(0, 3)
    .map(t => `${t.count.toLocaleString()} ${t.count === 1 ? t.unit[0] : t.unit[1]}`).join(' · ');
}

/** Time-of-day greeting — a small human touch for the home page H1. */
export function greeting(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const isAudio = item => item.type === 'music' || item.type === 'audiobook' || item.type === 'podcast';

/** In-progress items, newest first, with their progress attached. */
export function continueItems(library, history, { audio = false } = {}) {
  const byId = new Map(library.map(i => [i.id, i]));
  const seen = new Set();
  const out = [];
  for (const entry of history) {
    if (!(entry.progress > 5 && entry.progress < 95)) continue;
    const item = byId.get(entry.itemId);
    if (!item || seen.has(item.id) || isAudio(item) !== audio || item.type === 'music') continue;
    seen.add(item.id);
    out.push({ ...item, progress: entry.progress });
  }
  return out;
}

/** Recently played songs, one per album, newest first. */
export function recentMusic(library, history, limit = ROW_LIMIT) {
  const byId = new Map(library.map(i => [i.id, i]));
  const albums = new Set();
  const out = [];
  for (const entry of history) {
    const item = byId.get(entry.itemId);
    if (!item || item.type !== 'music') continue;
    const album = `${item.album || ''}\u0000${item.albumArtist || item.artist || ''}`;
    if (item.album && albums.has(album)) continue;
    albums.add(album);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

const genresOf = item => (Array.isArray(item.genres) && item.genres.length ? item.genres
  : Array.isArray(item.genre) ? item.genre : [item.genre]).filter(Boolean);

/** "More like X": same type family, shared genres, unplayed first. */
export function similarItems(library, seed, { limit = ROW_LIMIT, playedIds = new Set() } = {}) {
  if (!seed) return [];
  const genres = new Set(genresOf(seed));
  if (!genres.size) return [];
  const sameFamily = item => (seed.type === 'music' ? item.type === 'music' : item.type !== 'music');
  return library
    .filter(item => item.id !== seed.id && sameFamily(item))
    .map(item => ({ item, overlap: genresOf(item).filter(g => genres.has(g)).length }))
    .filter(entry => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || Number(playedIds.has(a.item.id)) - Number(playedIds.has(b.item.id)))
    .slice(0, limit)
    .map(entry => entry.item);
}

const addedTime = item => new Date(item.addedAt || 0).getTime() || 0;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function openDetail(item) {
  window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
}

/** Music plays inside a queue (the rest of the row); everything else opens the player. */
function playItem(item, queue = null) {
  if (isAudio(item)) {
    const list = (queue || [item]).filter(isAudio);
    const index = Math.max(0, list.findIndex(i => i.id === item.id));
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue: list, index } }));
  } else {
    window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
  }
}

function navigate(route) {
  if (window.Vault?.router?.navigate) window.Vault.router.navigate(route);
  else window.location.assign(route.replace(/^\//, ''));
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderHome(container) {
  container.className = 'page home';
  container.innerHTML = `
    <header class="home-head">
      <div class="home-head-text">
        <p class="home-date">${escapeHtml(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
        <h1 class="page-title home-title">${greeting()}, ${escapeHtml(displayName())}</h1>
        <p class="home-summary" id="home-summary">Loading your library…</p>
      </div>
      <div class="home-head-actions" id="home-head-actions"></div>
    </header>
    <div id="home-content" class="home-content" aria-busy="true">${skeleton()}</div>
  `;

  const content = container.querySelector('#home-content');
  let timer = null;
  const draw = () => {
    clearTimeout(timer);
    timer = null;
    if (!content.isConnected) return;
    renderContent(container, content);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(draw, 250);
  };
  // The library often arrives just after the first paint (sign-in, profile
  // switch, a scan finishing); re-draw then instead of showing it as empty.
  subscribeView(store, 'library', schedule);
  // The profile's history and favourites are fetched alongside the library;
  // take them in while the page is fresh, but don't redraw (and lose the
  // scroll position) every time something plays later on.
  const mountedAt = Date.now();
  const early = () => { if (Date.now() - mountedAt < 5000) schedule(); };
  subscribeView(store, 'history', early);
  subscribeView(store, 'favourites', early);
  timer = setTimeout(draw, 0);
}

function displayName() {
  return store.get('profile')?.name || store.get('user')?.username || 'friend';
}

function skeleton() {
  const card = '<div class="home-skeleton-card"><div class="skeleton home-skeleton-art"></div><div class="skeleton skeleton-text"></div><div class="skeleton skeleton-text short"></div></div>';
  return `
    <div class="skeleton home-skeleton-hero"></div>
    <div class="home-row"><div class="skeleton skeleton-text home-skeleton-heading"></div>
      <div class="home-row-track">${card.repeat(6)}</div></div>`;
}

function renderContent(page, content) {
  const library = store.get('library') || [];
  const history = store.get('history') || [];
  const favourites = store.get('favourites') || [];
  const profile = store.get('profile') || null;
  const isAdmin = profile ? profile.isAdmin === true : true;
  const tiles = libraryTiles(library);

  const summary = page.querySelector('#home-summary');
  summary.textContent = library.length
    ? `${librarySummary(tiles)} in your vault`
    : 'Your vault is ready for its first files';
  renderHeadActions(page.querySelector('#home-head-actions'), library);

  content.removeAttribute('aria-busy');
  content.innerHTML = '';

  if (!library.length) {
    content.appendChild(gettingStarted({ isAdmin, empty: true }));
    return;
  }

  const recentlyAdded = [...library].sort((a, b) => addedTime(b) - addedTime(a));
  const inProgress = [...continueItems(library, history), ...continueItems(library, history, { audio: true })];
  const playedIds = new Set(history.map(h => h.itemId));

  // Hero: the most recent thing in progress, else the newest film with a
  // backdrop, else the newest item with real artwork.
  const hasArt = i => i.backdropPath || i.posterPath || i.coverArtPath || i.backdrop || i.poster;
  const heroSeed = inProgress[0]
    || recentlyAdded.find(i => isFilm(i) && (i.backdropPath || i.backdrop))
    || recentlyAdded.find(hasArt)
    || recentlyAdded[0];
  if (heroSeed) content.appendChild(createHero(heroSeed, inProgress[0]?.id === heroSeed.id ? inProgress[0].progress : 0));

  if (tiles.length) content.appendChild(libraryNav(tiles));

  const rows = document.createElement('div');
  rows.className = 'home-rows';
  content.appendChild(rows);

  if (inProgress.length) {
    rows.appendChild(createRow({
      id: 'continue', title: 'Continue watching', items: inProgress.slice(0, ROW_LIMIT),
      seeAll: '/continue', onPlay: item => playItem(item, inProgress),
    }));
  }

  // Next up across shows (server computed: next unwatched episode per show).
  const nextUpSlot = document.createElement('div');
  nextUpSlot.className = 'home-slot';
  rows.appendChild(nextUpSlot);
  api.getNextUp(ROW_LIMIT).then(next => {
    // One episode per show; a show already in "Continue watching" is skipped.
    const busyShows = new Set(inProgress.filter(isEpisode).map(showKeyOf));
    const items = (next?.items || []).filter(i => !inProgress.some(p => p.id === i.id) && !busyShows.has(showKeyOf(i)));
    if (!items.length || !nextUpSlot.isConnected) return;
    nextUpSlot.replaceWith(createRow({ id: 'next-up', title: 'Next up in your shows', items, seeAll: '/shows' }));
  }).catch(() => {});

  const music = recentMusic(library, history);
  if (music.length >= 2) {
    rows.appendChild(createRow({
      id: 'recent-music', title: 'Jump back into music', items: music, seeAll: '/music',
      onPlay: item => playItem(item, music),
    }));
  }

  const seedEntry = history.find(h => library.some(i => i.id === h.itemId && genresOf(i).length));
  const seed = seedEntry ? library.find(i => i.id === seedEntry.itemId) : null;
  const similar = similarItems(library, seed, { playedIds })
    .filter(i => !inProgress.some(p => p.id === i.id));
  if (similar.length >= 4) {
    rows.appendChild(createRow({
      id: 'similar', title: `More like ${seed.title}`, items: similar,
      onPlay: item => playItem(item, similar),
    }));
  }

  // A small library gets one mixed "Recently added" row (rows of one or two
  // cards look broken); past that, one row per media type.
  if (library.length < SMALL_LIBRARY) {
    const recent = recentlyAddedGroups(recentlyAdded).flatMap(g => g.items)
      .sort((a, b) => addedTime(b) - addedTime(a)).slice(0, ROW_LIMIT);
    rows.appendChild(createRow({ id: 'recent', title: 'Recently added', items: recent, onPlay: item => playItem(item, recent) }));
  } else {
    for (const row of recentlyAddedRows(recentlyAdded)) rows.appendChild(row);
  }

  const favItems = favourites.map(id => library.find(i => i.id === id)).filter(Boolean);
  if (favItems.length) {
    rows.appendChild(createRow({
      id: 'favourites', title: 'Your favourites', items: favItems.slice(0, ROW_LIMIT), seeAll: '/favourites',
      onPlay: item => playItem(item, favItems),
    }));
  }

  const topRated = library.filter(i => i.rating > 0).sort((a, b) => b.rating - a.rating || addedTime(b) - addedTime(a));
  if (topRated.length >= 4) {
    rows.appendChild(createRow({
      id: 'top-rated', title: 'Top rated', items: topRated.slice(0, ROW_LIMIT),
      onPlay: item => playItem(item, topRated),
    }));
  }

  const panels = document.createElement('div');
  panels.className = 'home-panels';
  panels.appendChild(weekPanel());
  if (library.length < SMALL_LIBRARY) panels.appendChild(gettingStarted({ isAdmin, empty: false }));
  else panels.appendChild(shortcutsPanel());
  content.appendChild(panels);
}

function renderHeadActions(host, library) {
  host.innerHTML = library.length
    ? `<button type="button" class="btn btn-secondary" data-surprise>${icon('shuffle', { size: 16 })}<span>Surprise me</span></button>`
    : '';
  host.querySelector('[data-surprise]')?.addEventListener('click', () => {
    const pool = store.get('library') || [];
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    toast.info(`Playing “${pick.title}”`);
    playItem(pick, pick.type === 'music' ? pool.filter(i => i.type === 'music') : null);
  });
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

/** Big backdrop + resume button + progress (Netflix/Disney+ pattern). */
function createHero(item, progress) {
  const hero = document.createElement('section');
  hero.className = 'hero home-hero-banner';
  hero.setAttribute('aria-labelledby', 'hero-title');
  hero.dataset.npId = item.id; // "Playing" next to the overline while it plays
  const music = item.type === 'music' || isAudio(item);
  // Backdrop endpoint falls back server-side: backdrop → cover → poster → frame.
  const backdropUrl = item.backdrop && String(item.backdrop).startsWith('http')
    ? item.backdrop
    : (music ? api.getCoverUrl(item.id) : api.getBackdropUrl(item.id));
  const posterUrl = (isFilm(item) && (item.posterPath || item.poster)) || music ? api.getCoverUrl(item.id) : null;
  const kind = item.type === 'music' ? 'Music' : item.type === 'audiobook' ? 'Audiobook' : item.type === 'podcast' ? 'Podcast'
    : item.type === 'video' ? 'Video' : item.type === 'comic' ? 'Comic' : (isEpisode(item) ? 'Episode' : 'Film');
  const overline = progress ? `Continue ${music ? 'listening' : 'watching'}` : 'Newly added';
  const genre = genresOf(item)[0];
  const overview = item.description || item.overview || '';
  const episodeLabel = isEpisode(item) ? [hasValue(item.season) ? `S${item.season}` : '', hasValue(item.episode) ? `E${item.episode}` : ''].join('') : '';

  hero.innerHTML = `
    <img class="hero-backdrop${music ? ' is-cover' : ''}" src="${backdropUrl}" alt="" data-img-fallback="hide">
    <div class="hero-body">
      <p class="hero-overline" data-np-slot="inline">${overline}</p>
      <h2 class="hero-title" id="hero-title">${escapeHtml(item.seriesTitle && isEpisode(item) ? item.seriesTitle : item.title)}</h2>
      <div class="hero-meta">
        <span>${kind}</span>
        ${episodeLabel ? `<span>${episodeLabel}${item.seriesTitle ? ` · ${escapeHtml(item.title)}` : ''}</span>` : ''}
        ${item.year ? `<span>${escapeHtml(String(item.year))}</span>` : ''}
        ${genre ? `<span>${escapeHtml(genre)}</span>` : ''}
        ${item.artist ? `<span>${escapeHtml(item.artist)}</span>` : ''}
        ${item.rating ? `<span>${icon('star-filled', { size: 13 })} ${escapeHtml(String(item.rating))}</span>` : ''}
      </div>
      ${overview ? `<p class="hero-overview">${escapeHtml(overview)}</p>` : ''}
      ${progress ? `<div class="hero-progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><span style="width:${Math.round(progress)}%"></span></div><p class="hero-progress-label">${Math.round(progress)}% ${music ? 'played' : 'watched'}</p>` : ''}
      <div class="hero-actions">
        <button class="btn btn-primary btn-lg" type="button" data-hero-play>${icon('play', { size: 18 })}<span>${progress ? 'Resume' : 'Play'}</span></button>
        <button class="btn hero-btn" type="button" data-hero-info>${icon('info', { size: 16 })}<span>Details</span></button>
        <button class="btn hero-btn hero-btn-quiet" type="button" data-hero-list aria-pressed="false">${icon('bookmark', { size: 16 })}<span>My list</span></button>
      </div>
    </div>
    ${posterUrl ? `<img class="hero-poster${music ? ' is-square' : ''}" src="${posterUrl}" alt="" data-img-fallback="remove">` : ''}
  `;

  hero.querySelector('[data-hero-play]').addEventListener('click', () => playItem(item));
  hero.querySelector('[data-hero-info]').addEventListener('click', () => openDetail(item));
  const listBtn = hero.querySelector('[data-hero-list]');
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

// ---------------------------------------------------------------------------
// Library tiles
// ---------------------------------------------------------------------------

function libraryNav(tiles) {
  const nav = document.createElement('nav');
  nav.className = 'home-libraries';
  nav.setAttribute('aria-label', 'Your libraries');
  nav.innerHTML = `<ul class="home-library-list">${tiles.map(tile => `
    <li><a class="home-library" href="${tile.route.slice(1)}" data-route="${tile.route}" data-library="${tile.key}">
      <span class="home-library-icon" aria-hidden="true">${icon(tile.icon, { size: 20 })}</span>
      <span class="home-library-text">
        <span class="home-library-label">${escapeHtml(tile.label)}</span>
        <span class="home-library-count">${escapeHtml(tile.countLabel)}</span>
      </span>
      <span class="home-library-arrow" aria-hidden="true">${icon('chevron-right', { size: 16 })}</span>
    </a></li>`).join('')}</ul>`;
  return nav;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A titled horizontal strip of media cards with "See all" and scroll
 * buttons. `onPlay` defaults to playing the item on its own.
 */
export function createRow({ id, title, items, seeAll = null, onPlay = null }) {
  const section = document.createElement('section');
  section.className = 'home-row';
  section.dataset.row = id;
  const headingId = `home-row-${id}`;
  section.setAttribute('aria-labelledby', headingId);
  section.innerHTML = `
    <div class="home-row-head">
      <h2 class="home-row-title" id="${headingId}">${escapeHtml(title)}</h2>
      <div class="home-row-tools">
        ${seeAll ? `<a class="home-row-all" href="${seeAll.slice(1)}" data-route="${seeAll}">See all<span class="sr-only"> ${escapeHtml(title.toLowerCase())}</span>${icon('chevron-right', { size: 14 })}</a>` : ''}
        <button type="button" class="btn btn-ghost btn-icon home-row-scroll" data-scroll="-1" aria-label="Scroll ${escapeHtml(title.toLowerCase())} back">${icon('chevron-left', { size: 16 })}</button>
        <button type="button" class="btn btn-ghost btn-icon home-row-scroll" data-scroll="1" aria-label="Scroll ${escapeHtml(title.toLowerCase())} forward">${icon('chevron-right', { size: 16 })}</button>
      </div>
    </div>
    <div class="home-row-track" data-scroll-strip></div>`;
  fillTrack(section.querySelector('.home-row-track'), items, onPlay);
  wireScroll(section);
  return section;
}

function fillTrack(track, items, onPlay) {
  track.innerHTML = '';
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const card = createMediaCard(item, {
      onClick: openDetail,
      onPlay: onPlay || (it => playItem(it)),
    });
    labelEpisode(card, item);
    fragment.appendChild(card);
  }
  track.appendChild(fragment);
  track.scrollLeft = 0;
  track.dispatchEvent(new Event('scroll'));
}

/** An episode card leads with its show ("The Lanterns" / "S1 · E2 · Pilot"). */
function labelEpisode(card, item) {
  const show = item.seriesTitle || item.showTitle;
  if (!isEpisode(item) || !show) return;
  const title = card.querySelector('.media-card-title');
  const meta = card.querySelector('.media-card-meta');
  const code = [hasValue(item.season) ? `S${item.season}` : '', hasValue(item.episode) ? `E${item.episode}` : ''].filter(Boolean).join(' · ');
  if (title) { title.textContent = show; title.title = show; }
  if (meta) meta.textContent = [code, item.title].filter(Boolean).join(' · ');
  card.setAttribute('aria-label', `${show}, ${[code, item.title].filter(Boolean).join(', ')}`);
}

function wireScroll(section) {
  const track = section.querySelector('.home-row-track');
  const back = section.querySelector('[data-scroll="-1"]');
  const forward = section.querySelector('[data-scroll="1"]');
  const update = () => {
    const max = track.scrollWidth - track.clientWidth;
    back.disabled = track.scrollLeft <= 4;
    forward.disabled = max <= 4 || track.scrollLeft >= max - 4;
  };
  section.querySelectorAll('[data-scroll]').forEach(button => {
    button.addEventListener('click', () => {
      const step = Math.max(track.clientWidth * 0.85, 200) * Number(button.dataset.scroll);
      track.scrollBy({ left: step, behavior: 'smooth' });
    });
  });
  track.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
}

const RECENT_TITLES = {
  films: 'New films', shows: 'New episodes', music: 'New music', audiobooks: 'New audiobooks',
  podcasts: 'New podcast episodes', comics: 'New comics', videos: 'New videos',
};

/**
 * Recently added, one row per media type so every row has one artwork shape.
 * Episodes collapse to the newest per show and songs to one per album; rows
 * are ordered by their newest arrival.
 */
export function recentlyAddedGroups(sorted, limit = ROW_LIMIT) {
  return LIBRARY_TILES.map(tile => {
    const seen = new Set();
    const items = [];
    for (const item of sorted) {
      if (!tile.test(item)) continue;
      let key = null;
      if (tile.key === 'shows') key = showKeyOf(item);
      else if (tile.key === 'music' && item.album) key = `${item.album}\u0000${item.albumArtist || item.artist || ''}`;
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      items.push(item);
      if (items.length >= limit) break;
    }
    return { key: tile.key, title: RECENT_TITLES[tile.key], route: tile.route, items, newest: items.length ? addedTime(items[0]) : 0 };
  }).filter(group => group.items.length).sort((a, b) => b.newest - a.newest);
}

function recentlyAddedRows(sorted) {
  return recentlyAddedGroups(sorted).map(group => createRow({
    id: `new-${group.key}`, title: group.title, items: group.items, seeAll: group.route,
    onPlay: item => playItem(item, group.items),
  }));
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** "Your week": time listened/watched and a bar per day. */
function weekPanel() {
  const panel = document.createElement('section');
  panel.className = 'home-panel home-week';
  panel.setAttribute('aria-labelledby', 'home-week-title');
  panel.innerHTML = `
    <div class="home-panel-head">
      <h2 class="home-panel-title" id="home-week-title">${icon('bar-chart', { size: 18 })}<span>Your week</span></h2>
      <a class="home-row-all" href="stats" data-route="/stats">Stats${icon('chevron-right', { size: 14 })}</a>
    </div>
    <div class="home-week-body"><p class="home-panel-text">Loading…</p></div>`;
  const body = panel.querySelector('.home-week-body');
  api.getRecap('week').then(recap => {
    if (!body.isConnected) return;
    body.innerHTML = weekHtml(recap);
  }).catch(() => {
    if (body.isConnected) body.innerHTML = '<p class="home-panel-text">Your listening and watching time shows up here.</p>';
  });
  return panel;
}

const minutesLabel = seconds => {
  const m = Math.round((seconds || 0) / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
};

export function weekHtml(recap) {
  const s = recap?.summary || {};
  const daily = (recap?.watching?.daily || []).slice(-7);
  if (!s.totalSeconds) {
    return '<p class="home-panel-text">Nothing played this week yet. Press play on something and your time shows up here.</p>';
  }
  const max = Math.max(1, ...daily.map(d => d.seconds || 0));
  const dayName = d => {
    const date = new Date(d.date || d.day || '');
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { weekday: 'narrow' });
  };
  return `
    <p class="home-week-total"><span class="home-week-number">${escapeHtml(minutesLabel(s.totalSeconds))}</span> played on ${plural(s.activeDays || 0, 'day')}</p>
    <dl class="home-week-split">
      <div><dt>Watching</dt><dd>${escapeHtml(minutesLabel(s.watchSeconds))}</dd></div>
      <div><dt>Listening</dt><dd>${escapeHtml(minutesLabel(s.listenSeconds))}</dd></div>
      <div><dt>Titles</dt><dd>${(s.videoItems || 0) + (s.musicTracks || 0)}</dd></div>
    </dl>
    ${daily.length ? `<ol class="home-week-bars" aria-label="Time played per day">${daily.map(d => `
      <li title="${escapeHtml(minutesLabel(d.seconds))}"><span class="home-week-bar" style="height:${Math.max(4, Math.round(((d.seconds || 0) / max) * 100))}%"></span><span class="home-week-day" aria-hidden="true">${escapeHtml(dayName(d))}</span><span class="sr-only">${escapeHtml(dayName(d))}: ${escapeHtml(minutesLabel(d.seconds))}</span></li>`).join('')}
    </ol>` : ''}`;
}

/** Quick ways into the rest of the app, for libraries past the first steps. */
function shortcutsPanel() {
  const panel = document.createElement('section');
  panel.className = 'home-panel home-shortcuts';
  panel.setAttribute('aria-labelledby', 'home-shortcuts-title');
  const links = [
    ['/watchlist', 'bookmark', 'My list', 'Saved for later'],
    ['/playlists', 'list', 'Playlists', 'Mixes and collections'],
    ['/livetv', 'radio', 'Live TV', 'Channels and recordings'],
    ['/syncplay', 'users', 'Watch together', 'SyncPlay rooms'],
  ];
  panel.innerHTML = `
    <div class="home-panel-head"><h2 class="home-panel-title" id="home-shortcuts-title">${icon('sparkles', { size: 18 })}<span>Also in Vault</span></h2></div>
    <ul class="home-shortcut-list">${links.map(([route, iconName, label, help]) => `
      <li><a class="home-shortcut" href="${route.slice(1)}" data-route="${route}">
        <span class="home-library-icon" aria-hidden="true">${icon(iconName, { size: 18 })}</span>
        <span class="home-library-text"><span class="home-library-label">${label}</span><span class="home-library-count">${help}</span></span>
      </a></li>`).join('')}
    </ul>`;
  return panel;
}

/**
 * First steps: where files go, uploading, and phones. `empty` makes it the
 * whole page (with a welcome); otherwise it is a panel next to "Your week".
 */
export function gettingStarted({ isAdmin, empty }) {
  const section = document.createElement('section');
  section.className = empty ? 'home-welcome' : 'home-panel home-start';
  section.setAttribute('aria-labelledby', 'home-start-title');
  const steps = isAdmin ? [
    {
      icon: 'folder', title: 'Add files to your media folders',
      text: 'Copy films, shows, music and books into the folders you picked during setup. Vault notices new files by itself.',
      action: `<button type="button" class="btn btn-secondary btn-sm" data-start-scan>${icon('refresh', { size: 14 })}<span>Scan now</span></button>`,
    },
    {
      icon: 'upload', title: 'Or upload from this device',
      text: 'Drag files or a whole folder in. Vault sorts them by type and reads their tags and artwork.',
      action: `<a class="btn btn-secondary btn-sm" href="upload" data-route="/upload">${icon('upload', { size: 14 })}<span>Upload</span></a>`,
    },
    {
      icon: 'smartphone', title: 'Get Vault on your phone and TV',
      text: 'Scan a QR code to open Vault on another device on your Wi-Fi, or switch on remote access.',
      action: `<a class="btn btn-secondary btn-sm" href="settings#connection" data-route="/settings#connection">${icon('smartphone', { size: 14 })}<span>Show QR code</span></a>`,
    },
  ] : [
    {
      icon: 'folder', title: 'Nothing here for this profile yet',
      text: 'Ask whoever runs this Vault to add some media, or switch to another profile.',
      action: `<a class="btn btn-secondary btn-sm" href="profiles" data-route="/profiles">${icon('users', { size: 14 })}<span>Profiles</span></a>`,
    },
  ];
  section.innerHTML = `
    ${empty ? `<div class="home-welcome-intro">
      <span class="home-welcome-icon" aria-hidden="true">${icon('sparkles', { size: 26 })}</span>
      <h2 class="home-welcome-title" id="home-start-title">Welcome to your vault</h2>
      <p class="home-welcome-text">${isAdmin ? 'Three steps and your films, shows and music are here — on every screen in the house.' : 'This profile has nothing to show yet.'}</p>
    </div>` : `<div class="home-panel-head"><h2 class="home-panel-title" id="home-start-title">${icon('sparkles', { size: 18 })}<span>Getting started</span></h2></div>`}
    <ol class="home-steps">${steps.map((step, index) => `
      <li class="home-step">
        <span class="home-step-number" aria-hidden="true">${steps.length > 1 ? index + 1 : icon(step.icon, { size: 18 })}</span>
        <div class="home-step-text">
          <h3 class="home-step-title">${escapeHtml(step.title)}</h3>
          <p class="home-panel-text">${escapeHtml(step.text)}</p>
          <div class="home-step-action">${step.action}</div>
        </div>
      </li>`).join('')}
    </ol>`;
  section.querySelector('[data-start-scan]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api.triggerScan();
      toast.success('Scanning your media folders — new files appear here as they are found');
      const data = await api.getLibrary({ limit: 1000 });
      if (data?.items) store.setLibrary(data.items);
    } catch (err) {
      toast.error(`Scan failed: ${err.message}`);
    } finally {
      button.disabled = false;
    }
  });
  return section;
}
