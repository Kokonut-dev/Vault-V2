/**
 * Media Grid — optimized: DocumentFragment batch, IntersectionObserver lazy image
 */
import { createMediaCard } from './mediaCard.js';
import { escapeHtml } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { createVirtualGrid } from '../utils/virtualGrid.js';

/** Above this many items the grid switches to windowed rendering (F-12). */
const VIRTUAL_THRESHOLD = 150;

export function renderMediaGrid(container, items, options = {}) {
  const { onPlay, onClick, emptyMessage = 'No items found', virtual } = options;
  
  container.innerHTML = '';
  
  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('layout-grid', { size: 30 })}</div>
        <div class="empty-state-title">Nothing here yet</div>
        <div class="empty-state-message">${escapeHtml(emptyMessage)}</div>
      </div>
    `;
    return;
  }
  
  // Large libraries: only keep the visible slice of cards in the DOM.
  // Below the threshold we keep the simple path (and its stagger animation).
  if (virtual !== false && items.length > VIRTUAL_THRESHOLD) {
    container._vaultVirtualGrid?.destroy?.();
    const grid = createVirtualGrid(container, {
      itemHeight: options.itemHeight || 300,
      columns: options.columns || 0,
      gap: 16,
      threshold: VIRTUAL_THRESHOLD,
    });
    grid.setItems(items, item => createMediaCard(item, { onPlay, onClick }));
    container._vaultVirtualGrid = grid;
    return grid;
  }
  container._vaultVirtualGrid?.destroy?.();
  container._vaultVirtualGrid = null;

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
