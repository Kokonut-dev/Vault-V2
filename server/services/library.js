const fs = require('fs-extra');
const path = require('path');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const { writeJsonAtomic } = require('../utils/fileUtils');

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

function rebuildIndexes() {
  idMap.clear();
  typeIndex = { movie: [], music: [], video: [] };
  genreSet.clear();

  for (const item of library) {
    idMap.set(item.id, item);
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
  const existingIdx = library.findIndex(i => i.id === item.id || i.path === item.path);
  const now = new Date().toISOString();
  if (existingIdx >= 0) {
    library[existingIdx] = { ...library[existingIdx], ...item, updatedAt: now };
    idMap.set(library[existingIdx].id, library[existingIdx]);
  } else {
    const newItem = { ...item, addedAt: now, updatedAt: now };
    library.push(newItem);
    idMap.set(newItem.id, newItem);
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
  const idx = library.findIndex(i => i.id === id);
  if (idx === -1) return null;
  library[idx] = { ...library[idx], ...updates, updatedAt: new Date().toISOString() };
  idMap.set(id, library[idx]);
  // Rebuild type index if type changed
  if (updates.type) rebuildIndexes();
  else if (updates.genre) {
    if (Array.isArray(updates.genre)) updates.genre.forEach(g => genreSet.add(g));
    else genreSet.add(updates.genre);
  }
  saveLibrary();
  return library[idx];
}

function removeItem(id) {
  const idx = library.findIndex(i => i.id === id);
  if (idx === -1) return false;
  library.splice(idx, 1);
  idMap.delete(id);
  // Rebuild indexes to keep typeIndex consistent
  rebuildIndexes();

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
  // Use cached set if available
  if (genreSet.size > 0) return Array.from(genreSet).sort();
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
    playCount: 1,
  };
  if (existingIdx >= 0) {
    newEntry.playCount = (history[existingIdx].playCount || 0) + 1;
    // Preserve original added time if exists
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
