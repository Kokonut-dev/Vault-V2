/**
 * Comics / eBooks — CBZ/CBR reader (Komga-lite).
 * Server: /api/comics (pages via the CBZ central directory).
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { toast } from '../components/toast.js';

export async function renderComics(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('book', { size: 26 })}<span>Comics & eBooks</span></h1>
      <p class="page-subtitle">CBZ archives from your comics library, readable in the browser</p>
    </div>
    <div id="comics-body"></div>
  `;
  const body = container.querySelector('#comics-body');
  const items = (store.get('library') || []).filter(item => item.type === 'comic');

  if (!items.length) {
    body.innerHTML = `<div class="empty-state">${icon('book', { size: 30 })}
      <div class="empty-state-title">No comics found</div>
      <div class="empty-state-message">Add <code>.cbz</code> files under a configured comics path and run a scan.</div></div>`;
    return;
  }

  body.innerHTML = `<div class="media-grid stagger" id="comic-grid"></div>`;
  const grid = body.querySelector('#comic-grid');
  items.forEach(item => {
    const card = document.createElement('a');
    card.className = 'media-card';
    card.href = `#/read/${item.id}`;
    card.dataset.type = 'movie';
    card.innerHTML = `
      <div class="media-card-cover">
        <img loading="lazy" src="${api.getCoverUrl(item.id)}" alt="${escapeHtml(item.title)}">
        <div class="media-card-placeholder">${icon('book', { size: 34 })}</div>
      </div>
      <div class="media-card-info">
        <div class="media-card-title">${escapeHtml(item.title)}</div>
        <div class="media-card-meta">${escapeHtml(item.series || item.author || 'Comic')}</div>
      </div>`;
    grid.appendChild(card);
  });
}

export async function renderComicReader(container, id) {
  container.className = 'page reader-page';
  container.innerHTML = `<div class="comic-reader" id="comic-reader">
    <div class="comic-controls">
      <button class="btn btn-icon" id="page-prev" aria-label="Previous page">${icon('chevron-left', { size: 18 })}</button>
      <span class="row-meta" id="page-indicator">Loading…</span>
      <button class="btn btn-icon" id="page-next" aria-label="Next page">${icon('chevron-right', { size: 18 })}</button>
      <button class="btn btn-ghost btn-sm" id="page-fit">Fit: width</button>
      <button class="btn btn-ghost btn-sm" id="page-fullscreen">Fullscreen</button>
    </div>
    <div id="comic-pages" class="comic-pages"></div>
  </div>`;

  const pagesHost = container.querySelector('#comic-pages');
  const indicator = container.querySelector('#page-indicator');
  const reader = container.querySelector('#comic-reader');
  let pages = [];
  let current = 0;
  let mode = 'single';

  try {
    const data = await api.getComicPages(id);
    pages = data.pages || [];
  } catch (err) {
    pagesHost.innerHTML = `<div class="empty-state"><div class="empty-state-title">Could not open this comic</div>
      <div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  if (!pages.length) {
    pagesHost.innerHTML = '<div class="empty-state"><div class="empty-state-message">This archive has no readable pages.</div></div>';
    return;
  }

  function pageUrl(index) {
    return api.comicPageUrl(id, index);
  }

  function paint() {
    if (mode === 'single') {
      pagesHost.innerHTML = `<img class="comic-page" src="${pageUrl(current)}" alt="Page ${current + 1}">`;
      pagesHost.style.display = 'grid';
      pagesHost.style.gap = '0';
    } else {
      pagesHost.innerHTML = pages.map((_, index) => `<img class="comic-page" loading="lazy" src="${pageUrl(index)}" alt="Page ${index + 1}">`).join('');
      pagesHost.style.display = 'grid';
      pagesHost.style.gap = '8px';
    }
    indicator.textContent = `${current + 1} / ${pages.length}`;
  }

  function go(delta) {
    if (mode !== 'single') return;
    current = Math.max(0, Math.min(pages.length - 1, current + delta));
    paint();
    reader.scrollIntoView({ block: 'start' });
  }

  container.querySelector('#page-prev').addEventListener('click', () => go(-1));
  container.querySelector('#page-next').addEventListener('click', () => go(1));
  container.querySelector('#page-fit').addEventListener('click', (event) => {
    mode = mode === 'single' ? 'scroll' : 'single';
    event.currentTarget.textContent = mode === 'single' ? 'Fit: width' : 'Mode: single page';
    paint();
  });
  container.querySelector('#page-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else reader.requestFullscreen?.().catch(() => toast.info('Fullscreen blocked by the browser'));
  });

  // Keyboard paging (arrow keys are the natural reading gesture).
  const onKey = (event) => {
    if (event.key === 'ArrowRight' || event.key === ' ') go(1);
    if (event.key === 'ArrowLeft') go(-1);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', () => document.removeEventListener('keydown', onKey), { once: true });

  paint();
}

export default { renderComics, renderComicReader };
