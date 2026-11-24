/**
 * Media List — table view — optimized with DocumentFragment
 */
import { api } from '../api.js';
import { formatDuration, escapeHtml } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { attachContextMenu } from './contextMenu.js';
import { releaseVirtualGrid } from '../utils/virtualGrid.js';
import { likeButton } from '../utils/likes.js';

export function renderMediaList(container, items, options = {}) {
  const { onPlay, onClick, sortField = 'title', sortOrder = 'asc', onSort, hideAlbum = false } = options;
  
  // The same container may have held a (windowed) grid a moment ago.
  releaseVirtualGrid(container);
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
  list.className = `media-list media-list--library${hideAlbum ? ' media-list--album' : ''}`;
  
  const header = document.createElement('div');
  header.className = 'media-list-header';
  // Name the second column for what it actually shows.
  const musicCount = items.filter(i => i.type === 'music').length;
  const secondLabel = musicCount === items.length ? 'Artist' : musicCount === 0 ? 'Genre' : 'Artist / Genre';
  const columns = [
    ['title', 'Title'],
    ['artist', secondLabel],
    ['duration', 'Duration'],
    ['year', 'Year'],
  ];
  // Sortable only when the view supplies onSort; plain spans otherwise.
  header.innerHTML = columns.map(([field, label]) => {
    if (!onSort) return `<span class="media-list-col media-list-col--${field}">${label}</span>`;
    const active = sortField === field;
    const state = active ? (sortOrder === 'asc' ? 'ascending' : 'descending') : 'unsorted';
    const ind = active ? icon(sortOrder === 'asc' ? 'chevron-up' : 'chevron-down', { size: 12, strokeWidth: 2.5 }) : '';
    return `<button type="button" class="media-list-sort media-list-col media-list-col--${field}${active ? ' active' : ''}" data-field="${field}" aria-label="Sort by ${label} — currently ${state}">${label}<span class="sort-ind" aria-hidden="true">${ind}</span></button>`;
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
    // Highlighted + animated bars on the cover while it plays (utils/nowPlaying.js).
    row.dataset.npId = item.id;
    // Focusable group (Enter/Space open it) — not role=button, because the
    // row contains its own Play <button> (nested-interactive, C-11).
    row.setAttribute('role', 'group');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', [item.title, item.artist].filter(Boolean).join(', '));
    const itemVersion = item.updatedAt ? new Date(item.updatedAt).getTime() : '';
    const coverSrc = item.type === 'music'
      ? (itemVersion && typeof api.getCoverUrlVersioned === 'function' ? api.getCoverUrlVersioned(item.id, itemVersion) : api.getCoverUrl(item.id))
      : api.getThumbnailUrl(item.id);
    
    // Second line: the album for music (the filename repeated the title and
    // artist), the filename otherwise — and nothing when it adds no info.
    const knownAlbum = item.album && item.album !== 'Unknown Album' ? item.album : '';
    const subtitle = item.type === 'music' ? (hideAlbum ? '' : (knownAlbum || item.filename || '')) : (item.filename || '');
    const knownArtist = item.artist && item.artist !== 'Unknown Artist' ? item.artist : '';
    const second = item.type === 'music' ? (knownArtist || item.genre || '') : (item.genre || knownArtist || '');

    row.innerHTML = `
      <div class="media-list-item-main">
        <button class="media-list-play" type="button" aria-label="Play">${icon('play', { size: 13 })}</button>
        <div class="media-list-item-cover">
          <img src="${coverSrc}" alt="" loading="lazy" data-img-fallback="hide">
        </div>
        <div class="media-list-item-text">
          <div class="media-list-item-title" data-np-slot="start">${escapeHtml(item.title)}</div>
          ${subtitle ? `<div class="media-list-item-artist">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        ${likeButton(item, { className: 'media-list-like' })}
      </div>
      <div class="media-list-cell media-list-cell--artist" title="${escapeHtml(second)}">${escapeHtml(second) || '<span class="media-list-none">—</span>'}</div>
      <div class="media-list-cell media-list-cell--duration">${formatDuration(item.duration)}</div>
      <div class="media-list-cell media-list-cell--year">${item.year || '<span class="media-list-none">—</span>'}</div>
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
    // Marks the row as item X (multi-select, keyboard navigation). Opening
    // the menu is right-click / long-press only — see attachContextMenu.
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
