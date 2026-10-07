/**
 * API client — optimized with caching, abort, token memoization, retries
 */
import { getApiBaseUrl } from './config.js';
import { store } from './store.js';

class ApiClient {
  constructor() {
    this._tokenCache = null;
    this._tokenCacheTime = 0;
    this._cache = new Map(); // simple GET cache
    this._cacheTTL = 30 * 1000; // 30s for stats/genres
    this._abortControllers = new Map();
  }

  // Always read the live base URL. Previously this was captured once in the
  // constructor, so changing the server URL (onboarding / settings / login
  // screen) kept hitting the stale URL until a full page reload.
  get baseUrl() {
    return getApiBaseUrl();
  }

  // NOTE: `baseUrl` is a getter — do not assign to `api.baseUrl` anywhere.

  getToken() {
    // Memoize token for 1s to avoid repeated localStorage reads
    const now = Date.now();
    if (this._tokenCache && now - this._tokenCacheTime < 1000) return this._tokenCache;
    const token = store.get('token') || localStorage.getItem('vault_token');
    this._tokenCache = token;
    this._tokenCacheTime = now;
    return token;
  }

  clearTokenCache() {
    this._tokenCache = null;
    this._tokenCacheTime = 0;
  }

  getHeaders(includeAuth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (includeAuth) {
      const token = this.getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  _getCacheKey(path) {
    return `${this.baseUrl}${path}`;
  }

  _getCached(path) {
    const key = this._getCacheKey(path);
    const entry = this._cache.get(key);
    if (entry && Date.now() - entry.time < this._cacheTTL) return entry.data;
    this._cache.delete(key);
    return null;
  }

  _setCached(path, data) {
    const key = this._getCacheKey(path);
    this._cache.set(key, { data, time: Date.now() });
    // LRU: keep max 50 entries
    if (this._cache.size > 50) {
      const firstKey = this._cache.keys().next().value;
      this._cache.delete(firstKey);
    }
  }

  clearCache() {
    this._cache.clear();
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const isFormData = options.body instanceof FormData;
    const isGet = !options.method || options.method === 'GET';
    const useCache = isGet && options.cache !== false && (path.includes('/stats') || path.includes('/genres') || path.includes('/settings'));

    if (useCache) {
      const cached = this._getCached(path);
      if (cached) return cached;
    }

    const headers = {
      ...this.getHeaders(options.auth !== false),
      ...(options.headers || {}),
    };
    if (isFormData) delete headers['Content-Type'];

    // Abort previous same-path request to avoid race
    if (isGet && this._abortControllers.has(path)) {
      try { this._abortControllers.get(path).abort(); } catch {}
    }
    const controller = new AbortController();
    if (isGet) this._abortControllers.set(path, controller);

    const fetchOptions = {
      ...options,
      headers,
      signal: options.signal || controller.signal,
      // Accept plain objects for `body` (the v3 methods pass objects) while
      // keeping FormData and pre-stringified bodies untouched.
      body: isFormData || options.body === undefined || typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body),
    };

    // Retry logic for transient failures
    const maxRetries = options.retry === false ? 0 : (options.retries ?? 1);
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, fetchOptions);

        if (isGet) this._abortControllers.delete(path);

        if (res.status === 401) {
          const data = await res.json().catch(() => ({}));
          if (data.code !== 'GRID_REQUIRED') {
            this.clearTokenCache();
            store.clearAuth();
            window.dispatchEvent(new CustomEvent('vault:auth-required'));
          }
          const err = new Error(data.error || 'Unauthorized');
          err.status = 401;
          err.code = data.code || 'UNAUTHORIZED';
          throw err;
        }

        const contentType = res.headers.get('content-type');
        if (contentType && (contentType.includes('video/') || contentType.includes('audio/') || contentType.includes('image/') || contentType.includes('text/vtt'))) {
          return res;
        }

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const err = new Error(data.error || `Request failed: ${res.status}`);
          err.status = res.status;
          err.code = data.code || 'REQUEST_FAILED';
          throw err;
        }

        if (useCache) this._setCached(path, data);
        if (isGet && res.ok) store.set('serverConnected', true);

        return data;
      } catch (err) {
        lastErr = err;
        if (err.name === 'AbortError') throw err;
        if (attempt < maxRetries && (err.message === 'Failed to fetch' || err.message.includes('Network'))) {
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        break;
      }
    }

    if (isGet) this._abortControllers.delete(path);

    if (lastErr) {
      if (lastErr.message === 'Failed to fetch' || lastErr.name === 'TypeError') {
        store.set('serverConnected', false);
        throw new Error('Cannot connect to Vault server. Check if server is running and API URL is correct in settings.');
      }
      throw lastErr;
    }
  }

  // Auth
  login(username, password) {
    return this.request('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ username, password }),
    });
  }

  gridChallenge(challengeToken, pattern) {
    return this.request('/api/auth/grid', {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ challengeToken, pattern }),
    });
  }

  logout() {
    return this.request('/api/auth/logout', { method: 'POST' }).catch(() => {});
  }

  verify() {
    return this.request('/api/auth/verify');
  }

  // Library
  /**
   * Fetch library items.
   *
   * - With an explicit `page`, behaves exactly like the server API (single
   *   page response).
   * - Without `page`, fetches EVERY page (the server caps each response at
   *   `limit`) and returns the combined result — callers keep the old
   *   `limit: 1000` contract but libraries larger than that are no longer
   *   silently truncated (F-11).
   */
  async getLibrary(params = {}) {
    const { page, limit = 50, ...rest } = params;
    const buildQuery = (p) => {
      const q = new URLSearchParams({ ...rest, limit: String(limit) });
      if (p) q.set('page', String(p));
      return q.toString();
    };

    if (page !== undefined) {
      return this.request(`/api/library?${buildQuery(page)}`);
    }

    const first = await this.request(`/api/library?${buildQuery(1)}`);
    const totalPages = first.totalPages || 1;
    if (totalPages <= 1) return first;

    const restPages = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        this.request(`/api/library?${buildQuery(i + 2)}`)
      )
    );
    const items = [first.items || []].concat(restPages.map(r => r.items || [])).flat();
    return { ...first, items, total: items.length, page: 1, totalPages: 1 };
  }

  getItem(id) {
    return this.request(`/api/library/${id}`);
  }

  updateItem(id, updates) {
    return this.request(`/api/library/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  deleteItem(id, deleteFile = false) {
    return this.request(`/api/library/${id}?deleteFile=${deleteFile}`, {
      method: 'DELETE',
    });
  }

  getStats() {
    return this.request('/api/library/stats');
  }

  getGenres() {
    return this.request('/api/library/genres');
  }

  search(query, type = 'all') {
    return this.request(`/api/library/search?q=${encodeURIComponent(query)}&type=${type}`);
  }

  triggerScan() {
    return this.request('/api/library/scan', { method: 'POST' });
  }

  // Media
  getStreamUrl(id) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/media/stream/${id}?token=${encodeURIComponent(token || '')}`;
  }

  getCoverUrl(id) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/media/cover/${id}?token=${encodeURIComponent(token || '')}`;
  }

  getThumbnailUrl(id, time = null) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    const timeParam = time ? `&time=${time}` : '';
    return `${this.baseUrl}/api/media/thumbnail/${id}?token=${encodeURIComponent(token || '')}${timeParam}`;
  }

  getTranscodeUrl(id, quality = '720p') {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/transcode/${id}?quality=${quality}&token=${encodeURIComponent(token || '')}`;
  }

  getAudioTranscodeUrl(id, codec = 'aac') {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/transcode/audio/${id}?codec=${codec}&token=${encodeURIComponent(token || '')}`;
  }

  _extOf(item) {
    const name = (item?.filename || item?.path || '').toLowerCase();
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx) : '';
  }

  needsTranscode(item) {
    if (!item) return false;
    const ext = this._extOf(item);
    if (item.type === 'music') {
      return !['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac', '.webm'].includes(ext);
    }
    const directExt = ['.mp4', '.webm', '.m4v', '.ogv'];
    if (!directExt.includes(ext)) return true;
    const codec = String(item.videoCodec || '').toLowerCase();
    if (codec && !['h264', 'avc', 'avc1', 'vp8', 'vp9', 'av1', 'unknown', ''].includes(codec)) return true;
    return false;
  }

  getPlaybackUrl(item, { forceTranscode = false } = {}) {
    if (!item) return '';
    if (forceTranscode || this.needsTranscode(item)) {
      if (item.type === 'music') return this.getAudioTranscodeUrl(item.id);
      return this.getTranscodeUrl(item.id);
    }
    return this.getStreamUrl(item.id);
  }

  // Hosts browsers NEVER treat as mixed content. Per the Secure Contexts spec
  // (https://w3c.github.io/webappsec-secure-contexts/#potentially-trustworthy-origin)
  // Chrome, Edge and Firefox allow an HTTPS page to load http://localhost,
  // http://127.0.0.1, http://[::1] and http://*.localhost without blocking.
  // (Safari is the exception and may still block — playback will simply fail
  // with a media error there, which the players surface.)
  _isLoopbackHost(hostname) {
    if (!hostname) return false;
    const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
    return (
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h === '127.0.0.1' ||
      h.startsWith('127.') || // whole 127.0.0.0/8 loopback range
      h === '::1' ||
      h === '::ffff:127.0.0.1'
    );
  }

  // True ONLY when the browser will actually block the URL, i.e. the page is
  // HTTPS and the target is plain HTTP on a NON-loopback host (LAN IP, NAS
  // hostname, etc.). Loopback URLs are deliberately exempt — modern browsers
  // allow them, and pre-emptively blocking them here was preventing playback
  // from the GitHub Pages site with a local server on the same machine.
  isMixedContent(url) {
    if (window.location.protocol !== 'https:') return false;
    if (typeof url !== 'string' || !url.startsWith('http:')) return false;
    try {
      const host = new URL(url, window.location.href).hostname;
      return !this._isLoopbackHost(host);
    } catch {
      return true;
    }
  }

  // Human-readable explanation + fixes for a genuinely blocked URL.
  mixedContentHelp(url) {
    return [
      `Browsers block HTTP media ("${url}") on HTTPS pages like this one.`,
      'Fixes: (1) if Vault runs on this same computer, set the server URL to http://localhost:4000 — browsers allow localhost;',
      '(2) give the server HTTPS: run "npm run generate-cert" in server/, enable server.https in config.json, then use https://localhost:4000;',
      '(3) or expose it over an HTTPS tunnel: cloudflared tunnel --url http://localhost:4000',
    ].join(' ');
  }

  getSubtitleUrl(id, subtitleId) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/media/subtitle/${id}/${encodeURIComponent(subtitleId)}?token=${encodeURIComponent(token || '')}`;
  }

  getMediaInfo(id) {
    return this.request(`/api/media/info/${id}`);
  }

  // Upload
  async upload(type, files, metadata = {}, onProgress = null) {
    const formData = new FormData();
    
    if (Array.isArray(files)) {
      files.forEach(file => formData.append('files', file));
    } else {
      formData.append('file', files);
    }

    if (metadata.cover) {
      formData.append('cover', metadata.cover);
      delete metadata.cover;
    }
    if (metadata.subtitle) {
      if (Array.isArray(metadata.subtitle)) {
        metadata.subtitle.forEach(s => formData.append('subtitle', s));
      } else {
        formData.append('subtitle', metadata.subtitle);
      }
      delete metadata.subtitle;
    }

    formData.append('metadata', JSON.stringify(metadata));

    const token = store.get('token') || localStorage.getItem('vault_token');
    const url = `${this.baseUrl}/api/upload/${type}`;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
      }

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || 'Upload failed'));
        } catch {
          if (xhr.status >= 200 && xhr.status < 300) resolve({ message: 'Upload complete' });
          else reject(new Error('Upload failed'));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(formData);
    });
  }

  // Playlists
  getPlaylists() {
    return this.request('/api/playlists');
  }

  getPlaylist(id) {
    return this.request(`/api/playlists/${id}`);
  }

  createPlaylist(data) {
    return this.request('/api/playlists', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  updatePlaylist(id, data) {
    return this.request(`/api/playlists/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  deletePlaylist(id) {
    return this.request(`/api/playlists/${id}`, { method: 'DELETE' });
  }

  addToPlaylist(playlistId, itemId) {
    return this.request(`/api/playlists/${playlistId}/items`, {
      method: 'POST',
      body: JSON.stringify({ itemId }),
    });
  }

  removeFromPlaylist(playlistId, itemId) {
    return this.request(`/api/playlists/${playlistId}/items/${itemId}`, {
      method: 'DELETE',
    });
  }

  // Favourites
  getFavourites() {
    return this.request('/api/playlists/favourites');
  }

  addFavourite(id) {
    return this.request(`/api/playlists/favourites/${id}`, { method: 'POST' });
  }

  removeFavourite(id) {
    return this.request(`/api/playlists/favourites/${id}`, { method: 'DELETE' });
  }

  // History
  getHistory() {
    return this.request('/api/playlists/history');
  }

  addHistory(entry) {
    return this.request('/api/playlists/history', {
      method: 'POST',
      body: JSON.stringify(entry),
    });
  }

  clearHistory() {
    return this.request('/api/playlists/history', { method: 'DELETE' });
  }

  /** Mark an item as fully watched (fires the completed/scrobble path). */
  markCompleted(id, duration = null) {
    return this.addHistory({ itemId: id, progress: 100, completed: true, duration: duration ?? undefined });
  }

  // Settings
  getSettings() {
    return this.request('/api/settings');
  }

  updateSettings(settings) {
    return this.request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  updateCredentials(data) {
    return this.request('/api/settings/credentials', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  // Health
  health() {
    return this.request('/api/health', { auth: false });
  }

  // Setup / Onboarding
  getSetupStatus() {
    return this.request('/api/setup/status', { auth: false });
  }

  getSetupDefaults() {
    return this.request('/api/setup/defaults', { auth: false });
  }

  testSetup(data) {
    return this.request('/api/setup/test', {
      method: 'POST',
      auth: false,
      body: JSON.stringify(data),
    });
  }

  completeSetup(data) {
    return this.request('/api/setup/complete', {
      method: 'POST',
      auth: false,
      body: JSON.stringify(data),
    });
  }

  // For already-setup servers, complete with auth
  completeSetupAuthed(data) {
    return this.request('/api/setup/complete', {
      method: 'POST',
      auth: true,
      body: JSON.stringify(data),
    });
  }

  // ==========================================================================
  // v3 API surface — profiles, watchlist, collections, series, system, extras
  // ==========================================================================

  // --- Auth additions ------------------------------------------------------
  secondFactor(challengeToken, payload) {
    return this.request('/api/auth/second-factor', {
      method: 'POST',
      body: { challengeToken, ...payload },
    });
  }

  refreshToken() {
    return this.request('/api/auth/refresh', { method: 'POST' });
  }

  mediaToken() {
    return this.request('/api/auth/media-token');
  }

  getSessions() {
    return this.request('/api/auth/sessions');
  }

  revokeSession(id) {
    return this.request(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  revokeOtherSessions() {
    return this.request('/api/auth/sessions/revoke-others', { method: 'POST' });
  }

  totpStatus() {
    return this.request('/api/auth/totp');
  }

  totpSetup() {
    return this.request('/api/auth/totp/setup', { method: 'POST' });
  }

  totpEnable(code) {
    return this.request('/api/auth/totp/enable', { method: 'POST', body: { code } });
  }

  totpDisable(password) {
    return this.request('/api/auth/totp/disable', { method: 'POST', body: { password } });
  }

  totpRecoveryCodes(code) {
    return this.request('/api/auth/totp/recovery-codes', { method: 'POST', body: { code } });
  }

  createPairingCode(baseUrl) {
    return this.request('/api/auth/pair', { method: 'POST', body: { baseUrl }, auth: false });
  }

  approvePairing(data) {
    return this.request('/api/auth/pair/approve', { method: 'POST', body: data });
  }

  pairingStatus(code) {
    return this.request(`/api/auth/pair/${encodeURIComponent(code)}`, { auth: false });
  }

  // --- Profiles ------------------------------------------------------------
  getProfiles() {
    return this.request('/api/profiles');
  }

  createProfile(data) {
    return this.request('/api/profiles', { method: 'POST', body: data });
  }

  updateProfile(id, data) {
    return this.request(`/api/profiles/${id}`, { method: 'PUT', body: data });
  }

  deleteProfile(id) {
    return this.request(`/api/profiles/${id}`, { method: 'DELETE' });
  }

  switchProfile(id, pin) {
    return this.request(`/api/profiles/${id}/switch`, { method: 'POST', body: { pin } });
  }

  profileSummary(id) {
    return this.request(`/api/profiles/${id}/summary`);
  }

  // --- Watchlist -----------------------------------------------------------
  getWatchlist() {
    return this.request('/api/extras/watchlist');
  }

  addToWatchlist(id) {
    return this.request(`/api/extras/watchlist/${id}`, { method: 'POST' });
  }

  removeFromWatchlist(id) {
    return this.request(`/api/extras/watchlist/${id}`, { method: 'DELETE' });
  }

  // --- Collections ---------------------------------------------------------
  getCollections() {
    return this.request('/api/extras/collections');
  }

  createCollection(data) {
    return this.request('/api/extras/collections', { method: 'POST', body: data });
  }

  updateCollection(id, data) {
    return this.request(`/api/extras/collections/${id}`, { method: 'PUT', body: data });
  }

  deleteCollection(id) {
    return this.request(`/api/extras/collections/${id}`, { method: 'DELETE' });
  }

  addToCollection(id, itemId) {
    return this.request(`/api/extras/collections/${id}/items`, { method: 'POST', body: { itemId } });
  }

  removeFromCollection(id, itemId) {
    return this.request(`/api/extras/collections/${id}/items/${itemId}`, { method: 'DELETE' });
  }

  // --- Markers / chapters / bookmarks --------------------------------------
  getMarkers(id) {
    return this.request(`/api/extras/markers/${id}`);
  }

  setMarkers(id, data) {
    return this.request(`/api/extras/markers/${id}`, { method: 'PUT', body: data });
  }

  getChapters(id) {
    return this.request(`/api/media/chapters/${id}`);
  }

  getBookmarks(itemId) {
    return this.request(`/api/extras/bookmarks${itemId ? `?itemId=${encodeURIComponent(itemId)}` : ''}`);
  }

  addBookmark(data) {
    return this.request('/api/extras/bookmarks', { method: 'POST', body: data });
  }

  removeBookmark(id) {
    return this.request(`/api/extras/bookmarks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // --- Watched state -------------------------------------------------------
  setWatched(id, watched = true) {
    return this.request(`/api/extras/watched/${id}`, { method: 'POST', body: { watched } });
  }

  getWatched() {
    return this.request('/api/extras/watched');
  }

  // --- Stats ---------------------------------------------------------------
  getRecap(period = 'all') {
    return this.request(`/api/extras/stats/recap?period=${period}`);
  }

  recordListen(itemId, seconds) {
    return this.request('/api/extras/listens', { method: 'POST', body: { itemId, seconds } });
  }

  // --- Series --------------------------------------------------------------
  getShows() {
    return this.request('/api/series/shows');
  }

  getShow(key) {
    return this.request(`/api/series/shows/${encodeURIComponent(key)}`);
  }

  getNextUp(limit = 12) {
    return this.request(`/api/series/next-up?limit=${limit}`);
  }

  setSeriesWatched(key, { season = null, watched = true } = {}) {
    return this.request('/api/series/watched', { method: 'POST', body: { key, season, watched } });
  }

  // --- Trash ---------------------------------------------------------------
  getTrash() {
    return this.request('/api/extras/trash');
  }

  restoreFromTrash(id) {
    return this.request(`/api/extras/trash/${id}/restore`, { method: 'POST' });
  }

  purgeTrashEntry(id) {
    return this.request(`/api/extras/trash/${id}`, { method: 'DELETE' });
  }

  emptyTrash() {
    return this.request('/api/extras/trash', { method: 'DELETE' });
  }

  // --- System console ------------------------------------------------------
  getJobs() {
    return this.request('/api/system/jobs');
  }

  getLogs(limit = 200) {
    return this.request(`/api/system/logs?limit=${limit}`);
  }

  exportLogs() {
    return this.request('/api/system/logs/export', { method: 'POST' });
  }

  getDisk() {
    return this.request('/api/system/disk');
  }

  getIndexStatus() {
    return this.request('/api/system/index');
  }

  rebuildIndex() {
    return this.request('/api/system/index/rebuild', { method: 'POST' });
  }

  getLibraryHealth(deep = false) {
    return this.request(`/api/system/health${deep ? '?deep=true' : ''}`);
  }

  pruneMissing() {
    return this.request('/api/system/health/prune-missing', { method: 'POST' });
  }

  clearCaches() {
    return this.request('/api/system/cache', { method: 'DELETE' });
  }

  getBackups() {
    return this.request('/api/system/backups');
  }

  createBackup(includeMedia = false) {
    return this.request('/api/system/backups', { method: 'POST', body: { includeMedia } });
  }

  restoreBackup(file) {
    return this.request('/api/system/backups/restore', { method: 'POST', body: { file } });
  }

  deleteBackup(name) {
    return this.request(`/api/system/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
  }

  testNotifications() {
    return this.request('/api/system/notifications/test', { method: 'POST' });
  }

  getScrobbles(limit = 50) {
    return this.request(`/api/system/scrobbles?limit=${limit}`);
  }

  getAgents() {
    return this.request('/api/system/agents');
  }

  setAgent(provider, data) {
    return this.request(`/api/system/agents/${provider}`, { method: 'POST', body: data });
  }

  getCapabilities() {
    return this.request('/api/system/capabilities');
  }

  getSubsonic() {
    return this.request('/api/system/subsonic');
  }

  setSubsonicPassword(password, username) {
    return this.request('/api/system/subsonic', { method: 'PUT', body: { password, username } });
  }

  // --- Metadata agents (match / fix) ---------------------------------------
  searchMetadata(params) {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
    return this.request(`/api/agent/search?${qs}`);
  }

  applyMetadata(id, match, downloadArtwork = true) {
    return this.request(`/api/agent/apply/${id}`, { method: 'POST', body: { match, downloadArtwork } });
  }

  // --- Podcasts ------------------------------------------------------------
  getFeeds() {
    return this.request('/api/podcasts/feeds');
  }

  subscribeFeed(url, autoDownload = false) {
    return this.request('/api/podcasts/feeds', { method: 'POST', body: { url, autoDownload } });
  }

  refreshFeed(id) {
    return this.request(`/api/podcasts/feeds/${id}/refresh`, { method: 'POST' });
  }

  refreshAllFeeds() {
    return this.request('/api/podcasts/refresh', { method: 'POST' });
  }

  updateFeed(id, data) {
    return this.request(`/api/podcasts/feeds/${id}`, { method: 'PATCH', body: data });
  }

  deleteFeed(id) {
    return this.request(`/api/podcasts/feeds/${id}`, { method: 'DELETE' });
  }

  downloadEpisode(feedId, guid) {
    return this.request(`/api/podcasts/feeds/${feedId}/episodes/${encodeURIComponent(guid)}/download`, { method: 'POST' });
  }

  // --- Comics --------------------------------------------------------------
  getComic(id) {
    return this.request(`/api/comics/${id}`);
  }

  getComicPages(id) {
    return this.request(`/api/comics/${id}/pages`);
  }

  comicPageUrl(id, index) {
    const token = this.getToken();
    return `${this.baseUrl}/api/comics/${id}/page/${index}?token=${encodeURIComponent(token || '')}`;
  }

  // --- Live TV -------------------------------------------------------------
  getChannels(withEpg = false) {
    return this.request(`/api/livetv/channels${withEpg ? '?epg=true' : ''}`);
  }

  getEpg(channelIds = []) {
    const qs = channelIds.length ? `?channel=${channelIds.join(',')}` : '';
    return this.request(`/api/livetv/epg${qs}`);
  }

  getRecordings() {
    return this.request('/api/livetv/recordings');
  }

  startRecording(data) {
    return this.request('/api/livetv/recordings', { method: 'POST', body: data });
  }

  stopRecording(id) {
    return this.request(`/api/livetv/recordings/${id}/stop`, { method: 'POST' });
  }

  deleteRecording(id) {
    return this.request(`/api/livetv/recordings/${id}`, { method: 'DELETE' });
  }

  updateLiveTvSettings(data) {
    return this.request('/api/livetv/settings', { method: 'PUT', body: data });
  }

  // --- SyncPlay (watch party) ----------------------------------------------
  getRooms() {
    return this.request('/api/syncplay/rooms');
  }

  createRoom(data) {
    return this.request('/api/syncplay/rooms', { method: 'POST', body: data });
  }

  getRoom(id) {
    return this.request(`/api/syncplay/rooms/${id}`);
  }

  joinRoom(id, data) {
    return this.request(`/api/syncplay/rooms/${id}/join`, { method: 'POST', body: data });
  }

  leaveRoom(id, memberId) {
    return this.request(`/api/syncplay/rooms/${id}/leave`, { method: 'POST', body: { memberId } });
  }

  syncPlayState(id, data) {
    return this.request(`/api/syncplay/rooms/${id}/state`, { method: 'POST', body: data });
  }

  syncPlayItem(id, itemId, memberId) {
    return this.request(`/api/syncplay/rooms/${id}/item`, { method: 'POST', body: { itemId, memberId } });
  }

  syncPlayChat(id, memberId, text) {
    return this.request(`/api/syncplay/rooms/${id}/chat`, { method: 'POST', body: { memberId, text } });
  }

  // --- Library additions ---------------------------------------------------
  getLibraries() {
    return this.request('/api/library/libraries');
  }

  getRecent(since = null, limit = 20) {
    const qs = new URLSearchParams({ limit });
    if (since) qs.set('since', since);
    return this.request(`/api/library/recent?${qs}`);
  }

  startBackgroundScan() {
    return this.request('/api/library/scan/background', { method: 'POST' });
  }

  // --- Playlist additions --------------------------------------------------
  reorderPlaylist(id, payload) {
    return this.request(`/api/playlists/${id}/order`, { method: 'PUT', body: payload });
  }

  playlistStats(id) {
    return this.request(`/api/playlists/${id}/stats`);
  }

  importPlaylist(name, content) {
    return this.request('/api/playlists/import', { method: 'POST', body: { name, content } });
  }

  exportPlaylistUrl(id) {
    return `${this.baseUrl}/api/playlists/${id}/export?token=${encodeURIComponent(this.getToken() || '')}`;
  }

  // --- Media additions -----------------------------------------------------
  getSources(id) {
    return this.request(`/api/media/sources/${id}`);
  }

  getPlan(id, quality = 'auto') {
    return this.request(`/api/media/plan/${id}?quality=${encodeURIComponent(quality)}`);
  }

  getArtwork(id) {
    return this.request(`/api/media/artwork/${id}`);
  }

  getLyrics(id) {
    return this.request(`/api/media/lyrics/${id}`);
  }

  getTrickplay(id) {
    return this.request(`/api/media/trickplay/${id}`);
  }

  trailerUrl(id) {
    return `${this.baseUrl}/api/media/trailer/${id}?token=${encodeURIComponent(this.getToken() || '')}`;
  }

  extraUrl(id, index) {
    return `${this.baseUrl}/api/media/extra/${id}/${index}?token=${encodeURIComponent(this.getToken() || '')}`;
  }

  hlsMasterUrl(id) {
    return `${this.baseUrl}/api/transcode/hls/${id}/master.m3u8?token=${encodeURIComponent(this.getToken() || '')}`;
  }

  getEventsUrl() {
    return `${this.baseUrl}/api/events?token=${encodeURIComponent(this.getToken() || '')}`;
  }
}

export const api = new ApiClient();
export default api;
