const express = require('express');
const router = express.Router();
const libraryService = require('../services/library');
const scannerService = require('../services/scanner');
const { sanitizeString } = require('../utils/validators');
const logger = require('../utils/logger');

router.get('/', (req, res) => {
  try {
    const { type, search, genre, year, sort, order, page, limit } = req.query;
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

router.get('/:id', (req, res) => {
  try {
    const item = libraryService.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });

    // Add favourite status
    const isFav = libraryService.isFavourite(item.id);
    res.json({ ...item, isFavourite: isFav });
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

router.delete('/:id', (req, res) => {
  try {
    const { deleteFile } = req.query;
    const item = libraryService.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    if (deleteFile === 'true') {
      const fs = require('fs-extra');
      try {
        if (fs.existsSync(item.path)) {
          fs.removeSync(item.path);
          logger.info(`Deleted file: ${item.path}`);
        }
      } catch (err) {
        logger.warn(`Failed to delete file ${item.path}: ${err.message}`);
      }
    }

    libraryService.removeItem(req.params.id);
    res.json({ message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

module.exports = router;
