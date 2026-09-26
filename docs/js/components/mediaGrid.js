/**
 * Media Grid — optimized: DocumentFragment batch, IntersectionObserver lazy image
 */
import { createMediaCard } from './mediaCard.js';
import { escapeHtml } from '../utils/format.js';

export function renderMediaGrid(container, items, options = {}) {
  const { onPlay, onClick, emptyMessage = 'No items found' } = options;
  
  container.innerHTML = '';
  
  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">◫</div>
        <div class="empty-state-title">Nothing here yet</div>
        <div class="empty-state-message">${escapeHtml(emptyMessage)}</div>
      </div>
    `;
    return;
  }
  
  const grid = document.createElement('div');
  grid.className = 'media-grid stagger';
  
  const fragment = document.createDocumentFragment();
  items.forEach(item => {
    const card = createMediaCard(item, { onPlay, onClick });
    fragment.appendChild(card);
  });
  grid.appendChild(fragment);
  
  container.appendChild(grid);
}

export function renderSkeletonGrid(container, count = 12) {
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'media-grid';
  
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'media-card';
    card.innerHTML = `
      <div class="media-card-cover skeleton skeleton-card"></div>
      <div class="media-card-info">
        <div class="skeleton skeleton-text" style="width:80%"></div>
        <div class="skeleton skeleton-text short"></div>
      </div>
    `;
    fragment.appendChild(card);
  }
  grid.appendChild(fragment);
  container.appendChild(grid);
}
