/**
 * Global store — pub/sub state management
 */

class Store {
  constructor() {
    this.state = {
      // Auth
      isAuthenticated: false,
      user: null,
      token: localStorage.getItem('vault_token') || null,
      challengeToken: null,

      // Library
      library: [],
      filteredLibrary: [],
      currentItem: null,
      searchQuery: '',
      filters: {
        type: 'all',
        genre: null,
        year: null,
        sort: 'addedAt',
        order: 'desc',
      },
      viewMode: localStorage.getItem('vault_view_mode') || 'grid',

      // Player
      currentTrack: null,
      queue: JSON.parse(localStorage.getItem('vault_queue') || '[]'),
      queueIndex: parseInt(localStorage.getItem('vault_queue_index') || '-1', 10),
      isPlaying: false,
      volume: parseFloat(localStorage.getItem('vault_volume') || '0.8'),
      isMuted: false,
      shuffle: localStorage.getItem('vault_shuffle') === 'true',
      repeat: localStorage.getItem('vault_repeat') || 'off', // off, all, one
      crossfade: parseInt(localStorage.getItem('vault_crossfade') || '0', 10),
      playbackRate: 1,

      // Video
      currentVideo: null,
      videoProgress: {}, // id -> progress

      // UI
      theme: localStorage.getItem('vault_theme') || 'dark',
      glassIntensity: parseInt(localStorage.getItem('vault_glass') || '20', 10),
      grainIntensity: parseInt(localStorage.getItem('vault_grain') || '15', 10),
      sidebarCollapsed: localStorage.getItem('vault_sidebar_collapsed') === 'true',
      theatreMode: false,

      // Playlists
      playlists: [],
      favourites: JSON.parse(localStorage.getItem('vault_favourites') || '[]'),
      history: JSON.parse(localStorage.getItem('vault_history') || '[]'),

      // EQ
      eqEnabled: localStorage.getItem('vault_eq_enabled') === 'true',
      eqPreset: localStorage.getItem('vault_eq_preset') || 'flat',
      eqGains: JSON.parse(localStorage.getItem('vault_eq_gains') || '[0,0,0,0,0,0,0,0,0,0]'),
      eqCustomPresets: JSON.parse(localStorage.getItem('vault_eq_custom') || '{}'),

      // Search
      recentSearches: JSON.parse(localStorage.getItem('vault_recent_searches') || '[]'),
      searchHistory: JSON.parse(localStorage.getItem('vault_search_history') || '[]'),

      // Connection
      isOnline: navigator.onLine,
      serverConnected: true,
    };

    this.listeners = new Map();
  }

  get(key) {
    return this.state[key];
  }

  set(key, value, persist = false) {
    const oldValue = this.state[key];
    this.state[key] = value;

    if (persist) {
      this.persist(key, value);
    }

    this.emit(key, value, oldValue);
    this.emit('*', { key, value, oldValue });
  }

  persist(key, value) {
    const persistMap = {
      token: 'vault_token',
      theme: 'vault_theme',
      glassIntensity: 'vault_glass',
      grainIntensity: 'vault_grain',
      viewMode: 'vault_view_mode',
      volume: 'vault_volume',
      shuffle: 'vault_shuffle',
      repeat: 'vault_repeat',
      crossfade: 'vault_crossfade',
      queue: 'vault_queue',
      queueIndex: 'vault_queue_index',
      favourites: 'vault_favourites',
      history: 'vault_history',
      eqEnabled: 'vault_eq_enabled',
      eqPreset: 'vault_eq_preset',
      eqGains: 'vault_eq_gains',
      recentSearches: 'vault_recent_searches',
      searchHistory: 'vault_search_history',
      sidebarCollapsed: 'vault_sidebar_collapsed',
    };

    const storageKey = persistMap[key];
    if (storageKey) {
      if (typeof value === 'object') {
        localStorage.setItem(storageKey, JSON.stringify(value));
      } else {
        localStorage.setItem(storageKey, String(value));
      }
    }
  }

  update(updates, persistKeys = []) {
    Object.entries(updates).forEach(([key, value]) => {
      this.state[key] = value;
      if (persistKeys.includes(key)) this.persist(key, value);
      this.emit(key, value);
    });
    this.emit('*', updates);
  }

  subscribe(key, callback) {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(callback);
    return () => this.listeners.get(key).delete(callback);
  }

  emit(key, ...args) {
    if (this.listeners.has(key)) {
      this.listeners.get(key).forEach(cb => {
        try { cb(...args); } catch (e) { console.error('Store listener error', e); }
      });
    }
  }

  // Auth helpers
  setAuth(token, user) {
    this.set('token', token, true);
    this.set('user', user);
    this.set('isAuthenticated', true);
    if (token) localStorage.setItem('vault_token', token);
  }

  clearAuth() {
    this.set('token', null, true);
    this.set('user', null);
    this.set('isAuthenticated', false);
    this.set('challengeToken', null);
    localStorage.removeItem('vault_token');
  }

  // Library helpers
  setLibrary(library) {
    this.set('library', library);
    this.applyFilters();
  }

  applyFilters() {
    let filtered = [...this.state.library];
    const { type, genre, year, sort, order } = this.state.filters;
    const query = this.state.searchQuery;

    if (type && type !== 'all') {
      filtered = filtered.filter(i => i.type === type);
    }
    if (genre) {
      filtered = filtered.filter(i => {
        if (!i.genre) return false;
        if (Array.isArray(i.genre)) return i.genre.includes(genre);
        return i.genre === genre;
      });
    }
    if (year) {
      filtered = filtered.filter(i => i.year === parseInt(year, 10));
    }
    if (query) {
      const q = query.toLowerCase();
      filtered = filtered.filter(item => {
        const haystack = [
          item.title, item.artist, item.album, item.genre,
          item.year?.toString(), item.description, item.filename,
          item.tags?.join(' ')
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }

    filtered.sort((a, b) => {
      let aVal = a[sort] ?? '';
      let bVal = b[sort] ?? '';
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      if (aVal < bVal) return order === 'asc' ? -1 : 1;
      if (aVal > bVal) return order === 'asc' ? 1 : -1;
      return 0;
    });

    this.set('filteredLibrary', filtered);
  }

  // Queue helpers
  addToQueue(item, next = false) {
    const queue = [...this.state.queue];
    if (next && this.state.queueIndex >= 0) {
      queue.splice(this.state.queueIndex + 1, 0, item);
    } else {
      queue.push(item);
    }
    this.set('queue', queue, true);
  }

  removeFromQueue(index) {
    const queue = [...this.state.queue];
    queue.splice(index, 1);
    let queueIndex = this.state.queueIndex;
    if (index < queueIndex) queueIndex--;
    if (index === queueIndex) queueIndex = -1;
    this.set('queue', queue, true);
    this.set('queueIndex', queueIndex, true);
  }

  clearQueue() {
    this.set('queue', [], true);
    this.set('queueIndex', -1, true);
  }

  // Favourites
  toggleFavourite(id) {
    const favs = [...this.state.favourites];
    const idx = favs.indexOf(id);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push(id);
    this.set('favourites', favs, true);
    return favs.includes(id);
  }

  // History
  addToHistory(itemId, progress = 0) {
    let history = [...this.state.history];
    const existing = history.findIndex(h => h.itemId === itemId);
    const entry = { itemId, progress, watchedAt: new Date().toISOString() };
    if (existing >= 0) history[existing] = entry;
    else history.unshift(entry);
    // Keep last 100
    history = history.slice(0, 100);
    this.set('history', history, true);
  }
}

export const store = new Store();
export default store;
