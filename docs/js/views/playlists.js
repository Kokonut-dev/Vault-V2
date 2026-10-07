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
            ${icon(pl.type === 'collection' ? 'layout-grid' : 'music', { size: 32 })}
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
  
  function openPlaylist(playlist) {
    // Simple detail view
    content.innerHTML = `
      <div style="margin-bottom:24px;">
        <button class="btn btn-secondary btn-sm" id="back-btn">${icon('arrow-left', { size: 16 })}<span>Back</span></button>
      </div>
      <div style="background:rgba(var(--glass-tint),0.05); border-radius:16px; padding:24px; margin-bottom:24px;">
        <h2 style="font-size:24px; font-weight:700; margin-bottom:8px;">${escapeHtml(playlist.name)}</h2>
        <p style="color:var(--text-secondary); margin-bottom:16px;">${escapeHtml(playlist.description || '')}</p>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button class="btn btn-primary btn-sm" id="play-pl">Play All</button>
          <a class="btn btn-secondary btn-sm" id="export-pl" href="${api.exportPlaylistUrl(playlist.id)}" download>${icon('download', { size: 14 })}<span>Export .m3u</span></a>
          <label class="btn btn-secondary btn-sm" for="import-pl" style="cursor:pointer">${icon('upload', { size: 14 })}<span>Import .m3u</span></label>
          <input type="file" id="import-pl" accept=".m3u,.m3u8,audio/x-mpegurl" hidden>
          <button class="btn btn-ghost btn-sm" id="stats-pl">${icon('bar-chart', { size: 14 })}<span>Stats</span></button>
          <button class="btn btn-secondary btn-sm" id="delete-pl">Delete</button>
        </div>
        <p class="row-meta" style="margin-top:8px">Drag rows to reorder — the order is saved on the server.</p>
      </div>
      <div id="pl-items"></div>
    `;
    
    content.querySelector('#back-btn').addEventListener('click', loadPlaylists);
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
        wireReorder(itemsContainer, playlist, items);
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

  /**
   * Drag & drop reordering inside an open playlist (Tier 2 item 31).
   * Sends only the {from,to} pair — the server reorders its copy.
   */
  function wireReorder(itemsContainer, playlist, items) {
    const rows = [...itemsContainer.querySelectorAll('.media-list .media-list-item')];
    if (!rows.length) return;
    let fromIndex = null;

    rows.forEach((row, index) => {
      row.draggable = true;
      row.classList.add('playlist-item');
      row.addEventListener('dragstart', (event) => {
        fromIndex = index;
        row.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        rows.forEach(r => r.classList.remove('drop-target'));
      });
      row.addEventListener('dragover', (event) => {
        event.preventDefault();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', async (event) => {
        event.preventDefault();
        row.classList.remove('drop-target');
        const from = fromIndex ?? Number(event.dataTransfer.getData('text/plain'));
        const to = index;
        if (Number.isNaN(from) || from === to) return;
        const next = [...(playlist.items || [])];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        try {
          await api.reorderPlaylist(playlist.id, { items: next });
          playlist.items = next;
          toast.success('Order saved');
          openPlaylist(playlist);
        } catch (err) {
          toast.error(`Could not reorder: ${err.message}`);
        }
      });
    });
  }
}


