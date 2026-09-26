/**
 * Movies view
 */
import { store } from '../store.js';
import { renderMediaGrid, renderSkeletonGrid } from '../components/mediaGrid.js';
import { renderMediaList } from '../components/mediaList.js';

export function renderMovies(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Movies & Series</h1>
      <p class="page-subtitle">Your movie and TV show collection</p>
    </div>
    <div class="view-controls">
      <div class="view-toggle">
        <button class="active" data-view="grid">Grid</button>
        <button data-view="list">List</button>
      </div>
      <select class="form-select" id="sort-select" style="width:auto;">
        <option value="addedAt-desc">Recently Added</option>
        <option value="title-asc">Title A-Z</option>
        <option value="title-desc">Title Z-A</option>
        <option value="year-desc">Year Newest</option>
        <option value="year-asc">Year Oldest</option>
        <option value="rating-desc">Rating High</option>
      </select>
      <input type="text" class="form-input" id="filter-input" placeholder="Filter movies..." style="width:200px;">
    </div>
    <div id="movies-content"></div>
  `;
  
  const content = container.querySelector('#movies-content');
  const sortSelect = container.querySelector('#sort-select');
  const filterInput = container.querySelector('#filter-input');
  const viewButtons = container.querySelectorAll('.view-toggle button');
  
  let viewMode = store.get('viewMode') || 'grid';
  let sort = 'addedAt';
  let order = 'desc';
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
  
  sortSelect.addEventListener('change', (e) => {
    const [s, o] = e.target.value.split('-');
    sort = s;
    order = o;
    render();
  });
  
  filterInput.addEventListener('input', (e) => {
    filter = e.target.value.toLowerCase();
    render();
  });
  
  function getFiltered() {
    let items = store.get('library').filter(i => i.type === 'movie');
    
    if (filter) {
      items = items.filter(i => 
        i.title.toLowerCase().includes(filter) ||
        (i.genre && i.genre.toLowerCase().includes(filter)) ||
        (i.year && i.year.toString().includes(filter))
      );
    }
    
    items.sort((a, b) => {
      let aVal = a[sort] || '';
      let bVal = b[sort] || '';
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return order === 'asc' ? -1 : 1;
      if (aVal > bVal) return order === 'asc' ? 1 : -1;
      return 0;
    });
    
    return items;
  }
  
  function render() {
    const items = getFiltered();
    
    if (viewMode === 'grid') {
      renderMediaGrid(content, items, {
        onClick: (item) => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } })),
        emptyMessage: 'No movies found. Upload some movies to get started.'
      });
    } else {
      renderMediaList(content, items, {
        onClick: (item) => window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }))
      });
    }
  }
  
  render();
  
  // Listen for library updates
  store.subscribe('library', render);
}
