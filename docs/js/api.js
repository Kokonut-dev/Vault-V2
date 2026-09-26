/**
 * API client — optimized with caching, abort, token memoization, retries
 */
import { getApiBaseUrl } from './config.js';
import { store } from './store.js';

class ApiClient {
  constructor() {
    this.baseUrl = getApiBaseUrl();
    this._tokenCache = null;
    this._tokenCacheTime = 0;
    this._cache = new Map(); // simple GET cache
    this._cacheTTL = 30 * 1000; // 30s for stats/genres
    this._abortControllers = new Map();
  }

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
          throw new Error(data.error || 'Unauthorized');
        }

        const contentType = res.headers.get('content-type');
        if (contentType && (contentType.includes('video/') || contentType.includes('audio/') || contentType.includes('image/') || contentType.includes('text/vtt'))) {
          return res;
        }

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || `Request failed: ${res.status}`);
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
  getLibrary(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/api/library?${query}`);
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

  isMixedContent(url) {
    return window.location.protocol === 'https:' && typeof url === 'string' && url.startsWith('http:');
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
}

export const api = new ApiClient();
export default api;
