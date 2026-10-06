/**
 * Media Card component
 */
import { api } from '../api.js';
import { formatTime, truncate, escapeHtml, escapeAttr } from '../utils/format.js';
import { lazyLoadElement } from '../utils/lazyLoad.js';
import { icon } from '../utils/icons.js';

function defaultPlay(item) {
  if (item.type === 'music') {
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item } }));
  } else {
    window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
  }
}

function defaultClick(item) {
  window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
}

export function createMediaCard(item, options = {}) {
  const { onPlay, onClick, showProgress = true } = options;

  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.id = item.id;
  card.dataset.type = item.type || 'movie'; // F-12: per-type intrinsic sizes in CSS
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('aria-label', `${item.title} ${item.artist ? `by ${item.artist}` : ''}`);

  const isMusic = item.type === 'music';
  const isVideo = item.type === 'video' || item.type === 'movie';
  const coverType = isMusic ? 'music' : isVideo ? 'video' : '';

  const progress = item.progress || 0;
  const hasProgress = showProgress && progress > 0 && progress < 95;
  const coverUrl = (item.coverArtPath || isMusic)
    ? api.getCoverUrl(item.id)
    : (item.thumbnailPath ? api.getThumbnailUrl(item.id) : api.getCoverUrl(item.id));

  card.innerHTML = `
    <div class="media-card-cover ${coverType}">
      <img data-src="${coverUrl}" alt="${escapeHtml(item.title)}" loading="lazy">
      <div class="media-card-placeholder" aria-hidden="true">${icon(isMusic ? 'music' : isVideo ? 'video' : 'film', { size: 34 })}</div>
      <div class="media-card-overlay">
        <button class="media-card-play" type="button" aria-label="Play ${escapeAttr(item.title)}">${icon('play', { size: 20 })}</button>
      </div>
      ${hasProgress ? `<div class="media-card-progress"><div class="media-card-progress-bar" style="width:${progress}%"></div></div>` : ''}
      ${item.duration ? `<div class="media-card-duration">${formatTime(item.duration)}</div>` : ''}
    </div>
    <div class="media-card-info">
      <div class="media-card-title" title="${escapeHtml(item.title)}">${escapeHtml(truncate(item.title, 40))}</div>
      <div class="media-card-meta">${getMeta(item)}</div>
    </div>
  `;

  const img = card.querySelector('img[data-src]');
  if (img) {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      const ph = card.querySelector('.media-card-placeholder');
      if (ph) ph.classList.add('visible');
    });
    img.addEventListener('load', () => {
      img.classList.add('loaded');
    });
    lazyLoadElement(img);
  }

  const playBtn = card.querySelector('.media-card-play');
  playBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onPlay) onPlay(item, e);
    else defaultPlay(item);
  });

  card.addEventListener('click', (e) => {
    if (e.target.closest('.media-card-play')) return;
    if (onClick) onClick(item, e);
    else defaultClick(item);
  });

  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (onClick) onClick(item, e);
      else defaultClick(item);
    }
  });

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
    return parts.map(p => escapeHtml(String(p))).join(' • ') || '';
  }
  return escapeHtml(item.genre || (item.duration ? formatTime(item.duration) : '') || '');
}

export function formatYear(item) {
  return item?.year || '';
}
