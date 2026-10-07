const express = require('express');
const router = express.Router();
const libraryService = require('../services/library');
const scannerService = require('../services/scanner');
const { sanitizeString } = require('../utils/validators');
const logger = require('../utils/logger');
const trash = require('../services/trash');
const extras = require('../services/extras');
const events = require('../services/events');
const sqlite = require('../services/sqliteIndex');
const { getConfig } = require('../config');

router.get('/', (req, res) => {
  try {
    const { type, search, genre, year, sort, order, page, limit, libraryId, watched, rating, count } = req.query;

    // SQL index path (opt-in): serves filtered/paged queries from SQLite when
    // configured, which is what keeps very large libraries responsive.
    const config = getConfig();
    if (config.media?.storage === 'sqlite' && count !== 'all') {
      const indexed = sqlite.query({
        type,
        search,
        genre,
        year,
        sort: sort || 'addedAt',
        order: order || 'desc',
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 50,
      });
      if (indexed) {
        return res.json({
          items: indexed.items,
          total: indexed.total,
          page: indexed.page,
          limit: indexed.limit,
          totalPages: Math.ceil(indexed.total / indexed.limit),
          storage: 'sqlite',
        });
      }
    }

    // F-14: always work on a copy — getAll() returns the live master array and
    // the sort below used to mutate it, making response order depend on
    // whatever a previous request left behind.
    let items = libraryService.getAll().slice();

    // Filter by type
    if (type && type !== 'all') {
      items = items.filter(i => i.type === type);
    }

    // Search — per-item haystacks are cached in the service (WeakMap),
    // so this no longer rebuilds a joined lowercase string per item per call.
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(item => libraryService.getSearchText(item).includes(q));
    }

    // Genre filter
    if (genre) {
      items = items.filter(i => {
        if (!i.genre) return false;
        if (Array.isArray(i.genre)) return i.genre.includes(genre);
        return i.genre === genre;
      });
    }

    // Year filter
    if (year) {
      const y = parseInt(year, 10);
      if (!isNaN(y)) {
        items = items.filter(i => i.year === y);
      }
    }

    // Library (named libraries), watched state, rating floor
    if (libraryId) {
      items = items.filter(i => i.libraryId === libraryId);
    }
    if (rating) {
      const min = parseFloat(rating);
      if (!isNaN(min)) items = items.filter(i => (i.rating || 0) >= min);
    }
    if (watched === 'true' || watched === 'false') {
      const map = libraryService.getWatchedMap(req.profileId || 'default');
      const want = watched === 'true';
      items = items.filter(i => !!map[i.id]?.watched === want);
    }

    // Sorting — decorate/sort/undecorate: each key is normalised once instead
    // of toLowerCase() inside the comparator (~2n·log n calls on 1000 items).
    const sortField = sort || 'addedAt';
    const sortOrder = order === 'asc' ? 1 : -1;
    const sortKey = (item) => {
      let v = item[sortField];
      if (v == null) return '';
      if (typeof v === 'string') return v.toLowerCase();
      return v;
    };
    items = items
      .map(item => ({ item, key: sortKey(item) }))
      .sort((a, b) => {
        if (a.key < b.key) return -1 * sortOrder;
        if (a.key > b.key) return 1 * sortOrder;
        return 0;
      })
      .map(entry => entry.item);

    // Pagination
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 50;
    const start = (pageNum - 1) * limitNum;
    const paginated = items.slice(start, start + limitNum);

    res.json({
      items: paginated,
      total: items.length,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(items.length / limitNum),
    });
  } catch (err) {
    logger.error('Library list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch library', code: 'LIBRARY_ERROR' });
  }
});

router.get('/stats', (req, res) => {
  try {
    const stats = libraryService.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

router.get('/genres', (req, res) => {
  try {
    const genres = libraryService.getGenres();
    res.json({ genres });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

router.get('/search', (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q) return res.json({ results: { movies: [], music: [], videos: [] }, query: '' });

    const all = libraryService.search(q, type || 'all');
    const results = {
      movies: all.filter(i => i.type === 'movie'),
      music: all.filter(i => i.type === 'music'),
      videos: all.filter(i => i.type === 'video'),
    };

    res.json({ results, query: q, total: all.length });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

router.post('/scan', async (req, res) => {
  try {
    const result = await scannerService.scanAll();
    res.json({ message: 'Scan complete', ...result });
  } catch (err) {
    res.status(500).json({ error: 'Scan failed', details: err.message });
  }
});

// Kick off a background scan and return immediately — the UI tracks it through
// /api/system/jobs (and the SSE job:* events).
router.post('/scan/background', (req, res) => {
  if (scannerService.isScanning?.()) {
    return res.status(409).json({ error: 'Scan already running', code: 'SCAN_RUNNING' });
  }
  scannerService.scanAll().catch(err => logger.error('Background scan failed:', err.message));
  res.json({ message: 'Scan started', background: true });
});

// Named libraries (Plex/Jellyfin style).
router.get('/libraries', (req, res) => {
  res.json({ libraries: scannerService.getLibraries() });
});

// Recent additions since a timestamp — used by the live-update toasts.
router.get('/recent', (req, res) => {
  const since = req.query.since ? new Date(req.query.since).getTime() : Date.now() - 7 * 86400000;
  const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
  const items = libraryService.getAll()
    .filter(i => i.addedAt && new Date(i.addedAt).getTime() >= since)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .slice(0, limit);
  res.json({ items, total: items.length, since: new Date(since).toISOString() });
});

router.get('/:id', (req, res) => {
  try {
    const item = libraryService.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });

    const profileId = req.profileId || 'default';
    const markers = extras.getMarkers(item.id);
    res.json({
      ...item,
      isFavourite: libraryService.isFavourite(item.id),
      inWatchlist: extras.getWatchlist().some(w => w.itemId === item.id && (w.profileId || 'default') === profileId),
      watched: libraryService.isWatched(item.id, profileId),
      markers: {
        ...markers,
        chapters: (markers.chapters && markers.chapters.length) ? markers.chapters : (item.chapters || []),
      },
      bookmarks: extras.getBookmarks(item.id),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch item' });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { title, artist, album, genre, year, description, rating, tags, season, episode } = req.body;
    const updates = {};

    if (title !== undefined) updates.title = sanitizeString(title, 500);
    if (artist !== undefined) updates.artist = sanitizeString(artist, 500);
    if (album !== undefined) updates.album = sanitizeString(album, 500);
    if (genre !== undefined) updates.genre = sanitizeString(genre, 200);
    if (description !== undefined) updates.description = sanitizeString(description, 2000);
    if (year !== undefined) {
      const y = parseInt(year, 10);
      if (!isNaN(y) && y >= 1900 && y <= 2100) updates.year = y;
    }
    if (rating !== undefined) {
      const r = parseFloat(rating);
      if (!isNaN(r) && r >= 0 && r <= 5) updates.rating = r;
    }
    if (tags !== undefined && Array.isArray(tags)) {
      updates.tags = tags.map(t => sanitizeString(t, 100)).filter(Boolean).slice(0, 20);
    }
    if (season !== undefined) {
      const s = parseInt(season, 10);
      if (!isNaN(s)) updates.season = s;
    }
    if (episode !== undefined) {
      const e = parseInt(episode, 10);
      if (!isNaN(e)) updates.episode = e;
    }

    const updated = libraryService.updateItem(req.params.id, updates);
    if (!updated) return res.status(404).json({ error: 'Item not found' });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update item' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { deleteFile, permanent } = req.query;
    const item = libraryService.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const fs = require('fs-extra');
    let trashEntry = null;

    if (deleteFile === 'true') {
      const config = getConfig();
      const useTrash = permanent !== 'true' && config.media?.trash?.enabled !== false;
      try {
        if (fs.existsSync(item.path)) {
          if (useTrash) {
            // Soft delete: move to data/trash so it can be restored (undo).
            trashEntry = await trash.moveToTrash(item.path, {
              type: item.type,
              title: item.title,
              itemId: item.id,
              retentionDays: config.media?.trash?.retentionDays ?? 30,
            });
          } else {
            await fs.remove(item.path);
            logger.info(`Deleted file: ${item.path}`);
          }
        }
      } catch (err) {
        logger.warn(`Failed to delete file ${item.path}: ${err.message}`);
      }
    }

    libraryService.removeItem(req.params.id);
    sqlite.remove(req.params.id);
    events.broadcast('library:changed', { reason: 'delete', id: req.params.id, title: item.title });

    res.json({
      message: trashEntry ? 'Moved to trash' : 'Item deleted',
      trashId: trashEntry?.id || null,
      restorable: !!trashEntry,
      retentionDays: trashEntry?.retentionDays ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

module.exports = router;
