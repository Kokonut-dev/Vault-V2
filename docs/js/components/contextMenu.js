/**
 * Right-click / long-press context menu for media cards and rows (Plex,
 * Jellyfin and Spotify all have one; Vault previously buried every action in
 * the detail page).
 */
import { icon } from '../utils/icons.js';
import { toast } from './toast.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { copyText } from '../utils/clipboard.js';
import { confirmDialog } from './confirmDialog.js';

let menuEl = null;
let openFor = null;

function close() {
  if (menuEl) {
    menuEl.classList.remove('active');
    const node = menuEl;
    setTimeout(() => node.remove(), 120);
    menuEl = null;
  }
  openFor = null;
}

function playNext(item) {
  window.dispatchEvent(new CustomEvent('vault:queue', { detail: { item, next: true } }));
  toast.success(`"${item.title}" plays next`);
}

function addToQueue(item) {
  window.dispatchEvent(new CustomEvent('vault:queue', { detail: { item, next: false } }));
  toast.success(`Added "${item.title}" to queue`);
}

async function toggleWatchlist(item) {
  const inList = store.get('watchlist')?.some(i => i.id === item.id);
  try {
    if (inList) {
      await api.removeFromWatchlist(item.id);
      store.set('watchlist', (store.get('watchlist') || []).filter(i => i.id !== item.id), true);
      toast.info('Removed from your list');
    } else {
      await api.addToWatchlist(item.id);
      store.set('watchlist', [{ ...item }, ...(store.get('watchlist') || [])], true);
      toast.success('Added to your list');
    }
    window.dispatchEvent(new CustomEvent('vault:watchlist-changed', { detail: { item, added: !inList } }));
  } catch (err) {
    toast.error(`Could not update your list: ${err.message}`);
  }
}

async function toggleWatched(item) {
  const watched = !item.watched;
  try {
    await api.setWatched(item.id, watched);
    store.set('watched', { ...(store.get('watched') || {}), [item.id]: watched ? { watched: true } : undefined });
    toast.success(watched ? 'Marked as watched' : 'Marked as unwatched');
    window.dispatchEvent(new CustomEvent('vault:watched-changed', { detail: { item, watched } }));
  } catch (err) {
    toast.error(`Could not update watched state: ${err.message}`);
  }
}

async function addToPlaylistFlow(item) {
  window.dispatchEvent(new CustomEvent('vault:add-to-playlist', { detail: { item } }));
}

async function deleteFlow(item) {
  const ok = await confirmDialog({
    title: `Delete "${item.title}"?`,
    message: 'The file moves to the trash so you can undo it. Nothing is deleted permanently until the retention window passes.',
    confirmLabel: 'Move to trash',
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await api.deleteItem(item.id, true);
    store.set('library', store.get('library').filter(i => i.id !== item.id));
    if (result?.trashId) {
      toast.undo('Moved to trash', async () => {
        await api.restoreFromTrash(result.trashId);
        window.dispatchEvent(new CustomEvent('vault:library-refresh'));
        toast.success('Restored');
      });
    } else {
      toast.success('Deleted');
    }
    window.dispatchEvent(new CustomEvent('vault:library-refresh'));
  } catch (err) {
    toast.error(`Delete failed: ${err.message}`);
  }
}

function buildItems(item, extra = []) {
  const isMusic = item.type === 'music' || item.type === 'audiobook' || item.type === 'podcast';
  const base = [];

  if (isMusic) {
    base.push({ label: 'Play next', icon: 'list', action: () => playNext(item) });
    base.push({ label: 'Add to queue', icon: 'plus', action: () => addToQueue(item) });
  } else {
    base.push({ label: 'Play', icon: 'play', action: () => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } })) });
    base.push({ label: 'Play next', icon: 'list', action: () => playNext(item) });
  }

  base.push({ label: 'Open details', icon: 'info', action: () => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } })) });
  base.push({ separator: true });
  base.push({ label: 'Add to playlist', icon: 'plus', action: () => addToPlaylistFlow(item) });
  base.push({ label: 'Add to collection', icon: 'folder', action: () => window.dispatchEvent(new CustomEvent('vault:add-to-collection', { detail: { item } })) });
  base.push({ label: 'Add to my list', icon: 'bookmark', action: () => toggleWatchlist(item) });
  base.push({ label: item.watched ? 'Mark as unwatched' : 'Mark as watched', icon: 'check', action: () => toggleWatched(item) });
  base.push({ separator: true });
  base.push({ label: 'Copy file path', icon: 'copy', action: async () => { await copyText(item.path); toast.success('Path copied'); } });
  base.push({ label: 'Fix metadata', icon: 'search', action: () => window.dispatchEvent(new CustomEvent('vault:match-metadata', { detail: { item } })) });
  if (!isMusic) {
    base.push({
      label: 'Save offline',
      icon: 'download',
      action: () => window.dispatchEvent(new CustomEvent('vault:download', { detail: { item } })),
    });
  }
  base.push({ separator: true });
  base.push({ label: 'Delete', icon: 'trash', danger: true, action: () => deleteFlow(item) });

  return [...base, ...extra];
}

export function showContextMenu(event, item, options = {}) {
  event.preventDefault();
  event.stopPropagation();
  close();

  const items = options.items || buildItems(item);
  menuEl = document.createElement('div');
  menuEl.className = 'context-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.innerHTML = items.map((entry, index) => {
    if (entry.separator) return '<div class="context-menu-separator" role="separator"></div>';
    return `<button type="button" class="context-menu-item${entry.danger ? ' danger' : ''}" role="menuitem" data-index="${index}">
      ${entry.icon ? icon(entry.icon, { size: 16 }) : ''}<span>${entry.label}</span>
      ${entry.hint ? `<span class="context-menu-hint">${entry.hint}</span>` : ''}
    </button>`;
  }).join('');

  document.body.appendChild(menuEl);

  menuEl.querySelectorAll('.context-menu-item').forEach(button => {
    button.addEventListener('click', async (clickEvent) => {
      clickEvent.stopPropagation();
      const entry = items[Number(button.dataset.index)];
      close();
      if (entry?.action) await entry.action();
    });
  });

  // Position inside the viewport
  const rect = menuEl.getBoundingClientRect();
  const x = event.clientX || (event.touches && event.touches[0]?.clientX) || 0;
  const y = event.clientY || (event.touches && event.touches[0]?.clientY) || 0;
  menuEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 12)}px`;
  menuEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 12)}px`;
  requestAnimationFrame(() => menuEl?.classList.add('active'));
  openFor = item;

  // Focus the first entry for keyboard users
  menuEl.querySelector('.context-menu-item')?.focus();
  return menuEl;
}

/** Attach context-menu + long-press behaviour to a card/row element. */
export function attachContextMenu(element, item, options = {}) {
  element.addEventListener('contextmenu', event => showContextMenu(event, item, options));

  let pressTimer = null;
  let longPressed = false;
  element.addEventListener('touchstart', (event) => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      showContextMenu(event, item, options);
    }, 500);
  }, { passive: true });
  const cancel = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  element.addEventListener('touchend', (event) => {
    if (longPressed) event.preventDefault();
    cancel();
  });
  element.addEventListener('touchmove', cancel, { passive: true });
  element.addEventListener('touchcancel', cancel);
}

/** Global dismiss handlers (installed once). */
export function initContextMenu() {
  document.addEventListener('click', () => close());
  document.addEventListener('scroll', () => close(), { passive: true, capture: true });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
  });
  window.addEventListener('blur', () => close());

  // "More" buttons rendered anywhere in the UI open the same menu.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-context-menu-for]');
    if (!trigger) return;
    const item = store.get('library')?.find(i => i.id === trigger.dataset.contextMenuFor);
    if (item) showContextMenu(event, item);
  });
}

export { close as closeContextMenu };
