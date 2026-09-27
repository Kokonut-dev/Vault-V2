/**
 * Favourites view
 */
import { store } from '../store.js';
import { renderMediaGrid } from '../components/mediaGrid.js';
import { subscribeView } from '../utils/lifecycle.js';

export function renderFavourites(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Favourites</h1>
      <p class="page-subtitle">Your favourite movies, music, and videos</p>
    </div>
    <div id="fav-content"></div>
  `;
  
  const content = container.querySelector('#fav-content');
  
  function render() {
    const library = store.get('library');
    const favIds = store.get('favourites') || [];
    const favItems = favIds.map(id => library.find(i => i.id === id)).filter(Boolean);
    
    const play = (item) => {
      if (item.type === 'music') {
        window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue: favItems, index: favItems.findIndex(i => i.id === item.id) } }));
      } else {
        window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item } }));
      }
    };
    renderMediaGrid(content, favItems, {
      onClick: (item) => window.dispatchEvent(new CustomEvent('vault:open-detail', { detail: { item } })),
      onPlay: play,
      emptyMessage: 'No favourites yet. Heart items to add them here.'
    });
  }
  
  render();
  subscribeView(store, 'favourites', render);
  subscribeView(store, 'library', render);
}
