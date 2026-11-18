/**
 * API client — optimized with caching, abort, token memoization, retries
 */
import { getApiBaseUrl } from './config.js';
import { store } from './store.js';

// Audio the browser plays as-is; everything else goes through the server's
// audio converter (WMA, AIFF, APE, ALAC…). Safari can't do Ogg/FLAC on old
// versions — those fall back to the converter on the first media error.
const DIRECT_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.flac', '.webm', '.weba'];
const AUDIO_EXTENSIONS = [...DIRECT_AUDIO_EXTENSIONS, '.wma', '.aiff', '.aif', '.alac', '.ape', '.wv'];

class ApiClient {
  constructor() {
    this._tokenCache = null;
    this._tokenCacheTime = 0;
    this._cache = new Map(); // simple GET cache
    this._cacheTTL = 30 * 1000; // 30s for stats/genres
    // Identical GETs are shared instead of cancelling one another. A library
    // mutation is announced over SSE before its HTTP response is received, so
    // both the live-event handler and the view can refresh `/api/library` at
    // nearly the same time. Cancelling the first request made a successful
    // album reorder surface as "The operation was aborted" in the UI.
    this._inflightGets = new Map();
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

  request(path, options = {}) {
    const isGet = !options.method || options.method === 'GET';
    const shareRequest = isGet && options.dedupe !== false && !options.signal;
    const authScope = options.auth === false ? 'public' : (this.getToken() || 'anonymous');
    const inflightKey = `${this._getCacheKey(path)}|${authScope}`;

    // Two consumers asking for the exact same resource want the same result.
    // Sharing also prevents one consumer (notably an SSE refresh) from
    // cancelling the other and turning a successful edit into an AbortError.
    if (shareRequest && this._inflightGets.has(inflightKey)) {
      const shared = this._inflightGets.get(inflightKey);
      // A Response body is single-use. JSON requests return parsed values, but
      // clone the occasional image/audio Response for a second consumer.
      return shared.then(result => (
        typeof Response !== 'undefined' && result instanceof Response
          ? result.clone()
          : result
      ));
    }

    const pending = this._performRequest(path, options);
    if (shareRequest) {
      this._inflightGets.set(inflightKey, pending);
      const clear = () => {
        if (this._inflightGets.get(inflightKey) === pending) {
          this._inflightGets.delete(inflightKey);
        }
      };
      pending.then(clear, clear);
    }
    return pending;
  }

  async _performRequest(path, options = {}) {
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

    const fetchOptions = {
      ...options,
      headers,
      // Accept plain objects for `body` (the v3 methods pass objects) while
      // keeping FormData and pre-stringified bodies untouched.
      body: isFormData || options.body === undefined || typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body),
    };
    // Client-only controls are not part of RequestInit. Most browsers ignore
    // unknown keys, but removing them keeps strict fetch implementations happy.
    delete fetchOptions.auth;
    delete fetchOptions.dedupe;
    delete fetchOptions.retries;
    delete fetchOptions.retry;
    if (fetchOptions.cache === false) delete fetchOptions.cache;

    // Retry logic for transient failures
    const maxRetries = options.retry === false ? 0 : (options.retries ?? 1);
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, fetchOptions);

        if (res.status === 401) {
          const data = await res.json().catch(() => ({}));
          // A 401 from a credential step means "that password/grid was
          // wrong" — NOT "your session died". Treating it as session
          // expiry wiped the stored challenge token and bounced the user
          // back to the password step after every wrong grid entry,
          // forcing a fresh login POST per retry and feeding the
          // server's failed-attempt counters until they hit 429.
          const isCredentialStep = path.startsWith('/api/auth/login')
            || path.startsWith('/api/auth/grid')
            || path.startsWith('/api/auth/second-factor');
          if (data.code !== 'GRID_REQUIRED' && !isCredentialStep) {
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
          // Per-field validation messages (Settings forms show them inline).
          if (data.fields && typeof data.fields === 'object') err.fields = data.fields;
          else if (data.field) err.fields = { [data.field]: data.error };
          err.path = data.path || path;
          err.endpointNotFound = data.code === 'NOT_FOUND' && typeof data.path === 'string';
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

  // Attachment download of the original file (works over remote access:
  // the token rides in the query string and the server answers with
  // Content-Disposition, so no custom headers or CORS preflight are needed
  // and the browser saves instead of playing the stream).
  getDownloadUrl(id) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/media/download/${id}?token=${encodeURIComponent(token || '')}`;
  }

  /** Trigger a browser download of an item's original file. */
  downloadItemFile(itemOrId) {
    const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.id;
    if (!id) return false;
    const link = document.createElement('a');
    link.href = this.getDownloadUrl(id);
    link.download = (typeof itemOrId === 'object' && itemOrId?.filename) || '';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  }

  /** True when the UI is being used away from the server's own origin. */
  isRemoteAccess() {
    try {
      return new URL(this.baseUrl, window.location.href).origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  getCoverUrl(id, size = null) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    const sizeParam = size ? `&size=${encodeURIComponent(size)}` : '';
    return `${this.baseUrl}/api/media/cover/${id}?token=${encodeURIComponent(token || '')}${sizeParam}`;
  }

  getBackdropUrl(id) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    return `${this.baseUrl}/api/media/cover/${id}?kind=backdrop&token=${encodeURIComponent(token || '')}`;
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

  getAudioTranscodeUrl(id, codec = 'aac', start = 0) {
    const token = store.get('token') || localStorage.getItem('vault_token');
    const startParam = start > 0 ? `&start=${Math.floor(start * 10) / 10}` : '';
    return `${this.baseUrl}/api/transcode/audio/${id}?codec=${codec}${startParam}&token=${encodeURIComponent(token || '')}`;
  }

  _extOf(item) {
    const name = (item?.filename || item?.path || '').toLowerCase();
    const idx = name.lastIndexOf('.');
    return idx >= 0 ? name.slice(idx) : '';
  }

  /** Music, podcasts and audiobooks (or anything with an audio extension). */
  isAudioItem(item) {
    if (!item) return false;
    if (['music', 'podcast', 'audiobook'].includes(item.type)) return true;
    return !item.type && AUDIO_EXTENSIONS.includes(this._extOf(item));
  }

  needsTranscode(item) {
    if (!item) return false;
    const ext = this._extOf(item);
    if (this.isAudioItem(item)) {
      // Feed episodes and other external sources have no file name; the
      // browser gets the URL as-is.
      if (item.streamUrl && !ext) return false;
      if (!DIRECT_AUDIO_EXTENSIONS.includes(ext)) return true;
      // ALAC hides inside .m4a/.m4b; only Safari decodes it.
      return /alac/i.test(String(item.codec || '')) && !this._canPlayAlac();
    }
    const directExt = ['.mp4', '.webm', '.m4v', '.ogv'];
    if (!directExt.includes(ext)) return true;
    const codec = String(item.videoCodec || '').toLowerCase();
    if (codec && !['h264', 'avc', 'avc1', 'vp8', 'vp9', 'av1', 'unknown', ''].includes(codec)) return true;
    return false;
  }

  _canPlayAlac() {
    try {
      return Boolean(document.createElement('audio').canPlayType('audio/mp4; codecs="alac"'));
    } catch {
      return false;
    }
  }

  getPlaybackUrl(item, { forceTranscode = false, startAt = 0 } = {}) {
    if (!item) return '';
    // Items can carry their own source (live TV channels, recordings, plugin
    // providers, podcast feed episodes). Those must never be rewritten to
    // /api/media/stream/<id>, which would 404 for anything not in the library.
    if (!forceTranscode && item.streamUrl && !this.needsTranscode(item)) {
      return item.streamUrl;
    }
    // Feed episodes etc. aren't library files: the server can't convert them.
    const external = !item.id || String(item.id).includes(':');
    if (item.streamUrl && external && this.isAudioItem(item)) return item.streamUrl;
    if (!item.id) return item.streamUrl || '';
    if (forceTranscode || this.needsTranscode(item)) {
      // Audio goes to the audio converter — the video transcoder (720p
      // H.264) fails on files without a picture, which broke every podcast
      // and audiobook that wasn't a plain MP3.
      if (this.isAudioItem(item)) return this.getAudioTranscodeUrl(item.id, 'aac', startAt);
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
    const includesCover = Boolean(metadata.cover);
    
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
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(Object.keys(data).length ? data : { message: 'Upload complete' });
          return;
        }

        const missingEndpoint = xhr.status === 404 && (
          data.code === 'NOT_FOUND'
          || /^not found$/i.test(data.error || '')
          || !data.error
        );
        const uploadPath = data.path || `/api/upload/${type}`;
        const message = missingEndpoint
          ? `${includesCover ? 'Media and cover upload' : 'Media upload'} endpoint was not found (${url}). Check that the Server URL points to your Vault backend; if it does, update and restart the server, then try again.`
          : (data.error || 'Upload failed');
        const error = new Error(message);
        error.status = xhr.status;
        error.code = missingEndpoint ? 'UPLOAD_UNAVAILABLE' : (data.code || 'UPLOAD_FAILED');
        error.path = uploadPath;
        reject(error);
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

  /** Mark an item fully watched/listened (drives scrobbling + "watched" state). */
  markCompleted(id, duration = null) {
    return this.request('/api/playlists/history', {
      method: 'POST',
      body: { itemId: id, progress: 100, duration, completed: true, bumpPlayCount: true },
    });
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

  pairingState(code) {
    return this.request(`/api/auth/pair/${encodeURIComponent(code)}/state`, { cache: false, dedupe: false });
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
    // The server expects `query`; callers often pass the natural `q`.
    const normalised = { ...params, query: params.query || params.q };
    const qs = new URLSearchParams(Object.entries(normalised).filter(([, v]) => v));
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

  /**
   * Start (or join) a server-side restream of a Live TV / IPTV entry.
   * Resolves to { sessionId, playlist, live, plan, source }; rejects with
   * err.code (NO_FFMPEG, AUTH, NOT_FOUND, UNREACHABLE, BLOCKED, …).
   */
  playChannel(channelId, { transcode = false } = {}) {
    return this.request(`/api/livetv/channels/${encodeURIComponent(channelId)}/play`, {
      method: 'POST', body: { transcode }, retry: false,
    });
  }

  stopChannelStream(sessionId) {
    if (!sessionId) return Promise.resolve();
    // keepalive: the request must survive the tab closing (pagehide).
    return this.request(`/api/livetv/stream/${encodeURIComponent(sessionId)}`, { method: 'DELETE', retry: false, keepalive: true }).catch(() => {});
  }

  /** Absolute, token-carrying URL for a restream playlist path from playChannel(). */
  liveStreamUrl(playlistPath) {
    return `${this.baseUrl}${playlistPath}?token=${encodeURIComponent(this.getToken() || '')}`;
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

  getLiveTvSettings() {
    return this.request('/api/livetv/settings');
  }

  updateLiveTvSettings(data) {
    return this.request('/api/livetv/settings', { method: 'PUT', body: data });
  }

  /** Dry-run a channel list / guide (omitted keys fall back to saved values). */
  testLiveTv(data = {}) {
    return this.request('/api/livetv/test', { method: 'POST', body: data });
  }

  adoptLiveTvGuide(data = {}) {
    return this.request('/api/livetv/settings/adopt-guide', { method: 'POST', body: data });
  }

  // --- Links ("paste a link") ---------------------------------------------
  inspectLink(url) {
    return this.request('/api/links/inspect', { method: 'POST', body: { url } });
  }

  importPlaylistFromUrl(url, name = '') {
    return this.request('/api/links/import-playlist', { method: 'POST', body: { url, name } });
  }

  // --- Notification targets -------------------------------------------------
  getNotificationSettings() {
    return this.request('/api/settings/notifications');
  }

  updateNotificationSettings(data) {
    return this.request('/api/settings/notifications', { method: 'PUT', body: data });
  }

  testNotifications() {
    return this.request('/api/settings/notifications/test', { method: 'POST' });
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

  // --- Album / playlist editing -------------------------------------------
  // Albums are tag-derived, so these fan out server-side to every track id.
  updateAlbumOrder(ids) {
    return this.request('/api/library/albums/order', { method: 'PUT', body: { ids } });
  }

  updateAlbumTitle(ids, album) {
    return this.request('/api/library/albums/metadata', { method: 'PUT', body: { ids, album } });
  }

  _isMissingEndpoint(err) {
    if (err?.status !== 404) return false;
    return err.endpointNotFound === true
      || /^not found$/i.test(err.message || '')
      || /^request failed:\s*404$/i.test(err.message || '');
  }

  async _uploadCover(paths, buildForm) {
    let lastError;
    for (const path of paths) {
      try {
        return await this.request(path, { method: 'POST', body: buildForm() });
      } catch (err) {
        lastError = err;
        if (!this._isMissingEndpoint(err)) throw err;
      }
    }

    // A separately hosted UI is often updated before the self-hosted server.
    // Replace the opaque reverse-proxy/Express "Not found" with the action that
    // fixes that version skew. Alias routes let current servers recover when a
    // proxy only forwards one of the route shapes.
    const attempted = paths.map(path => `${this.baseUrl}${path}`).join(', ');
    const unavailable = new Error(`Cover upload endpoints were not found (${attempted}). Check that the Server URL points to your Vault backend; if it does, update and restart the server, then try again.`);
    unavailable.status = 404;
    unavailable.code = 'COVER_UPLOAD_UNAVAILABLE';
    unavailable.path = lastError?.path || paths[paths.length - 1];
    unavailable.cause = lastError;
    throw unavailable;
  }

  uploadAlbumCover(ids, file) {
    const buildForm = () => {
      const form = new FormData();
      form.append('cover', file);
      form.append('ids', JSON.stringify(ids));
      return form;
    };
    return this._uploadCover(['/api/library/albums/cover', '/api/library/cover'], buildForm);
  }

  uploadPlaylistCover(id, file) {
    const buildForm = () => {
      const form = new FormData();
      form.append('cover', file);
      return form;
    };
    return this._uploadCover([
      `/api/playlists/${id}/cover`,
      `/api/playlists/cover/${id}`,
    ], buildForm);
  }

  removePlaylistCover(id) {
    return this.request(`/api/playlists/${id}/cover`, { method: 'DELETE' });
  }

  playlistCoverUrl(id, version = '') {
    const token = this.getToken();
    return `${this.baseUrl}/api/playlists/${id}/cover?token=${encodeURIComponent(token || '')}${version ? `&v=${encodeURIComponent(version)}` : ''}`;
  }

  // Cover URL for a library item, with an optional cache-busting version
  // (pass updatedAt after editing artwork so browsers drop the old image).
  getCoverUrlVersioned(id, version, size = null) {
    if (!id) return '';
    const url = this.getCoverUrl(id, size);
    return version ? `${url}&v=${encodeURIComponent(version)}` : url;
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

  // --- Sign another device in (QR carries a single-use, pre-approved link)
  createSignInLink(baseUrl, deviceLabel) {
    return this.request('/api/auth/pair', { method: 'POST', body: { baseUrl, deviceLabel }, retry: false });
  }

  exchangePairingToken(token) {
    return this.request('/api/auth/pair/exchange', { method: 'POST', body: { token }, auth: false, retry: false });
  }

  // --- Server control (/api/server) -------------------------------------
  serverInfo() {
    return this.request('/api/server', { cache: false });
  }

  restartServer() {
    return this.request('/api/server/restart', { method: 'POST', retry: false });
  }

  stopServer() {
    return this.request('/api/server/stop', { method: 'POST', retry: false });
  }

  setAutostart(enabled, startServer) {
    return this.request('/api/server/autostart', { method: 'PUT', body: { enabled, startServer } });
  }

  setLanAccess(lan) {
    return this.request('/api/server/network', { method: 'PUT', body: { lan } });
  }

  setKeepAwake(enabled) {
    return this.request('/api/server/keep-awake', { method: 'PUT', body: { enabled } });
  }

  // --- Move to another server (/api/transfer) ---------------------------
  transferStatus() {
    return this.request('/api/transfer', { cache: false, dedupe: false, retry: false });
  }

  transferSummary(media = true) {
    return this.request(`/api/transfer/summary?media=${media ? 1 : 0}`, { cache: false, retry: false });
  }

  /** A short-lived link to the .zip — absolute, so it can be opened on another device. */
  async createTransferLink(media = true) {
    const res = await this.request('/api/transfer/export-link', { method: 'POST', body: { media }, retry: false });
    return { ...res, url: `${this.baseUrl}${res.url}` };
  }

  exportTransferToFolder(dir, media = true) {
    return this.request('/api/transfer/export-folder', { method: 'POST', body: { dir, media }, retry: false });
  }

  inspectTransfer(source) {
    return this.request('/api/transfer/inspect', { method: 'POST', body: { source }, retry: false });
  }

  importTransfer({ source, mediaDir, copyMedia = true }) {
    return this.request('/api/transfer/import', { method: 'POST', body: { source, mediaDir, copyMedia }, retry: false });
  }

  cancelTransfer() {
    return this.request('/api/transfer/cancel', { method: 'POST', body: {}, retry: false });
  }

  /**
   * Upload a transfer .zip (streamed, with progress). Returns a promise with
   * an extra `abort()`.
   */
  uploadTransfer(file, mediaDir, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('POST', `${this.baseUrl}/api/transfer/import/upload?mediaDir=${encodeURIComponent(mediaDir || '')}`);
      const token = this.getToken();
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
        const err = new Error(body.error || `Upload failed (${xhr.status})`);
        err.status = xhr.status;
        err.code = body.code || 'UPLOAD_FAILED';
        if (body.field) err.fields = { [body.field]: body.error };
        reject(err);
      };
      xhr.onerror = () => reject(new Error('The upload was interrupted — check the connection and try again'));
      xhr.onabort = () => reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
      xhr.send(file);
    });
    promise.abort = () => xhr.abort();
    return promise;
  }

  // --- Remote access (/api/remote) --------------------------------------
  remoteStatus() {
    return this.request('/api/remote', { cache: false, dedupe: false });
  }

  startTunnel() {
    return this.request('/api/remote/tunnel', { method: 'POST', body: {}, retry: false });
  }

  stopTunnel() {
    return this.request('/api/remote/tunnel', { method: 'DELETE', retry: false });
  }

  setRemoteSettings(settings) {
    return this.request('/api/remote/settings', { method: 'PUT', body: settings });
  }

  // --- Google Drive import (/api/import) --------------------------------
  driveConfig() {
    return this.request('/api/import/gdrive/config', { cache: false });
  }

  saveDriveConfig(data) {
    return this.request('/api/import/gdrive/config', { method: 'PUT', body: data });
  }

  inspectDrive(link, accessToken) {
    return this.request('/api/import/gdrive/inspect', { method: 'POST', body: { link, accessToken }, retry: false });
  }

  importFromDrive({ link, files, selection, destination, accessToken }) {
    return this.request('/api/import/gdrive', { method: 'POST', body: { link, files, selection, destination, accessToken }, retry: false });
  }

  browseDrive({ folder = 'root', q = '' } = {}, accessToken) {
    const qs = new URLSearchParams({ folder, q });
    return this.request(`/api/import/gdrive/browse?${qs}`, { headers: accessToken ? { 'X-Google-Token': accessToken } : {}, dedupe: false });
  }

  importJobs() {
    return this.request('/api/import/jobs', { cache: false, dedupe: false });
  }

  cancelImport(id) {
    return this.request(`/api/import/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
export default api;
