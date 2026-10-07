/**
 * My List (watchlist) + Continue Watching + Next Up.
 * Server side lives in /api/extras/watchlist (per profile).
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { renderMediaGrid, renderSkeletonGrid } from '../components/mediaGrid.js';
import { subscribeView } from '../utils/lifecycle.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime, truncate } from '../utils/format.js';
import { toast } from '../components/toast.js';

export async function renderWatchlist(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('bookmark', { size: 26 })}<span>My List</span></h1>
      <p class="page-subtitle">Everything you saved for later, plus what you are part-way through</p>
    </div>
    <div id="watchlist-content"></div>
  `;
  const content = container.querySelector('#watchlist-content');
  renderSkeletonGrid(content, 8);

  async function load() {
    let items = [];
    try {
      const data = await api.getWatchlist();
      items = (data.items || []).map(entry => entry.item || entry);
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not load your list</div>
        <div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }

    renderMediaGrid(content, items, {
      onClick: item => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } })),
      onPlay: item => {
        if (item.type === 'music') window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue: items, index: items.findIndex(i => i.id === item.id) } }));
        else window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
      },
      emptyMessage: 'Use “Add to my list” on any card or detail page.',
    });
  }

  await load();
  window.addEventListener('vault:watchlist-changed', load);
}

export async function renderContinue(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('activity', { size: 26 })}<span>Continue Watching</span></h1>
      <p class="page-subtitle">Pick up where you left off — positions sync across your devices</p>
    </div>
    <div id="continue-content"></div>
  `;
  const content = container.querySelector('#continue-content');
  renderSkeletonGrid(content, 6);

  let inFlight = [];
  try {
    const [recent, nextUp] = await Promise.all([
      api.getRecent(null, 24).catch(() => ({ items: [] })),
      api.getNextUp(12).catch(() => ({ items: [] })),
    ]);
    inFlight = (recent.items || []).filter(item => !item.watched);
    renderMediaGrid(content, inFlight, {
      onClick: item => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } })),
      onPlay: item => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } })),
      emptyMessage: 'Nothing in progress. Start something and it will appear here.',
    });

    if (nextUp.items?.length) {
      const wrap = document.createElement('section');
      wrap.className = 'carousel';
      wrap.innerHTML = `<div class="carousel-header"><h2 class="carousel-title">Next up in your shows</h2></div>
        <div class="carousel-track" id="next-up-track"></div>`;
      const track = wrap.querySelector('#next-up-track');
      nextUp.items.forEach(item => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'media-card';
        card.dataset.itemId = item.id;
        card.dataset.contextMenuFor = item.id;
        card.innerHTML = `
          <div class="media-card-cover">
            <img loading="lazy" src="${api.getThumbnailUrl(item.id)}" alt="">
            ${item.progress ? `<div class="media-card-progress"><div class="media-card-progress-bar" style="width:${item.progress}%"></div></div>` : ''}
          </div>
          <div class="media-card-info">
            <div class="media-card-title">${escapeHtml(truncate(item.title, 40))}</div>
            <div class="media-card-meta">${item.season ? `S${item.season}E${item.episode} · ` : ''}${item.duration ? formatTime(item.duration) : ''}</div>
          </div>`;
        card.addEventListener('click', () => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } })));
        track.appendChild(card);
      });
      content.appendChild(wrap);
    }
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
  }

  window.addEventListener('vault:library-changed', () => {
    // Cheap re-render instead of a full reload: pull the newest progress
    // values and repaint the grid in place.
    api.getRecent(null, 24).then(result => {
      renderMediaGrid(content, (result.items || []).filter(item => !item.watched), {
        onClick: item => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } })),
        onPlay: item => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } })),
      });
    }).catch(() => {});
  });
}

export default { renderWatchlist, renderContinue };
