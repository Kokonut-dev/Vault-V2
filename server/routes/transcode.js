const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const libraryService = require('../services/library');
const transcoderService = require('../services/transcoder');
const logger = require('../utils/logger');
const { sendFileWithRange } = require('../utils/fileUtils');
const hls = require('../services/hls');
const transcodePlan = require('../services/transcodePlan');

router.get('/audio/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (!fs.existsSync(item.path)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const { codec = 'aac', bitrate = '128k' } = req.query;
  transcoderService.transcodeAudioStream(item.path, res, { codec, bitrate });
});

// --- HLS / adaptive streaming ---------------------------------------------
router.get('/hls/:id/master.m3u8', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item || !fs.existsSync(item.path)) return res.status(404).json({ error: 'Item not found' });
  const variants = hls.variantsFor(item);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(hls.masterPlaylist(item, variants));
});

router.get('/hls/:id/:variant/index.m3u8', async (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item || !fs.existsSync(item.path)) return res.status(404).json({ error: 'Item not found' });
  const playlist = await hls.variantPlaylist(item, req.params.variant);
  if (!playlist) return res.status(503).json({ error: 'Transcoder did not produce a playlist', code: 'HLS_UNAVAILABLE' });
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(playlist);
});

router.get('/hls/:id/:variant/:file', (req, res) => {
  const file = hls.segmentPath(req.params.id, req.params.variant, req.params.file);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'Segment not found' });
  res.setHeader('Content-Type', req.params.file.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=600');
  return sendFileWithRange(req, res, file);
});

router.get('/hls/status', (req, res) => res.json(hls.status()));

router.delete('/hls/cache', async (req, res) => {
  const removed = await hls.clearCache();
  res.json({ message: `Cleared ${removed} HLS session(s)`, removed });
});

router.get('/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (!fs.existsSync(item.path)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const { quality = '720p', format = 'mp4', audioCodec = 'aac', plan: wantPlan } = req.query;

  // `?plan=true` returns what would happen instead of streaming (stats panel).
  if (wantPlan === 'true') {
    return res.json(transcodePlan.plan(item, quality));
  }

  // Check cache first — serve through the shared Range-aware helper so
  // seeking in a cached transcode returns proper 206 responses (F-16).
  const cachePath = transcoderService.getCachePath(item.id, quality, format);
  if (fs.existsSync(cachePath)) {
    logger.info(`Serving cached transcode: ${cachePath}`);
    return sendFileWithRange(req, res, cachePath);
  }

  // Stream transcode
  transcoderService.transcodeStream(item.path, res, { quality, format, audioCodec });
});

router.delete('/cache', async (req, res) => {
  try {
    const { getConfig } = require('../config');
    const config = getConfig();
    const cacheDir = config.media.transcoding.cacheDir;
    if (fs.existsSync(cacheDir)) {
      const files = await fs.readdir(cacheDir);
      let deleted = 0;
      for (const file of files) {
        try {
          await fs.remove(path.join(cacheDir, file));
          deleted++;
        } catch {}
      }
      res.json({ message: `Cleared ${deleted} cached files` });
    } else {
      res.json({ message: 'Cache already empty' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to clear cache', details: err.message });
  }
});

module.exports = router;
