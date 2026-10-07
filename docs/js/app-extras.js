/**
 * v3 client wiring — everything that has to run once for the whole app:
 * live events, queue panel, lyrics, context menus, multi-select, mobile
 * gestures, bottom navigation, ambient artwork colour, sleep/cast controls
 * and the SyncPlay follower.
 *
 * Kept out of the inline bootstrap in index.html so the shell stays readable;
 * index.html calls `initAppExtras()` after the players are initialised.
 */
import { store } from './store.js';
import { api } from './api.js';
import { toast } from './components/toast.js';
import { initLiveEvents } from './events.js';
import { initQueuePanel, toggleQueue } from './components/queuePanel.js';
import { initLyrics } from './components/lyrics.js';
import { initContextMenu } from './components/contextMenu.js';
import { applyArtworkAmbience, clearArtworkAmbience } from './utils/color.js';
import { wireCastButton, renderSleepMenu, wireSleepMenu, updateSleepIndicator, onItemFinished } from './components/playerExtras.js';
import { initVideoExtras } from './components/videoExtras.js';
import { confirmDialog } from './components/confirmDialog.js';
import { icon } from './utils/icons.js';
import { formatTime } from './utils/format.js';

// ---------------------------------------------------------------------------
// Multi-select (batch operations on cards)
// ---------------------------------------------------------------------------
const selection = {
  active: false,
  ids: new Set(),
};

function selectionBar() {
  let bar = document.getElementById('multi-select-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.className = 'multi-select-bar';
  bar.id = 'multi-select-bar';
  bar.hidden = true;
  bar.innerHTML = `
    <span id="selection-count" class="row-meta"></span>
    <button type="button" class="btn btn-ghost btn-sm" data-sel="all">${icon('check', { size: 14 })}<span>Select all</span></button>
    <button type="button" class="btn btn-ghost btn-sm" data-sel="watched">${icon('eye', { size: 14 })}<span>Watched</span></button>
    <button type="button" class="btn btn-ghost btn-sm" data-sel="list">${icon('bookmark', { size: 14 })}<span>My list</span></button>
    <button type="button" class="btn btn-ghost btn-sm" data-sel="playlist">${icon('plus', { size: 14 })}<span>Playlist</span></button>
    <button type="button" class="btn btn-ghost btn-sm" data-sel="queue">${icon('list', { size: 14 })}<span>Queue</span></button>
    <button type="button" class="btn btn-ghost btn-sm danger" data-sel="delete">${icon('trash', { size: 14 })}</button>
    <button type="button" class="btn btn-ghost btn-sm" data-sel="close" aria-label="Cancel selection">${icon('x', { size: 14 })}</button>
  `;
  document.body.appendChild(bar);

  bar.querySelector('[data-sel="close"]').addEventListener('click', () => setSelectionMode(false));
  bar.querySelector('[data-sel="all"]').addEventListener('click', () => selectAll());
  bar.querySelector('[data-sel="watched"]').addEventListener('click', async () => {
    const items = selectedItems();
    for (const item of items) {
      try { await api.setWatched(item.id, true); } catch { /* best effort */ }
    }
    toast.success(`Marked ${items.length} item${items.length === 1 ? '' : 's'} watched`);
    setSelectionMode(false);
    window.dispatchEvent(new CustomEvent('vault:library-refresh'));
  });
  bar.querySelector('[data-sel="list"]').addEventListener('click', async () => {
    const items = selectedItems();
    for (const item of items) {
      try { await api.addToWatchlist(item.id); } catch { /* best effort */ }
    }
    toast.success(`Added ${items.length} to your list`);
    setSelectionMode(false);
  });
  bar.querySelector('[data-sel="playlist"]').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:add-to-playlist', { detail: { items: selectedItems() } }));
  });
  bar.querySelector('[data-sel="queue"]').addEventListener('click', () => {
    const items = selectedItems();
    items.forEach(item => store.addToQueue(item));
    toast.success(`Queued ${items.length} item${items.length === 1 ? '' : 's'}`);
    toggleQueue(true);
    setSelectionMode(false);
  });
  bar.querySelector('[data-sel="delete"]').addEventListener('click', async () => {
    const items = selectedItems();
    const ok = await confirmDialog({
      title: `Delete ${items.length} item${items.length === 1 ? '' : 's'}?`,
      message: 'Files move to the trash and can be restored for the retention window.',
      confirmLabel: 'Move to trash',
      danger: true,
    });
    if (!ok) return;
    let moved = 0;
    for (const item of items) {
      try {
        const result = await api.deleteItem(item.id, true);
        if (result?.trashId) moved += 1;
      } catch { /* keep going */ }
    }
    store.set('library', store.get('library').filter(i => !selection.ids.has(i.id)));
    toast.success(`${moved} moved to trash — restore them from Settings → Trash`);
    setSelectionMode(false);
    window.dispatchEvent(new CustomEvent('vault:library-refresh'));
  });
  return bar;
}

function currentItems() {
  const view = document.getElementById('view-container');
  const ids = [...view.querySelectorAll('[data-context-menu-for], [data-item-id]')]
    .map(node => node.dataset.contextMenuFor || node.dataset.itemId);
  const library = store.get('library') || [];
  const unique = [...new Set(ids)];
  return unique.map(id => library.find(i => i.id === id)).filter(Boolean);
}

function selectedItems() {
  return currentItems().filter(item => selection.ids.has(item.id));
}

function selectAll() {
  const items = currentItems();
  const allSelected = items.every(item => selection.ids.has(item.id));
  selection.ids = new Set(allSelected ? [] : items.map(i => i.id));
  paintSelection();
}

function paintSelection() {
  const bar = selectionBar();
  bar.querySelector('#selection-count').textContent = `${selection.ids.size} selected`;
  document.querySelectorAll('[data-context-menu-for], [data-item-id]').forEach(node => {
    const id = node.dataset.contextMenuFor || node.dataset.itemId;
    const selected = selection.ids.has(id);
    node.classList.toggle('selected', selected);
    node.classList.toggle('selectable', selection.active);
    if (selection.active && !node.querySelector('.selection-check')) {
      const check = document.createElement('span');
      check.className = 'selection-check';
      check.innerHTML = icon('check', { size: 13 });
      if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
      node.appendChild(check);
    }
    const check = node.querySelector('.selection-check');
    if (check) check.style.display = selected || selection.active ? 'grid' : 'none';
  });
}

export function setSelectionMode(active) {
  selection.active = active;
  if (!active) selection.ids = new Set();
  selectionBar().hidden = !active;
  document.body.classList.toggle('selection-mode', active);
  paintSelection();
}

export function initMultiSelect() {
  selectionBar();
  document.addEventListener('click', (event) => {
    if (!selection.active) return;
    const selectable = event.target.closest('[data-context-menu-for], [data-item-id]');
    if (!selectable) return;
    const id = selectable.dataset.contextMenuFor || selectable.dataset.itemId;
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (selection.ids.has(id)) selection.ids.delete(id);
    else selection.ids.add(id);
    paintSelection();
  }, true);
  return { setSelectionMode };
}

// ---------------------------------------------------------------------------
// Mobile gestures (player): swipe to seek / volume, double-tap to skip
// ---------------------------------------------------------------------------
function initGestures() {
  const container = document.getElementById('video-container');
  if (!container) return;

  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let startVolume = 1;
  let mode = null;
  let lastTap = 0;
  let lastTapX = 0;

  const hint = document.createElement('div');
  hint.className = 'gesture-toast';
  document.body.appendChild(hint);
  let hintTimer = null;
  const showHint = (text) => {
    hint.textContent = text;
    hint.classList.add('active');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('active'), 700);
  };

  const video = () => document.getElementById('video-element');

  container.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    startX = touch.clientX;
    startY = touch.clientY;
    startTime = Date.now();
    startVolume = video()?.volume ?? 1;
    mode = null;

    const now = Date.now();
    if (now - lastTap < 300 && Math.abs(touch.clientX - lastTapX) < 40) {
      const rect = container.getBoundingClientRect();
      const left = touch.clientX - rect.left < rect.width / 2;
      const el = video();
      if (el) {
        el.currentTime = Math.max(0, el.currentTime + (left ? -10 : 10));
        showHint(left ? '−10s' : '+10s');
      }
      event.preventDefault();
    }
    lastTap = now;
    lastTapX = touch.clientX;
  }, { passive: true });

  container.addEventListener('touchmove', (event) => {
    const touch = event.touches[0];
    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;
    if (!mode && Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.2) mode = 'seek';
    if (mode === 'seek') {
      event.preventDefault();
      showHint(`${dx > 0 ? '→' : '←'} ${Math.round(dx / 6)}s`);
    }
  }, { passive: false });

  container.addEventListener('touchend', (event) => {
    const touch = event.changedTouches[0];
    const dx = touch.clientX - startX;
    const elapsed = (Date.now() - startTime) / 1000;
    if (mode === 'seek' && Math.abs(dx) > 24 && elapsed < 1.2) {
      const el = video();
      if (el) {
        const delta = dx / 6;
        el.currentTime = Math.max(0, el.currentTime + delta);
        toast.info(`${delta > 0 ? 'Skipped forward' : 'Skipped back'} ${Math.abs(Math.round(delta))}s`);
      }
    }
    mode = null;
  });
}

// ---------------------------------------------------------------------------
// Bottom navigation (mobile)
// ---------------------------------------------------------------------------
function initBottomNav() {
  if (document.getElementById('bottom-nav')) return;
  const nav = document.createElement('nav');
  nav.className = 'bottom-nav';
  nav.id = 'bottom-nav';
  nav.setAttribute('aria-label', 'Primary');
  const links = [
    ['/home', 'home', 'Home'],
    ['/movies', 'film', 'Movies'],
    ['/music', 'music', 'Music'],
    ['/shows', 'tv', 'Shows'],
    ['/settings', 'settings', 'More'],
  ];
  nav.innerHTML = links.map(([href, iconName, label]) => `<a href="#${href}" data-path="${href}">${icon(iconName, { size: 20 })}<span>${label}</span></a>`).join('');
  document.body.appendChild(nav);

  const paint = () => {
    const path = location.hash.replace('#', '') || '/home';
    nav.querySelectorAll('a').forEach(a => a.classList.toggle('active', path.startsWith(a.dataset.path)));
  };
  window.addEventListener('hashchange', paint);
  paint();
}

// ---------------------------------------------------------------------------
// Ambient artwork colour
// ---------------------------------------------------------------------------
function initAmbient() {
  let ambient = document.getElementById('ambient');
  if (!ambient) {
    ambient = document.createElement('div');
    ambient.id = 'ambient';
    ambient.setAttribute('aria-hidden', 'true');
    document.body.prepend(ambient);
  }

  window.addEventListener('vault:open-detail', async (event) => {
    const item = event.detail?.item;
    const url = item?.poster || item?.cover || item?.thumbnail;
    if (url) await applyArtworkAmbience(url, { element: ambient });
  });
  window.addEventListener('vault:track-changed', async (event) => {
    const item = event.detail?.item;
    const url = item?.cover || item?.poster || item?.thumbnail;
    if (url) await applyArtworkAmbience(url, { element: ambient, alpha: 0.22, accent: true });
  });
  window.addEventListener('vault:close-detail', () => clearArtworkAmbience());
}

// ---------------------------------------------------------------------------
// SyncPlay follower — guests snap to the host's clock
// ---------------------------------------------------------------------------
const syncplayState = { roomId: null, memberId: null, last: null };

function activeMedia() {
  return document.getElementById('video-element') || document.getElementById('audio-element');
}

function applySyncState(data) {
  if (!syncplayState.roomId || !data || data.roomId !== syncplayState.roomId) return;
  const media = activeMedia();
  if (!media || !data.position) return;
  const drift = media.currentTime - data.position;
  if (Math.abs(drift) > 2.5) {
    media.currentTime = data.position;
    toast.info('Resynced with the host');
  } else if (Math.abs(drift) > 0.75) {
    media.playbackRate = drift > 0 ? 0.96 : 1.04;
    setTimeout(() => { media.playbackRate = 1; }, 1200);
  }
  if (data.paused && !media.paused) media.pause();
  if (!data.paused && media.paused) media.play().catch(() => {});
}

export function initSyncPlayFollower() {
  window.addEventListener('vault:syncplay-state', event => applySyncState(event.detail));
  window.addEventListener('vault:syncplay-joined', (event) => {
    syncplayState.roomId = event.detail?.roomId || null;
    syncplayState.memberId = event.detail?.memberId || null;
  });
  window.addEventListener('vault:syncplay-left', () => {
    syncplayState.roomId = null;
    syncplayState.memberId = null;
  });
}

// ---------------------------------------------------------------------------
// Offline downloads (PWA) — cache a few items for the commute
// ---------------------------------------------------------------------------
export async function downloadItemForOffline(item) {
  if (!('caches' in window)) {
    toast.info('Offline downloads need a service-worker capable browser');
    return false;
  }
  const url = api.getStreamUrl(item);
  const cache = await caches.open('vault-offline');
  toast.info(`Downloading "${item.title}"…`, 'Offline');
  try {
    await cache.add(new Request(url));
    const meta = (await cache.match('/vault-offline-index').then(r => r?.json())) || { items: [] };
    meta.items = [...meta.items.filter(entry => entry.id !== item.id), {
      id: item.id, title: item.title, duration: item.duration, size: item.size, addedAt: Date.now(),
    }];
    await cache.put('/vault-offline-index', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    toast.success(`"${item.title}" is available offline`);
    window.dispatchEvent(new CustomEvent('vault:offline-changed'));
    return true;
  } catch (err) {
    toast.error(`Download failed: ${err.message}`);
    return false;
  }
}

export async function listOfflineItems() {
  if (!('caches' in window)) return [];
  try {
    const cache = await caches.open('vault-offline');
    const response = await cache.match('/vault-offline-index');
    return response ? (await response.json()).items || [] : [];
  } catch {
    return [];
  }
}

export async function removeOfflineItem(id) {
  const cache = await caches.open('vault-offline');
  const meta = (await cache.match('/vault-offline-index').then(r => r?.json())) || { items: [] };
  const entry = meta.items.find(i => i.id === id);
  meta.items = meta.items.filter(i => i.id !== id);
  await cache.put('/vault-offline-index', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  // Delete every cached stream URL that belongs to this item.
  for (const request of await cache.keys()) {
    if (request.url.includes(encodeURIComponent(entry?.id || id)) || (entry && request.url.includes(entry.id))) {
      await cache.delete(request);
    }
  }
  window.dispatchEvent(new CustomEvent('vault:offline-changed'));
}

// ---------------------------------------------------------------------------
// Player extras: sleep menu, cast, bookmarks-in-context-menu
// ---------------------------------------------------------------------------
function initPlayerExtras() {
  window.addEventListener('vault:item-finished', onItemFinished);
  window.addEventListener('vault:sleep-changed', updateSleepIndicator);
  setInterval(updateSleepIndicator, 30000);

  const castButton = document.getElementById('cast-button');
  wireCastButton(castButton);

  document.querySelectorAll('[data-player-menu]').forEach(menu => {
    if (menu.querySelector('.player-menu-section')) return;
    menu.insertAdjacentHTML('beforeend', renderSleepMenu());
    wireSleepMenu(menu);
  });

  window.addEventListener('vault:keyboard', (event) => {
    const key = event.detail?.key;
    if (key === 's' && event.detail?.shiftKey) toggleQueue();
  });
}

// ---------------------------------------------------------------------------
// Keyboard grid navigation (arrow keys move a focus ring through cards)
// ---------------------------------------------------------------------------
function initGridKeyboardNav() {
  document.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
    if (document.querySelector('.modal-backdrop.active')) return;

    const cards = [...document.querySelectorAll('#view-container [data-context-menu-for], #view-container [data-item-id], #view-container .media-card')];
    if (!cards.length) return;
    const current = cards.findIndex(card => card === target || card.contains(target));

    let step = 0;
    if (event.key === 'ArrowRight') step = 1;
    else if (event.key === 'ArrowLeft') step = -1;
    else {
      // Vertical movement jumps by the number of cards in the first row.
      const firstTop = cards[0].getBoundingClientRect().top;
      const perRow = Math.max(1, cards.filter(card => Math.abs(card.getBoundingClientRect().top - firstTop) < 4).length);
      step = (event.key === 'ArrowDown' ? 1 : -1) * perRow;
    }

    if (current < 0) {
      event.preventDefault();
      cards[0].focus();
      return;
    }
    const next = cards[current + step];
    if (next) {
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function initAppExtras() {
  initLiveEvents();
  initQueuePanel();
  initLyrics();
  initContextMenu();
  initMultiSelect();
  initGestures();
  initBottomNav();
  initAmbient();
  initSyncPlayFollower();
  initPlayerExtras();
  initVideoExtras();
  initGridKeyboardNav();

  window.vaultExtras = {
    downloadItemForOffline,
    listOfflineItems,
    removeOfflineItem,
    setSelectionMode,
    formatTime,
  };

  return window.vaultExtras;
}
