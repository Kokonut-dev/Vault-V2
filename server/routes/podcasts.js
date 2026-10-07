const express = require('express');
const router = express.Router();
const podcasts = require('../services/podcasts');
const extras = require('../services/extras');
const libraryService = require('../services/library');
const logger = require('../utils/logger');

router.get('/feeds', (req, res) => {
  const feeds = extras.getFeeds().map(feed => ({
    ...feed,
    items: (feed.items || []).map(item => ({
      ...item,
      downloaded: !!(item.localPath && libraryService.getById(require('crypto').createHash('md5').update(item.localPath).digest('hex'))),
      localItemId: item.localPath ? require('crypto').createHash('md5').update(item.localPath).digest('hex') : null,
    })),
    episodeCount: (feed.items || []).length,
  }));
  res.json({ feeds, total: feeds.length });
});

router.post('/feeds', async (req, res) => {
  const { url, autoDownload } = req.body || {};
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'A valid feed URL is required' });
  try {
    const feed = await podcasts.subscribe(url, { autoDownload });
    res.json(feed);
  } catch (err) {
    logger.warn(`[Podcast] subscribe failed: ${err.message}`);
    res.status(400).json({ error: `Could not read feed: ${err.message}` });
  }
});

router.get('/feeds/:id', (req, res) => {
  const feed = extras.getFeeds().find(f => f.id === req.params.id);
  if (!feed) return res.status(404).json({ error: 'Feed not found' });
  res.json(feed);
});

router.post('/feeds/:id/refresh', async (req, res) => {
  try {
    const feed = await podcasts.refreshFeed(req.params.id);
    if (!feed) return res.status(404).json({ error: 'Feed not found' });
    res.json(feed);
  } catch (err) {
    res.status(502).json({ error: `Refresh failed: ${err.message}` });
  }
});

router.post('/refresh', async (req, res) => {
  const results = await podcasts.refreshAll();
  res.json({ message: `Refreshed ${results.length} feed(s)`, results });
});

router.patch('/feeds/:id', (req, res) => {
  const feed = extras.updateFeed(req.params.id, {
    autoDownload: req.body?.autoDownload,
    title: req.body?.title,
  });
  if (!feed) return res.status(404).json({ error: 'Feed not found' });
  res.json(feed);
});

router.delete('/feeds/:id', (req, res) => {
  const ok = extras.removeFeed(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Feed not found' });
  res.json({ message: 'Feed removed', id: req.params.id });
});

router.post('/feeds/:id/episodes/:guid/download', async (req, res) => {
  try {
    const result = await podcasts.downloadEpisode(req.params.id, decodeURIComponent(req.params.guid));
    res.json({ message: 'Episode downloaded', ...result });
  } catch (err) {
    logger.warn(`[Podcast] download failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
