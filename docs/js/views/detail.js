/**
 * Detail view — movie, music, video detail pages — optimized
 */
import { store } from '../store.js';
import { formatTime, formatBytes, escapeHtml } from '../utils/format.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { confirmDialog, alertDialog } from '../components/confirmDialog.js';
import { copyText } from '../utils/clipboard.js';
import { icon, setIcon } from '../utils/icons.js';

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
  const albumTracks = library.filter(i => i.type === 'music' && i.album === item.album).sort((a, b) => (a.track || 0) - (b.track || 0));
  const isAlbumView = albumTracks.length > 1;
  
  container.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">
      <button class="btn btn-secondary btn-sm" id="back-btn">${icon('arrow-left', { size: 16 })}<span>Back</span></button>
      <span style="color:var(--text-tertiary); font-size:13px;">${isAlbumView ? 'Album' : 'Track'}</span>
    </div>
    
    <div class="detail-layout">
      <div>
        <div style="aspect-ratio:1/1; background:rgba(var(--glass-tint),0.05); border-radius:16px; overflow:hidden; box-shadow:var(--shadow-lg);">
          <img src="${api.getCoverUrl(item.id)}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">
        </div>
      </div>
      
      <div>
        <h1 style="font-size:32px; font-weight:800; line-height:1.1;">${escapeHtml(isAlbumView ? item.album : item.title)}</h1>
        <div style="font-size:18px; color:var(--text-secondary); margin-top:8px; margin-bottom:24px;">${escapeHtml(item.artist || '')} ${item.year ? `• ${item.year}` : ''}</div>
        
        <div style="display:flex; gap:12px; margin-bottom:24px;">
          <button class="btn btn-primary" id="play-btn">${icon('play', { size: 18 })}<span>Play ${isAlbumView ? 'Album' : ''}</span></button>
          <button class="btn btn-secondary" id="shuffle-btn">${icon('shuffle', { size: 18 })}<span>Shuffle</span></button>
          <button class="btn btn-secondary" id="fav-btn" aria-label="${store.get('favourites').includes(item.id) ? 'Remove from favourites' : 'Add to favourites'}" aria-pressed="${store.get('favourites').includes(item.id)}">${icon(store.get('favourites').includes(item.id) ? 'heart-filled' : 'heart', { size: 18 })}</button>
        </div>
        
        <div id="track-list"></div>
      </div>
    </div>
    
    <style>@media (max-width: 768px) { .detail-grid { grid-template-columns: 1fr !important; } }</style>
  `;
  
  container.querySelector('#back-btn').addEventListener('click', () => history.back());
  
  const tracks = isAlbumView ? albumTracks : [item];
  const trackListEl = container.querySelector('#track-list');
  
  import('../components/mediaList.js').then(({ renderMediaList }) => {
    renderMediaList(trackListEl, tracks, {
      onClick: (track) => {
        window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: track, queue: tracks, index: tracks.findIndex(t => t.id === track.id) } }));
      }
    });
  });
  
  container.querySelector('#play-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: tracks[0], queue: tracks, index: 0 } }));
  });
  
  container.querySelector('#shuffle-btn').addEventListener('click', () => {
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: shuffled[0], queue: shuffled, index: 0 } }));
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
