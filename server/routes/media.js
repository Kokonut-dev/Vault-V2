const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const libraryService = require('../services/library');
const metadataService = require('../services/metadata');
const thumbnailService = require('../services/thumbnail');
const logger = require('../utils/logger');
// Shared Range-aware streaming helper (moved to utils so the transcode cache
// route can reuse it — F-16).
const { sendFileWithRange } = require('../utils/fileUtils');

router.get('/stream/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (!fs.existsSync(item.path)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  // Update play count and history?
  // We'll let client explicitly POST to history

  sendFileWithRange(req, res, item.path);
});

router.get('/cover/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  let coverPath = item.coverArtPath || item.thumbnailPath;

  // For music, coverArtPath should exist if extracted
  // For video, use thumbnail
  if (coverPath && fs.existsSync(coverPath)) {
    const ct = mime.lookup(coverPath) || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(coverPath).pipe(res);
  } else {
    // No cover, return placeholder or 404
    res.status(404).json({ error: 'Cover not found' });
  }
});

router.get('/thumbnail/:id', async (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  let thumbPath = item.thumbnailPath;

  if (!thumbPath || !fs.existsSync(thumbPath)) {
    // Try to generate on demand for video
    if (item.type === 'movie' || item.type === 'video') {
      const time = req.query.time ? parseFloat(req.query.time) : null;
      if (time !== null && !isNaN(time)) {
        const outputPath = path.join(__dirname, '../cache/thumbnails', `${item.id}_t${time}.jpg`);
        if (fs.existsSync(outputPath)) {
          thumbPath = outputPath;
        } else {
          thumbPath = await thumbnailService.generateThumbnailAtTime(item.path, outputPath, time);
        }
      } else {
        thumbPath = await thumbnailService.getOrGenerateThumbnail(item.path, item.id);
      }
    }
  }

  if (thumbPath && fs.existsSync(thumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(thumbPath).pipe(res);
  } else {
    res.status(404).json({ error: 'Thumbnail not found' });
  }
});

router.get('/subtitle/:id/:subtitleId', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  let subtitleId = req.params.subtitleId;
  // Sanitize subtitleId to prevent path traversal — only allow safe chars, no .., no /
  if (typeof subtitleId !== 'string') return res.status(400).json({ error: 'Invalid subtitle id' });
  subtitleId = path.basename(subtitleId); // strip directory
  if (subtitleId.includes('..') || subtitleId.includes('/') || subtitleId.includes('\\')) {
    return res.status(400).json({ error: 'Invalid subtitle id' });
  }
  // Only allow alphanumeric, dash, underscore, dot, space, parentheses
  if (!/^[\w\-\.\s\(\)\[\]]+$/.test(subtitleId) && !/^[\w\-]+\.(vtt|srt|ass|ssa)$/i.test(subtitleId)) {
    // Still allow if it's a simple id from metadata, but block traversal
    if (subtitleId.length > 255) return res.status(400).json({ error: 'Invalid subtitle id' });
  }

  let subtitlePath = null;

  if (item.subtitles && Array.isArray(item.subtitles)) {
    const sub = item.subtitles.find(s => s.id === subtitleId || (s.path && s.path.includes(subtitleId)));
    if (sub && sub.path) {
      // Ensure subtitle path is inside same directory as media file (prevent traversal)
      const mediaDir = path.dirname(item.path);
      const resolved = path.resolve(sub.path);
      if (resolved.startsWith(path.resolve(mediaDir)) || resolved.startsWith(path.resolve(__dirname, '../cache'))) {
        subtitlePath = sub.path;
      }
    }
  }

  // Also try to find by direct file lookup (only in media dir)
  if (!subtitlePath) {
    const dir = path.dirname(item.path);
    const base = path.basename(item.path, path.extname(item.path));
    const possible = [
      path.join(dir, `${base}.vtt`),
      path.join(dir, `${base}.srt`),
      path.join(dir, subtitleId),
    ];
    for (const p of possible) {
      const resolved = path.resolve(p);
      // Must be inside media dir
      if (!resolved.startsWith(path.resolve(dir))) continue;
      if (fs.existsSync(p)) {
        subtitlePath = p;
        break;
      }
    }
  }

  if (!subtitlePath || !fs.existsSync(subtitlePath)) {
    return res.status(404).json({ error: 'Subtitle not found' });
  }

  const ext = path.extname(subtitlePath).toLowerCase();

  if (ext === '.vtt') {
    res.setHeader('Content-Type', 'text/vtt');
    fs.createReadStream(subtitlePath).pipe(res);
  } else if (ext === '.srt') {
    // Convert SRT to VTT on the fly (simple conversion)
    try {
      let content = fs.readFileSync(subtitlePath, 'utf-8');
      // Basic SRT to VTT conversion
      content = 'WEBVTT\n\n' + content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      res.setHeader('Content-Type', 'text/vtt');
      res.send(content);
    } catch (err) {
      res.status(500).json({ error: 'Failed to convert subtitle' });
    }
  } else {
    // For ASS/SSA, try to serve as is or convert via ffmpeg if available
    res.setHeader('Content-Type', 'text/plain');
    fs.createReadStream(subtitlePath).pipe(res);
  }
});

router.get('/info/:id', async (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  try {
    let probeData = null;
    if (item.type === 'music') {
      // Already have metadata
      probeData = {
        codec: item.codec,
        bitrate: item.bitrate,
        sampleRate: item.sampleRate,
        duration: item.duration,
        fileSize: item.fileSize,
        filePath: item.path,
        title: item.title,
        artist: item.artist,
        album: item.album,
      };
    } else {
      probeData = await metadataService.probeVideo(item.path);
      probeData.filePath = item.path;
      probeData.fileSize = item.fileSize;
      probeData.title = item.title;
    }

    res.json(probeData);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get media info', details: err.message });
  }
});

router.get('/subtitles/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  res.json({ subtitles: item.subtitles || [] });
});

module.exports = router;
