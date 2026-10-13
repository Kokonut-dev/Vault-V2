/**
 * Playlists view — optimized
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { renderSkeletonGrid } from '../components/mediaGrid.js';
import { confirmDialog } from '../components/confirmDialog.js';
import { escapeHtml, formatTime } from '../utils/format.js';
import { icon } from '../utils/icons.js';

// Keep playlist pages usable for the one load where a newly deployed view may
// still be paired with an older installed-PWA API client. sw.js v4 prevents
// future mixed module sets, while these URL fallbacks avoid a forced cache wipe.
function playlistCoverUrl(id, version = '') {
  if (typeof api.playlistCoverUrl === 'function') return api.playlistCoverUrl(id, version);
  const token = api.getToken?.() || '';
  return `${api.baseUrl}/api/playlists/${id}/cover?token=${encodeURIComponent(token)}${version ? `&v=${encodeURIComponent(version)}` : ''}`;
}

function exportPlaylistUrl(id) {
  if (typeof api.exportPlaylistUrl === 'function') return api.exportPlaylistUrl(id);
  const token = api.getToken?.() || '';
  return `${api.baseUrl}/api/playlists/${id}/export?token=${encodeURIComponent(token)}`;
}

export function renderPlaylists(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <h1 class="page-title">Playlists & Collections</h1>
          <p class="page-subtitle">Your curated playlists and collections</p>
        </div>
        <button class="btn btn-primary" id="create-playlist-btn">Create Playlist</button>
      </div>
    </div>
    <div id="playlists-content"></div>
  `;
  
  const content = container.querySelector('#playlists-content');
  const createBtn = container.querySelector('#create-playlist-btn');
  
  createBtn.addEventListener('click', () => showCreateModal());
  
  loadPlaylists();
  
  async function loadPlaylists() {
    renderSkeletonGrid(content, 8);
    
    try {
      const data = await api.getPlaylists();
      const playlists = data.playlists || [];
      store.set('playlists', playlists);
      
      if (playlists.length === 0) {
        content.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">${icon('list', { size: 30 })}</div>
            <div class="empty-state-title">No playlists yet</div>
            <div class="empty-state-message">Create your first playlist to organize your media</div>
            <button class="btn btn-primary" id="empty-create">Create Playlist</button>
          </div>
        `;
        content.querySelector('#empty-create')?.addEventListener('click', showCreateModal);
        return;
      }
      
      content.innerHTML = '<div class="media-grid" id="playlists-grid"></div>';
      const grid = content.querySelector('#playlists-grid');
      
      playlists.forEach(pl => {
        const card = document.createElement('div');
        card.className = 'media-card';
        card.innerHTML = `
          <div class="media-card-cover" style="background:rgba(var(--glass-tint),0.05); display:flex; align-items:center; justify-content:center;">
            ${pl.coverArt ? `<img src="${playlistCoverUrl(pl.id, pl.updatedAt || '')}" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none'">` : icon(pl.type === 'collection' ? 'layout-grid' : 'music', { size: 32 })}
          </div>
          <div class="media-card-info">
            <div class="media-card-title">${escapeHtml(pl.name)}</div>
            <div class="media-card-meta">${pl.itemCount || pl.items?.length || 0} items • ${pl.type}</div>
          </div>
        `;
        card.addEventListener('click', () => openPlaylist(pl));
        grid.appendChild(card);
      });
      
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div class="empty-state-title">Failed to load playlists</div><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    }
  }
  
  function showCreateModal() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop active';
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">Create Playlist</div>
          <button class="modal-close" aria-label="Close dialog">${icon('x', { size: 16 })}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" class="form-input" id="pl-name" placeholder="My Awesome Playlist">
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" id="pl-desc" placeholder="Optional description"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Type</label>
            <select class="form-select" id="pl-type">
              <option value="playlist">Playlist</option>
              <option value="collection">Collection</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" id="pl-cancel">Cancel</button>
          <button class="btn btn-primary" id="pl-create">Create</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(backdrop);
    
    const close = () => backdrop.remove();
    backdrop.querySelector('.modal-close').addEventListener('click', close);
    backdrop.querySelector('#pl-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    
    backdrop.querySelector('#pl-create').addEventListener('click', async () => {
      const name = backdrop.querySelector('#pl-name').value.trim();
      const description = backdrop.querySelector('#pl-desc').value.trim();
      const type = backdrop.querySelector('#pl-type').value;
      
      if (!name) {
        toast.error('Name is required');
        return;
      }
      
      try {
        await api.createPlaylist({ name, description, type, items: [] });
        toast.success(`Created playlist "${name}"`);
        close();
        loadPlaylists();
      } catch (err) {
        toast.error(escapeHtml(err.message));
      }
    });
  }
  

  function showEditPlaylistModal(playlist, onSaved) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop active';
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-header"><div class="modal-title">Edit playlist</div><button class="modal-close" aria-label="Close dialog">${icon('x', { size: 16 })}</button></div>
        <div class="modal-body">
          <div class="form-group"><label class="form-label">Name</label><input type="text" class="form-input" id="edit-pl-name" value="${escapeHtml(playlist.name || '')}"></div>
          <div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="edit-pl-desc" placeholder="Optional description">${escapeHtml(playlist.description || '')}</textarea></div>
          <div class="form-group"><label class="form-label">Cover art</label><input type="file" class="form-input" id="edit-pl-cover" accept="image/*"></div>
          ${playlist.coverArt ? '<label style="display:flex; gap:8px; align-items:center; font-size:13px;"><input type="checkbox" id="edit-pl-cover-remove"> Remove current cover art</label>' : ''}
        </div>
        <div class="modal-footer"><button class="btn btn-secondary" id="edit-pl-cancel">Cancel</button><button class="btn btn-primary" id="edit-pl-save">Save</button></div>
      </div>
    `;
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    backdrop.querySelector('.modal-close').addEventListener('click', close);
    backdrop.querySelector('#edit-pl-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    backdrop.querySelector('#edit-pl-save').addEventListener('click', async () => {
      const name = backdrop.querySelector('#edit-pl-name').value.trim();
      if (!name) { toast.error('Name is required'); return; }
      try {
        let updated = await api.updatePlaylist(playlist.id, {
          name,
          description: backdrop.querySelector('#edit-pl-desc').value.trim(),
        });
        const cover = backdrop.querySelector('#edit-pl-cover').files?.[0];
        if (cover) updated = await api.uploadPlaylistCover(playlist.id, cover);
        else if (backdrop.querySelector('#edit-pl-cover-remove')?.checked) updated = await api.removePlaylistCover(playlist.id);
        Object.assign(playlist, updated);
        toast.success('Playlist updated');
        close();
        onSaved?.(playlist);
      } catch (err) {
        toast.error(err.message);
      }
    });
  }

  function openPlaylist(playlist) {
    // Simple detail view
    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <button class="btn btn-secondary btn-sm" id="back-btn">${icon('arrow-left', { size: 16 })}<span>Back</span></button>
      </div>
      <div style="background:var(--bg-elevated, var(--bg-secondary)); border:1px solid var(--border-subtle, rgba(var(--glass-tint),0.09)); border-radius:16px; padding:24px; margin-bottom:24px;">
        ${playlist.coverArt ? `<img src="${playlistCoverUrl(playlist.id, playlist.updatedAt || '')}" alt="" style="width:144px;height:144px;object-fit:cover;border-radius:12px;margin-bottom:16px;" onerror="this.style.display='none'">` : ''}
        <h2 style="font-size:24px; font-weight:700; margin-bottom:8px;">${escapeHtml(playlist.name)}</h2>
        <p style="color:var(--text-secondary); margin-bottom:16px;">${escapeHtml(playlist.description || '')}</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button class="btn btn-primary btn-sm" id="play-pl">Play All</button>
          <a class="btn btn-secondary btn-sm" id="export-pl" href="${exportPlaylistUrl(playlist.id)}" download>${icon('download', { size: 14 })}<span>Export .m3u</span></a>
          <label class="btn btn-secondary btn-sm" for="import-pl" style="cursor:pointer">${icon('upload', { size: 14 })}<span>Import .m3u</span></label>
          <input type="file" id="import-pl" accept=".m3u,.m3u8,audio/x-mpegurl" hidden>
          <button class="btn btn-ghost btn-sm" id="stats-pl">${icon('bar-chart', { size: 14 })}<span>Stats</span></button>
          <button class="btn btn-secondary btn-sm" id="edit-pl">Edit</button>
          <button class="btn btn-secondary btn-sm" id="delete-pl">Delete</button>
        </div>
        <p class="row-meta" style="margin-top:8px">Drag rows or use the ↑ ↓ buttons to reorder — the order is saved on the server. “Edit” renames a track in your library.</p>
      </div>
      <div id="pl-items"></div>
    `;
    
    content.querySelector('#back-btn').addEventListener('click', loadPlaylists);
    content.querySelector('#edit-pl').addEventListener('click', () => showEditPlaylistModal(playlist, (updated) => openPlaylist(updated)));
    content.querySelector('#delete-pl').addEventListener('click', async () => {
      const { confirmed } = await confirmDialog({
        title: 'Delete playlist',
        message: `Delete playlist "${playlist.name}"?`,
        confirmText: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await api.deletePlaylist(playlist.id);
        toast.success('Playlist deleted');
        loadPlaylists();
      } catch (err) {
        toast.error(escapeHtml(err.message));
      }
    });
    
    const itemsContainer = content.querySelector('#pl-items');
    // Build id map for O(1) lookups instead of O(n*m) find
  const library = store.get('library');
  const libMap = new Map(library.map(i => [i.id, i]));
  const items = (playlist.items || []).map(id => libMap.get(id)).filter(Boolean);
    
    if (items.length === 0) {
      itemsContainer.innerHTML = '<div class="empty-state"><div class="empty-state-title">No items in this playlist</div></div>';
    } else {
      import('../components/mediaList.js').then(({ renderMediaList }) => {
        renderMediaList(itemsContainer, items, {
          onClick: (item) => {
            if (item.type === 'music') {
              window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue: items, index: items.findIndex(i => i.id === item.id) } }));
            } else {
              window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
            }
          }
        });
        import('../components/reorderableList.js').then(({ makeReorderable }) => {
          makeReorderable(itemsContainer, {
            onEdit: async (index) => {
              const { showTrackEditModal } = await import('./detail.js');
              showTrackEditModal(items[index], () => openPlaylist(playlist));
            },
            onMove: async (from, to) => {
              // `from`/`to` are indices into the *rendered* rows, which skip
              // playlist entries whose track is missing from the library. Apply
              // the move to the visible ids, then write them back into the full
              // list so hidden entries keep their slots and the right track moves.
              const visibleIds = items.map(i => i.id);
              const nextVisible = [...visibleIds];
              const [moved] = nextVisible.splice(from, 1);
              nextVisible.splice(to, 0, moved);
              const visibleSet = new Set(visibleIds);
              let cursor = 0;
              const next = (playlist.items || []).map(id => (visibleSet.has(id) ? nextVisible[cursor++] : id));
              try {
                // Older installed PWA shells can still have an api.js from
                // before reorderPlaylist existed. Fall back to the public
                // request primitive so reordering works without clearing the
                // browser cache; the service worker update fixes future loads.
                const updated = typeof api.reorderPlaylist === 'function'
                  ? await api.reorderPlaylist(playlist.id, { items: next })
                  : await api.request(`/api/playlists/${playlist.id}/order`, {
                    method: 'PUT',
                    body: JSON.stringify({ items: next }),
                  });
                playlist.items = Array.isArray(updated?.items) ? updated.items : next;
                playlist.updatedAt = updated?.updatedAt || playlist.updatedAt;
                toast.success('Order saved');
                openPlaylist(playlist);
              } catch (err) {
                toast.error(`Could not reorder: ${err.message}`);
              }
            },
          });
        });
      });
      
      content.querySelector('#play-pl').addEventListener('click', () => {
        if (items.length > 0) {
          const first = items[0];
          if (first.type === 'music') {
            window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: first, queue: items, index: 0 } }));
          } else {
            window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: first } }));
          }
        }
      });
    }

    content.querySelector('#import-pl').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const result = await api.importPlaylist(playlist.name, text);
        toast.success(`Imported ${result.matched ?? 0} of ${(result.matched ?? 0) + (result.missed ?? 0)} entries`);
        loadPlaylists();
      } catch (err) {
        toast.error(`Import failed: ${err.message}`);
      }
    });

    content.querySelector('#stats-pl').addEventListener('click', async () => {
      try {
        const stats = await api.playlistStats(playlist.id);
        toast.info(`${stats.items ?? items.length} items · ${formatTime(stats.seconds || 0)}${stats.missing ? ` · ${stats.missing} missing` : ''}`, 'Playlist stats');
      } catch (err) {
        toast.error(err.message);
      }
    });
  }
}



