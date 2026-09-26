/**
 * Global store — pub/sub state management
 */

class Store {
  constructor() {
    const safeParse = (key, fallback) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
      } catch {
        console.warn(`[Store] Corrupted localStorage for ${key}, resetting`);
        try { localStorage.removeItem(key); } catch {}
        return fallback;
      }
    };
    const safeInt = (key, fallback) => {
      try {
        const v = parseInt(localStorage.getItem(key) || String(fallback), 10);
        return isNaN(v) ? fallback : v;
      } catch { return fallback; }
    };
    const safeFloat = (key, fallback) => {
      try {
        const v = parseFloat(localStorage.getItem(key) || String(fallback));
        return isNaN(v) ? fallback : v;
      } catch { return fallback; }
    };

    this.state = {
      // Auth
      isAuthenticated: false,
      user: null,
      token: (() => { try { return localStorage.getItem('vault_token') || null; } catch { return null; } })(),
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
      queue: safeParse('vault_queue', []),
      queueIndex: safeInt('vault_queue_index', -1),
      isPlaying: false,
      volume: safeFloat('vault_volume', 0.8),
      isMuted: false,
      shuffle: localStorage.getItem('vault_shuffle') === 'true',
      repeat: localStorage.getItem('vault_repeat') || 'off',
      crossfade: safeInt('vault_crossfade', 0),
      playbackRate: 1,

      // Video
      currentVideo: null,
      videoProgress: {},

      // UI
      theme: localStorage.getItem('vault_theme') || 'dark',
      glassIntensity: safeInt('vault_glass', 20),
      grainIntensity: safeInt('vault_grain', 15),
      sidebarCollapsed: localStorage.getItem('vault_sidebar_collapsed') === 'true',
      theatreMode: false,

      // Playlists
      playlists: [],
      favourites: safeParse('vault_favourites', []),
      history: safeParse('vault_history', []),

      // EQ
      eqEnabled: localStorage.getItem('vault_eq_enabled') === 'true',
      eqPreset: localStorage.getItem('vault_eq_preset') || 'flat',
      eqGains: safeParse('vault_eq_gains', [0,0,0,0,0,0,0,0,0,0]),
      eqCustomPresets: safeParse('vault_eq_custom', {}),

      // Search
      recentSearches: safeParse('vault_recent_searches', []),
      searchHistory: safeParse('vault_search_history', []),

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

  // Library helpers — optimized with memoization
  setLibrary(library) {
    // Pre-compute searchable haystack for faster filtering
    const optimized = library.map(item => ({
      ...item,
      _haystack: [
        item.title, item.artist, item.album, item.genre,
        item.year?.toString(), item.description, item.filename,
        item.tags?.join(' ')
      ].filter(Boolean).join(' ').toLowerCase(),
      _sortCache: {}
    }));
    this.set('library', optimized);
    this._lastFilterHash = null;
    this.applyFilters();
  }

  _getFilterHash() {
    const { type, genre, year, sort, order } = this.state.filters;
    return `${type}|${genre}|${year}|${sort}|${order}|${this.state.searchQuery}|${this.state.library.length}`;
  }

  applyFilters(force = false) {
    const currentHash = this._getFilterHash();
    if (!force && this._lastFilterHash === currentHash && this.state.filteredLibrary.length > 0) {
      return; // memoized, no change
    }
    this._lastFilterHash = currentHash;

    let filtered = this.state.library;
    const { type, genre, year, sort, order } = this.state.filters;
    const query = this.state.searchQuery;

    // Fast path: no filters
    if ((!type || type === 'all') && !genre && !year && !query) {
      filtered = [...filtered];
    } else {
      filtered = filtered.filter(item => {
        if (type && type !== 'all' && item.type !== type) return false;
        if (genre) {
          if (!item.genre) return false;
          if (Array.isArray(item.genre)) { if (!item.genre.includes(genre)) return false; }
          else if (item.genre !== genre) return false;
        }
        if (year && item.year !== parseInt(year, 10)) return false;
        if (query) {
          const q = query.toLowerCase();
          // Use precomputed haystack
          if (item._haystack) {
            if (!item._haystack.includes(q)) return false;
          } else {
            const haystack = [
              item.title, item.artist, item.album, item.genre,
              item.year?.toString(), item.description, item.filename,
              item.tags?.join(' ')
            ].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q)) return false;
          }
        }
        return true;
      });
    }

    // Optimized sort with caching
    const sortField = sort || 'addedAt';
    filtered.sort((a, b) => {
      let aVal = a._sortCache?.[sortField];
      let bVal = b._sortCache?.[sortField];
      if (aVal === undefined) {
        aVal = a[sortField] ?? '';
        if (typeof aVal === 'string') aVal = aVal.toLowerCase();
        if (a._sortCache) a._sortCache[sortField] = aVal;
      }
      if (bVal === undefined) {
        bVal = b[sortField] ?? '';
        if (typeof bVal === 'string') bVal = bVal.toLowerCase();
        if (b._sortCache) b._sortCache[sortField] = bVal;
      }
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
