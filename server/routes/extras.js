/**
 * Watchlist, collections, markers (intro/outro/chapters), bookmarks, watched
 * state, watch/listen stats and the trash.
 */
const express = require('express');
const router = express.Router();
const extras = require('../services/extras');
const libraryService = require('../services/library');
const trash = require('../services/trash');
const stats = require('../services/stats');
const events = require('../services/events');
const logger = require('../utils/logger');
const profiles = require('../services/profiles');
const { itemParam, blockRestricted } = require('../middleware/profileAccess');
const { requireAdmin } = require('../middleware/requireAdmin');

/** Age-limit check for routes keyed by a library item id (404 when hidden). */
const visibleItem = (key = 'id') => (req, res, next) => itemParam(req, res, next, req.params[key] ?? req.body?.itemId);

// ---------------------------------------------------------------------------
// Watchlist
// ---------------------------------------------------------------------------
router.get('/watchlist', (req, res) => {
  const profileId = req.profileId || 'default';
  const entries = extras.getWatchlist().filter(w => (w.profileId || 'default') === profileId);
  const items = profiles.filterItems(profileId, entries.map(e => {
    const item = libraryService.getById(e.itemId);
    return item ? { ...item, addedAtWatchlist: e.addedAt } : null;
  }).filter(Boolean));
  res.json({ items, total: items.length });
});

router.post('/watchlist/:id', visibleItem(), (req, res) => {
  const added = extras.addToWatchlist(req.params.id, req.profileId || 'default');
  res.json({ itemId: req.params.id, inWatchlist: true, added });
});

router.delete('/watchlist/:id', (req, res) => {
  const removed = extras.removeFromWatchlist(req.params.id, req.profileId || 'default');
  res.json({ itemId: req.params.id, inWatchlist: false, removed });
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
function expandCollection(collection, profileId = 'default') {
  if (!collection) return null;
  // Collections are shared; an age-limited profile sees only its part.
  const items = profiles.filterItems(profileId, (collection.items || []).map(id => libraryService.getById(id)).filter(Boolean));
  return { ...collection, items, itemIds: collection.items || [], count: items.length };
}

router.get('/collections', (req, res) => {
  const collections = extras.getCollections().map(c => expandCollection(c, req.profileId));
  res.json({ collections, total: collections.length });
});

router.get('/collections/:id', (req, res) => {
  const collection = expandCollection(extras.getCollection(req.params.id), req.profileId);
  if (!collection) return res.status(404).json({ error: 'Collection not found' });
  res.json(collection);
});

router.post('/collections', blockRestricted, (req, res) => {
  try {
    const collection = extras.createCollection(req.body || {});
    events.broadcast('collection:changed', { id: collection.id, action: 'create' });
    res.json(expandCollection(collection, req.profileId));
  } catch (err) {
    logger.warn(`[Collections] create failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

router.put('/collections/:id', blockRestricted, (req, res) => {
  const updated = extras.updateCollection(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Collection not found' });
  res.json(expandCollection(updated, req.profileId));
});

router.delete('/collections/:id', blockRestricted, (req, res) => {
  const ok = extras.deleteCollection(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Collection not found' });
  res.json({ message: 'Collection deleted', id: req.params.id });
});

router.post('/collections/:id/items', blockRestricted, (req, res) => {
  const { itemId, itemIds } = req.body || {};
  const added = extras.addToCollection(req.params.id, itemIds || itemId);
  if (!added) return res.status(404).json({ error: 'Collection not found' });
  res.json(expandCollection(added, req.profileId));
});

router.delete('/collections/:id/items/:itemId', blockRestricted, (req, res) => {
  const updated = extras.removeFromCollection(req.params.id, req.params.itemId);
  if (!updated) return res.status(404).json({ error: 'Collection not found' });
  res.json(expandCollection(updated, req.profileId));
});

// ---------------------------------------------------------------------------
// Markers (intro / outro / chapters) — manual edits always win
// ---------------------------------------------------------------------------
router.get('/markers/:id', visibleItem(), (req, res) => {
  const item = libraryService.getById(req.params.id);
  const markers = extras.getMarkers(req.params.id);
  res.json({
    ...markers,
    // Chapters come from the file itself (ffprobe) unless manually overridden.
    chapters: markers.chapters && markers.chapters.length ? markers.chapters : (item?.chapters || []),
    source: markers.source || (item?.chapters?.length ? 'file' : null),
  });
});

// Markers are shared by every profile (and copied to the whole series).
router.put('/markers/:id', blockRestricted, visibleItem(), (req, res) => {
  const { intro, outro, chapters, source = 'manual' } = req.body || {};
  const patch = {};
  if (intro !== undefined) patch.intro = intro;
  if (outro !== undefined) patch.outro = outro;
  if (chapters !== undefined) patch.chapters = chapters;
  patch.source = source;
  const markers = extras.setMarkers(req.params.id, patch);

  // Remember the intro for the whole series so the next episode doesn't need
  // detecting again (this is what Plex does).
  const item = libraryService.getById(req.params.id);
  if (item?.seriesKey && (intro || outro)) {
    extras.setSeriesMarker(item.seriesKey, markers.intro, markers.outro);
  }
  res.json(markers);
});

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------
router.get('/bookmarks', (req, res) => {
  const itemId = req.query.itemId;
  // Only bookmarks on items this profile may see.
  const bookmarks = extras.getBookmarks(itemId, req.profileId || 'default').filter((b) => {
    const item = libraryService.getById(b.itemId);
    return !item || profiles.canAccess(req.profileId || 'default', item);
  });
  res.json({ bookmarks });
});

router.post('/bookmarks', visibleItem(), (req, res) => {
  const { itemId, time, label } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  res.json(extras.addBookmark({ itemId, time, label }, req.profileId || 'default'));
});

router.delete('/bookmarks/:id', (req, res) => {
  // Only the profile's own bookmarks; anyone else's is "not found".
  const ok = extras.removeBookmark(req.params.id, req.profileId || 'default');
  if (!ok) return res.status(404).json({ error: 'Bookmark not found' });
  res.json({ message: 'Bookmark removed', id: req.params.id });
});

// ---------------------------------------------------------------------------
// Watched state
// ---------------------------------------------------------------------------
router.post('/watched/:id', visibleItem(), (req, res) => {
  const profileId = req.profileId || 'default';
  const watched = req.body?.watched !== false;
  const result = libraryService.setWatched(req.params.id, watched, profileId);
  if (!result) return res.status(404).json({ error: 'Item not found' });
  events.broadcast('watched:changed', { itemId: req.params.id, watched, profileId });
  res.json(result);
});

router.get('/watched', (req, res) => {
  const profileId = req.profileId || 'default';
  res.json({ watched: libraryService.getWatchedMap(profileId) });
});

// ---------------------------------------------------------------------------
// Listening / watching stats
// ---------------------------------------------------------------------------
router.post('/listens', visibleItem(), (req, res) => {
  const { itemId, seconds } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const result = extras.recordListen(itemId, seconds);
  res.json({ ok: !!result, itemId });
});

router.get('/stats/recap', (req, res) => {
  res.json(stats.build({ period: req.query.period || 'all', profileId: req.profileId || 'default' }));
});

// ---------------------------------------------------------------------------
// Trash (undo-able deletes)
// ---------------------------------------------------------------------------
// The trash holds deleted files of every library: admin profiles only.
router.get('/trash', requireAdmin, (req, res) => {
  res.json({ items: trash.list(), total: trash.list().length });
});

router.post('/trash/:id/restore', requireAdmin, async (req, res) => {
  const restored = await trash.restore(req.params.id);
  if (!restored) return res.status(404).json({ error: 'Trash entry not found' });
  try {
    const scanner = require('../services/scanner');
    await scanner.scanFile(restored.restoredTo);
    events.broadcast('library:changed', { reason: 'restore', path: restored.restoredTo });
  } catch {}
  res.json({ message: 'Restored', ...restored });
});

router.delete('/trash/:id', requireAdmin, async (req, res) => {
  const ok = await trash.purge(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Trash entry not found' });
  res.json({ message: 'Permanently deleted', id: req.params.id });
});

router.delete('/trash', requireAdmin, async (req, res) => {
  const removed = await trash.empty();
  res.json({ message: `Emptied trash (${removed} files)`, removed });
});

module.exports = router;
