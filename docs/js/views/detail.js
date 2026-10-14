/**
 * Detail view — movie, music, video detail pages — optimized
 */
import { store } from '../store.js';
import { formatTime, formatDuration, durationSeconds, formatBytes, escapeHtml } from '../utils/format.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { confirmDialog, alertDialog } from '../components/confirmDialog.js';
import { copyText } from '../utils/clipboard.js';
import { icon, setIcon } from '../utils/icons.js';

function isMissingCoverEndpoint(err) {
  return err?.status === 404 && (
    err.endpointNotFound === true
    || /^not found$/i.test(err.message || '')
    || /^request failed:\s*404$/i.test(err.message || '')
  );
}

async function uploadAlbumCover(ids, cover) {
  if (typeof api.uploadAlbumCover === 'function') return api.uploadAlbumCover(ids, cover);
  let lastError;
  for (const path of ['/api/library/albums/cover', '/api/library/cover']) {
    const form = new FormData();
    form.append('cover', cover);
    form.append('ids', JSON.stringify(ids));
    try {
      return await api.request(path, { method: 'POST', body: form });
    } catch (err) {
      lastError = err;
      if (!isMissingCoverEndpoint(err)) throw err;
    }
  }
  const base = api.baseUrl || '';
  const err = new Error(`Cover upload endpoints were not found (${base}/api/library/albums/cover, ${base}/api/library/cover). Check that the Server URL points to your Vault backend; if it does, update and restart the server, then try again.`);
  err.code = 'COVER_UPLOAD_UNAVAILABLE';
  err.path = lastError?.path || '/api/library/cover';
  err.cause = lastError;
  throw err;
}

export async function renderDetail(container, id) {
  container.className = 'page';
  container.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">
      <button class="btn btn-secondary btn-sm" id="back-btn">${icon('arrow-left', { size: 16 })}<span>Back</span></button>
      <div class="skeleton skeleton-text" style="width:200px; height:20px;"></div>
    </div>
    <div class="skeleton" style="height:400px; border-radius:16px;"></div>
  `;
  
  const library = store.get('library');
  let item = library.find(i => i.id === id);
  
  // If not in local library, fetch from API
  if (!item) {
    try {
      item = await api.getItem(id);
    } catch (err) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">${icon('search-x', { size: 30 })}</div>
          <div class="empty-state-title">Item not found</div>
          <div class="empty-state-message">${err.message}</div>
          <button class="btn btn-secondary" id="back-btn2">Go Back</button>
        </div>
      `;
      container.querySelector('#back-btn2').addEventListener('click', () => history.back());
      return;
    }
  }
  
  if (!item) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-title">Item not found</div></div>`;
    return;
  }
  
  const isMusic = item.type === 'music';
  const isMovie = item.type === 'movie';
  
  if (isMusic) {
    renderMusicDetail(container, item);
  } else {
    renderVideoDetail(container, item);
  }
}

function renderVideoDetail(container, item) {
  container.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">
      <button class="btn btn-secondary btn-sm" id="back-btn">${icon('arrow-left', { size: 16 })}<span>Back</span></button>
      <span style="color:var(--text-tertiary); font-size:13px;">${item.type} • ${item.year || ''}</span>
    </div>
    
    <div class="detail-layout">
      <div>
        <div style="aspect-ratio:2/3; background:rgba(var(--glass-tint),0.05); border-radius:16px; overflow:hidden;">
          <img src="${api.getThumbnailUrl(item.id)}" alt="${escapeHtml(item.title)}" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">
        </div>
        <div style="display:flex; gap:8px; margin-top:16px;">
          <button class="btn btn-primary" id="play-btn" style="flex:1;">${icon('play', { size: 18 })}<span>Play</span></button>
          <button class="btn btn-secondary" id="fav-btn" aria-label="${store.get('favourites').includes(item.id) ? 'Remove from favourites' : 'Add to favourites'}" aria-pressed="${store.get('favourites').includes(item.id)}">${icon(store.get('favourites').includes(item.id) ? 'heart-filled' : 'heart', { size: 18 })}</button>
        </div>
      </div>
      
      <div>
        <h1 style="font-size:32px; font-weight:800; line-height:1.1; margin-bottom:8px;">${escapeHtml(item.title)}</h1>
        <div style="display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; font-size:13px; color:var(--text-secondary);">
          ${item.year ? `<span>${item.year}</span>` : ''}
          ${item.genre ? `<span>${escapeHtml(item.genre)}</span>` : ''}
          ${item.duration ? `<span>${formatTime(item.duration)}</span>` : ''}
          ${item.resolution ? `<span>${item.resolution}</span>` : ''}
          ${item.rating ? `<span style="display:inline-flex; align-items:center; gap:4px;">${icon('star-filled', { size: 14 })}${item.rating}</span>` : ''}
        </div>
        
        ${item.description ? `<p style="color:var(--text-secondary); line-height:1.6; margin-bottom:24px;">${escapeHtml(item.description)}</p>` : ''}
        
        <div style="display:grid; gap:16px;">
          <div style="background:rgba(var(--glass-tint),0.05); border-radius:12px; padding:16px;">
            <h3 style="font-weight:600; margin-bottom:8px;">Media Info</h3>
            <div style="font-size:12px; font-family:var(--font-mono); color:var(--text-secondary); line-height:1.8;">
              <div>File: ${escapeHtml(item.filename)}</div>
              <div>Size: ${formatBytes(item.fileSize)}</div>
              <div>Codec: ${item.videoCodec || ''} / ${item.audioCodec || ''}</div>
              <div>Path: ${escapeHtml(item.path)} <button type="button" class="btn btn-ghost btn-sm" id="copy-path" style="padding:2px 8px; font-size:11px; margin-left:6px;">${icon('copy', { size: 13 })}<span>Copy</span></button></div>
              ${item.subtitles?.length ? `<div>Subtitles: ${item.subtitles.length}</div>` : ''}
            </div>
            <button class="btn btn-ghost btn-sm" id="more-info" style="margin-top:8px;">Technical Details</button>
          </div>
          
          <div style="background:rgba(var(--glass-tint),0.05); border-radius:12px; padding:16px;">
            <h3 style="font-weight:600; margin-bottom:12px;">Actions</h3>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button class="btn btn-secondary btn-sm" id="edit-btn">Edit Metadata</button>
              <button class="btn btn-secondary btn-sm" id="add-playlist">Add to Playlist</button>
              <button class="btn btn-secondary btn-sm" id="share-btn">Share</button>
              <button class="btn btn-ghost btn-sm" id="delete-btn" style="color:var(--error);">Delete</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <style>
      @media (max-width: 768px) {
        .detail-grid { grid-template-columns: 1fr !important; }
      }
    </style>
  `;
  
  container.querySelector('#back-btn').addEventListener('click', () => history.back());
  container.querySelector('#play-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
  });
  container.querySelector('#fav-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const isFav = store.toggleFavourite(item.id);
    setIcon(btn, isFav ? 'heart-filled' : 'heart', { size: 18 });
    btn.setAttribute('aria-pressed', String(isFav));
    btn.setAttribute('aria-label', isFav ? 'Remove from favourites' : 'Add to favourites');
    try {
      if (isFav) await api.addFavourite(item.id);
      else await api.removeFavourite(item.id);
    } catch {}
    toast.info(isFav ? 'Added to favourites' : 'Removed from favourites');
  });
  
  container.querySelector('#more-info').addEventListener('click', async () => {
    try {
      const info = await api.getMediaInfo(item.id);
      await alertDialog({
        title: 'Technical details',
        contentHtml: `<pre style="max-height:50vh; overflow:auto; margin:0; padding:12px; background:rgba(var(--glass-tint),0.07); border:1px solid rgba(var(--glass-tint),0.1); border-radius:10px; font-size:12px; line-height:1.5; color:var(--text-secondary); white-space:pre-wrap; word-break:break-word;">${escapeHtml(JSON.stringify(info, null, 2))}</pre>`,
      });
    } catch (err) {
      toast.error(err.message);
    }
  });
  
  container.querySelector('#copy-path')?.addEventListener('click', async () => {
    if (await copyText(item.path || '')) toast.success('File path copied');
    else toast.error('Could not copy the path');
  });

  container.querySelector('#edit-btn').addEventListener('click', () => showEditModal(item));
  container.querySelector('#add-playlist').addEventListener('click', () => showAddToPlaylist(item));
  container.querySelector('#delete-btn').addEventListener('click', async () => {
    const { confirmed, checked: deleteFile } = await confirmDialog({
      title: 'Delete media',
      message: `Delete "${item.title}"?`,
      confirmText: 'Delete',
      danger: true,
      checkbox: { label: 'Also delete the file from disk', checked: false },
    });
    if (!confirmed) return;
    try {
      await api.deleteItem(item.id, deleteFile);
      toast.success('Deleted');
      history.back();
      // Refresh library
      const data = await api.getLibrary({ limit: 1000 });
      store.setLibrary(data.items || []);
    } catch (err) {
      toast.error(err.message);
    }
  });
}

function renderMusicDetail(container, item) {
  const library = store.get('library');
  // Same grouping key as the Albums filter in views/music.js: tracks with no
  // album tag (undefined, '' or null) are one "Unknown Album" group, so opening
  // that group lists every untagged track instead of an empty heading.
  const albumKey = item.album || 'Unknown Album';
  const sortTracks = (list) => [...list].sort((a, b) => (a.track || 0) - (b.track || 0) || String(a.title).localeCompare(String(b.title)));
  let albumTracks = sortTracks(library.filter(i => i.type === 'music' && (i.album || 'Unknown Album') === albumKey));
  const isAlbumView = albumTracks.length > 1;
  const albumArtists = [...new Set(albumTracks.map(t => t.artist).filter(Boolean))];
  const byline = isAlbumView
    ? (albumArtists.length > 1 ? 'Various Artists' : (albumArtists[0] || ''))
    : (item.artist || '');
  const coverVersion = Math.max(0, ...albumTracks.map(t => new Date(t.updatedAt || 0).getTime() || 0));
  const totalSeconds = albumTracks.reduce((sum, t) => sum + durationSeconds(t.duration), 0);
  const coverUrl = typeof api.getCoverUrlVersioned === 'function'
    ? api.getCoverUrlVersioned(item.id, coverVersion || '')
    : `${api.getCoverUrl(item.id)}${coverVersion ? `&v=${encodeURIComponent(coverVersion)}` : ''}`;

  container.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">
      <button class="btn btn-secondary btn-sm" id="back-btn">${icon('arrow-left', { size: 16 })}<span>Back</span></button>
      <span style="color:var(--text-tertiary); font-size:13px;">${isAlbumView ? 'Album' : 'Track'}</span>
    </div>

    <div class="album-header">
      <div class="album-header-cover">
        <img src="${coverUrl}" alt="" onerror="this.style.display='none'">
      </div>
      <div class="album-header-meta">
        <span class="quality-badge">${isAlbumView ? 'Album' : 'Track'}</span>
        <h1 class="album-header-title">${escapeHtml(isAlbumView ? albumKey : item.title)}</h1>
        <div class="album-header-sub">
          ${byline ? `<span>${escapeHtml(byline)}</span>` : ''}
          ${item.year ? `<span>${item.year}</span>` : ''}
          <span>${albumTracks.length} track(s)</span>
          <span>${formatDuration(totalSeconds)} total</span>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn btn-primary" id="play-btn">${icon('play', { size: 18 })}<span>Play ${isAlbumView ? 'Album' : ''}</span></button>
          <button class="btn btn-secondary" id="shuffle-btn">${icon('shuffle', { size: 18 })}<span>Shuffle</span></button>
          <button class="btn btn-secondary" id="fav-btn" aria-label="${store.get('favourites').includes(item.id) ? 'Remove from favourites' : 'Add to favourites'}" aria-pressed="${store.get('favourites').includes(item.id)}">${icon(store.get('favourites').includes(item.id) ? 'heart-filled' : 'heart', { size: 18 })}</button>
          ${isAlbumView ? '<button class="btn btn-secondary" id="edit-album-btn">Edit album</button>' : '<button class="btn btn-secondary" id="edit-track-btn">Edit track</button>'}
        </div>
        ${isAlbumView ? '<p class="row-meta">Drag rows or use the ↑ ↓ buttons to reorder — new track numbers are saved for the whole album. “Edit” renames a single track.</p>' : ''}
      </div>
    </div>

    <div id="track-list"></div>
  `;

  container.querySelector('#back-btn').addEventListener('click', () => history.back());

  let tracks = isAlbumView ? albumTracks : [item];
  const trackListEl = container.querySelector('#track-list');

  const refreshLibrary = async (updatedItems) => {
    (updatedItems || []).forEach(u => {
      const local = store.get('library').find(i => i.id === u.id);
      if (local) Object.assign(local, u);
    });
    store.set('library', [...store.get('library')]);
  };

  const renderTracks = async () => {
    const { renderMediaList } = await import('../components/mediaList.js');
    renderMediaList(trackListEl, tracks, {
      onClick: (track) => {
        window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: track, queue: tracks, index: tracks.findIndex(t => t.id === track.id) } }));
      }
    });
    if (!isAlbumView) return;
    const { makeReorderable } = await import('../components/reorderableList.js');
    makeReorderable(trackListEl, {
      onEdit: (index) => showTrackEditModal(tracks[index], async () => { await refreshLibrary(); renderMusicDetail(container, item); }),
      onMove: async (from, to) => {
        const next = [...tracks];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        try {
          const ids = next.map(t => t.id);
          // `request` is a compatibility fallback for clients whose old PWA
          // shell cached api.js before updateAlbumOrder was added. The service
          // worker now updates shell files network-first, but this lets the
          // current page recover without making the user clear site data.
          const result = typeof api.updateAlbumOrder === 'function'
            ? await api.updateAlbumOrder(ids)
            : await api.request('/api/library/albums/order', {
              method: 'PUT',
              body: JSON.stringify({ ids }),
            });
          const updated = Array.isArray(result?.items) ? result.items : [];
          const missing = Array.isArray(result?.missing) ? result.missing : [];

          // Merge the authoritative response immediately. The server also
          // emits library:changed, whose refresh can race this handler; making
          // a second GET here used to let the two requests cancel each other
          // and report an AbortError even though the order had been saved.
          const updatesById = new Map(updated.map(track => [track.id, track]));
          const missingIds = new Set(missing);
          const mergedLibrary = store.get('library')
            .filter(track => !missingIds.has(track.id))
            .map(track => updatesById.has(track.id)
              ? { ...track, ...updatesById.get(track.id) }
              : track);
          store.setLibrary(mergedLibrary);

          if (missing.length) {
            const n = missing.length;
            toast.warning(`${n} track${n === 1 ? ' is' : 's are'} no longer in the library and ${n === 1 ? 'was' : 'were'} skipped.`);
          } else {
            toast.success('Album order saved');
          }
          const currentItem = updatesById.get(item.id)
            || mergedLibrary.find(track => track.id === item.id)
            || updated[0]
            || item;
          renderMusicDetail(container, currentItem);
        } catch (err) {
          toast.error(`Could not reorder: ${err.message}`);
        }
      },
    });
  };
  renderTracks();

  container.querySelector('#play-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: tracks[0], queue: tracks, index: 0 } }));
  });

  container.querySelector('#shuffle-btn').addEventListener('click', () => {
    if (!tracks.length) return;
    // Spotify-style: keep album order in the queue, turn shuffle on, and let the
    // player pick each next track from the ones not yet played in this pass.
    const start = Math.floor(Math.random() * tracks.length);
    store.set('shuffle', true, true);
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: tracks[start], queue: tracks, index: start } }));
  });

  container.querySelector('#fav-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const isFav = store.toggleFavourite(item.id);
    setIcon(btn, isFav ? 'heart-filled' : 'heart', { size: 18 });
    btn.setAttribute('aria-pressed', String(isFav));
    btn.setAttribute('aria-label', isFav ? 'Remove from favourites' : 'Add to favourites');
    try {
      if (isFav) await api.addFavourite(item.id);
      else await api.removeFavourite(item.id);
    } catch {}
  });

  container.querySelector('#edit-album-btn')?.addEventListener('click', () => {
    showAlbumEditModal({
      albumKey,
      tracks,
      onSaved: async (updated) => { await refreshLibrary(updated); renderMusicDetail(container, updated?.[0] || item); },
    });
  });
  container.querySelector('#edit-track-btn')?.addEventListener('click', () => {
    showTrackEditModal(item, async () => { await refreshLibrary(); renderMusicDetail(container, item); });
  });
}

/** Rename a single track (title, plus artist/album/year for context). */
export function showTrackEditModal(track, onSaved) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Edit track</div><button class="modal-close" aria-label="Close dialog">${icon('x', { size: 16 })}</button></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="track-title" value="${escapeHtml(track.title || '')}"></div>
        <div class="form-group"><label class="form-label">Artist</label><input type="text" class="form-input" id="track-artist" value="${escapeHtml(track.artist || '')}"></div>
        <div class="form-group"><label class="form-label">Track #</label><input type="number" class="form-input" id="track-num" min="0" value="${track.track || ''}"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" id="track-cancel">Cancel</button><button class="btn btn-primary" id="track-save">Save</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('#track-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#track-save').addEventListener('click', async () => {
    const title = backdrop.querySelector('#track-title').value.trim();
    if (!title) { toast.error('Title is required'); return; }
    try {
      const updated = await api.updateItem(track.id, {
        title,
        artist: backdrop.querySelector('#track-artist').value.trim(),
        track: parseInt(backdrop.querySelector('#track-num').value, 10) || 0,
      });
      Object.assign(track, updated);
      toast.success('Track updated');
      close();
      await onSaved?.();
    } catch (err) { toast.error(err.message); }
  });
}

/**
 * Edit an album after the fact: rename it (applied to every track) and/or
 * replace its cover art (also applied to every track, so all songs in the
 * album — grids, player, other album tracks — pick up the same artwork).
 * Albums intentionally have no description; descriptions are playlist-only.
 */
function showAlbumEditModal({ albumKey, tracks, onSaved }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Edit album</div><button class="modal-close" aria-label="Close dialog">${icon('x', { size: 16 })}</button></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Album title</label><input type="text" class="form-input" id="album-title" value="${escapeHtml(albumKey === 'Unknown Album' ? '' : albumKey)}" placeholder="Unknown Album"></div>
        <div class="form-group"><label class="form-label">Cover art (applies to all ${tracks.length} tracks)</label><input type="file" class="form-input" id="album-cover" accept="image/*"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" id="album-cancel">Cancel</button><button class="btn btn-primary" id="album-save">Save</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('#album-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#album-save').addEventListener('click', async () => {
    const ids = tracks.map(t => t.id);
    const title = backdrop.querySelector('#album-title').value.trim();
    const cover = backdrop.querySelector('#album-cover').files?.[0];
    if (!title && albumKey !== 'Unknown Album') { toast.error('Album title is required'); return; }
    try {
      let updated = tracks;
      if (cover) {
        const result = await uploadAlbumCover(ids, cover);
        if (result.items) updated = result.items;
      }
      if (title && title !== albumKey) {
        const result = typeof api.updateAlbumTitle === 'function'
          ? await api.updateAlbumTitle(ids, title)
          : await api.request('/api/library/albums/metadata', {
            method: 'PUT',
            body: JSON.stringify({ ids, album: title }),
          });
        if (result.items) updated = result.items;
      }
      toast.success('Album updated');
      close();
      await onSaved?.(updated);
    } catch (err) { toast.error(err.message); }
  });
}

function showEditModal(item) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Edit Metadata</div><button class="modal-close" aria-label="Close dialog">${icon('x', { size: 16 })}</button></div>
      <div class="modal-body">
        <div class="form-group"><label class="form-label">Title</label><input type="text" class="form-input" id="edit-title" value="${escapeHtml(item.title)}"></div>
        <div class="form-group"><label class="form-label">Genre</label><input type="text" class="form-input" id="edit-genre" value="${escapeHtml(item.genre || '')}"></div>
        <div class="form-group"><label class="form-label">Year</label><input type="number" class="form-input" id="edit-year" value="${item.year || ''}"></div>
        <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="edit-desc">${escapeHtml(item.description || '')}</textarea></div>
        <div class="form-group"><label class="form-label">Rating (0-5)</label><input type="number" class="form-input" id="edit-rating" min="0" max="5" step="0.5" value="${item.rating || 0}"></div>
      </div>
      <div class="modal-footer"><button class="btn btn-secondary" id="edit-cancel">Cancel</button><button class="btn btn-primary" id="edit-save">Save</button></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('#edit-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  
  backdrop.querySelector('#edit-save').addEventListener('click', async () => {
    const updates = {
      title: backdrop.querySelector('#edit-title').value.trim(),
      genre: backdrop.querySelector('#edit-genre').value.trim(),
      year: parseInt(backdrop.querySelector('#edit-year').value, 10) || undefined,
      description: backdrop.querySelector('#edit-desc').value.trim(),
      rating: parseFloat(backdrop.querySelector('#edit-rating').value) || 0,
    };
    
    try {
      await api.updateItem(item.id, updates);
      toast.success('Metadata updated');
      close();
      // Refresh
      const updated = await api.getItem(item.id);
      Object.assign(item, updated);
      renderDetail(document.getElementById('view-container'), item.id);
      const data = await api.getLibrary({ limit: 1000 });
      store.setLibrary(data.items || []);
    } catch (err) {
      toast.error(err.message);
    }
  });
}

function showAddToPlaylist(item) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal">
      <div class="modal-header"><div class="modal-title">Add to Playlist</div><button class="modal-close" aria-label="Close dialog">${icon('x', { size: 16 })}</button></div>
      <div class="modal-body" id="playlist-list">Loading...</div>
      <div class="modal-footer"><button class="btn btn-secondary" id="pl-cancel">Cancel</button></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.querySelector('#pl-cancel').addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  
  const listEl = backdrop.querySelector('#playlist-list');
  
  api.getPlaylists().then(data => {
    const playlists = data.playlists || [];
    if (playlists.length === 0) {
      listEl.innerHTML = '<p>No playlists yet. Create one in Playlists page.</p>';
      return;
    }
    
    listEl.innerHTML = playlists.map(pl => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:12px; background:rgba(var(--glass-tint),0.05); border-radius:8px; margin-bottom:8px;">
        <span>${escapeHtml(pl.name)}</span>
        <button class="btn btn-primary btn-sm" data-id="${escapeHtml(pl.id)}">Add</button>
      </div>
    `).join('');
    
    listEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await api.addToPlaylist(btn.dataset.id, item.id);
          toast.success('Added to playlist');
          close();
        } catch (err) {
          toast.error(err.message);
        }
      });
    });
  }).catch(err => {
    listEl.innerHTML = `<p>Failed to load: ${escapeHtml(err.message)}</p>`;
  });
}
