const fs = require('fs-extra');
const path = require('path');
const { getConfig } = require('../config');
const logger = require('../utils/logger');

const LIBRARY_PATH = path.join(__dirname, '../data/library.json');
const FAVOURITES_PATH = path.join(__dirname, '../data/favourites.json');
const PLAYLISTS_PATH = path.join(__dirname, '../data/playlists.json');
const HISTORY_PATH = path.join(__dirname, '../data/history.json');

let library = [];
let favourites = [];
let playlists = [];
let history = [];

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
  return library;
}

function saveLibrary() {
  try {
    fs.ensureDirSync(path.dirname(LIBRARY_PATH));
    fs.writeJsonSync(LIBRARY_PATH, library, { spaces: 2 });
  } catch (err) {
    logger.error('Failed to save library:', err.message);
  }
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

function saveFavourites() {
  try {
    fs.ensureDirSync(path.dirname(FAVOURITES_PATH));
    fs.writeJsonSync(FAVOURITES_PATH, favourites, { spaces: 2 });
  } catch (err) {
    logger.error('Failed to save favourites:', err.message);
  }
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

function savePlaylists() {
  try {
    fs.ensureDirSync(path.dirname(PLAYLISTS_PATH));
    fs.writeJsonSync(PLAYLISTS_PATH, playlists, { spaces: 2 });
  } catch (err) {
    logger.error('Failed to save playlists:', err.message);
  }
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

function saveHistory() {
  try {
    fs.ensureDirSync(path.dirname(HISTORY_PATH));
    fs.writeJsonSync(HISTORY_PATH, history, { spaces: 2 });
  } catch (err) {
    logger.error('Failed to save history:', err.message);
  }
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
  return library.find(item => item.id === id);
}

function getByType(type) {
  if (!type || type === 'all') return library;
  return library.filter(item => item.type === type);
}

function addItem(item) {
  const existing = library.findIndex(i => i.id === item.id || i.path === item.path);
  if (existing >= 0) {
    library[existing] = { ...library[existing], ...item, updatedAt: new Date().toISOString() };
  } else {
    library.push({ ...item, addedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  saveLibrary();
  return item;
}

function updateItem(id, updates) {
  const idx = library.findIndex(i => i.id === id);
  if (idx === -1) return null;
  library[idx] = { ...library[idx], ...updates, updatedAt: new Date().toISOString() };
  saveLibrary();
  return library[idx];
}

function removeItem(id) {
  const idx = library.findIndex(i => i.id === id);
  if (idx === -1) return false;
  library.splice(idx, 1);
  saveLibrary();
  // Also remove from favourites, playlists, history
  favourites = favourites.filter(f => f !== id);
  saveFavourites();
  playlists.forEach(pl => {
    pl.items = pl.items.filter(itemId => itemId !== id);
  });
  savePlaylists();
  history = history.filter(h => h.itemId !== id);
  saveHistory();
  return true;
}

function search(query, type = 'all') {
  let items = getByType(type);
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter(item => {
    const haystack = [
      item.title,
      item.artist,
      item.album,
      item.genre,
      item.year?.toString(),
      item.description,
      item.filename,
      item.tags?.join(' '),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

function getStats() {
  const movies = library.filter(i => i.type === 'movie').length;
  const music = library.filter(i => i.type === 'music').length;
  const videos = library.filter(i => i.type === 'video').length;
  const totalSize = library.reduce((sum, i) => sum + (i.fileSize || 0), 0);
  const recentlyAdded = [...library].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)).slice(0, 20);
  return { totalMovies: movies, totalMusic: music, totalVideos: videos, totalSize, totalItems: library.length, recentlyAdded };
}

function getGenres() {
  const genres = new Set();
  library.forEach(item => {
    if (item.genre) {
      if (Array.isArray(item.genre)) item.genre.forEach(g => genres.add(g));
      else genres.add(item.genre);
    }
  });
  return Array.from(genres).sort();
}

// Favourites
function getFavourites() {
  return favourites.map(id => getById(id)).filter(Boolean);
}

function addFavourite(id) {
  if (!favourites.includes(id)) {
    favourites.push(id);
    saveFavourites();
  }
  return true;
}

function removeFavourite(id) {
  favourites = favourites.filter(f => f !== id);
  saveFavourites();
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
  return playlists.find(p => p.id === id);
}

function createPlaylist(data) {
  const id = data.id || `pl_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
  const playlist = {
    id,
    name: data.name || 'Untitled Playlist',
    description: data.description || '',
    type: data.type || 'playlist',
    items: data.items || [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    coverArt: data.coverArt || null,
  };
  playlists.push(playlist);
  savePlaylists();
  return playlist;
}

function updatePlaylist(id, updates) {
  const idx = playlists.findIndex(p => p.id === id);
  if (idx === -1) return null;
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
  return history.sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
}

function addHistoryEntry(entry) {
  const existingIdx = history.findIndex(h => h.itemId === entry.itemId);
  const newEntry = {
    itemId: entry.itemId,
    progress: entry.progress || 0,
    duration: entry.duration || 0,
    completed: entry.completed || false,
    watchedAt: new Date().toISOString(),
    playCount: 1,
  };
  if (existingIdx >= 0) {
    newEntry.playCount = (history[existingIdx].playCount || 0) + 1;
    history[existingIdx] = { ...history[existingIdx], ...newEntry };
  } else {
    history.push(newEntry);
  }
  // Keep only last 500 entries
  if (history.length > 500) {
    history = history.slice(-500);
  }
  saveHistory();
  return newEntry;
}

function clearHistory() {
  history = [];
  saveHistory();
  return true;
}

module.exports = {
  init,
  loadLibrary,
  saveLibrary,
  getAll,
  getById,
  getByType,
  addItem,
  updateItem,
  removeItem,
  search,
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
};
