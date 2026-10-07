/**
 * Cross-cutting actions fired by the context menu, lyrics, audiobooks and the
 * player: add to playlist / collection, metadata match, offline download,
 * seek, library refresh, HLS fallback and sleep-timer feedback.
 *
 * These were dispatched as `vault:*` events but nothing listened, so the menu
 * entries silently did nothing. One module owns them all.
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { toast } from './toast.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime } from '../utils/format.js';
import { modal, promptModal } from './modal.js';

function closeModalOnEscape(backdrop) {
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  window.addEventListener('vault:escape', close, { once: true });
  return close;
}

function openModal(title, body) {
  const { backdrop } = modal.create({ title, content: body });
  closeModalOnEscape(backdrop);
  return backdrop;
}

// ---------------------------------------------------------------------------
// Add to playlist
// ---------------------------------------------------------------------------
async function addToPlaylist(detail) {
  const items = detail.items || (detail.item ? [detail.item] : []);
  if (!items.length) return;

  let playlists = [];
  try {
    playlists = (await api.getPlaylists()).playlists || [];
  } catch (err) {
    return toast.error(`Could not load playlists: ${err.message}`);
  }

  const backdrop = openModal(`Add ${items.length} item${items.length === 1 ? '' : 's'} to a playlist`, `
    <div class="page-actions" style="display:flex; gap:8px; margin-bottom:12px">
      <button class="btn btn-secondary btn-sm" id="new-pl">${icon('plus', { size: 14 })}<span>New playlist</span></button>
    </div>
    <div class="health-list">
      ${playlists.length ? playlists.map(playlist => `
        <button type="button" class="health-item" data-pl="${playlist.id}" style="width:100%; text-align:left; cursor:pointer">
          ${icon(playlist.type === 'collection' ? 'layout-grid' : 'list', { size: 16 })}
          <div class="row-main">
            <div class="row-title">${escapeHtml(playlist.name)}</div>
            <div class="row-meta">${(playlist.items || []).length} item(s)</div>
          </div>
          ${icon('plus', { size: 15 })}
        </button>`).join('') : '<div class="row-meta">No playlists yet — create one below.</div>'}
    </div>
  `);

  const addTo = async (playlistId) => {
    let added = 0;
    for (const item of items) {
      try {
        await api.addToPlaylist(playlistId, item.id);
        added += 1;
      } catch { /* item may already be in the list */ }
    }
    toast.success(`Added ${added} item(s)`);
    window.dispatchEvent(new CustomEvent('vault:playlists-changed'));
    backdrop.remove();
  };

  backdrop.querySelectorAll('[data-pl]').forEach(button => {
    button.addEventListener('click', () => addTo(button.dataset.pl));
  });
  backdrop.querySelector('#new-pl').addEventListener('click', async () => {
    const name = await promptModal({ title: 'New playlist', label: 'Name', confirmLabel: 'Create' });
    if (!name) return;
    try {
      const created = await api.createPlaylist({ name });
      await addTo(created.id);
    } catch (err) {
      toast.error(`Could not create playlist: ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Add to collection
// ---------------------------------------------------------------------------
async function addToCollection(detail) {
  const items = detail.items || (detail.item ? [detail.item] : []);
  if (!items.length) return;

  let collections = [];
  try {
    collections = (await api.getCollections()).collections || [];
  } catch (err) {
    return toast.error(`Could not load collections: ${err.message}`);
  }

  const backdrop = openModal(`Add to a collection`, `
    <div class="page-actions" style="display:flex; gap:8px; margin-bottom:12px">
      <button class="btn btn-secondary btn-sm" id="new-col">${icon('plus', { size: 14 })}<span>New collection</span></button>
    </div>
    <div class="health-list">
      ${collections.length ? collections.map(collection => `
        <button type="button" class="health-item" data-col="${collection.id}" style="width:100%; text-align:left; cursor:pointer">
          ${icon('folder', { size: 16 })}
          <div class="row-main">
            <div class="row-title">${escapeHtml(collection.name)}</div>
            <div class="row-meta">${(collection.items || []).length} item(s)${collection.kind === 'smart' ? ' · smart' : ''}</div>
          </div>
          ${icon('plus', { size: 15 })}
        </button>`).join('') : '<div class="row-meta">No collections yet.</div>'}
    </div>
  `);

  backdrop.querySelectorAll('[data-col]').forEach(button => {
    button.addEventListener('click', async () => {
      let added = 0;
      for (const item of items) {
        try {
          await api.addToCollection(button.dataset.col, item.id);
          added += 1;
        } catch { /* duplicate */ }
      }
      toast.success(`Added ${added} item(s) to the collection`);
      window.dispatchEvent(new CustomEvent('vault:collections-changed'));
      backdrop.remove();
    });
  });
  backdrop.querySelector('#new-col').addEventListener('click', async () => {
    const name = await promptModal({ title: 'New collection', label: 'Name', confirmLabel: 'Create' });
    if (!name) return;
    try {
      const created = await api.createCollection({ name });
      const id = created.id || created.collection?.id;
      for (const item of items) {
        try { await api.addToCollection(id, item.id); } catch { /* duplicate */ }
      }
      toast.success(`Created “${name}” with ${items.length} item(s)`);
      backdrop.remove();
    } catch (err) {
      toast.error(err.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Metadata match (TMDB / MusicBrainz / NFO)
// ---------------------------------------------------------------------------
async function matchMetadata(detail) {
  const item = detail.item;
  if (!item) return;
  const guessedType = item.type === 'music' ? 'music' : item.seriesKey ? 'tv' : 'movie';

  const backdrop = openModal(`Fix metadata — ${item.title}`, `
    <form id="match-form" class="form-group" style="display:flex; gap:8px; flex-wrap:wrap">
      <input class="form-input" id="match-query" value="${escapeHtml(item.title)}" style="flex:2; min-width:180px" placeholder="Title to search for">
      <select class="form-input" id="match-type" style="flex:1; min-width:120px">
        ${['movie', 'tv', 'music'].map(t => `<option value="${t}"${t === guessedType ? ' selected' : ''}>${t === 'tv' ? 'TV show' : t === 'music' ? 'Music' : 'Movie'}</option>`).join('')}
      </select>
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
    <div id="match-results"><div class="row-meta">Search an online provider to replace this item's metadata and artwork.</div></div>
  `);

  const results = backdrop.querySelector('#match-results');

  backdrop.querySelector('#match-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = backdrop.querySelector('#match-query').value.trim();
    const type = backdrop.querySelector('#match-type').value;
    results.innerHTML = '<div class="skeleton skeleton-line"></div>';
    let matches = [];
    let errors = [];
    try {
      const data = await api.searchMetadata({ q: query, type });
      matches = data.results || [];
      errors = data.errors || [];
    } catch (err) {
      results.innerHTML = `<div class="row-meta">Search failed: ${escapeHtml(err.message)}</div>`;
      return;
    }

    results.innerHTML = matches.length
      ? matches.map((match, index) => `
        <div class="health-item">
          ${match.poster ? `<img src="${escapeHtml(match.poster)}" alt="" style="width:42px; border-radius:6px">` : icon('search', { size: 16 })}
          <div class="row-main">
            <div class="row-title">${escapeHtml(match.title || match.name || '')}</div>
            <div class="row-meta">${match.year || ''} ${match.overview ? `· ${escapeHtml(String(match.overview).slice(0, 110))}` : ''}</div>
          </div>
          <button class="btn btn-secondary btn-sm" data-apply="${index}">Apply</button>
        </div>`).join('')
      : `<div class="row-meta">No matches found.${errors.length ? ` Provider errors: ${errors.map(e => escapeHtml(e.provider || e.message || '')).join(', ')}` : ''}</div>`;

    results.querySelectorAll('[data-apply]').forEach(button => {
      button.addEventListener('click', async () => {
        const match = matches[Number(button.dataset.apply)];
        button.disabled = true;
        button.textContent = 'Applying…';
        try {
          await api.applyMetadata(item.id, match, true);
          toast.success('Metadata applied — the library will refresh');
          backdrop.remove();
          window.dispatchEvent(new CustomEvent('vault:library-refresh'));
        } catch (err) {
          button.disabled = false;
          button.textContent = 'Apply';
          toast.error(`Apply failed: ${err.message}`);
        }
      });
    });
  });

  // Search immediately so the dialog opens with candidates.
  const form = backdrop.querySelector('#match-form');
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { cancelable: true }));
}

// ---------------------------------------------------------------------------
// Misc handlers
// ---------------------------------------------------------------------------
function handleSeek(detail) {
  const time = Number(detail?.time);
  if (!Number.isFinite(time)) return;
  const media = document.querySelector('#video-element')
    || document.querySelector('#audio-element')
    || document.querySelector('audio');
  if (media) {
    media.currentTime = Math.max(0, time);
    if (media.paused) media.play().catch(() => {});
    toast.info(`Jumped to ${formatTime(time)}`);
  }
}

async function handleLibraryRefresh() {
  try {
    const data = await api.getLibrary({ limit: 1000 });
    store.setLibrary(data.items || []);
    window.dispatchEvent(new CustomEvent('vault:library-changed', { detail: { reason: 'refresh' } }));
  } catch { /* offline: keep the cached library */ }
}

function handleHlsFailed(detail) {
  const video = document.getElementById('video-element');
  const itemId = detail?.itemId;
  if (!video || !itemId) return;
  const resume = video.currentTime || 0;
  video.src = api.getTranscodeUrl(itemId, '720p');
  video.addEventListener('loadedmetadata', function once() {
    video.removeEventListener('loadedmetadata', once);
    video.currentTime = resume;
    video.play().catch(() => {});
  });
  toast.info('Adaptive stream failed — using the progressive transcode');
}

export function initQuickActions() {
  window.addEventListener('vault:add-to-playlist', (event) => addToPlaylist(event.detail || {}).catch(() => {}));
  window.addEventListener('vault:add-to-collection', (event) => addToCollection(event.detail || {}).catch(() => {}));
  window.addEventListener('vault:match-metadata', (event) => matchMetadata(event.detail || {}).catch(() => {}));
  window.addEventListener('vault:download', (event) => {
    const item = event.detail?.item;
    if (!item) return;
    if (window.vaultExtras?.downloadItemForOffline) window.vaultExtras.downloadItemForOffline(item);
    else toast.info('Offline downloads are unavailable in this browser');
  });
  window.addEventListener('vault:seek', (event) => handleSeek(event.detail));
  window.addEventListener('vault:library-refresh', () => handleLibraryRefresh());
  window.addEventListener('vault:hls-failed', (event) => handleHlsFailed(event.detail));
  window.addEventListener('vault:sleep-triggered', () => toast.info('Sleep timer finished — playback paused'));
  window.addEventListener('vault:bookmarks-changed', () => {
    // Views that render bookmark lists re-read them on this event; nothing
    // else to do here beyond keeping the event from being unhandled.
  });
}

export default { initQuickActions };
