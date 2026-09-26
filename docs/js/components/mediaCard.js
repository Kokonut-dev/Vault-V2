/**
 * Media Card component
 */
import { api } from '../api.js';
import { formatTime, formatYear, truncate, escapeHtml } from '../utils/format.js';
import { lazyLoadElement } from '../utils/lazyLoad.js';

export function createMediaCard(item, options = {}) {
  const { onPlay, onClick, showProgress = true } = options;
  
  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.id = item.id;
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${item.title} ${item.artist ? `by ${item.artist}` : ''}`);
  
  const isMusic = item.type === 'music';
  const isVideo = item.type === 'video' || item.type === 'movie';
  const coverType = isMusic ? 'music' : isVideo ? 'video' : '';
  
  const progress = item.progress || 0;
  const hasProgress = showProgress && progress > 0 && progress < 95;
  
  card.innerHTML = `
    <div class="media-card-cover ${coverType}">
      <img data-src="${item.thumbnailPath ? api.getThumbnailUrl(item.id) : api.getCoverUrl(item.id)}" alt="${escapeHtml(item.title)}" loading="lazy" onerror="this.style.display='none'">
      <div class="media-card-overlay">
        <div class="media-card-play">▶</div>
      </div>
      ${hasProgress ? `<div class="media-card-progress"><div class="media-card-progress-bar" style="width:${progress}%"></div></div>` : ''}
    </div>
    <div class="media-card-info">
      <div class="media-card-title" title="${escapeHtml(item.title)}">${escapeHtml(truncate(item.title, 40))}</div>
      <div class="media-card-meta">${getMeta(item)}</div>
    </div>
  `;
  
  card.addEventListener('click', (e) => {
    if (onClick) onClick(item, e);
    else if (onPlay) onPlay(item, e);
    else {
      window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
    }
  });
  
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      card.click();
    }
  });
  
  // Lazy load
  const img = card.querySelector('img[data-src]');
  if (img) lazyLoadElement(img);
  
  return card;
}

function getMeta(item) {
  if (item.type === 'music') {
    return escapeHtml(item.artist || item.album || '');
  }
  if (item.type === 'movie') {
    const parts = [];
    if (item.year) parts.push(String(item.year));
    if (item.genre) parts.push(typeof item.genre === 'string' ? item.genre : item.genre[0]);
    if (item.season && item.episode) parts.push(`S${item.season}E${item.episode}`);
    return parts.map(escapeHtml).join(' • ') || '';
  }
  return escapeHtml(item.genre || formatTime(item.duration) || '');
}

export function formatYear(item) {
  return item.year || '';
}
