const express = require('express');
const router = express.Router();
const libraryService = require('../services/library');
const { sanitizeString } = require('../utils/validators');

router.get('/', (req, res) => {
  try {
    const playlists = libraryService.getPlaylists();
    // Expand items count, not full items for list view
    const withCounts = playlists.map(p => ({
      ...p,
      itemCount: p.items.length,
    }));
    res.json({ playlists: withCounts });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

router.get('/favourites', (req, res) => {
  try {
    const favs = libraryService.getFavourites();
    res.json({ items: favs, total: favs.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch favourites' });
  }
});

router.post('/favourites/:id', (req, res) => {
  try {
    const item = libraryService.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    libraryService.addFavourite(req.params.id);
    res.json({ favourited: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add favourite' });
  }
});

router.delete('/favourites/:id', (req, res) => {
  try {
    libraryService.removeFavourite(req.params.id);
    res.json({ favourited: false, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove favourite' });
  }
});

router.get('/history', (req, res) => {
  try {
    const history = libraryService.getHistory();
    // Expand with item details
    const expanded = history.map(h => ({
      ...h,
      item: libraryService.getById(h.itemId),
    })).filter(h => h.item);
    res.json({ history: expanded, total: expanded.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

router.post('/history', (req, res) => {
  try {
    const { itemId, progress, duration, completed } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const entry = libraryService.addHistoryEntry({ itemId, progress, duration, completed });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add history' });
  }
});

router.delete('/history', (req, res) => {
  try {
    libraryService.clearHistory();
    res.json({ message: 'History cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const playlist = libraryService.getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    // Expand items
    const items = playlist.items.map(id => libraryService.getById(id)).filter(Boolean);
    res.json({ ...playlist, itemsExpanded: items });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, description, type, items } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const playlist = libraryService.createPlaylist({
      name: sanitizeString(name, 200),
      description: description ? sanitizeString(description, 1000) : '',
      type: type === 'collection' ? 'collection' : 'playlist',
      items: Array.isArray(items) ? items : [],
    });

    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { name, description, items } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = sanitizeString(name, 200);
    if (description !== undefined) updates.description = sanitizeString(description, 1000);
    if (items !== undefined && Array.isArray(items)) updates.items = items;

    const updated = libraryService.updatePlaylist(req.params.id, updates);
    if (!updated) return res.status(404).json({ error: 'Playlist not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const ok = libraryService.deletePlaylist(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ message: 'Playlist deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

router.post('/:id/items', (req, res) => {
  try {
    const { itemId } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });

    const playlist = libraryService.getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    if (!playlist.items.includes(itemId)) {
      playlist.items.push(itemId);
      libraryService.updatePlaylist(playlist.id, { items: playlist.items });
    }

    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add item to playlist' });
  }
});

router.delete('/:id/items/:itemId', (req, res) => {
  try {
    const playlist = libraryService.getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    playlist.items = playlist.items.filter(id => id !== req.params.itemId);
    libraryService.updatePlaylist(playlist.id, { items: playlist.items });

    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove item from playlist' });
  }
});

module.exports = router;
