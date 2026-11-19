/**
 * Google Drive import.
 *
 * Three ways in, from zero setup to full access:
 *
 *  1. Share link (no setup): paste a "Anyone with the link" file or folder
 *     link. Files come from drive.usercontent.google.com (including the
 *     "can't scan for viruses" confirmation large files need); folders are
 *     read from Drive's public embedded folder view.
 *  2. API key (optional, config.integrations.googleDrive.apiKey): public
 *     links go through the Drive v3 API instead — sizes up front, big
 *     folders, no HTML parsing.
 *  3. Google account (optional OAuth client ID): the browser gets a
 *     short-lived read-only token via Google Identity Services and passes it
 *     with each request, so private files and "My Drive" browsing work. The
 *     token is held in memory for the length of an import, never saved.
 *
 * Every request goes only to Google hosts and every redirect is re-checked.
 * Downloads land next to their final name as dotfiles (the library watcher
 * ignores those), are size-capped, then renamed and indexed.
 */
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getConfig } = require('../config');
const events = require('./events');
const logger = require('../utils/logger');

// Overridable for tests (pointing at a local fake Google).
const endpoints = {
  web: 'https://drive.google.com',
  usercontent: 'https://drive.usercontent.google.com',
  api: 'https://www.googleapis.com',
  extraHosts: [],
};
const GOOGLE_HOST = /(^|\.)(google\.com|googleusercontent\.com|googleapis\.com)$/i;
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

class DriveError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/** Turn any Drive share link into { kind, id, resourceKey }. */
function parseDriveLink(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new DriveError('Paste a Google Drive link', 'INVALID_LINK');
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new DriveError('That doesn’t look like a Google Drive link', 'INVALID_LINK');
  }
  const host = url.hostname.toLowerCase();
  const resourceKey = url.searchParams.get('resourcekey') || null;
  const p = url.pathname;

  if (host === 'docs.google.com') {
    const kind = (p.match(/^\/(document|spreadsheets|presentation|forms|drawings)\//) || [])[1];
    if (kind) throw new DriveError('That’s a Google Docs/Sheets/Slides file, not a media file — only regular files (video, music, books…) can be imported', 'NOT_MEDIA');
    const fileId = (p.match(/\/file\/d\/([A-Za-z0-9_-]+)/) || [])[1];
    if (fileId) return { kind: 'file', id: fileId, resourceKey };
  }
  if (host !== 'drive.google.com' && host !== 'drive.usercontent.google.com' && !endpoints.extraHosts.includes(url.host)) {
    throw new DriveError('Only drive.google.com links can be imported here', 'INVALID_LINK');
  }
  let m = p.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (m) return { kind: 'folder', id: m[1], resourceKey };
  m = p.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
  if (m) return { kind: 'file', id: m[1], resourceKey };
  const id = url.searchParams.get('id');
  if (id && ID_RE.test(id)) {
    return { kind: /folderview|embeddedfolderview/.test(p) ? 'folder' : 'file', id, resourceKey };
  }
  throw new DriveError('Couldn’t find a file or folder in that link — use Share → Copy link in Google Drive', 'INVALID_LINK');
}

// ---------------------------------------------------------------------------
// HTTP (Google hosts only)
// ---------------------------------------------------------------------------
function hostAllowed(url) {
  if (endpoints.extraHosts.includes(url.host)) return true;
  return url.protocol === 'https:' && GOOGLE_HOST.test(url.hostname);
}

function isSignInRedirect(url) {
  return /(^|\.)accounts\.google\.com$/i.test(url.hostname) || /ServiceLogin|\/signin\//i.test(url.pathname);
}

/**
 * GET a Google URL, following redirects. Resolves the response stream.
 * @param {string} input
 * @param {{ headers?: object, signal?: AbortSignal, timeoutMs?: number }} opts
 */
function googleGet(input, { headers = {}, signal, timeoutMs = 30000, hops = 8 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(input); } catch { return reject(new DriveError('Bad Google URL', 'INVALID_LINK')); }
    if (isSignInRedirect(url)) return reject(new DriveError('This item isn’t shared publicly — set it to “Anyone with the link”, or connect your Google account', 'NOT_PUBLIC', 403));
    if (!hostAllowed(url)) return reject(new DriveError(`Refusing to contact ${url.hostname}`, 'BLOCKED_HOST', 400));
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Vault media server; Google Drive import)', Accept: '*/*', ...headers },
      timeout: timeoutMs,
      signal,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops <= 0) return reject(new DriveError('Google redirected too many times', 'TOO_MANY_REDIRECTS', 502));
        // Like browsers: the OAuth token only goes back to the same host
        // (download redirects already carry their own signed URL).
        const next = new URL(res.headers.location, url);
        const nextHeaders = next.host === url.host ? headers
          : Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'authorization'));
        resolve(googleGet(next.toString(), { headers: nextHeaders, signal, timeoutMs, hops: hops - 1 }));
        return;
      }
      res.socket?.setTimeout?.(0);
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new DriveError('Google took too long to answer', 'TIMEOUT', 504)));
    req.on('error', (err) => reject(err instanceof DriveError ? err
      : err.name === 'AbortError' ? new DriveError('Cancelled', 'CANCELLED', 499)
        : new DriveError(`Couldn’t reach Google Drive: ${err.message}`, 'NETWORK', 502)));
  });
}

async function readBody(res, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res) {
    size += chunk.length;
    if (size > limit) { res.destroy(); throw new DriveError('Google sent an unexpectedly large page', 'TOO_LARGE', 502); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function decodeHtml(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function filenameFromDisposition(header) {
  const value = String(header || '');
  const star = value.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  const plain = value.match(/filename\s*=\s*"([^"]+)"/) || value.match(/filename\s*=\s*([^;]+)/);
  return plain ? plain[1].trim() : null;
}

/** "1.2G" / "530M" from the virus-scan page → bytes (approximate). */
function parseApproxSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*([KMGT])B?/i);
  if (!m) return null;
  const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2].toUpperCase()];
  return Math.round(Number(m[1]) * mult);
}

/** Interpret an HTML page Google sent instead of a file. */
function classifyHtml(html) {
  const form = html.match(/<form[^>]*id=["']download-form["'][^>]*>([\s\S]*?)<\/form>/i);
  if (form) {
    const action = decodeHtml((form[0].match(/action=["']([^"']+)["']/i) || [])[1] || '');
    const params = new URLSearchParams();
    for (const input of form[1].matchAll(/<input[^>]*>/gi)) {
      const name = (input[0].match(/name=["']([^"']+)["']/i) || [])[1];
      const value = (input[0].match(/value=["']([^"']*)["']/i) || [])[1] || '';
      if (name) params.set(name, decodeHtml(value));
    }
    const nameSize = html.match(/class=["']uc-name-size["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>\s*\(([^)]+)\)/i);
    return {
      kind: 'confirm',
      action,
      params,
      name: nameSize ? decodeHtml(nameSize[1]).trim() : null,
      size: nameSize ? parseApproxSize(nameSize[2]) : null,
    };
  }
  if (/quota (has been )?exceeded|too many users have viewed or downloaded/i.test(html)) {
    return { kind: 'error', error: new DriveError('Google says this file was downloaded too many times recently — try again in 24 hours, or connect your Google account', 'QUOTA_EXCEEDED', 429) };
  }
  if (/accounts\.google\.com|ServiceLogin|you need (access|permission)|request access|sign in/i.test(html)) {
    return { kind: 'error', error: new DriveError('This item isn’t shared publicly — set it to “Anyone with the link”, or connect your Google account', 'NOT_PUBLIC', 403) };
  }
  if (/not found|does not exist|404/i.test(html)) {
    return { kind: 'error', error: new DriveError('Google Drive couldn’t find that file — the link may be wrong or the file was deleted', 'NOT_FOUND', 404) };
  }
  return { kind: 'error', error: new DriveError('Google Drive sent a web page instead of the file', 'UNEXPECTED_RESPONSE', 502) };
}

// ---------------------------------------------------------------------------
// Access modes
// ---------------------------------------------------------------------------
function driveConfig() {
  return getConfig().integrations?.googleDrive || {};
}

function apiAuth({ accessToken } = {}) {
  if (accessToken) return { headers: { Authorization: `Bearer ${accessToken}` }, query: '' , mode: 'account' };
  const key = driveConfig().apiKey;
  if (key) return { headers: {}, query: `&key=${encodeURIComponent(key)}`, mode: 'apiKey' };
  return null;
}

function resourceKeyHeader(id, resourceKey) {
  return resourceKey ? { 'X-Goog-Drive-Resource-Keys': `${id}/${resourceKey}` } : {};
}

async function apiJson(pathAndQuery, auth, extraHeaders = {}) {
  const res = await googleGet(`${endpoints.api}/drive/v3/${pathAndQuery}${auth.query}`, { headers: { ...auth.headers, ...extraHeaders, Accept: 'application/json' } });
  const text = await readBody(res);
  let body = {};
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (res.statusCode >= 400) {
    const reason = body?.error?.errors?.[0]?.reason || '';
    const message = body?.error?.message || `Google answered ${res.statusCode}`;
    if (res.statusCode === 401) throw new DriveError('Your Google sign-in expired — connect your Google account again', 'TOKEN_EXPIRED', 400);
    if (res.statusCode === 404) throw new DriveError(auth.mode === 'account' ? 'That file isn’t in your Drive or wasn’t shared with you' : 'This item isn’t shared publicly — set it to “Anyone with the link”, or connect your Google account', auth.mode === 'account' ? 'NOT_FOUND' : 'NOT_PUBLIC', 404);
    if (/rateLimit|userRateLimit|quota/i.test(reason)) throw new DriveError('Google Drive is rate-limiting requests — wait a minute and try again', 'RATE_LIMITED', 429);
    if (res.statusCode === 403 && /keyInvalid|API key|accessNotConfigured/i.test(`${reason} ${message}`)) throw new DriveError('The Google API key was rejected — check it in Settings → Links & imports (the Drive API must be enabled)', 'BAD_API_KEY', 400);
    throw new DriveError(message, 'GOOGLE_ERROR', res.statusCode);
  }
  return body;
}

const API_FIELDS = 'id,name,mimeType,size,resourceKey,shortcutDetails(targetId,targetMimeType,targetResourceKey)';

function fromApi(f) {
  if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails) {
    return { id: f.shortcutDetails.targetId, name: f.name, mimeType: f.shortcutDetails.targetMimeType, size: null, resourceKey: f.shortcutDetails.targetResourceKey || null };
  }
  return { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size != null ? Number(f.size) : null, resourceKey: f.resourceKey || null };
}

async function apiList(folderId, auth, resourceKey) {
  const out = [];
  let pageToken = '';
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    // eslint-disable-next-line no-await-in-loop
    const body = await apiJson(`files?q=${q}&fields=${encodeURIComponent(`nextPageToken,files(${API_FIELDS})`)}&pageSize=1000&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, auth, resourceKeyHeader(folderId, resourceKey));
    out.push(...(body.files || []).map(fromApi));
    pageToken = body.nextPageToken || '';
  } while (pageToken && out.length < 5000);
  return out;
}

/** Public folder without an API key: Drive's embeddable folder page. */
async function webList(folderId, resourceKey) {
  const res = await googleGet(`${endpoints.web}/embeddedfolderview?id=${encodeURIComponent(folderId)}${resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : ''}`);
  const html = await readBody(res);
  if (res.statusCode >= 400 || !/flip-entry|flip-entries/i.test(html)) {
    const verdict = classifyHtml(html);
    if (res.statusCode === 404 || verdict.error?.code === 'NOT_PUBLIC' || res.statusCode === 401 || res.statusCode === 403) {
      throw new DriveError('This folder isn’t shared publicly — set it to “Anyone with the link”, or connect your Google account', 'NOT_PUBLIC', 403);
    }
    throw verdict.error;
  }
  const title = decodeHtml((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim() || null;
  const items = [];
  for (const block of html.split(/<div[^>]+class=["']flip-entry["']/i).slice(1)) {
    const id = (block.match(/id=["']entry-([A-Za-z0-9_-]+)["']/) || [])[1];
    const href = decodeHtml((block.match(/href=["']([^"']+)["']/) || [])[1] || '');
    const name = decodeHtml((block.match(/class=["']flip-entry-title["'][^>]*>([^<]*)</) || [])[1] || '').trim();
    if (!id || !name) continue;
    const isFolder = /\/folders\//.test(href);
    const rk = (href.match(/[?&]resourcekey=([^&]+)/) || [])[1] || null;
    items.push({ id, name, mimeType: isFolder ? FOLDER_MIME : null, size: null, resourceKey: rk });
  }
  return { title, items };
}

/** Name + size of a single public file without downloading it. */
async function webFileInfo(id, resourceKey) {
  const controller = new AbortController();
  const res = await googleGet(downloadUrl(id, resourceKey), { signal: controller.signal });
  try {
    if (res.statusCode >= 400) {
      const html = await readBody(res).catch(() => '');
      throw (classifyHtml(html).error || new DriveError(`Google answered ${res.statusCode}`, 'GOOGLE_ERROR', res.statusCode));
    }
    if (/text\/html/i.test(res.headers['content-type'] || '')) {
      const verdict = classifyHtml(await readBody(res));
      if (verdict.kind === 'confirm') return { id, name: verdict.name, size: verdict.size, mimeType: null, resourceKey };
      throw verdict.error;
    }
    const name = filenameFromDisposition(res.headers['content-disposition']);
    const size = Number(res.headers['content-length'] || 0) || null;
    return { id, name, size, mimeType: res.headers['content-type'] || null, resourceKey };
  } finally {
    controller.abort();
    res.destroy();
  }
}

function downloadUrl(id, resourceKey) {
  return `${endpoints.usercontent}/download?id=${encodeURIComponent(id)}&export=download&confirm=t${resourceKey ? `&resourcekey=${encodeURIComponent(resourceKey)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Classification + destinations
// ---------------------------------------------------------------------------
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const COMIC_EXT = ['.cbz', '.cbr', '.pdf', '.epub'];

function fileKind(name, mimeType) {
  if (mimeType && mimeType.startsWith('application/vnd.google-apps.')) return 'google-doc';
  const ext = path.extname(name || '').toLowerCase();
  const exts = getConfig().media.supportedExtensions;
  if (exts.video.includes(ext)) return 'video';
  if (ext === '.m4b') return 'audiobook';
  if (exts.audio.includes(ext)) return 'audio';
  if (exts.subtitle.includes(ext)) return 'subtitle';
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (COMIC_EXT.includes(ext)) return 'comic';
  if (!ext && mimeType) {
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
  }
  return 'other';
}

const DESTINATIONS = ['auto', 'movies', 'music', 'videos', 'audiobooks', 'podcasts', 'comics'];
const KIND_TO_LIBRARY = { video: 'movies', audio: 'music', audiobook: 'audiobooks', comic: 'comics' };

/** Where "auto" sends everything: the library most of the media belongs to. */
function majorityLibrary(items) {
  const counts = {};
  for (const item of items) {
    const lib = KIND_TO_LIBRARY[item.kind];
    if (lib) counts[lib] = (counts[lib] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'movies';
}

function libraryFor(item, destination, majority) {
  if (destination && destination !== 'auto') return destination;
  // Audiobook chapters as .mp3 inside a folder of .m4b stay together.
  if (majority === 'audiobooks' && (item.kind === 'audio' || item.kind === 'audiobook')) return 'audiobooks';
  return KIND_TO_LIBRARY[item.kind] || majority;
}

function libraryPath(library) {
  const paths = getConfig().media.paths || {};
  const target = paths[library];
  if (!target) throw new DriveError(`There is no ${library} folder configured in Settings → Server`, 'NO_DESTINATION');
  return target;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A file/folder name that is safe on Windows, macOS and Linux but keeps
 * accents, apostrophes and non-Latin scripts ("Beyoncé", "Guns N' Roses",
 * "坂本龍一") — sanitizeFilename() would turn those into underscores.
 */
function safeSegment(name) {
  let clean = String(name || '').normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')       // no hidden files / traversal
    .replace(/[. ]+$/, '');     // Windows drops trailing dots/spaces
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  if (clean.length > 180) {
    const ext = path.extname(clean).slice(0, 12);
    clean = clean.slice(0, 180 - ext.length).trim() + ext;
  }
  return clean || 'Untitled';
}

// ---------------------------------------------------------------------------
// Inspect (what would be imported)
// ---------------------------------------------------------------------------
const MAX_ITEMS = 2000;
const MAX_DEPTH = 6;

/**
 * @returns {Promise<{kind, id, name, mode, items: Array, truncated: boolean}>}
 */
async function inspect(link, { accessToken } = {}) {
  // A missing link crashed on `target.kind` (500); it's a bad request.
  if (link == null || (typeof link !== 'string' && typeof link !== 'object') || link === '') {
    throw new DriveError('Paste a Google Drive link', 'INVALID_LINK');
  }
  const target = typeof link === 'string' ? parseDriveLink(link) : link;
  if (!target || !target.kind || !target.id) throw new DriveError('That isn’t a Google Drive file or folder link', 'INVALID_LINK');
  const auth = apiAuth({ accessToken });
  const out = { kind: target.kind, id: target.id, name: null, mode: auth ? auth.mode : 'public', items: [], truncated: false };

  if (target.kind === 'file') {
    let meta;
    if (auth) {
      meta = fromApi(await apiJson(`files/${encodeURIComponent(target.id)}?fields=${encodeURIComponent(API_FIELDS)}&supportsAllDrives=true`, auth, resourceKeyHeader(target.id, target.resourceKey)));
      if (meta.mimeType === FOLDER_MIME) return inspect({ ...target, kind: 'folder' }, { accessToken });
    } else {
      meta = await webFileInfo(target.id, target.resourceKey);
    }
    out.name = meta.name || 'Google Drive file';
    out.items.push(decorate({ ...meta, resourceKey: meta.resourceKey || target.resourceKey, relDir: '' }));
    return out;
  }

  // Folder: walk breadth-first.
  let rootName = null;
  if (auth) {
    const meta = await apiJson(`files/${encodeURIComponent(target.id)}?fields=id,name,mimeType&supportsAllDrives=true`, auth, resourceKeyHeader(target.id, target.resourceKey));
    rootName = meta.name;
  }
  const queue = [{ id: target.id, resourceKey: target.resourceKey, relDir: '', depth: 0 }];
  while (queue.length) {
    const folder = queue.shift();
    let children;
    if (auth) {
      // eslint-disable-next-line no-await-in-loop
      children = await apiList(folder.id, auth, folder.resourceKey);
    } else {
      // eslint-disable-next-line no-await-in-loop
      const page = await webList(folder.id, folder.resourceKey);
      if (folder.depth === 0) rootName = page.title;
      children = page.items;
    }
    for (const child of children) {
      if (child.mimeType === FOLDER_MIME) {
        if (folder.depth + 1 <= MAX_DEPTH) queue.push({ id: child.id, resourceKey: child.resourceKey, relDir: path.posix.join(folder.relDir, safeSegment(child.name)), depth: folder.depth + 1 });
        continue;
      }
      if (out.items.length >= MAX_ITEMS) { out.truncated = true; break; }
      out.items.push(decorate({ ...child, relDir: folder.relDir }));
    }
    if (out.truncated) break;
  }
  out.name = rootName || 'Google Drive folder';
  return out;
}

/** Several hand-picked files (account / API-key mode) as one listing. */
async function inspectFiles(ids, { accessToken } = {}) {
  const auth = apiAuth({ accessToken });
  if (!auth) throw new DriveError('Picking files needs a connected Google account', 'NO_TOKEN', 400);
  const unique = [...new Set(ids)].slice(0, 500);
  const items = [];
  const folders = [];
  for (const id of unique) {
    if (!ID_RE.test(id)) throw new DriveError('Invalid file id', 'INVALID_SELECTION');
    // eslint-disable-next-line no-await-in-loop
    const meta = fromApi(await apiJson(`files/${encodeURIComponent(id)}?fields=${encodeURIComponent(API_FIELDS)}&supportsAllDrives=true`, auth));
    if (meta.mimeType === FOLDER_MIME) folders.push(meta);
    else items.push(decorate({ ...meta, relDir: '' }));
  }
  // Picked folders keep their own name as a sub-folder.
  for (const folder of folders) {
    // eslint-disable-next-line no-await-in-loop
    const sub = await inspect({ kind: 'folder', id: folder.id, resourceKey: folder.resourceKey }, { accessToken });
    for (const item of sub.items) items.push({ ...item, relDir: path.posix.join(safeSegment(sub.name), item.relDir) });
  }
  const name = unique.length === 1 ? (folders[0]?.name || items[0]?.name) : `${unique.length} items from Google Drive`;
  return { kind: 'files', id: null, name: name || 'Google Drive', mode: auth.mode, items: items.slice(0, MAX_ITEMS), truncated: items.length > MAX_ITEMS };
}

function decorate(item) {
  const kind = fileKind(item.name, item.mimeType);
  return {
    id: item.id,
    name: item.name,
    size: item.size ?? null,
    mimeType: item.mimeType || null,
    resourceKey: item.resourceKey || null,
    relDir: item.relDir || '',
    kind,
    supported: !['other', 'google-doc'].includes(kind),
  };
}

// ---------------------------------------------------------------------------
// Download one file
// ---------------------------------------------------------------------------
async function openDownload(item, { accessToken, signal, publicOnly = false }) {
  const auth = publicOnly ? null : apiAuth({ accessToken });
  if (auth) {
    const url = `${endpoints.api}/drive/v3/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true${auth.query}`;
    const res = await googleGet(url, { headers: { ...auth.headers, ...resourceKeyHeader(item.id, item.resourceKey) }, signal });
    if (res.statusCode === 403 && auth.mode === 'apiKey') {
      // API keys can't fetch some public files (e.g. flagged ones) — the
      // public download path still can.
      res.resume();
      return openDownload(item, { signal, publicOnly: true });
    }
    if (res.statusCode >= 400) {
      const text = await readBody(res).catch(() => '');
      let reason = '';
      try { reason = JSON.parse(text)?.error?.message || ''; } catch { /* not JSON */ }
      if (res.statusCode === 401) throw new DriveError('Your Google sign-in expired — connect your Google account again', 'TOKEN_EXPIRED', 400);
      throw new DriveError(reason || `Google answered ${res.statusCode}`, 'GOOGLE_ERROR', res.statusCode);
    }
    return res;
  }
  let res = await googleGet(downloadUrl(item.id, item.resourceKey), { signal });
  for (let attempt = 0; attempt < 2 && /text\/html/i.test(res.headers['content-type'] || ''); attempt++) {
    const verdict = classifyHtml(await readBody(res));
    if (verdict.kind !== 'confirm') throw verdict.error;
    const action = new URL(verdict.action || '/download', endpoints.usercontent);
    for (const [k, v] of verdict.params) action.searchParams.set(k, v);
    res = await googleGet(action.toString(), { signal });
  }
  if (res.statusCode >= 400) {
    const html = await readBody(res).catch(() => '');
    throw (classifyHtml(html).error || new DriveError(`Google answered ${res.statusCode}`, 'GOOGLE_ERROR', res.statusCode));
  }
  if (/text\/html/i.test(res.headers['content-type'] || '')) {
    res.destroy();
    throw new DriveError('Google Drive kept asking for confirmation instead of sending the file', 'UNEXPECTED_RESPONSE', 502);
  }
  return res;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${base} (${i})${ext}`);
  return candidate;
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch { return null; }
}

async function downloadTo(item, dir, { accessToken, signal, maxBytes, onProgress }) {
  fs.mkdirSync(dir, { recursive: true });
  const res = await openDownload(item, { accessToken, signal });
  const headerName = filenameFromDisposition(res.headers['content-disposition']);
  const name = safeSegment(item.name || headerName || `${item.id}${path.extname(headerName || '')}`);
  const declared = Number(res.headers['content-length'] || 0) || item.size || null;
  if (declared && declared > maxBytes) {
    res.destroy();
    throw new DriveError(`Bigger than the ${Math.round(maxBytes / 1048576)} MB limit (Settings → media.maxUploadSizeMB)`, 'TOO_LARGE', 413);
  }
  const free = freeBytes(dir);
  if (declared && free != null && declared > free - 512 * 1024 * 1024) {
    res.destroy();
    throw new DriveError(`Not enough free disk space for this file (${Math.round(declared / 1048576)} MB needed)`, 'DISK_FULL', 507);
  }
  const finalPath = uniquePath(dir, name);
  const partPath = path.join(dir, `.${path.basename(finalPath)}.${crypto.randomBytes(3).toString('hex')}.vault-part`);
  const out = fs.createWriteStream(partPath);
  let received = 0;
  let onAbort = null;
  try {
    await new Promise((resolve, reject) => {
      const fail = (err) => { res.destroy(); out.destroy(); reject(err); };
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) return fail(new DriveError(`Bigger than the ${Math.round(maxBytes / 1048576)} MB limit`, 'TOO_LARGE', 413));
        if (!out.write(chunk)) res.pause();
        onProgress?.(received, declared);
      });
      out.on('drain', () => res.resume());
      res.on('end', () => out.end());
      res.on('error', (err) => fail(err.name === 'AbortError' || signal?.aborted ? new DriveError('Cancelled', 'CANCELLED', 499) : new DriveError(`Download interrupted: ${err.message}`, 'NETWORK', 502)));
      res.on('aborted', () => fail(new DriveError(signal?.aborted ? 'Cancelled' : 'Download interrupted', signal?.aborted ? 'CANCELLED' : 'NETWORK', 502)));
      out.on('finish', resolve);
      out.on('error', (err) => fail(new DriveError(`Couldn’t write the file: ${err.message}`, 'WRITE_FAILED', 500)));
      onAbort = () => fail(new DriveError('Cancelled', 'CANCELLED', 499));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (declared && received < declared) throw new DriveError('The download ended early', 'NETWORK', 502);
    fs.renameSync(partPath, finalPath);
    return { path: finalPath, bytes: received };
  } catch (err) {
    try { fs.unlinkSync(partPath); } catch { /* never created */ }
    throw err;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Import jobs
// ---------------------------------------------------------------------------
const jobs = new Map(); // id -> job
const controllers = new Map();
const KEEP_FINISHED = 10;

function publicJob(job) {
  // Never echo the token; internal bookkeeping stays server-side too.
  const { accessToken, _lastBroadcast, profileId, ...rest } = job;
  return rest;
}

function broadcast(job, force = false) {
  const now = Date.now();
  if (!force && now - (job._lastBroadcast || 0) < 500) return;
  job._lastBroadcast = now;
  events.broadcast('import:progress', publicJob(job));
  events.jobProgress(job.id, job.receivedBytes, job.totalBytes || 0);
}

function pruneJobs() {
  const finished = [...jobs.values()].filter(j => j.status !== 'running').sort((a, b) => (a.finishedAt || '').localeCompare(b.finishedAt || ''));
  while (finished.length > KEEP_FINISHED) jobs.delete(finished.shift().id);
}

/**
 * Start importing. `selection` limits to these file ids (from inspect()).
 * Resolves as soon as the job exists; downloading continues in background.
 */
async function startImport({ link, files, selection, destination = 'auto', accessToken, scanFile, profileId }) {
  if (!DESTINATIONS.includes(destination)) throw new DriveError('Pick where the files should go', 'INVALID_DESTINATION');
  const listing = Array.isArray(files) && files.length
    ? await inspectFiles(files, { accessToken })
    : await inspect(link, { accessToken });
  const chosen = listing.items.filter(i => i.supported && (!selection || selection.includes(i.id)));
  if (!chosen.length) throw new DriveError(listing.items.length ? 'None of the selected files are media Vault can play' : 'That folder is empty', 'NOTHING_TO_IMPORT');

  const majority = majorityLibrary(chosen);
  // Folder imports keep their structure under a folder named after the share.
  const rootDir = listing.kind === 'folder' ? safeSegment(listing.name) : '';
  // Artwork and subtitles first so the scanner finds them with their media.
  const order = { image: 0, subtitle: 1 };
  chosen.sort((a, b) => (order[a.kind] ?? 2) - (order[b.kind] ?? 2));

  const id = `gdrive-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const job = {
    id,
    source: 'google-drive',
    name: listing.name,
    mode: listing.mode,
    status: 'running',
    destination,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalBytes: chosen.reduce((s, i) => s + (i.size || 0), 0),
    sizeKnown: chosen.every(i => i.size != null),
    receivedBytes: 0,
    files: chosen.map(i => ({
      id: i.id, name: i.name, kind: i.kind, size: i.size, relDir: i.relDir,
      library: libraryFor(i, destination, majority), status: 'queued', received: 0, error: null,
    })),
    imported: 0,
    failed: 0,
    error: null,
    profileId,
    accessToken,
  };
  // Resolve every destination up front so a missing folder fails fast.
  for (const f of job.files) libraryPath(f.library);
  jobs.set(id, job);
  pruneJobs();
  const controller = new AbortController();
  controllers.set(id, controller);
  events.jobStart(id, 'import', `Importing “${listing.name}” from Google Drive`, job.totalBytes);
  broadcast(job, true);
  logger.info(`[Drive] Import ${id}: ${chosen.length} file(s) from “${listing.name}” (${listing.mode})`);

  runJob(job, chosen, rootDir, controller.signal, scanFile).catch((err) => {
    logger.warn(`[Drive] Import ${id} failed: ${err.message}`);
  });
  return publicJob(job);
}

async function runJob(job, chosen, rootDir, signal, scanFile) {
  const maxBytes = (getConfig().media.maxUploadSizeMB || 10240) * 1024 * 1024;
  const byId = new Map(chosen.map(i => [i.id, i]));
  const added = [];
  const queue = [...job.files];
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const file = queue.shift();
      const item = byId.get(file.id);
      file.status = 'downloading';
      broadcast(job, true);
      const dir = path.join(libraryPath(file.library), rootDir, ...file.relDir.split('/').filter(Boolean));
      let lastReceived = 0;
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await downloadTo(item, dir, {
          accessToken: job.accessToken,
          signal,
          maxBytes,
          onProgress: (received, total) => {
            job.receivedBytes += received - lastReceived;
            lastReceived = received;
            file.received = received;
            if (total && !file.size) { file.size = total; job.totalBytes += total; }
            broadcast(job);
          },
        });
        file.status = 'done';
        file.path = result.path;
        job.imported += 1;
        if (['video', 'audio', 'audiobook', 'comic'].includes(file.kind) && scanFile) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const indexed = await scanFile(result.path);
            if (indexed) { added.push(indexed); events.broadcast('library:changed', { reason: 'add', id: indexed.id, title: indexed.title, quiet: true }); }
          } catch (err) {
            logger.warn(`[Drive] Indexing ${result.path} failed: ${err.message}`);
          }
        }
      } catch (err) {
        job.receivedBytes -= lastReceived;
        file.received = 0;
        if (err.code === 'CANCELLED' || signal.aborted) {
          file.status = 'cancelled';
        } else {
          file.status = 'error';
          file.error = err.message;
          job.failed += 1;
          logger.warn(`[Drive] ${file.name}: ${err.message}`);
          // A dead token fails every remaining file the same way.
          if (err.code === 'TOKEN_EXPIRED' || err.code === 'QUOTA_EXCEEDED') {
            for (const rest of queue.splice(0)) { rest.status = 'error'; rest.error = err.message; job.failed += 1; }
          }
        }
      }
      broadcast(job, true);
    }
  };
  await Promise.all([worker(), worker()]);
  for (const f of job.files) if (f.status === 'queued') f.status = 'cancelled';

  job.status = signal.aborted ? 'cancelled' : job.failed && !job.imported ? 'error' : job.failed ? 'partial' : 'done';
  if (job.status === 'error') job.error = job.files.find(f => f.error)?.error || 'Import failed';
  job.finishedAt = new Date().toISOString();
  delete job.accessToken;
  controllers.delete(job.id);
  broadcast(job, true);
  events.jobFinish(job.id, job.status === 'done' || job.status === 'partial' ? 'done' : job.status, {
    name: `Google Drive import “${job.name}”`,
    imported: job.imported,
    failed: job.failed,
    error: job.error,
  });
  logger.info(`[Drive] Import ${job.id} ${job.status}: ${job.imported} imported, ${job.failed} failed`);
  return added;
}

function cancelImport(id) {
  const controller = controllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

function listJobs() {
  return [...jobs.values()].map(publicJob).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

/** Browse "My Drive" (account mode only). */
async function browse({ accessToken, folderId = 'root', query = '' }) {
  if (!accessToken) throw new DriveError('Connect your Google account to browse your Drive', 'NO_TOKEN', 400);
  const auth = apiAuth({ accessToken });
  let q;
  if (query) {
    const safe = String(query).replace(/['\\]/g, ' ').slice(0, 100);
    q = `name contains '${safe}' and trashed = false`;
  } else {
    q = `'${String(folderId).replace(/[^A-Za-z0-9_-]/g, '') || 'root'}' in parents and trashed = false`;
  }
  const body = await apiJson(`files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(`nextPageToken,files(${API_FIELDS})`)}&pageSize=200&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`, auth);
  let folderName = 'My Drive';
  if (!query && folderId !== 'root') {
    folderName = (await apiJson(`files/${encodeURIComponent(folderId)}?fields=name&supportsAllDrives=true`, auth)).name || folderName;
  }
  return {
    folder: { id: folderId, name: query ? `Search: ${query}` : folderName },
    items: (body.files || []).map(fromApi).map(f => (f.mimeType === FOLDER_MIME ? { ...f, kind: 'folder', supported: true } : decorate(f))),
  };
}

function publicConfig() {
  const cfg = driveConfig();
  return {
    clientId: cfg.clientId || null,
    apiKeyConfigured: Boolean(cfg.apiKey),
  };
}

module.exports = {
  DriveError,
  DESTINATIONS,
  parseDriveLink,
  classifyHtml,
  filenameFromDisposition,
  fileKind,
  majorityLibrary,
  libraryFor,
  inspect,
  inspectFiles,
  startImport,
  cancelImport,
  listJobs,
  getJob,
  browse,
  publicConfig,
  _endpoints: endpoints,
};
