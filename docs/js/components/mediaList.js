/**
 * Media List — table view — optimized with DocumentFragment
 */
import { api } from '../api.js';
import { formatTime, escapeHtml } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { attachContextMenu } from './contextMenu.js';

export function renderMediaList(container, items, options = {}) {
  const { onPlay, onClick, sortField = 'title', sortOrder = 'asc', onSort } = options;
  
  container.innerHTML = '';
  
  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${icon('list', { size: 30 })}</div>
        <div class="empty-state-title">No items</div>
        <div class="empty-state-message">Try adjusting your filters or add some media</div>
      </div>
    `;
    return;
  }
  
  const list = document.createElement('div');
  list.className = 'media-list media-list--library';
  
  const header = document.createElement('div');
  header.className = 'media-list-header';
  const columns = [
    ['title', 'Title'],
    ['artist', 'Artist / Genre'],
    ['duration', 'Duration'],
    ['year', 'Year'],
  ];
  // Sortable only when the view supplies onSort; plain spans otherwise.
  header.innerHTML = columns.map(([field, label]) => {
    if (!onSort) return `<span>${label}</span>`;
    const active = sortField === field;
    const state = active ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'unsorted';
    const ind = active ? icon(sortOrder === 'asc' ? 'chevron-up' : 'chevron-down', { size: 12, strokeWidth: 2.5 }) : '';
    return `<button type="button" class="media-list-sort${active ? ' active' : ''}" data-field="${field}" aria-label="Sort by ${label} — currently ${state}">${label}<span class="sort-ind" aria-hidden="true">${ind}</span></button>`;
  }).join('');
  if (onSort) {
    header.querySelectorAll('.media-list-sort').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = btn.dataset.field;
        const next = sortField === field
          ? (sortOrder === 'asc' ? 'desc' : 'asc')
          : (field === 'title' || field === 'artist' ? 'asc' : 'desc');
        onSort(field, next);
      });
    });
  }
  list.appendChild(header);
  
  // Use DocumentFragment for batch DOM insertion — faster
  const fragment = document.createDocumentFragment();
  
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'media-list-item';
    row.dataset.id = item.id;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    
    row.innerHTML = `
      <div class="media-list-item-main">
        <button class="media-list-play" type="button" aria-label="Play">${icon('play', { size: 13 })}</button>
        <div class="media-list-item-cover">
          <img src="${item.type === 'music' ? api.getCoverUrl(item.id) : api.getThumbnailUrl(item.id)}" alt="" loading="lazy" onerror="this.style.display='none'">
        </div>
        <div style="min-width:0;">
          <div class="media-list-item-title">${escapeHtml(item.title)}</div>
          <div class="media-list-item-artist">${escapeHtml(item.filename || '')}</div>
        </div>
      </div>
      <div style="font-size:13px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
        ${escapeHtml(item.artist || item.genre || '')}
      </div>
      <div style="font-size:13px; font-family:var(--font-mono); color:var(--text-secondary);">
        ${formatTime(item.duration)}
      </div>
      <div style="font-size:13px; color:var(--text-secondary);">
        ${item.year || '—'}
      </div>
    `;

    row.querySelector('.media-list-play').addEventListener('click', (e) => {
      e.stopPropagation();
      if (onPlay) onPlay(item);
      else if (onClick) onClick(item);
    });

    row.addEventListener('click', () => {
      if (onClick) onClick(item);
      else if (onPlay) onPlay(item);
    });
    
    // Right-click / long-press gets the same actions as grid cards
    // (queue, watchlist, watched, add to playlist, trash).
    row.dataset.itemId = item.id;
    row.dataset.contextMenuFor = item.id;
    attachContextMenu(row, item);

    row.addEventListener('keydown', (e) => {
      // Row-focused only — a Space/Enter on the nested .media-list-play button
      // must reach that button, not be swallowed here (see mediaCard.js).
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        row.click();
      }
    });
    
    fragment.appendChild(row);
  });
  
  list.appendChild(fragment);
  container.appendChild(list);
}
