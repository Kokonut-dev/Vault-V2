/**
 * Videos view
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
    filter = e.target.value.toLowerCase();
    render();
  });
  
  function getFiltered() {
    let items = store.get('library').filter(i => i.type === 'video');
    if (filter) {
      items = items.filter(i => i.title.toLowerCase().includes(filter));
    }
    return items.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  }
  
  function render() {
    const items = getFiltered();
    if (viewMode === 'grid') {
      renderMediaGrid(content, items, {
        onClick: (item) => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } })),
        emptyMessage: 'No videos found.'
      });
    } else {
      renderMediaList(content, items, {
        onClick: (item) => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }))
      });
    }
  }
  
  render();
  store.subscribe('library', render);
}
