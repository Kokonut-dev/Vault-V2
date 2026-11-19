/**
 * User-curated data that used to have no home: watchlist, collections,
 * per-item markers (intro/outro/chapters), bookmarks and podcasts.
 *
 * All of it is exposed through `routes/extras.js` and broadcast over SSE so the
 * UI updates live.
 */
const { randomUUID } = require('crypto');
const { createJsonStore } = require('../utils/jsonStore');
const events = require('./events');

const watchlistStore = createJsonStore('watchlist.json', []);
const collectionsStore = createJsonStore('collections.json', []);
const markersStore = createJsonStore('markers.json', {});
const bookmarksStore = createJsonStore('bookmarks.json', []);
const podcastsStore = createJsonStore('podcasts.json', []);
const listensStore = createJsonStore('listens.json', { total: {}, daily: {} });

function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// Watchlist ("My List")
// ---------------------------------------------------------------------------
function getWatchlist() {
  return watchlistStore.get();
}

function isInWatchlist(itemId, profileId = 'default') {
  return getWatchlist().some(w => w.itemId === itemId && (w.profileId || 'default') === profileId);
}

function addToWatchlist(itemId, profileId = 'default') {
  const list = getWatchlist();
  if (list.some(w => w.itemId === itemId && (w.profileId || 'default') === profileId)) return false;
  list.unshift({ itemId, profileId, addedAt: new Date().toISOString() });
  watchlistStore.set(list.slice(0, 2000));
  events.broadcast('watchlist:changed', { itemId, added: true });
  return true;
}

/** Drop a deleted profile's watchlist entries. Returns how many went. */
function removeProfileWatchlist(profileId) {
  const list = getWatchlist();
  const next = list.filter(w => (w.profileId || 'default') !== profileId);
  if (next.length === list.length) return 0;
  watchlistStore.set(next);
  events.broadcast('watchlist:changed', { profileId, removed: list.length - next.length });
  return list.length - next.length;
}

function removeFromWatchlist(itemId, profileId = 'default') {
  const list = getWatchlist();
  const next = list.filter(w => !(w.itemId === itemId && (w.profileId || 'default') === profileId));
  if (next.length === list.length) return false;
  watchlistStore.set(next);
  events.broadcast('watchlist:changed', { itemId, added: false });
  return true;
}

// ---------------------------------------------------------------------------
// Collections (manual + rule-based smart collections)
// ---------------------------------------------------------------------------
function getCollections() {
  return collectionsStore.get();
}

function getCollection(id) {
  return getCollections().find(c => c.id === id) || null;
}

function createCollection(data) {
  const now = new Date().toISOString();
  const collection = {
    id: shortId('col'),
    name: (data.name || 'Untitled Collection').slice(0, 120),
    description: (data.description || '').slice(0, 500),
    kind: data.kind === 'smart' ? 'smart' : 'manual',
    rules: data.kind === 'smart' ? normalizeRules(data.rules) : null,
    items: Array.isArray(data.items) ? [...new Set(data.items)] : [],
    coverArt: data.coverArt || null,
    createdAt: now,
    updatedAt: now,
  };
  const list = getCollections();
  list.push(collection);
  collectionsStore.set(list);
  events.broadcast('collection:changed', { id: collection.id, action: 'create' });
  return collection;
}

function normalizeRules(rules = {}) {
  const out = {};
  if (Array.isArray(rules.types) && rules.types.length) out.types = rules.types;
  if (Array.isArray(rules.genres) && rules.genres.length) out.genres = rules.genres;
  if (Array.isArray(rules.years) && rules.years.length === 2) out.years = rules.years.map(Number);
  if (typeof rules.minRating === 'number' && rules.minRating > 0) out.minRating = rules.minRating;
  if (rules.unwatchedOnly) out.unwatchedOnly = true;
  if (rules.search) out.search = String(rules.search).slice(0, 80);
  if (rules.sort) out.sort = String(rules.sort).slice(0, 40);
  if (rules.limit) out.limit = Math.min(500, Math.max(1, parseInt(rules.limit, 10) || 50));
  return out;
}

function updateCollection(id, updates) {
  const list = getCollections();
  const idx = list.findIndex(c => c.id === id);
  if (idx === -1) return null;
  const next = { ...list[idx] };
  if (updates.name !== undefined) next.name = String(updates.name).slice(0, 120);
  if (updates.description !== undefined) next.description = String(updates.description).slice(0, 500);
  if (updates.coverArt !== undefined) next.coverArt = updates.coverArt;
  if (updates.rules !== undefined && next.kind === 'smart') next.rules = normalizeRules(updates.rules);
  if (Array.isArray(updates.items)) next.items = [...new Set(updates.items)];
  next.updatedAt = new Date().toISOString();
  list[idx] = next;
  collectionsStore.set(list);
  events.broadcast('collection:changed', { id, action: 'update' });
  return next;
}

function deleteCollection(id) {
  const list = getCollections();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  collectionsStore.set(next);
  events.broadcast('collection:changed', { id, action: 'delete' });
  return true;
}

function addToCollection(id, itemIds) {
  const collection = getCollection(id);
  if (!collection) return null;
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
  collection.items = [...new Set([...(collection.items || []), ...ids])];
  collection.updatedAt = new Date().toISOString();
  const list = getCollections();
  const idx = list.findIndex(c => c.id === id);
  list[idx] = collection;
  collectionsStore.set(list);
  events.broadcast('collection:changed', { id, action: 'update' });
  return collection;
}

function removeFromCollection(id, itemId) {
  const collection = getCollection(id);
  if (!collection) return null;
  collection.items = (collection.items || []).filter(i => i !== itemId);
  collection.updatedAt = new Date().toISOString();
  const list = getCollections();
  const idx = list.findIndex(c => c.id === id);
  list[idx] = collection;
  collectionsStore.set(list);
  events.broadcast('collection:changed', { id, action: 'update' });
  return collection;
}

// ---------------------------------------------------------------------------
// Markers — intro/outro ranges and chapters, per item id
// ---------------------------------------------------------------------------
function getMarkers(itemId) {
  const all = markersStore.get();
  return all[itemId] || { intro: null, outro: null, chapters: [], source: null };
}

function setMarkers(itemId, patch) {
  const all = markersStore.get();
  const current = all[itemId] || { intro: null, outro: null, chapters: [] };
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  all[itemId] = next;
  markersStore.set(all);
  events.broadcast('markers:changed', { itemId });
  return next;
}

// Series-level intro memory: keyed by the show key (folder/parsed title)
function getSeriesMarkers(key) {
  const all = markersStore.get();
  return all[`series:${key}`] || null;
}

function setSeriesMarker(key, intro, outro) {
  const all = markersStore.get();
  all[`series:${key}`] = { intro, outro, updatedAt: new Date().toISOString() };
  markersStore.set(all);
  return all[`series:${key}`];
}

// ---------------------------------------------------------------------------
// Bookmarks (video + audio timestamps)
// ---------------------------------------------------------------------------
// Bookmarks belong to the profile that made them. Ones saved before that
// (no profileId) belong to the default profile, like the watchlist.
const BOOKMARKS_PER_PROFILE = 1000;
const ownerOf = b => b.profileId || 'default';

/**
 * Bookmarks for one profile (optionally one item). Without a profileId this
 * returns every profile's bookmarks — internal use only.
 */
function getBookmarks(itemId, profileId) {
  const list = bookmarksStore.get();
  return list.filter(b => (!itemId || b.itemId === itemId) && (profileId === undefined || ownerOf(b) === profileId));
}

function addBookmark(data, profileId = 'default') {
  const bookmark = {
    id: shortId('bm'),
    itemId: data.itemId,
    profileId,
    time: Math.max(0, Number(data.time) || 0),
    label: String(data.label || '').slice(0, 160) || `At ${Math.round(data.time || 0)}s`,
    createdAt: new Date().toISOString(),
  };
  const list = bookmarksStore.get();
  list.unshift(bookmark);
  // The cap is per profile, so one profile can't push out everyone else's.
  let mine = 0;
  bookmarksStore.set(list.filter(b => ownerOf(b) !== profileId || ++mine <= BOOKMARKS_PER_PROFILE));
  events.broadcast('bookmark:changed', { itemId: bookmark.itemId, profileId });
  return bookmark;
}

/** Remove one of `profileId`'s bookmarks. Someone else's counts as not found. */
function removeBookmark(id, profileId = 'default') {
  const list = bookmarksStore.get();
  const next = list.filter(b => !(b.id === id && ownerOf(b) === profileId));
  if (next.length === list.length) return false;
  bookmarksStore.set(next);
  events.broadcast('bookmark:changed', { id, profileId });
  return true;
}

/** Drop a deleted profile's bookmarks. Returns how many went. */
function removeProfileBookmarks(profileId) {
  const list = bookmarksStore.get();
  const next = list.filter(b => ownerOf(b) !== profileId);
  if (next.length !== list.length) bookmarksStore.set(next);
  return list.length - next.length;
}

// ---------------------------------------------------------------------------
// Podcasts (RSS feeds — episodes are downloaded like normal audio)
// ---------------------------------------------------------------------------
function getFeeds() {
  return podcastsStore.get();
}

function addFeed(feed) {
  const list = getFeeds();
  const existing = list.find(f => f.url === feed.url);
  if (existing) return existing;
  const entry = {
    id: shortId('feed'),
    url: feed.url,
    title: feed.title || feed.url,
    description: feed.description || '',
    artwork: feed.artwork || null,
    items: feed.items || [],
    autoDownload: !!feed.autoDownload,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  list.push(entry);
  podcastsStore.set(list);
  return entry;
}

function updateFeed(id, updates) {
  const list = getFeeds();
  const idx = list.findIndex(f => f.id === id);
  if (idx === -1) return null;
  // Skip undefined fields: PATCH {autoDownload} used to also send
  // title: undefined and wipe the feed's name.
  const defined = Object.fromEntries(Object.entries(updates || {}).filter(([, v]) => v !== undefined));
  list[idx] = { ...list[idx], ...defined, updatedAt: new Date().toISOString() };
  podcastsStore.set(list);
  return list[idx];
}

function removeFeed(id) {
  const list = getFeeds();
  const next = list.filter(f => f.id !== id);
  if (next.length === list.length) return false;
  podcastsStore.set(next);
  return true;
}

// ---------------------------------------------------------------------------
// Listening stats (for the Stats page)
// ---------------------------------------------------------------------------
function recordListen(itemId, seconds) {
  const secs = Math.max(0, Math.round(Number(seconds) || 0));
  if (!secs) return null;
  const store = listensStore.get();
  const today = new Date().toISOString().slice(0, 10);
  store.total[itemId] = (store.total[itemId] || 0) + secs;
  store.daily[today] = store.daily[today] || { seconds: 0, items: {} };
  store.daily[today].seconds += secs;
  store.daily[today].items[itemId] = (store.daily[today].items[itemId] || 0) + secs;
  // keep ~2 years of daily buckets
  const keys = Object.keys(store.daily).sort();
  if (keys.length > 730) keys.slice(0, keys.length - 730).forEach(k => delete store.daily[k]);
  listensStore.set(store);
  return store;
}

function getListens() {
  return listensStore.get();
}

function removeSeriesMarker(key) {
  const all = markersStore.get();
  if (!all[`series:${key}`]) return false;
  delete all[`series:${key}`];
  markersStore.set(all);
  return true;
}

/**
 * Point references to item `oldId` at `newId` (a moved file), or drop them
 * when `newId` is null (the item was removed). Called by
 * library.rewriteItemRefs.
 */
function rewriteItemRefs(oldId, newId = null) {
  if (!oldId || oldId === newId) return;

  const watchlist = watchlistStore.get();
  if (watchlist.some(w => w.itemId === oldId)) {
    const seen = new Set();
    const next = [];
    for (const w of watchlist) {
      const entry = w.itemId === oldId ? (newId ? { ...w, itemId: newId } : null) : w;
      if (!entry) continue;
      const key = `${entry.profileId || 'default'}\u0000${entry.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(entry);
    }
    watchlistStore.set(next);
  }

  const collections = collectionsStore.get();
  let collectionsChanged = false;
  for (const c of collections) {
    if (!Array.isArray(c.items) || !c.items.includes(oldId)) continue;
    c.items = [...new Set(newId ? c.items.map(i => (i === oldId ? newId : i)) : c.items.filter(i => i !== oldId))];
    collectionsChanged = true;
  }
  if (collectionsChanged) collectionsStore.set(collections);

  const markers = markersStore.get();
  if (Object.prototype.hasOwnProperty.call(markers, oldId)) {
    if (newId && !markers[newId]) markers[newId] = markers[oldId];
    delete markers[oldId];
    markersStore.set(markers);
  }

  const bookmarks = bookmarksStore.get();
  if (bookmarks.some(b => b.itemId === oldId)) {
    bookmarksStore.set(newId
      ? bookmarks.map(b => (b.itemId === oldId ? { ...b, itemId: newId } : b))
      : bookmarks.filter(b => b.itemId !== oldId));
  }

  // Listening stats: per-item totals follow the item; the daily listening
  // time itself stays (it still happened).
  const listens = listensStore.get();
  let listensChanged = false;
  const move = (bucket) => {
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, oldId)) return;
    if (newId) bucket[newId] = (bucket[newId] || 0) + bucket[oldId];
    delete bucket[oldId];
    listensChanged = true;
  };
  move(listens.total);
  for (const day of Object.values(listens.daily || {})) move(day.items);
  if (listensChanged) listensStore.set(listens);
}

async function flush() {
  await Promise.all([
    watchlistStore.flush(),
    collectionsStore.flush(),
    markersStore.flush(),
    bookmarksStore.flush(),
    podcastsStore.flush(),
    listensStore.flush(),
  ]);
}

module.exports = {
  getWatchlist,
  isInWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  removeProfileWatchlist,
  getCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addToCollection,
  removeFromCollection,
  getMarkers,
  setMarkers,
  getSeriesMarkers,
  setSeriesMarker,
  getBookmarks,
  addBookmark,
  removeBookmark,
  removeProfileBookmarks,
  removeSeriesMarker,
  rewriteItemRefs,
  getFeeds,
  addFeed,
  updateFeed,
  removeFeed,
  recordListen,
  getListens,
  flush,
};
