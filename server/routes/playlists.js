const express = require('express');
const path = require('path');
const router = express.Router();
const libraryService = require('../services/library');
const extras = require('../services/extras');
const events = require('../services/events');
const { sanitizeString } = require('../utils/validators');

// Every route in here is profile-scoped: the default profile keeps using the
// original flat data files, extra profiles get their own copies.
function scoped(req) {
  return libraryService.forProfile(req.profileId || 'default');
}

router.get('/', (req, res) => {
  try {
    const playlists = scoped(req).getPlaylists();
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
    const favs = scoped(req).getFavourites();
    res.json({ items: favs, total: favs.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch favourites' });
  }
});

router.post('/favourites/:id', (req, res) => {
  try {
    const item = libraryService.getById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    scoped(req).addFavourite(req.params.id);
    res.json({ favourited: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add favourite' });
  }
});

router.delete('/favourites/:id', (req, res) => {
  try {
    scoped(req).removeFavourite(req.params.id);
    res.json({ favourited: false, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove favourite' });
  }
});

router.get('/history', (req, res) => {
  try {
    const history = scoped(req).getHistory();
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
    const { itemId, progress, duration, completed, bumpPlayCount, seconds } = req.body;
    if (!itemId) return res.status(400).json({ error: 'itemId required' });
    const entry = scoped(req).addHistoryEntry({ itemId, progress, duration, completed, bumpPlayCount });

    // Watch/listen time feeds the stats page and the scrobbler.
    if (seconds) extras.recordListen(itemId, seconds);
    if (bumpPlayCount) {
      const item = libraryService.getById(itemId);
      if (item) {
        events.broadcast('playback:started', { id: itemId, title: item.title });
        require('../services/notifications').nowPlaying(item).catch(() => {});
      }
    }
    if (completed) {
      const item = libraryService.getById(itemId);
      if (item) require('../services/notifications').scrobble(item).catch(() => {});
    }
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add history' });
  }
});

router.delete('/history', (req, res) => {
  try {
    scoped(req).clearHistory();
    res.json({ message: 'History cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const playlist = scoped(req).getPlaylistById(req.params.id);
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

    const playlist = scoped(req).createPlaylist({
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

    const updated = scoped(req).updatePlaylist(req.params.id, updates);
    if (!updated) return res.status(404).json({ error: 'Playlist not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const ok = scoped(req).deletePlaylist(req.params.id);
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

    const playlist = scoped(req).getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    if (!playlist.items.includes(itemId)) {
      playlist.items.push(itemId);
      scoped(req).updatePlaylist(playlist.id, { items: playlist.items });
    }

    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add item to playlist' });
  }
});

// Drag & drop reordering (queue order is the whole point of a playlist).
router.put('/:id/order', (req, res) => {
  try {
    const { items, from, to } = req.body || {};
    const playlist = scoped(req).getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    let next = Array.isArray(items) ? items : [...playlist.items];
    if (!Array.isArray(items) && Number.isInteger(from) && Number.isInteger(to)) {
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
    }
    const updated = scoped(req).updatePlaylist(playlist.id, { items: next });
    events.broadcast('playlist:changed', { id: playlist.id, action: 'reorder' });
    res.json({ ...updated, itemsExpanded: updated.items.map(id => libraryService.getById(id)).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reorder playlist' });
  }
});

// Export as M3U (works in VLC, Plex, Navidrome, foobar2000…).
router.get('/:id/export', (req, res) => {
  const playlist = scoped(req).getPlaylistById(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  const lines = ['#EXTM3U'];
  for (const id of playlist.items) {
    const item = libraryService.getById(id);
    if (!item) continue;
    const seconds = Math.round(item.duration || 0);
    lines.push(`#EXTINF:${seconds},${item.artist ? `${item.artist} - ` : ''}${item.title}`);
    lines.push(item.path);
  }
  res.setHeader('Content-Type', 'audio/x-mpegurl');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizeString(playlist.name, 60) || 'playlist'}.m3u"`);
  res.send(lines.join('\n'));
});

// Import an .m3u by matching file paths against the library index.
router.post('/import', (req, res) => {
  try {
    const { name, content, paths } = req.body || {};
    const entries = Array.isArray(paths) ? paths : String(content || '').split(/\r?\n/);
    const matched = [];
    const all = libraryService.getAll();
    for (const raw of entries) {
      const line = String(raw).trim();
      if (!line || line.startsWith('#')) continue;
      const hit = all.find(i => i.path === line || i.path.endsWith(line) || path.basename(i.path) === path.basename(line));
      if (hit) matched.push(hit.id);
    }
    const playlist = scoped(req).createPlaylist({ name: name || 'Imported playlist', items: matched });
    res.json({ ...playlist, matched: matched.length, missed: entries.filter(e => e.trim() && !e.startsWith('#')).length - matched.length });
  } catch (err) {
    res.status(500).json({ error: 'Import failed' });
  }
});

// Total runtime + duplicate report for the playlist header.
router.get('/:id/stats', (req, res) => {
  const playlist = scoped(req).getPlaylistById(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  const items = (playlist.items || []).map(id => libraryService.getById(id)).filter(Boolean);
  const titles = new Map();
  for (const item of items) {
    const key = `${item.title}|${item.artist || ''}`;
    titles.set(key, (titles.get(key) || 0) + 1);
  }
  res.json({
    count: items.length,
    duration: Math.round(items.reduce((sum, i) => sum + (i.duration || 0), 0)),
    size: items.reduce((sum, i) => sum + (i.fileSize || 0), 0),
    duplicates: [...titles.entries()].filter(([, n]) => n > 1).map(([key, n]) => ({ key, count: n })),
    types: items.reduce((acc, i) => ({ ...acc, [i.type]: (acc[i.type] || 0) + 1 }), {}),
  });
});

router.delete('/:id/items/:itemId', (req, res) => {
  try {
    const playlist = scoped(req).getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    playlist.items = playlist.items.filter(id => id !== req.params.itemId);
    scoped(req).updatePlaylist(playlist.id, { items: playlist.items });

    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove item from playlist' });
  }
});

module.exports = router;
