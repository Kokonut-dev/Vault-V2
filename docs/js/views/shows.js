/**
 * TV shows — library list, show detail with seasons/episodes, Next Up.
 * (Tier 2 item 10: the biggest missing piece of Plex/Jellyfin parity.)
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { renderSkeletonGrid } from '../components/mediaGrid.js';
import { subscribeView } from '../utils/lifecycle.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime, truncate } from '../utils/format.js';
import { toast } from '../components/toast.js';

const watchedKey = item => !!item.watched;

export async function renderShows(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('tv', { size: 26 })}<span>TV Shows</span></h1>
      <p class="page-subtitle">Series, seasons and episodes from your library</p>
    </div>
    <div id="shows-content"></div>
  `;
  const content = container.querySelector('#shows-content');
  renderSkeletonGrid(content, 12);

  let shows = [];
  async function load() {
    try {
      const data = await api.getShows();
      shows = data.shows || data.items || [];
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load shows</div>
        <div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }
    paint();
  }

  function paint() {
    if (!shows.length) {
      content.innerHTML = `<div class="empty-state">${icon('tv', { size: 30 })}
        <div class="empty-state-title">No shows found</div>
        <div class="empty-state-message">Series are detected from <code>Show/Season 01/Show S01E01.mkv</code> style paths. Add episodes and run a scan.</div></div>`;
      return;
    }
    content.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'media-grid stagger';
    shows.forEach(show => {
      const card = document.createElement('a');
      card.className = 'media-card';
      card.href = `#/show/${encodeURIComponent(show.key)}`;
      card.dataset.type = 'movie';
      card.innerHTML = `
        <div class="media-card-cover">
          <img loading="lazy" src="${show.poster ? (show.poster.startsWith('http') ? show.poster : `${api.baseUrl}${show.poster}`) : api.getCoverUrl(show.key)}" alt="${escapeHtml(show.title)}">
          <div class="media-card-placeholder" aria-hidden="true">${icon('tv', { size: 34 })}</div>
          ${show.unwatchedCount ? `<div class="media-card-badge">${show.unwatchedCount} new</div>` : ''}
        </div>
        <div class="media-card-info">
          <div class="media-card-title">${escapeHtml(truncate(show.title, 40))}</div>
          <div class="media-card-meta">${show.seasonCount} season${show.seasonCount === 1 ? '' : 's'} · ${show.episodeCount} episodes</div>
        </div>
      `;
      card.addEventListener('click', (event) => {
        event.preventDefault();
        location.hash = `#/show/${encodeURIComponent(show.key)}`;
      });
      grid.appendChild(card);
    });
    content.appendChild(grid);
  }

  await load();
  subscribeView(store, 'library', load);
}

export async function renderShowDetail(container, key) {
  container.className = 'page';
  container.innerHTML = `<div class="page-header"><div class="skeleton skeleton-title"></div></div>`;

  let show;
  try {
    const data = await api.getShow(key);
    show = data.show || data;
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Show not found</div>
      <div class="empty-state-message">${escapeHtml(err.message)}</div>
      <a class="btn btn-primary" href="#/shows">Back to shows</a></div>`;
    return;
  }

  const seasons = show.seasons || [];
  let activeSeason = seasons.find(s => s.episodes.some(e => !e.watched))?.season ?? seasons[0]?.season ?? 1;
  let nextUp = null;
  if (show.key) {
    try {
      const next = await api.getNextUp(50);
      nextUp = (next.items || []).find(entry => entry.seriesKey === show.key) || null;
    } catch { /* next-up is optional */ }
  }

  const backdrop = show.backdrop || show.poster;
  container.innerHTML = `
    <div class="hero">
      ${backdrop ? `<img class="hero-backdrop" src="${backdrop.startsWith('http') ? backdrop : api.baseUrl + backdrop}" alt="">` : ''}
      <h1 class="hero-title">${escapeHtml(show.title)}</h1>
      <div class="hero-meta">
        ${show.year ? `<span>${show.year}</span>` : ''}
        <span>${seasons.length} season${seasons.length === 1 ? '' : 's'}</span>
        <span>${show.episodeCount || 0} episodes</span>
        ${show.rating ? `<span>${icon('star-filled', { size: 13 })} ${show.rating}</span>` : ''}
        ${show.genre ? `<span>${escapeHtml(Array.isArray(show.genre) ? show.genre.join(', ') : show.genre)}</span>` : ''}
      </div>
      ${show.overview ? `<p class="hero-overview">${escapeHtml(show.overview)}</p>` : ''}
      <div class="hero-actions">
        ${nextUp ? `<button class="btn btn-primary" id="show-continue">${icon('play', { size: 16 })}<span>Continue: ${escapeHtml(nextUp.title)}${nextUp.episode ? ` (S${nextUp.season}E${nextUp.episode})` : ''}</span></button>` : ''}
        <button class="btn btn-secondary" id="show-play-random">${icon('shuffle', { size: 16 })}<span>Play random</span></button>
        <button class="btn btn-ghost" id="show-watched">${icon('check', { size: 16 })}<span>Mark all watched</span></button>
        <button class="btn btn-ghost" id="show-list">${icon('bookmark', { size: 16 })}<span>Add to my list</span></button>
      </div>
    </div>
    <div class="season-tabs" id="season-tabs" role="tablist"></div>
    <div id="episode-list" class="episode-list"></div>
  `;

  const tabs = container.querySelector('#season-tabs');
  const list = container.querySelector('#episode-list');

  function episodeRow(episode) {
    const row = document.createElement('div');
    row.className = `episode-row${episode.watched ? ' watched' : ''}`;
    row.innerHTML = `
      <div class="episode-thumb">
        <img loading="lazy" src="${api.getThumbnailUrl(episode.id)}" alt="" onerror="this.style.display='none'">
        ${episode.progress ? `<div class="media-card-progress"><div class="media-card-progress-bar" style="width:${episode.progress}%"></div></div>` : ''}
      </div>
      <div class="episode-info">
        <div class="episode-title">${episode.episode ? `<span class="episode-number">E${String(episode.episode).padStart(2, '0')}</span>` : ''}${escapeHtml(episode.title)}</div>
        <div class="episode-meta">${episode.duration ? formatTime(episode.duration) : ''}${episode.overview ? ` · ${escapeHtml(truncate(episode.overview, 120))}` : ''}</div>
      </div>
      <div class="episode-actions">
        ${episode.watched ? `<span class="episode-watched-mark" title="Watched">${icon('check', { size: 14 })}</span>` : ''}
        <button class="btn btn-icon" data-play aria-label="Play ${escapeHtml(episode.title)}">${icon('play', { size: 16 })}</button>
        <button class="btn btn-icon" data-toggle-watched aria-label="${episode.watched ? 'Mark unwatched' : 'Mark watched'}">${episode.watched ? icon('eye-off', { size: 16 }) : icon('eye', { size: 16 })}</button>
      </div>
    `;
    row.addEventListener('dblclick', () => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: episode } })));
    row.querySelector('[data-play]').addEventListener('click', (event) => {
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: episode } }));
    });
    row.querySelector('[data-toggle-watched]').addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        await api.setWatched(episode.id, !episode.watched);
        episode.watched = !episode.watched;
        row.classList.toggle('watched', episode.watched);
        row.querySelector('[data-toggle-watched]').innerHTML = episode.watched ? icon('eye-off', { size: 16 }) : icon('eye', { size: 16 });
      } catch (err) {
        toast.error(`Could not update: ${err.message}`);
      }
    });
    return row;
  }

  function paintSeason(seasonNumber) {
    activeSeason = seasonNumber;
    tabs.querySelectorAll('.season-tab').forEach(tab => {
      const active = Number(tab.dataset.season) === seasonNumber;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    const season = seasons.find(s => s.season === seasonNumber);
    list.innerHTML = '';
    if (!season) return;
    season.episodes.forEach(episode => list.appendChild(episodeRow(episode)));
  }

  tabs.innerHTML = seasons.map(season => `
    <button type="button" class="settings-tab season-tab" role="tab" data-season="${season.season}">
      Season ${season.season}${season.episodes.some(e => !e.watched) ? ' <span class="dot"></span>' : ''}
    </button>
  `).join('');
  tabs.querySelectorAll('.season-tab').forEach(tab => {
    tab.addEventListener('click', () => paintSeason(Number(tab.dataset.season)));
  });
  paintSeason(activeSeason);

  container.querySelector('#show-continue')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: nextUp } }));
  });
  container.querySelector('#show-play-random')?.addEventListener('click', () => {
    const all = seasons.flatMap(s => s.episodes);
    const pick = all[Math.floor(Math.random() * all.length)];
    if (pick) window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: pick } }));
  });
  container.querySelector('#show-watched')?.addEventListener('click', async () => {
    try {
      await api.setSeriesWatched(show.key, { watched: true });
      seasons.forEach(s => s.episodes.forEach(e => { e.watched = true; }));
      paintSeason(activeSeason);
      toast.success('Series marked watched');
    } catch (err) {
      toast.error(`Could not update: ${err.message}`);
    }
  });
  container.querySelector('#show-list')?.addEventListener('click', async () => {
    try {
      await api.addToWatchlist(show.key);
      toast.success('Added to your list');
    } catch (err) {
      toast.error(err.message);
    }
  });
}

export default { renderShows, renderShowDetail };
