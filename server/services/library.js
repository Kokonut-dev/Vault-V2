const fs = require('fs-extra');
const path = require('path');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const { writeJsonAtomic } = require('../utils/fileUtils');
const { createJsonStore } = require('../utils/jsonStore');

const LIBRARY_PATH = path.join(__dirname, '../data/library.json');
const FAVOURITES_PATH = path.join(__dirname, '../data/favourites.json');
const PLAYLISTS_PATH = path.join(__dirname, '../data/playlists.json');
const HISTORY_PATH = path.join(__dirname, '../data/history.json');

// In-memory data + indexes for O(1) lookups
let library = [];
let favourites = [];
let playlists = [];
let history = [];

// Indexes
let idMap = new Map(); // id -> item
let pathMap = new Map(); // path -> item (addItem used to find by path too)
let typeIndex = { movie: [], music: [], video: [] };
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

function rebuildIndexes() {
  idMap.clear();
  typeIndex = { movie: [], music: [], video: [] };
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

function loadLibrary() {
  try {
    if (fs.existsSync(LIBRARY_PATH)) {
      library = fs.readJsonSync(LIBRARY_PATH);
      logger.info(`Loaded ${library.length} items from library`);
    } else {
      library = [];
      logger.info('No existing library, starting fresh');
    }
  } catch (err) {
    logger.warn('Failed to load library:', err.message);
    library = [];
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
  try {
    if (fs.existsSync(FAVOURITES_PATH)) {
      favourites = fs.readJsonSync(FAVOURITES_PATH);
    } else {
      favourites = [];
    }
  } catch {
    favourites = [];
  }
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
  try {
    if (fs.existsSync(PLAYLISTS_PATH)) {
      playlists = fs.readJsonSync(PLAYLISTS_PATH);
    } else {
      playlists = [];
    }
  } catch {
    playlists = [];
  }
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
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      history = fs.readJsonSync(HISTORY_PATH);
    } else {
      history = [];
    }
  } catch {
    history = [];
  }
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
  if (existing) {
    const previousType = existing.type;
    const previousPath = existing.path;
    Object.assign(existing, item, { updatedAt: now });
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
  saveLibrary();
  return idMap.get(item.id);
}

function updateItem(id, updates) {
  const existing = idMap.get(id);
  if (!existing) return null;
  const previousType = existing.type;
  // Mutate in place so indexMap/typeIndex/array stay consistent without an
  // O(n) findIndex + rebuild on every progress/metadata write.
  Object.assign(existing, updates, { updatedAt: new Date().toISOString() });
  searchTextCache.delete(existing); // cached haystack no longer valid
  if (updates.type && updates.type !== previousType) moveTypeIndex(existing, previousType);
  if (updates.genre) {
    if (Array.isArray(updates.genre)) updates.genre.forEach(g => genreSet.add(g));
    else genreSet.add(updates.genre);
  }
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

function removeItem(id) {
  const item = idMap.get(id);
  if (!item) return false;
  const idx = library.indexOf(item);
  if (idx !== -1) library.splice(idx, 1);
  idMap.delete(id);
  if (item.path) pathMap.delete(item.path);
  // Surgical index update — a full rebuildIndexes() per removal turned batch
  // deletes (prune missing, rescan after a drive is gone) into O(n²).
  const bucket = typeIndex[item.type];
  if (bucket) {
    const bucketIdx = bucket.indexOf(item);
    if (bucketIdx !== -1) bucket.splice(bucketIdx, 1);
  }
  genreDirty = true; // genreSet may now contain a genre with no items

  // Also remove from favourites, playlists, history
  let changed = false;
  if (favourites.includes(id)) {
    favourites = favourites.filter(f => f !== id);
    changed = true;
    saveFavourites();
  }
  let playlistsChanged = false;
  playlists.forEach(pl => {
    const before = pl.items.length;
    pl.items = pl.items.filter(itemId => itemId !== id);
    if (pl.items.length !== before) playlistsChanged = true;
  });
  if (playlistsChanged) savePlaylists();

  const beforeHistory = history.length;
  history = history.filter(h => h.itemId !== id);
  if (history.length !== beforeHistory) saveHistory();

  saveLibraryImmediate(); // immediate for removal
  return true;
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
  removeItem,
  search,
  getSearchText,
  getStats,
  getGenres,
  bumpPlayCount,
  isWatched,
  setWatched,
  getWatchedMap,
  forProfile,
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
