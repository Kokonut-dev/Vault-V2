const fs = require('fs-extra');
const path = require('path');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const { writeJsonAtomic, readJsonOrQuarantine } = require('../utils/fileUtils');
const { createJsonStore } = require('../utils/jsonStore');

const { DATA_DIR } = require('../utils/dataDir');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');
const FAVOURITES_PATH = path.join(DATA_DIR, 'favourites.json');
const PLAYLISTS_PATH = path.join(DATA_DIR, 'playlists.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');

// In-memory data + indexes for O(1) lookups
let library = [];
let favourites = [];
let playlists = [];
let history = [];

// Indexes
let idMap = new Map(); // id -> item
let pathMap = new Map(); // path -> item (addItem used to find by path too)
// Prototype-free, so a request for type "__proto__" or "constructor" (it
// comes straight from the query string) finds nothing instead of
// Object.prototype — that used to crash /api/library/search with a 500.
const newTypeIndex = () => Object.assign(Object.create(null), { movie: [], music: [], video: [] });
let typeIndex = newTypeIndex();
let genreSet = new Set();

// Debounced save timers
let saveTimers = {
  library: null,
  favourites: null,
  playlists: null,
  history: null,
};

// In-flight async writes — flush() awaits these on shutdown (F-15).
const pendingWrites = new Set();

function trackWrite(name, filePath, data) {
  const p = writeJsonAtomic(filePath, data)
    .catch(err => logger.error(`Failed to save ${name}:`, err.message))
    .finally(() => pendingWrites.delete(p));
  pendingWrites.add(p);
  return p;
}

let genreDirty = false;

// JSON remains the source of truth, but when the optional SQLite read index is
// enabled every runtime mutation must be mirrored immediately. Without this,
// album track numbers were saved in memory/JSON while the next GET /library
// returned the old order from SQLite until the server restarted.
function mirrorSqlite(action, value) {
  if (getConfig().media?.storage !== 'sqlite') return;
  try {
    const index = require('./sqliteIndex');
    if (typeof index[action] === 'function') index[action](value);
  } catch (err) {
    logger.warn(`[Index] ${action} mirror failed: ${err.message}`);
  }
}

function rebuildIndexes() {
  idMap.clear();
  typeIndex = newTypeIndex();
  genreSet.clear();
  pathMap.clear();
  genreDirty = false;

  for (const item of library) {
    idMap.set(item.id, item);
    if (item.path) pathMap.set(item.path, item);
    if (typeIndex[item.type]) typeIndex[item.type].push(item);
    if (item.genre) {
      if (Array.isArray(item.genre)) item.genre.forEach(g => genreSet.add(g));
      else genreSet.add(item.genre);
    }
  }
}

function logCorrupt({ file, backup, error }) {
  logger.error(`${path.basename(file)} is unreadable (${error}); ${backup ? `a copy was kept at ${backup}` : 'it could not be moved aside'}. Starting with an empty list.`);
}

function loadLibrary() {
  if (fs.existsSync(LIBRARY_PATH)) {
    library = readJsonOrQuarantine(LIBRARY_PATH, [], { onCorrupt: logCorrupt });
    logger.info(`Loaded ${library.length} items from library`);
  } else {
    library = [];
    logger.info('No existing library, starting fresh');
  }
  rebuildIndexes();
  return library;
}

function saveLibraryImmediate() {
  // F-15: async + atomic (tmp file + rename), compact JSON — never blocks
  // the event loop the way writeJsonSync did.
  return trackWrite('library', LIBRARY_PATH, library);
}

function saveLibrary() {
  // Debounce to avoid frequent disk writes during batch scans
  if (saveTimers.library) clearTimeout(saveTimers.library);
  saveTimers.library = setTimeout(() => {
    saveLibraryImmediate();
    saveTimers.library = null;
  }, 500);
}

function loadFavourites() {
  favourites = readJsonOrQuarantine(FAVOURITES_PATH, [], { onCorrupt: logCorrupt });
  return favourites;
}

function saveFavouritesImmediate() {
  return trackWrite('favourites', FAVOURITES_PATH, favourites);
}

function saveFavourites() {
  if (saveTimers.favourites) clearTimeout(saveTimers.favourites);
  saveTimers.favourites = setTimeout(() => {
    saveFavouritesImmediate();
    saveTimers.favourites = null;
  }, 300);
}

function loadPlaylists() {
  playlists = readJsonOrQuarantine(PLAYLISTS_PATH, [], { onCorrupt: logCorrupt });
  return playlists;
}

function savePlaylistsImmediate() {
  return trackWrite('playlists', PLAYLISTS_PATH, playlists);
}

function savePlaylists() {
  if (saveTimers.playlists) clearTimeout(saveTimers.playlists);
  saveTimers.playlists = setTimeout(() => {
    savePlaylistsImmediate();
    saveTimers.playlists = null;
  }, 300);
}

function loadHistory() {
  history = readJsonOrQuarantine(HISTORY_PATH, [], { onCorrupt: logCorrupt });
  return history;
}

function saveHistoryImmediate() {
  return trackWrite('history', HISTORY_PATH, history);
}

function saveHistory() {
  if (saveTimers.history) clearTimeout(saveTimers.history);
  saveTimers.history = setTimeout(() => {
    saveHistoryImmediate();
    saveTimers.history = null;
  }, 300);
}

function init() {
  loadLibrary();
  loadFavourites();
  loadPlaylists();
  loadHistory();
}

function getAll() {
  return library;
}

function getById(id) {
  // O(1) via map, fallback to find for safety
  return idMap.get(id) || library.find(item => item.id === id) || null;
}

function getByType(type) {
  if (!type || type === 'all') return library;
  return typeIndex[type] || library.filter(item => item.type === type);
}

function addItem(item) {
  // O(1) existence check via idMap (the old findIndex made a full scan of the
  // library for every scanned file, i.e. O(n²) per scan).
  const existing = idMap.get(item.id) || (item.path ? pathMap.get(item.path) : null) || null;
  const now = new Date().toISOString();
  let replacedId = null;
  if (existing) {
    const previousType = existing.type;
    const previousPath = existing.path;
    const previousId = existing.id;
    Object.assign(existing, item, { updatedAt: now });
    // Re-key the id index when a rescan assigns a new id to a known path:
    // without this, getById (array fallback) finds the item but updateItem
    // (idMap only) returns null, so every metadata edit silently fails.
    if (previousId && previousId !== existing.id) {
      idMap.delete(previousId);
      replacedId = previousId;
    }
    idMap.set(existing.id, existing);
    searchTextCache.delete(existing);
    if (previousPath && previousPath !== existing.path) pathMap.delete(previousPath);
    if (existing.path) pathMap.set(existing.path, existing);
    if (item.type && item.type !== previousType) moveTypeIndex(existing, previousType);
  } else {
    const newItem = { ...item, addedAt: now, updatedAt: now };
    library.push(newItem);
    idMap.set(newItem.id, newItem);
    if (newItem.path) pathMap.set(newItem.path, newItem);
    if (typeIndex[newItem.type]) typeIndex[newItem.type].push(newItem);
    if (newItem.genre) {
      if (Array.isArray(newItem.genre)) newItem.genre.forEach(g => genreSet.add(g));
      else genreSet.add(newItem.genre);
    }
  }
  const saved = idMap.get(item.id);
  if (replacedId) mirrorSqlite('remove', replacedId);
  mirrorSqlite('upsert', saved);
  saveLibrary();
  return saved;
}

// Metadata a person typed in (upload form, edit dialog, album editor). The
// scanner re-reads a file's tags on every rescan — including the watcher pass
// right after an upload when the duration couldn't be read — and used to
// overwrite these with whatever the file says (often nothing: "Unknown
// Artist", the filename as title, no cover). Fields listed in an item's
// `manualFields` are kept over the file's tags; see scanner.applyManualFields.
const MANUAL_FIELDS = new Set([
  'title', 'artist', 'albumArtist', 'album', 'year', 'genre', 'track', 'disc',
  'season', 'episode', 'description', 'tags', 'contentRating',
  'coverArtPath', 'posterPath', 'thumbnailPath',
  'composer', 'author', 'narrator', 'series', 'issue', 'seriesTitle', 'seriesKey',
]);

/**
 * Update an item. `{ manual: true }` marks the updated metadata fields as
 * set by hand so a later rescan keeps them.
 */
function updateItem(id, updates, { manual = false } = {}) {
  const existing = idMap.get(id);
  if (!existing) return null;
  const previousType = existing.type;
  if (manual) {
    // Only fields whose value actually changes: an edit dialog that sends
    // every field back shouldn't lock the untouched ones to today's tags.
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const marked = Object.keys(updates).filter(key => MANUAL_FIELDS.has(key)
      && updates[key] !== undefined && !same(updates[key], existing[key]));
    if (marked.length) {
      updates = { ...updates, manualFields: [...new Set([...(existing.manualFields || []), ...marked])] };
    }
  }
  // Mutate in place so indexMap/typeIndex/array stay consistent without an
  // O(n) findIndex + rebuild on every progress/metadata write.
  Object.assign(existing, updates, { updatedAt: new Date().toISOString() });
  searchTextCache.delete(existing); // cached haystack no longer valid
  if (updates.type && updates.type !== previousType) moveTypeIndex(existing, previousType);
  if (updates.genre) {
    if (Array.isArray(updates.genre)) updates.genre.forEach(g => genreSet.add(g));
    else genreSet.add(updates.genre);
  }
  mirrorSqlite('upsert', existing);
  saveLibrary();
  return existing;
}

/** Move an item between type buckets without rebuilding the whole index. */
function moveTypeIndex(item, previousType) {
  const from = typeIndex[previousType];
  if (from) {
    const index = from.indexOf(item);
    if (index !== -1) from.splice(index, 1);
  }
  if (typeIndex[item.type]) typeIndex[item.type].push(item);
}

/** Take an item out of the in-memory indexes (no reference clean-up). */
function detachItem(item) {
  const idx = library.indexOf(item);
  if (idx !== -1) library.splice(idx, 1);
  idMap.delete(item.id);
  if (item.path && pathMap.get(item.path) === item) pathMap.delete(item.path);
  // Surgical index update — a full rebuildIndexes() per removal turned batch
  // deletes (prune missing, rescan after a drive is gone) into O(n²).
  const bucket = typeIndex[item.type];
  if (bucket) {
    const bucketIdx = bucket.indexOf(item);
    if (bucketIdx !== -1) bucket.splice(bucketIdx, 1);
  }
  genreDirty = true; // genreSet may now contain a genre with no items
}

/** Profiles that have their own data folder (or a loaded scoped store). */
function scopedProfileIds() {
  const ids = new Set([...scopedStores.keys()].map(key => key.slice(0, key.lastIndexOf(':'))));
  try {
    for (const entry of fs.readdirSync(path.join(DATA_DIR, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  } catch { /* no profile folders yet */ }
  ids.delete('default');
  return [...ids];
}

/**
 * Point every per-user reference to `oldId` at `newId` — or drop it when
 * `newId` is null. Covers favourites, playlists, history and watched marks
 * for the default profile (flat files) and every other profile (scoped
 * stores), plus the extras (watchlist, collections, markers, bookmarks,
 * listening stats). Removing an item used to clean only the default
 * profile's lists, so other profiles kept dead ids forever and a moved file
 * lost everyone's progress.
 */
function rewriteItemRefs(oldId, newId = null) {
  if (!oldId || oldId === newId) return;
  const swapList = (list) => {
    if (!list.includes(oldId)) return null;
    const next = newId ? list.map(id => (id === oldId ? newId : id)) : list.filter(id => id !== oldId);
    return [...new Set(next)];
  };
  const swapHistory = (list) => {
    if (!list.some(h => h.itemId === oldId)) return null;
    if (!newId) return list.filter(h => h.itemId !== oldId);
    // Keep one entry per item: the moved file's history wins over a fresh
    // entry the new path may already have.
    return list.filter(h => h.itemId !== newId).map(h => (h.itemId === oldId ? { ...h, itemId: newId } : h));
  };
  const swapPlaylists = (list) => {
    let changed = false;
    const next = list.map((pl) => {
      const items = Array.isArray(pl.items) ? swapList(pl.items) : null;
      if (!items) return pl;
      changed = true;
      return { ...pl, items, updatedAt: new Date().toISOString() };
    });
    return changed ? next : null;
  };
  const swapWatched = (map) => {
    if (!map || !Object.prototype.hasOwnProperty.call(map, oldId)) return null;
    const next = { ...map };
    if (newId && !next[newId]) next[newId] = next[oldId];
    delete next[oldId];
    return next;
  };

  // Default profile (flat files).
  const fav = swapList(favourites);
  if (fav) { favourites = fav; saveFavourites(); }
  const pls = swapPlaylists(playlists);
  if (pls) { playlists = pls; savePlaylists(); }
  const hist = swapHistory(history);
  if (hist) { history = hist; saveHistory(); }
  const watched = swapWatched(watchedStore.get());
  if (watched) watchedStore.set(watched);

  // Every other profile.
  for (const profileId of scopedProfileIds()) {
    const swaps = { favourites: swapList, history: swapHistory, playlists: swapPlaylists, watched: swapWatched };
    for (const [kind, swap] of Object.entries(swaps)) {
      const store = getScopedStore(profileId, kind);
      if (!store) continue;
      const next = swap(store.get());
      if (next) store.set(next);
    }
  }

  // Extras live in their own module (which doesn't depend on this one).
  try {
    require('./extras').rewriteItemRefs(oldId, newId);
  } catch (err) {
    logger.warn(`Couldn't update extras for ${oldId}: ${err.message}`);
  }
}

/** Remove an item and every per-user reference to it. */
function removeItem(id) {
  const item = idMap.get(id);
  if (!item) return false;
  detachItem(item);
  rewriteItemRefs(id, null);
  // Series intro memory goes once the last episode of the show is gone.
  if (item.seriesKey && !library.some(i => i.seriesKey === item.seriesKey)) {
    try { require('./extras').removeSeriesMarker(item.seriesKey); } catch { /* best effort */ }
  }
  mirrorSqlite('remove', id);
  saveLibraryImmediate(); // immediate for removal
  return true;
}

// What a person did with an item — kept when its file moves (relinkItem).
const USER_FIELDS = ['addedAt', 'playCount', 'lastPlayedAt', 'rating', 'description', 'tags'];

/**
 * A file moved or was renamed: `oldId` (missing) and `newId` (just scanned
 * at the new path) are the same media. Carry the old item's user data over
 * to the new one — play count, rating, tags, hand-edited metadata, and every
 * profile's favourites, playlists, history, watched marks, bookmarks… — then
 * drop the old entry. Returns the new item, or null when either is unknown.
 */
function relinkItem(oldId, newId) {
  const old = idMap.get(oldId);
  const next = idMap.get(newId);
  if (!old || !next || old === next) return null;
  const patch = {};
  for (const key of USER_FIELDS) {
    if (old[key] !== undefined && old[key] !== null && old[key] !== '' && !(Array.isArray(old[key]) && !old[key].length)) patch[key] = old[key];
  }
  for (const key of old.manualFields || []) {
    if (old[key] !== undefined) patch[key] = old[key];
  }
  if (old.manualFields?.length) patch.manualFields = [...new Set([...(next.manualFields || []), ...old.manualFields])];
  if (!next.contentRating && old.contentRating) patch.contentRating = old.contentRating;
  for (const key of ['podcastFeedId', 'episodeGuid', 'published', 'externalIds', 'matchedAt']) {
    if (old[key] !== undefined && next[key] === undefined) patch[key] = old[key];
  }
  patch.movedFrom = old.path;
  patch.missing = false;
  patch.missingSince = null;
  Object.assign(next, patch, { updatedAt: new Date().toISOString() });
  searchTextCache.delete(next);

  detachItem(old);
  rewriteItemRefs(oldId, newId);
  mirrorSqlite('remove', oldId);
  mirrorSqlite('upsert', next);
  saveLibraryImmediate();
  return next;
}

/**
 * Flag an item whose file is gone. It stays in the library (with its
 * favourites, history, ratings…) so a drive coming back or a file being moved
 * back loses nothing; a scan removes it for real after
 * `media.missingRetentionDays` (see scanner.scanAll), as does Health → Remove
 * missing.
 */
function markMissing(id, missing = true) {
  const item = idMap.get(id);
  if (!item) return null;
  if (!!item.missing === !!missing) return item;
  return updateItem(id, missing
    ? { missing: true, missingSince: new Date().toISOString() }
    : { missing: false, missingSince: null });
}

// F-14: per-item search text is cached (WeakMap) — item objects are replaced
// on update, so the cache self-invalidates. Search and the library route both
// use this instead of rebuilding a haystack per item per request.
const searchTextCache = new WeakMap();

function getSearchText(item) {
  let text = searchTextCache.get(item);
  if (text === undefined) {
    text = [
      item.title,
      item.artist,
      item.album,
      item.genre,
      item.year?.toString(),
      item.description,
      item.filename,
      item.tags?.join(' '),
    ].filter(Boolean).join(' ').toLowerCase();
    searchTextCache.set(item, text);
  }
  return text;
}

function search(query, type = 'all') {
  let items = getByType(type);
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(item => getSearchText(item).includes(q));
}

function getStats() {
  const movies = typeIndex.movie?.length ?? library.filter(i => i.type === 'movie').length;
  const music = typeIndex.music?.length ?? library.filter(i => i.type === 'music').length;
  const videos = typeIndex.video?.length ?? library.filter(i => i.type === 'video').length;
  const totalSize = library.reduce((sum, i) => sum + (i.fileSize || 0), 0);
  const recentlyAdded = [...library].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)).slice(0, 20);
  return { totalMovies: movies, totalMusic: music, totalVideos: videos, totalSize, totalItems: library.length, recentlyAdded };
}

function getGenres() {
  // Use cached set if available (rebuilt lazily after removals)
  if (!genreDirty && genreSet.size > 0) return Array.from(genreSet).sort();
  const genres = new Set();
  library.forEach(item => {
    if (item.genre) {
      if (Array.isArray(item.genre)) item.genre.forEach(g => genres.add(g));
      else genres.add(item.genre);
    }
  });
  genreSet = genres;
  return Array.from(genres).sort();
}

// Favourites
function getFavourites() {
  // Use idMap for O(1)
  return favourites.map(id => idMap.get(id) || getById(id)).filter(Boolean);
}

function addFavourite(id) {
  if (!favourites.includes(id)) {
    favourites.push(id);
    saveFavourites();
  }
  return true;
}

function removeFavourite(id) {
  if (favourites.includes(id)) {
    favourites = favourites.filter(f => f !== id);
    saveFavourites();
  }
  return true;
}

function isFavourite(id) {
  return favourites.includes(id);
}

// Playlists
function getPlaylists() {
  return playlists;
}

function getPlaylistById(id) {
  return playlists.find(p => p.id === id) || null;
}

function createPlaylist(data) {
  const id = data.id || `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const now = new Date().toISOString();
  const playlist = {
    id,
    name: data.name || 'Untitled Playlist',
    description: data.description || '',
    type: data.type || 'playlist',
    items: Array.isArray(data.items) ? [...new Set(data.items)] : [],
    createdAt: now,
    updatedAt: now,
    coverArt: data.coverArt || null,
  };
  playlists.push(playlist);
  savePlaylists();
  return playlist;
}

function updatePlaylist(id, updates) {
  const idx = playlists.findIndex(p => p.id === id);
  if (idx === -1) return null;
  if (updates.items && Array.isArray(updates.items)) {
    updates.items = [...new Set(updates.items)];
  }
  playlists[idx] = { ...playlists[idx], ...updates, updatedAt: new Date().toISOString() };
  savePlaylists();
  return playlists[idx];
}

function deletePlaylist(id) {
  const idx = playlists.findIndex(p => p.id === id);
  if (idx === -1) return false;
  playlists.splice(idx, 1);
  savePlaylists();
  return true;
}

// History
function getHistory() {
  return [...history].sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
}

function addHistoryEntry(entry) {
  if (!entry.itemId) return null;
  const existingIdx = history.findIndex(h => h.itemId === entry.itemId);
  const now = new Date().toISOString();
  const newEntry = {
    itemId: entry.itemId,
    progress: Math.min(100, Math.max(0, entry.progress || 0)),
    duration: entry.duration || 0,
    completed: !!entry.completed,
    watchedAt: now,
    // playCount on the entry counts how many times the *entry* was resumed;
    // the item-level counter below counts real "start playback" events.
    playCount: (existingIdx >= 0 ? (history[existingIdx].playCount || 0) : 0) + (entry.bumpPlayCount ? 1 : 0),
  };
  if (entry.bumpPlayCount) bumpPlayCount(entry.itemId);
  if (existingIdx >= 0) {
    history[existingIdx] = { ...history[existingIdx], ...newEntry };
  } else {
    history.push(newEntry);
  }
  if (history.length > 500) {
    history = history.slice(-500);
  }
  saveHistory();
  return newEntry;
}

function clearHistory() {
  history = [];
  saveHistoryImmediate();
  return true;
}

// Flush all debounced saves (for shutdown) — F-15: writes are async now,
// so flush awaits both the debounced payloads and any in-flight writes.
async function flush() {
  if (saveTimers.library) {
    clearTimeout(saveTimers.library);
    saveTimers.library = null;
    saveLibraryImmediate();
  }
  if (saveTimers.favourites) {
    clearTimeout(saveTimers.favourites);
    saveTimers.favourites = null;
    saveFavouritesImmediate();
  }
  if (saveTimers.playlists) {
    clearTimeout(saveTimers.playlists);
    saveTimers.playlists = null;
    savePlaylistsImmediate();
  }
  if (saveTimers.history) {
    clearTimeout(saveTimers.history);
    saveTimers.history = null;
    saveHistoryImmediate();
  }
  await Promise.allSettled([...pendingWrites]);
  // Also wait for chains owned by other modules (e.g. authService's
  // bruteforce records) so shutdown persistence is complete.
  const { flushWrites } = require('../utils/fileUtils');
  await flushWrites();
}



// ---------------------------------------------------------------------------
// Play counts & watched state
// ---------------------------------------------------------------------------
function bumpPlayCount(itemId) {
  const item = getById(itemId);
  if (!item) return null;
  item.playCount = (item.playCount || 0) + 1;
  item.lastPlayedAt = new Date().toISOString();
  saveLibrary();
  return item.playCount;
}

const watchedStore = createJsonStore('watched.json', {});

function isWatched(itemId, profileId = 'default') {
  const scoped = getScopedStore(profileId, 'watched');
  const map = scoped ? scoped.get() : watchedStore.get();
  return !!(map[itemId] && map[itemId].watched);
}

function setWatched(itemId, watched, profileId = 'default') {
  const scoped = getScopedStore(profileId, 'watched');
  const store = scoped || watchedStore;
  const map = store.get();
  if (watched) {
    map[itemId] = { watched: true, at: new Date().toISOString() };
  } else {
    delete map[itemId];
  }
  store.set(map);
  if (!getById(itemId)) return null;
  return { itemId, watched: !!watched };
}

function getWatchedMap(profileId = 'default') {
  const scoped = getScopedStore(profileId, 'watched');
  return (scoped || watchedStore).get();
}

// ---------------------------------------------------------------------------
// Per-profile data scoping
//
// The `default` profile keeps using the original flat files, so existing
// installs are never migrated or touched. Extra profiles get their own folder.
// ---------------------------------------------------------------------------
const scopedStores = new Map();

const SCOPED_KINDS = {
  favourites: 'favourites.json',
  history: 'history.json',
  playlists: 'playlists.json',
  watched: 'watched.json',
};

function getScopedStore(profileId, kind) {
  if (!profileId || profileId === 'default') return null;
  const key = `${profileId}:${kind}`;
  if (!scopedStores.has(key)) {
    scopedStores.set(key, createJsonStore(
      path.join('profiles', String(profileId).replace(/[^a-zA-Z0-9_-]/g, ''), SCOPED_KINDS[kind]),
      kind === 'watched' ? {} : []
    ));
  }
  return scopedStores.get(key);
}

/**
 * Returns the same favourites/history/playlists API as this module, but bound to
 * one profile. For the default profile this is literally the module itself.
 */
function forProfile(profileId) {
  if (!profileId || profileId === 'default') {
    return {
      profileId: 'default',
      getFavourites, addFavourite, removeFavourite, isFavourite,
      getHistory, addHistoryEntry, clearHistory,
      getPlaylists, getPlaylistById, createPlaylist, updatePlaylist, deletePlaylist,
      setWatched, isWatched, getWatchedMap,
    };
  }

  const favStore = getScopedStore(profileId, 'favourites');
  const histStore = getScopedStore(profileId, 'history');
  const plStore = getScopedStore(profileId, 'playlists');

  return {
    profileId,
    getFavourites() {
      return favStore.get().map(id => idMap.get(id)).filter(Boolean);
    },
    addFavourite(id) {
      const list = favStore.get();
      if (!list.includes(id)) {
        list.push(id);
        favStore.set(list);
      }
      return true;
    },
    removeFavourite(id) {
      favStore.set(favStore.get().filter(f => f !== id));
      return true;
    },
    isFavourite(id) {
      return favStore.get().includes(id);
    },
    getHistory() {
      return [...histStore.get()].sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
    },
    addHistoryEntry(entry) {
      const list = histStore.get();
      const idx = list.findIndex(h => h.itemId === entry.itemId);
      const record = {
        itemId: entry.itemId,
        progress: Math.min(100, Math.max(0, entry.progress || 0)),
        duration: entry.duration || 0,
        completed: !!entry.completed,
        watchedAt: new Date().toISOString(),
        playCount: (idx >= 0 ? (list[idx].playCount || 0) : 0) + (entry.bumpPlayCount ? 1 : 0),
      };
      if (entry.bumpPlayCount) bumpPlayCount(entry.itemId);
      if (idx >= 0) list[idx] = { ...list[idx], ...record };
      else list.push(record);
      histStore.set(list.slice(-500));
      return record;
    },
    clearHistory() {
      histStore.set([]);
      return true;
    },
    getPlaylists() {
      return plStore.get();
    },
    getPlaylistById(id) {
      return plStore.get().find(p => p.id === id) || null;
    },
    createPlaylist(data) {
      const list = plStore.get();
      const now = new Date().toISOString();
      const playlist = {
        id: data.id || `pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: data.name || 'Untitled Playlist',
        description: data.description || '',
        type: data.type || 'playlist',
        items: Array.isArray(data.items) ? [...new Set(data.items)] : [],
        createdAt: now,
        updatedAt: now,
        profileId,
      };
      list.push(playlist);
      plStore.set(list);
      return playlist;
    },
    updatePlaylist(id, updates) {
      const list = plStore.get();
      const idx = list.findIndex(p => p.id === id);
      if (idx === -1) return null;
      if (updates.items) updates.items = [...new Set(updates.items)];
      list[idx] = { ...list[idx], ...updates, updatedAt: new Date().toISOString() };
      plStore.set(list);
      return list[idx];
    },
    deletePlaylist(id) {
      const list = plStore.get();
      const next = list.filter(p => p.id !== id);
      if (next.length === list.length) return false;
      plStore.set(next);
      return true;
    },
    setWatched,
    isWatched,
    getWatchedMap,
  };
}

/**
 * Delete everything that belongs to one profile: favourites, history,
 * playlists and watched marks. Used when a profile is deleted, so a new
 * profile never inherits a stale folder and the "removed" promise in the UI
 * is true. The `default` profile's data lives in the flat files; those are
 * emptied rather than deleted.
 */
async function removeProfileData(profileId) {
  if (!profileId || profileId === 'default') {
    favourites = [];
    history = [];
    playlists = [];
    saveFavouritesImmediate();
    saveHistoryImmediate();
    savePlaylistsImmediate();
    watchedStore.set({});
    await Promise.all([...pendingWrites, watchedStore.flush()].map(p => Promise.resolve(p).catch(() => {})));
    return true;
  }
  const safeId = String(profileId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) return false;
  // Settle pending debounced writes first, so none of them recreates the
  // folder after it has been removed.
  const pending = [];
  for (const kind of Object.keys(SCOPED_KINDS)) {
    const key = `${profileId}:${kind}`;
    const store = scopedStores.get(key);
    if (store) {
      pending.push(store.flush());
      scopedStores.delete(key);
    }
  }
  await Promise.all(pending.map(p => Promise.resolve(p).catch(() => {})));
  if (DATA_DIR) await fs.remove(path.join(DATA_DIR, 'profiles', safeId)).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Query helper (filters + pagination + sorting) shared by /api/library and the
// live views. Sorting always works on a copy (F-14).
// ---------------------------------------------------------------------------
function queryWith({ type = 'all', search = '', genre = '', year = null, rating = null, sort = 'addedAt', order = 'desc', page = 1, limit = 0, watched = null, profileId = 'default' } = {}) {
  let items = getByType(type).slice();
  if (search) items = items.filter(i => getSearchText(i).includes(String(search).toLowerCase()));
  if (genre) {
    const g = String(genre).toLowerCase();
    items = items.filter(i => {
      const value = Array.isArray(i.genre) ? i.genre.join(' ') : (i.genre || '');
      return value.toLowerCase().includes(g);
    });
  }
  if (year) items = items.filter(i => String(i.year) === String(year));
  if (rating) items = items.filter(i => (i.rating || 0) >= Number(rating));

  if (watched !== null) {
    const map = getWatchedMap(profileId);
    items = items.filter(i => !!map[i.id]?.watched === !!watched);
  }

  const dir = order === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    let av = a[sort];
    let bv = b[sort];
    if (sort === 'title' || sort === 'artist' || sort === 'album') {
      av = String(av || '').toLowerCase();
      bv = String(bv || '').toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    if (sort === 'addedAt' || sort === 'updatedAt' || sort === 'lastPlayedAt') {
      return (new Date(av || 0) - new Date(bv || 0)) * dir;
    }
    return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
  });

  const total = items.length;
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.min(1000, Math.max(0, parseInt(limit, 10) || 0));
  if (pageSize > 0) items = items.slice((pageNum - 1) * pageSize, pageNum * pageSize);
  return { items, total, page: pageNum, limit: pageSize };
}

async function flushScoped() {
  const pending = [];
  for (const store of scopedStores.values()) pending.push(store.flush());
  pending.push(watchedStore.flush());
  await Promise.all(pending);
}

module.exports = {
  init,
  loadLibrary,
  saveLibrary: saveLibraryImmediate,
  saveLibraryDebounced: saveLibrary,
  getAll,
  getById,
  getByType,
  addItem,
  updateItem,
  MANUAL_FIELDS,
  removeItem,
  relinkItem,
  markMissing,
  rewriteItemRefs,
  search,
  getSearchText,
  getStats,
  getGenres,
  bumpPlayCount,
  isWatched,
  setWatched,
  getWatchedMap,
  forProfile,
  removeProfileData,
  queryWith,
  flushScoped,
  getFavourites,
  addFavourite,
  removeFavourite,
  isFavourite,
  getPlaylists,
  getPlaylistById,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  getHistory,
  addHistoryEntry,
  clearHistory,
  flush,
  _rebuildIndexes: rebuildIndexes,
};
