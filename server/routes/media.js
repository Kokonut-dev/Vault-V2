const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const libraryService = require('../services/library');
const metadataService = require('../services/metadata');
const thumbnailService = require('../services/thumbnail');
const extrasService = require('../services/extras');
const transcodePlan = require('../services/transcodePlan');
const events = require('../services/events');
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

router.get('/cover/:id', async (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  // Artwork priority: explicit poster/backdrop sidecar → embedded cover → frame.
  const poster = item.posterPath && fs.existsSync(item.posterPath) ? item.posterPath : null;
  const cover = item.coverArtPath && fs.existsSync(item.coverArtPath) ? item.coverArtPath : null;
  const source = req.query.kind === 'backdrop'
    ? (item.backdropPath && fs.existsSync(item.backdropPath) ? item.backdropPath : null) || cover || poster || item.thumbnailPath
    : poster || cover || (item.thumbnailPath && fs.existsSync(item.thumbnailPath) ? item.thumbnailPath : null);

  if (!source || !fs.existsSync(source)) {
    return res.status(404).json({ error: 'Cover not found' });
  }

  // `?size=` serves a resized copy so grids don't pull multi-megabyte art.
  const size = parseInt(req.query.size, 10);
  if (size && size > 0) {
    const resized = await thumbnailService.getOrGenerateResizedImage(source, item.id, Math.min(2048, size));
    if (resized) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return fs.createReadStream(resized).pipe(res);
    }
  }

  res.setHeader('Content-Type', mime.lookup(source) || 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(source).pipe(res);
});

// Poster / backdrop / trailer / extras for the detail hero.
router.get('/artwork/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json({
    poster: item.posterPath ? `/api/media/cover/${item.id}` : (item.thumbnailPath ? `/api/media/thumbnail/${item.id}` : null),
    backdrop: item.backdropPath ? `/api/media/cover/${item.id}?kind=backdrop` : (item.thumbnailPath ? `/api/media/thumbnail/${item.id}` : null),
    trailer: item.trailerPath ? `/api/media/trailer/${item.id}` : null,
    extras: (item.extras || []).map((extra, index) => ({
      title: extra.title,
      kind: extra.kind,
      url: `/api/media/extra/${item.id}/${index}`,
    })),
  });
});

router.get('/trailer/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item?.trailerPath || !fs.existsSync(item.trailerPath)) {
    return res.status(404).json({ error: 'No trailer for this item' });
  }
  return require('../utils/fileUtils').sendFileWithRange(req, res, item.trailerPath);
});

router.get('/extra/:id/:index', (req, res) => {
  const item = libraryService.getById(req.params.id);
  const extra = item?.extras?.[parseInt(req.params.index, 10)];
  if (!extra || !fs.existsSync(extra.path)) return res.status(404).json({ error: 'Extra not found' });
  return require('../utils/fileUtils').sendFileWithRange(req, res, extra.path);
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

// Trickplay storyboards for scrub previews.
router.get('/trickplay/:id', (req, res) => {
  const manifest = thumbnailService.getTrickplayManifest(req.params.id);
  if (!manifest) return res.status(404).json({ error: 'No trickplay for this item' });
  res.json({
    ...manifest,
    sheets: Array.from({ length: manifest.sheets }, (_, i) => `/api/media/trickplay/${req.params.id}/${i}`),
  });
});

router.get('/trickplay/:id/:sheet', (req, res) => {
  const file = thumbnailService.getTrickplaySheetPath(req.params.id, parseInt(req.params.sheet, 10));
  if (!file) return res.status(404).json({ error: 'Sprite not found' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  fs.createReadStream(file).pipe(res);
});

// Lyrics (sidecar .lrc / embedded), served for the Now Playing view.
router.get('/lyrics/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (!item.lyricsPath || !fs.existsSync(item.lyricsPath)) {
    return res.json({ id: item.id, synced: false, lyrics: null, lines: [] });
  }
  const raw = fs.readFileSync(item.lyricsPath, 'utf8');
  const lines = raw.split(/\r?\n/).map(line => {
    const timestamp = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]/);
    if (!timestamp) return null;
    const seconds = Number(timestamp[1]) * 60 + Number(timestamp[2]);
    return { time: seconds, text: line.replace(/^\[\d+:\d+(?:\.\d+)?\]/, '').trim() };
  }).filter(l => l && l.text);
  res.json({
    id: item.id,
    synced: !!item.lyricsSynced && lines.length > 0,
    lyrics: lines.length ? null : raw,
    lines,
  });
});

// Chapters for the player timeline.
router.get('/chapters/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const markers = extrasService.getMarkers(item.id);
  res.json({
    chapters: (markers.chapters && markers.chapters.length) ? markers.chapters : (item.chapters || []),
    intro: markers.intro || extrasService.getSeriesMarkers(item.seriesKey)?.intro || null,
    outro: markers.outro || extrasService.getSeriesMarkers(item.seriesKey)?.outro || null,
    source: markers.source || (item.chapters?.length ? 'file' : null),
  });
});

// Playback plan: direct play vs transcode + why ("stats for nerds").
router.get('/plan/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json(transcodePlan.plan(item, req.query.quality || 'auto'));
});

// Media sources (subtitles, audio tracks, quality ladder) for the player menus.
router.get('/sources/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json({
    subtitles: (item.subtitles || []).map(s => ({
      id: s.id,
      label: s.label || s.language || 'Subtitle',
      language: s.language || 'unknown',
      forced: !!s.forced,
      default: !!s.default,
      url: `/api/media/subtitle/${item.id}/${encodeURIComponent(s.id)}`,
    })),
    audio: item.audioTracks || [],
    qualities: transcodePlan.QUALITY_LADDER.filter(q => !q.height || q.height <= Math.max(1080, item.height || 1080)).map(q => q.name),
    hdr: !!item.hdr,
    fourK: !!item.fourK,
  });
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
