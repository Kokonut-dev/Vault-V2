/**
 * Global search — command palette (Option+Space)
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { Fuse } from '../utils/fuse.js';
import { router } from '../router.js';

export class SearchModal {
  constructor() {
    this.isOpen = false;
    this.fuse = null;
    this.results = [];
    this.selectedIndex = 0;
    this.debounceTimer = null;
    this.container = null;
  }

  init() {
    this.createModal();
    this.bindEvents();
    this.buildIndex();
  }

  createModal() {
    const backdrop = document.createElement('div');
    backdrop.className = 'search-modal-backdrop';
    backdrop.id = 'search-backdrop';
    backdrop.innerHTML = `
      <div class="search-modal glass" role="dialog" aria-modal="true" aria-label="Search">
        <div class="search-input-wrapper">
          <span class="search-icon">⌕</span>
          <input type="text" class="search-input" id="search-input" placeholder="Search movies, music, videos..." autocomplete="off" spellcheck="false">
          <span class="search-shortcut">ESC</span>
        </div>
        <div class="search-results" id="search-results">
          <div class="search-empty">
            <div class="search-empty-icon">⌕</div>
            <div>Start typing to search your library</div>
            <div style="font-size:12px; margin-top:8px; opacity:0.6;">Searches titles, artists, albums, genres, years</div>
          </div>
        </div>
        <div class="search-footer">
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Select</span>
          <span><kbd>ESC</kbd> Close</span>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    this.container = backdrop;
  }

  bindEvents() {
    const input = this.container.querySelector('#search-input');

    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });

    input.addEventListener('input', (e) => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.search(e.target.value), 150);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.selectCurrent();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    window.addEventListener('vault:open-search', () => this.open());
    window.addEventListener('vault:escape', () => {
      if (this.isOpen) this.close();
    });

    store.subscribe('library', () => this.buildIndex());
  }

  buildIndex() {
    const library = store.get('library') || [];
    this.fuse = new Fuse(library, {
      keys: [
        { name: 'title', weight: 3 },
        { name: 'artist', weight: 2 },
        { name: 'album', weight: 2 },
        { name: 'genre', weight: 1 },
        { name: 'year', weight: 1 },
        { name: 'description', weight: 0.5 },
        { name: 'filename', weight: 0.5 },
      ],
      threshold: 0.4,
    });
  }

  open() {
    this.isOpen = true;
    this.container.classList.add('active');
    const input = this.container.querySelector('#search-input');
    input.focus();
    input.select();
    this.showRecent();
  }

  close() {
    this.isOpen = false;
    this.container.classList.remove('active');
    this.selectedIndex = 0;
  }

  async search(query) {
    const resultsContainer = this.container.querySelector('#search-results');
    
    if (!query || query.trim() === '') {
      this.showRecent();
      return;
    }

    // Add to recent searches
    this.addToRecent(query);

    if (!this.fuse) this.buildIndex();

    const results = this.fuse.search(query).slice(0, 30);
    this.results = results.map(r => r.item);

    if (this.results.length === 0) {
      resultsContainer.innerHTML = `
        <div class="search-empty">
          <div class="search-empty-icon">∅</div>
          <div>No results for "${this.escape(query)}"</div>
          <div style="font-size:12px; margin-top:8px; opacity:0.6;">Try different keywords or check spelling</div>
        </div>
      `;
      return;
    }

    // Group by type
    const grouped = {
      movie: this.results.filter(i => i.type === 'movie'),
      music: this.results.filter(i => i.type === 'music'),
      video: this.results.filter(i => i.type === 'video'),
    };

    let html = '';
    let globalIndex = 0;

    for (const [type, items] of Object.entries(grouped)) {
      if (items.length === 0) continue;
      const label = type === 'movie' ? 'Movies & Series' : type === 'music' ? 'Music' : 'Videos';
      html += `
        <div class="search-section">
          <div class="search-section-title">${label} <span class="search-section-count">${items.length}</span></div>
          ${items.map(item => {
            const idx = globalIndex++;
            return `
              <div class="search-item ${idx === this.selectedIndex ? 'selected' : ''}" data-index="${idx}" data-id="${item.id}">
                <div class="search-item-cover">
                  <img data-src="${api.getThumbnailUrl(item.id) || api.getCoverUrl(item.id)}" alt="" loading="lazy">
                </div>
                <div class="search-item-info">
                  <div class="search-item-title">${this.escape(item.title)}</div>
                  <div class="search-item-meta">${this.escape(item.artist || item.genre || item.year || '')}</div>
                </div>
                <span class="search-item-type">${item.type}</span>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    resultsContainer.innerHTML = html;

    // Bind click
    resultsContainer.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        const item = this.results.find(i => i.id === id);
        if (item) this.selectItem(item);
      });
    });

    // Lazy load images
    const { lazyLoad } = await import('../utils/lazyLoad.js');
    lazyLoad('#search-results [data-src]');
  }

  showRecent() {
    const recent = store.get('recentSearches') || [];
    const history = store.get('searchHistory') || [];
    const resultsContainer = this.container.querySelector('#search-results');

    if (recent.length === 0 && history.length === 0) {
      resultsContainer.innerHTML = `
        <div class="search-empty">
          <div class="search-empty-icon">⌕</div>
          <div>Start typing to search</div>
          <div style="font-size:12px; margin-top:8px; opacity:0.6;">Recent searches will appear here</div>
        </div>
      `;
      return;
    }

    let html = '';

    if (recent.length > 0) {
      html += `
        <div class="search-section">
          <div class="search-section-title">Recent Searches</div>
          ${recent.slice(0, 5).map(q => `
            <div class="search-recent-item" data-query="${this.escape(q)}">
              <span>◷</span> ${this.escape(q)}
            </div>
          `).join('')}
        </div>
      `;
    }

    if (history.length > 0) {
      const items = history.slice(0, 5).map(h => {
        const lib = store.get('library').find(i => i.id === h.itemId);
        return lib;
      }).filter(Boolean);

      if (items.length > 0) {
        html += `
          <div class="search-section">
            <div class="search-section-title">Recently Played</div>
            ${items.map(item => `
              <div class="search-item" data-id="${item.id}">
                <div class="search-item-cover"><img data-src="${api.getThumbnailUrl(item.id)}" alt=""></div>
                <div class="search-item-info">
                  <div class="search-item-title">${this.escape(item.title)}</div>
                  <div class="search-item-meta">${this.escape(item.artist || '')}</div>
                </div>
                <span class="search-item-type">${item.type}</span>
              </div>
            `).join('')}
          </div>
        `;
      }
    }

    resultsContainer.innerHTML = html;

    resultsContainer.querySelectorAll('.search-recent-item').forEach(el => {
      el.addEventListener('click', () => {
        const q = el.getAttribute('data-query');
        const input = this.container.querySelector('#search-input');
        input.value = q;
        this.search(q);
      });
    });

    resultsContainer.querySelectorAll('.search-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        const item = store.get('library').find(i => i.id === id);
        if (item) this.selectItem(item);
      });
    });
  }

  moveSelection(dir) {
    const items = this.container.querySelectorAll('.search-item');
    if (items.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(items.length - 1, this.selectedIndex + dir));
    items.forEach((el, idx) => el.classList.toggle('selected', idx === this.selectedIndex));
    items[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  selectCurrent() {
    const items = this.container.querySelectorAll('.search-item');
    const selected = items[this.selectedIndex];
    if (selected) {
      const id = selected.getAttribute('data-id');
      const item = this.results.find(i => i.id === id) || store.get('library').find(i => i.id === id);
      if (item) this.selectItem(item);
    }
  }

  selectItem(item) {
    this.close();
    // Navigate to detail or play
    if (item.type === 'music') {
      window.dispatchEvent(new CustomEvent('vault:play', { detail: { item } }));
    } else {
      router.navigate(`/watch/${item.id}`);
    }
    // Add to search history
    const history = store.get('searchHistory') || [];
    history.unshift({ itemId: item.id, searchedAt: new Date().toISOString() });
    store.set('searchHistory', history.slice(0, 20), true);
  }

  addToRecent(query) {
    if (!query || query.trim().length < 2) return;
    let recent = store.get('recentSearches') || [];
    recent = recent.filter(q => q !== query);
    recent.unshift(query);
    recent = recent.slice(0, 10);
    store.set('recentSearches', recent, true);
  }

  escape(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

export const searchModal = new SearchModal();
export default searchModal;
