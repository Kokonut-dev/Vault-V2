/**
 * "Up Next" queue panel (Spotify pattern).
 *
 * The store already tracked a queue — nothing rendered it, and `#queue-container`
 * / `#now-playing-queue` were dead markup. This renders the queue with drag
 * reordering, jump-to, remove, clear and "save as playlist".
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { formatTime, escapeHtml } from '../utils/format.js';
import { toast } from './toast.js';
import { modal } from './modal.js';

let panelEl = null;
let dragIndex = null;

function ensurePanel() {
  if (panelEl && document.body.contains(panelEl)) return panelEl;
  panelEl = document.createElement('aside');
  panelEl.className = 'queue-panel';
  panelEl.setAttribute('aria-label', 'Play queue');
  panelEl.innerHTML = `
    <header class="queue-header">
      <div>
        <h2 class="queue-title">Up Next</h2>
        <span class="queue-subtitle" id="queue-subtitle"></span>
      </div>
      <div class="queue-header-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="queue-save" title="Save as playlist">${icon('plus', { size: 15 })}<span>Save</span></button>
        <button type="button" class="btn btn-ghost btn-sm" id="queue-clear" title="Clear queue">${icon('trash', { size: 15 })}</button>
        <button type="button" class="btn btn-ghost btn-sm" id="queue-close" aria-label="Close queue">${icon('close', { size: 15 })}</button>
      </div>
    </header>
    <div class="queue-body" id="queue-body"></div>
  `;
  document.body.appendChild(panelEl);

  panelEl.querySelector('#queue-close').addEventListener('click', () => toggleQueue(false));
  panelEl.querySelector('#queue-clear').addEventListener('click', () => {
    store.clearQueue();
    renderQueuePanel();
    toast.info('Queue cleared');
  });
  panelEl.querySelector('#queue-save').addEventListener('click', saveQueueAsPlaylist);
  return panelEl;
}

async function saveQueueAsPlaylist() {
  const queue = store.get('queue') || [];
  if (!queue.length) return toast.info('Queue is empty');

  const name = await modal.prompt({
    title: 'Save queue as playlist',
    label: 'Playlist name',
    value: `Queue ${new Date().toLocaleDateString()}`,
    confirmLabel: 'Save playlist',
  });
  if (!name) return;

  try {
    await api.createPlaylist({ name, items: queue.map(i => i.id) });
    toast.success(`Saved "${name}"`);
    window.dispatchEvent(new CustomEvent('vault:playlists-changed'));
  } catch (err) {
    toast.error(`Could not save playlist: ${err.message}`);
  }
}

function renderQueuePanel() {
  if (!panelEl) return;
  const queue = store.get('queue') || [];
  const index = store.get('queueIndex');
  const body = panelEl.querySelector('#queue-body');
  const subtitle = panelEl.querySelector('#queue-subtitle');
  const totalSeconds = queue.reduce((sum, item) => sum + (item.duration || 0), 0);

  subtitle.textContent = queue.length
    ? `${queue.length} item${queue.length === 1 ? '' : 's'} · ${formatTime(totalSeconds)}`
    : '';

  if (!queue.length) {
    body.innerHTML = `<div class="empty-state compact">${icon('list', { size: 28 })}
      <div class="empty-state-title">Queue is empty</div>
      <div class="empty-state-text">Use “Play next” or “Add to queue” on any card.</div></div>`;
    return;
  }

  body.innerHTML = queue.map((item, i) => `
    <div class="queue-item${i === index ? ' current' : ''}${i < index ? ' played' : ''}" draggable="true" data-index="${i}" data-id="${item.id}">
      <span class="queue-drag" aria-hidden="true">${icon('list', { size: 14 })}</span>
      <div class="queue-item-info">
        <div class="queue-item-title">${escapeHtml(item.title)}</div>
        <div class="queue-item-meta">${escapeHtml(item.artist || item.album || item.type || '')}</div>
      </div>
      <span class="queue-item-time">${formatTime(item.duration || 0)}</span>
      <button type="button" class="btn btn-ghost btn-sm queue-remove" aria-label="Remove from queue" data-remove="${i}">${icon('close', { size: 14 })}</button>
    </div>
  `).join('');

  body.querySelectorAll('[data-remove]').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      store.removeFromQueue(Number(button.dataset.remove));
      renderQueuePanel();
    });
  });

  body.querySelectorAll('.queue-item').forEach(row => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-remove]')) return;
      const idx = Number(row.dataset.index);
      const item = queue[idx];
      store.set('queueIndex', idx, true);
      window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue, index: idx } }));
    });

    row.addEventListener('dragstart', (event) => {
      dragIndex = Number(row.dataset.index);
      row.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(dragIndex));
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      dragIndex = null;
    });
    row.addEventListener('dragover', (event) => {
      event.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      row.classList.remove('drop-target');
      const from = dragIndex ?? Number(event.dataTransfer.getData('text/plain'));
      const to = Number(row.dataset.index);
      if (Number.isNaN(from) || from === to) return;
      const next = [...queue];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      let queueIndex = store.get('queueIndex');
      if (from === queueIndex) queueIndex = to;
      else if (from < queueIndex && to >= queueIndex) queueIndex--;
      else if (from > queueIndex && to <= queueIndex) queueIndex++;
      store.set('queue', next, true);
      store.set('queueIndex', queueIndex, true);
      renderQueuePanel();
    });
  });
}

export function toggleQueue(show = null) {
  const panel = ensurePanel();
  const shouldShow = show === null ? !panel.classList.contains('active') : show;
  panel.classList.toggle('active', shouldShow);
  document.body.classList.toggle('queue-open', shouldShow);
  if (shouldShow) renderQueuePanel();
  return shouldShow;
}

export function initQueuePanel() {
  // Queue changes from anywhere in the app keep the panel in sync.
  store.subscribe('queue', () => renderQueuePanel());
  store.subscribe('queueIndex', () => renderQueuePanel());

  document.querySelectorAll('[data-queue-toggle]').forEach(button => {
    button.addEventListener('click', () => toggleQueue());
  });

  // The audio player and mini player dispatch this when a track starts.
  window.addEventListener('vault:queue', (event) => {
    const { item, next } = event.detail || {};
    if (!item) return;
    store.addToQueue(item, next);
    if (!panelEl?.classList.contains('active')) toggleQueue(true);
  });

  window.addEventListener('vault:queue-refresh', renderQueuePanel);
  return { toggleQueue, renderQueuePanel };
}
