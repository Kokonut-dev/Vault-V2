/**
 * Media List — table view — optimized with DocumentFragment
 */
import { api } from '../api.js';
import { formatTime, formatBytes, formatDate, escapeHtml } from '../utils/format.js';

export function renderMediaList(container, items, options = {}) {
  const { onPlay, onClick, sortField = 'title', sortOrder = 'asc' } = options;
  
  container.innerHTML = '';
  
  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">≡</div>
        <div class="empty-state-title">No items</div>
        <div class="empty-state-message">Try adjusting your filters or add some media</div>
      </div>
    `;
    return;
  }
  
  const list = document.createElement('div');
  list.className = 'media-list';
  
  const header = document.createElement('div');
  header.className = 'media-list-header';
  header.innerHTML = `
    <span>Title</span>
    <span>Artist / Genre</span>
    <span>Duration</span>
    <span>Year</span>
  `;
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
        <button class="media-list-play" type="button" aria-label="Play">▶</button>
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
    
    row.addEventListener('keydown', (e) => {
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
