/**
 * Videos view — optimized with debounce and _sortCache
 */
import { store } from '../store.js';
import { renderMediaGrid } from '../components/mediaGrid.js';
import { renderMediaList } from '../components/mediaList.js';

export function renderVideos(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Videos</h1>
      <p class="page-subtitle">Your general video collection</p>
    </div>
    <div class="view-controls">
      <div class="view-toggle">
        <button class="active" data-view="grid">Grid</button>
        <button data-view="list">List</button>
      </div>
      <input type="text" class="form-input" id="filter-input" placeholder="Filter videos..." style="width:200px;">
    </div>
    <div id="videos-content"></div>
  `;
  
  const content = container.querySelector('#videos-content');
  const filterInput = container.querySelector('#filter-input');
  const viewButtons = container.querySelectorAll('.view-toggle button');
  
  let viewMode = store.get('viewMode') || 'grid';
  let filter = '';
  let filterTimer = null;
  
  viewButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewMode);
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.view;
      viewButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.set('viewMode', viewMode, true);
      render();
    });
  });
  
  filterInput.addEventListener('input', (e) => {
    clearTimeout(filterTimer);
    const val = e.target.value.toLowerCase();
    filterTimer = setTimeout(() => { filter = val; render(); }, 150);
  });
  
  function getFiltered() {
    let items = store.get('library').filter(i => i.type === 'video');
    if (filter) {
      items = items.filter(i => i._haystack ? i._haystack.includes(filter) : i.title.toLowerCase().includes(filter));
    }
    // Use addedAt sort cache
    return items.sort((a, b) => (b._sortCache?.addedAt ?? 0) - (a._sortCache?.addedAt ?? 0) || new Date(b.addedAt) - new Date(a.addedAt));
  }
  
  function render() {
    const items = getFiltered();
    const play = (item) => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
    const open = (item) => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } }));
    if (viewMode === 'grid') {
      renderMediaGrid(content, items, {
        onClick: open,
        onPlay: play,
        emptyMessage: 'No videos found. Upload some videos to get started.'
      });
    } else {
      renderMediaList(content, items, {
        onClick: open,
        onPlay: play,
      });
    }
  }
  
  render();
  let t;
  store.subscribe('library', () => { clearTimeout(t); t = setTimeout(render, 100); });
}
