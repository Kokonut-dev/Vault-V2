/**
 * API client — handles auth, errors, retries
 */
import { getApiBaseUrl } from './config.js';
import { store } from './store.js';

class ApiClient {
  constructor() {
    this.baseUrl = getApiBaseUrl();
  }

  getHeaders(includeAuth = true) {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (includeAuth) {
      const token = store.get('token') || localStorage.getItem('vault_token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  async request(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const isFormData = options.body instanceof FormData;

    const headers = {
      ...this.getHeaders(options.auth !== false),
      ...(options.headers || {}),
    };

    if (isFormData) delete headers['Content-Type'];

    try {
      const res = await fetch(url, {
        ...options,
        headers,
      });

      // Handle 401 — redirect to login
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        if (data.code !== 'GRID_REQUIRED') {
          store.clearAuth();
          window.dispatchEvent(new CustomEvent('vault:auth-required'));
        }
        throw new Error(data.error || 'Unauthorized');
      }

      // Handle non-JSON (media streams)
      const contentType = res.headers.get('content-type');
      if (contentType && (contentType.includes('video/') || contentType.includes('audio/') || contentType.includes('image/') || contentType.includes('text/vtt'))) {
        return res;
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || `Request failed: ${res.status}`);
      }

      return data;
    } catch (err) {
      if (err.message === 'Failed to fetch') {
        store.set('serverConnected', false);
        throw new Error('Cannot connect to Vault server. Check if server is running and API URL is correct in settings.');
      }
      throw err;
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
    return `${this.baseUrl}/api/media/transcode/${id}?quality=${quality}&token=${encodeURIComponent(token || '')}`;
  }

  getAudioTranscodeUrl(id, codec = 'aac') {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/media/transcode/audio/${id}?codec=${codec}&token=${encodeURIComponent(token || '')}`;
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
