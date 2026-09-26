const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const libraryService = require('../services/library');
const metadataService = require('../services/metadata');
const thumbnailService = require('../services/thumbnail');
const logger = require('../utils/logger');

function sendFileWithRange(req, res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    const contentType = mime.lookup(filePath) || 'application/octet-stream';

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    logger.error(`Failed to stream ${filePath}: ${err.message}`);
    res.status(404).json({ error: 'File not found' });
  }
}

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

  const subtitleId = req.params.subtitleId;
  let subtitlePath = null;

  if (item.subtitles && Array.isArray(item.subtitles)) {
    const sub = item.subtitles.find(s => s.id === subtitleId || s.path.includes(subtitleId));
    if (sub) subtitlePath = sub.path;
  }

  // Also try to find by direct file lookup
  if (!subtitlePath) {
    const dir = path.dirname(item.path);
    const base = path.basename(item.path, path.extname(item.path));
    const possible = [
      path.join(dir, `${base}.vtt`),
      path.join(dir, `${base}.srt`),
      path.join(dir, subtitleId),
    ];
    for (const p of possible) {
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
