const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const libraryService = require('../services/library');
const transcoderService = require('../services/transcoder');
const logger = require('../utils/logger');

router.get('/audio/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (!fs.existsSync(item.path)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const { codec = 'aac', bitrate = '128k' } = req.query;
  transcoderService.transcodeAudioStream(item.path, res, { codec, bitrate });
});

router.get('/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (!fs.existsSync(item.path)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  const { quality = '720p', format = 'mp4', audioCodec = 'aac' } = req.query;

  // Check cache first
  const cachePath = transcoderService.getCachePath(item.id, quality, format);
  if (fs.existsSync(cachePath)) {
    logger.info(`Serving cached transcode: ${cachePath}`);
    const stat = fs.statSync(cachePath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    return fs.createReadStream(cachePath).pipe(res);
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
