/**
 * History view
 */
import { store } from '../store.js';
import { renderMediaList } from '../components/mediaList.js';
import { formatRelativeTime, escapeHtml } from '../utils/format.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/confirmDialog.js';
import { subscribeView } from '../utils/lifecycle.js';

export function renderHistory(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <h1 class="page-title">History</h1>
          <p class="page-subtitle">Your watch and listen history</p>
        </div>
        <button class="btn btn-secondary btn-sm" id="clear-history">Clear History</button>
      </div>
    </div>
    <div id="history-content"></div>
  `;
  
  const content = container.querySelector('#history-content');
  const clearBtn = container.querySelector('#clear-history');
  
  clearBtn.addEventListener('click', async () => {
    const { confirmed } = await confirmDialog({
      title: 'Clear history',
      message: 'Clear all watch history? This cannot be undone.',
      confirmText: 'Clear all',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await api.clearHistory();
      store.set('history', [], true);
      toast.success('History cleared');
      render();
    } catch (err) {
      // Fallback to local clear
      store.set('history', [], true);
      toast.success('History cleared locally');
      render();
    }
  });
  
  function render() {
    const library = store.get('library');
    const history = store.get('history') || [];
    
    if (history.length === 0) {
      content.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">◷</div>
          <div class="empty-state-title">No history yet</div>
          <div class="empty-state-message">Your watched and listened items will appear here</div>
        </div>
      `;
      return;
    }
    
    const items = history.map(h => {
      const item = library.find(i => i.id === h.itemId);
      return item ? { ...item, history: h } : null;
    }).filter(Boolean);
    
    content.innerHTML = '';
    
    const list = document.createElement('div');
    list.className = 'media-list';
    
    const header = document.createElement('div');
    header.className = 'media-list-header';
    header.innerHTML = `<span>Title</span><span>Progress</span><span>Watched</span><span></span>`;
    list.appendChild(header);
    
    items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'media-list-item';
      const watchedDate = new Date(item.history.watchedAt);
      const timeAttrs = Number.isNaN(watchedDate.getTime())
        ? ''
        : `datetime="${watchedDate.toISOString()}" title="${watchedDate.toLocaleString()}"`;
      row.innerHTML = `
        <div class="media-list-item-main">
          <div class="media-list-item-cover">
            <img src="${api.getThumbnailUrl(item.id)}" alt="" loading="lazy">
          </div>
          <div>
            <div class="media-list-item-title">${escapeHtml(item.title)}</div>
            <div class="media-list-item-artist">${escapeHtml(item.artist || '')}</div>
          </div>
        </div>
        <div>
          <div class="progress" style="width:80px;" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${item.history.progress || 0}" aria-label="Watched">
            <div class="progress-bar" style="width:${item.history.progress || 0}%"></div>
          </div>
        </div>
        <div style="font-size:12px; color:var(--text-secondary);"><time ${timeAttrs}>${formatRelativeTime(item.history.watchedAt)}</time></div>
        <div>
          <button class="btn btn-ghost btn-sm" data-id="${item.id}">Play</button>
        </div>
      `;
      
      row.querySelector('button').addEventListener('click', () => {
        if (item.type === 'music') {
          window.dispatchEvent(new CustomEvent('vault:play', { detail: { item } }));
        } else {
          window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
        }
      });
      
      list.appendChild(row);
    });
    
    content.appendChild(list);
  }
  
  render();
  subscribeView(store, 'history', render);
}
