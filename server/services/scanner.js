const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const crypto = require('crypto');
const { getConfig } = require('../config');
const libraryService = require('./library');
const metadataService = require('./metadata');
const thumbnailService = require('./thumbnail');
const logger = require('../utils/logger');
const { getExtension, isMediaFile, getFileSize } = require('../utils/fileUtils');
const events = require('./events');
const extrasService = require('./extras');
const ignoreRules = require('../utils/ignoreRules');

let watcher = null;
let isScanning = false;

function generateId(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

// Paths are matched against the configured library roots so a file's type
// follows the library it lives in (Plex/Jellyfin behaviour), not just a guess.
function findLibraryFor(filePath, config) {
  const libraries = getLibraries(config);
  let best = null;
  for (const lib of libraries) {
    for (const root of lib.paths || []) {
      const resolved = path.resolve(root);
      if (filePath === resolved || filePath.startsWith(resolved + path.sep)) {
        if (!best || resolved.length > best.root.length) best = { library: lib, root: resolved };
      }
    }
  }
  return best;
}

function getLibraries(config = getConfig()) {
  const media = config.media || {};
  const custom = Array.isArray(media.libraries) ? media.libraries : [];
  const named = custom
    .filter(l => l && l.type && (Array.isArray(l.paths) ? l.paths.length : l.path))
    .map(l => ({
      id: l.id || `lib_${String(l.name || l.type).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      name: l.name || l.type,
      type: l.type,
      paths: (Array.isArray(l.paths) && l.paths.length ? l.paths : [l.path]).map(p => path.resolve(p)),
      ignore: l.ignore || [],
      scanSchedule: l.scanSchedule || media.scanSchedule || 'off',
    }));
  if (named.length) return named;

  // No explicit libraries → implicit ones from media.paths.
  const typeFor = key => (key === 'audiobooks' ? 'audiobook' : key === 'podcasts' ? 'podcast' : key === 'comics' ? 'comic' : key);
  return Object.entries(media.paths || {})
    .filter(([key]) => ['movies', 'music', 'videos', 'audiobooks', 'podcasts', 'comics'].includes(key))
    .map(([key, dir]) => ({
      id: `lib_${key}`,
      name: key.charAt(0).toUpperCase() + key.slice(1),
      type: typeFor(key),
      paths: [path.resolve(dir)],
      ignore: [],
      scanSchedule: media.scanSchedule || 'off',
    }));
}

function determineType(filePath, config, library = null) {
  const ext = getExtension(filePath);
  const lib = library || findLibraryFor(filePath, config)?.library || null;

  if (lib && lib.type) {
    if (lib.type === 'comic' && ['.cbz', '.cbr', '.pdf', '.epub'].includes(ext)) return 'comic';
    if (lib.type === 'audiobook' && config.media.supportedExtensions.audio.includes(ext)) return 'audiobook';
    if (lib.type === 'podcast' && config.media.supportedExtensions.audio.includes(ext)) return 'podcast';
    if (lib.type === 'music' && config.media.supportedExtensions.audio.includes(ext)) return 'music';
    if ((lib.type === 'movie' || lib.type === 'show') && config.media.supportedExtensions.video.includes(ext)) return 'movie';
    if (lib.type === 'video' && config.media.supportedExtensions.video.includes(ext)) return 'video';
  }

  if (config.media.supportedExtensions.video.includes(ext)) {
    const lower = filePath.toLowerCase();
    if (lower.includes('movie') || lower.includes('film') || lower.includes('series') || lower.includes('show') || lower.includes('season')) {
      return 'movie';
    }
    return 'video';
  }
  if (config.media.supportedExtensions.audio.includes(ext)) {
    // Heuristic for audiobooks so they don't pollute the music library.
    const lower = filePath.toLowerCase();
    if (lower.includes('audiobook') || lower.includes('audio book')) return 'audiobook';
    if (lower.includes('podcast')) return 'podcast';
    return 'music';
  }
  return null;
}

/** Show key for grouping episodes: folder name, or the parsed series title. */
function seriesKeyFor(filePath, metadata) {
  if (!metadata || metadata.season === undefined && metadata.episode === undefined) return null;
  if (metadata.episode === undefined && metadata.season === undefined) return null;
  const dir = path.basename(path.dirname(filePath));
  const cleaned = dir.replace(/[._]+/g, ' ').replace(/\s*(season|s)\s*\d+.*$/i, '').trim();
  if (cleaned && !/^(movies|series|shows|tv|videos)$/i.test(cleaned)) return cleaned.toLowerCase();
  const title = String(metadata.title || '').replace(/[._]+/g, ' ').replace(/\s*[sS]\d+[eE]\d+.*$/, '').trim();
  return title ? title.toLowerCase() : null;
}

async function scanFile(filePath) {
  try {
    const config = getConfig();
    const found = findLibraryFor(filePath, config);
    const type = determineType(filePath, config, found?.library);
    if (!type) return null;
    const libraryId = found?.library?.id || null;
    const libraryName = found?.library?.name || null;

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;

    const id = generateId(filePath);
    const existing = libraryService.getById(id);
    // Skip if file hasn't changed (size + mtime)
    if (existing && existing.fileSize === stat.size && existing.mtime === stat.mtimeMs) {
      return existing;
    }

    let metadata = {};
    let thumbnailPath = null;
    let coverArtPath = null;

    if (type === 'music' || type === 'audiobook' || type === 'podcast') {
      const audioMeta = await metadataService.extractAudioMetadata(filePath);
      metadata = {
        title: audioMeta.title,
        artist: audioMeta.artist,
        albumArtist: audioMeta.albumArtist,
        album: audioMeta.album,
        year: audioMeta.year,
        genre: audioMeta.genre,
        genres: audioMeta.genres,
        track: audioMeta.track,
        disc: audioMeta.disc,
        composer: audioMeta.composer,
        duration: audioMeta.duration,
        bitrate: audioMeta.bitrate,
        sampleRate: audioMeta.sampleRate,
        codec: audioMeta.codec,
        lossless: audioMeta.lossless,
      };
      if (audioMeta.lyricsLrc || audioMeta.lyrics) {
        try {
          const lyricsDir = path.join(__dirname, '../cache/lyrics');
          await fs.ensureDir(lyricsDir);
          const ext = audioMeta.lyricsLrc ? 'lrc' : 'txt';
          const lyricsPath = path.join(lyricsDir, `${id}.${ext}`);
          await fs.writeFile(lyricsPath, audioMeta.lyricsLrc || audioMeta.lyrics, 'utf8');
          metadata.lyricsPath = lyricsPath;
          metadata.lyricsSynced = !!audioMeta.lyricsLrc;
        } catch {}
      }
      if (audioMeta.coverArtPath) {
        coverArtPath = audioMeta.coverArtPath;
      }
    } else if (type === 'comic') {
      const ext = path.extname(filePath).toLowerCase();
      metadata = {
        title: path.basename(filePath, ext),
        format: ext.slice(1),
        pageCount: 0,
        duration: 0,
      };
    } else {
      const videoMeta = await metadataService.extractVideoMetadata(filePath, type);
      metadata = {
        title: videoMeta.title,
        year: videoMeta.year,
        season: videoMeta.season,
        episode: videoMeta.episode,
        duration: videoMeta.duration,
        width: videoMeta.width,
        height: videoMeta.height,
        resolution: videoMeta.resolution,
        bitrate: videoMeta.bitrate,
        videoCodec: videoMeta.videoCodec,
        audioCodec: videoMeta.audioCodec,
        audioTracks: videoMeta.audioTracks,
        format: videoMeta.format,
        subtitles: videoMeta.subtitles,
        chapters: videoMeta.chapters,
        posterPath: videoMeta.posterPath,
        backdropPath: videoMeta.backdropPath,
        trailerPath: videoMeta.trailerPath,
        extras: videoMeta.extras,
        hdr: videoMeta.hdr,
        fourK: videoMeta.fourK,
        surround: videoMeta.surround,
        seriesKey: seriesKeyFor(filePath, videoMeta),
        fileSize: videoMeta.fileSize,
      };

      // Generate thumbnail for video
      if (config.media.thumbnail.enabled) {
        try {
          thumbnailPath = await thumbnailService.getOrGenerateThumbnail(filePath, id);
        } catch (err) {
          logger.warn(`Thumbnail failed for ${filePath}: ${err.message}`);
        }
      }

      // Scrub-preview storyboards (trickplay) — Plex/YouTube style.
      if (config.media.trickplay?.enabled && metadata.duration > 120 && !existing?.trickplay) {
        try {
          const manifest = await thumbnailService.generateTrickplay(filePath, id, {
            intervalSeconds: config.media.trickplay.intervalSeconds || 10,
            width: config.media.trickplay.width || 160,
            duration: metadata.duration,
          });
          if (manifest) metadata.trickplay = { sheets: manifest.sheets, interval: manifest.interval };
        } catch (err) {
          logger.warn(`Trickplay failed for ${filePath}: ${err.message}`);
        }
      }

      // Intro/outro detection (silence analysis) — seeded once per episode.
      if (config.media.extras?.detectIntro && metadata.seriesKey && !extrasService.getMarkers(id).intro) {
        try {
          const detected = await detectIntroOutro(filePath, metadata.duration, config);
          if (detected.intro || detected.outro) {
            extrasService.setMarkers(id, detected);
            if (!extrasService.getSeriesMarkers(metadata.seriesKey)) {
              extrasService.setSeriesMarker(metadata.seriesKey, detected.intro, detected.outro);
            }
          }
        } catch (err) {
          logger.warn(`Intro detection failed for ${filePath}: ${err.message}`);
        }
      }
    }

    const item = {
      id,
      path: filePath,
      filename: path.basename(filePath),
      fileSize: stat.size,
      mtime: stat.mtimeMs,
      type,
      libraryId,
      libraryName,
      ...metadata,
      thumbnailPath,
      coverArtPath,
      addedAt: existing ? existing.addedAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      playCount: existing ? existing.playCount : 0,
      rating: existing ? existing.rating : 0,
      description: existing ? existing.description : '',
      tags: existing ? existing.tags : [],
    };

    libraryService.addItem(item);
    return item;
  } catch (err) {
    logger.warn(`Failed to scan file ${filePath}: ${err.message}`);
    return null;
  }
}

/**
 * Intro/outro detection via ffmpeg silencedetect.
 *
 * Heuristic: an intro is the audio span that follows a short silence (cold
 * open → title sequence) inside the first 40% of the episode; the outro is the
 * last silence gap before the credits. Auto markers are always editable in the
 * UI and a manual marker always wins.
 */
function detectSilences(filePath) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let bin = null;
    try {
      bin = require('ffmpeg-static');
    } catch {}
    if (!bin) bin = 'ffmpeg';
    let stderr = '';
    let proc;
    try {
      proc = spawn(bin, ['-hide_banner', '-nostats', '-i', filePath, '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-']);
    } catch {
      return resolve([]);
    }
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const starts = [];
      const ends = [];
      let m;
      const startRe = /silence_start: ([0-9.]+)/g;
      const endRe = /silence_end: ([0-9.]+)/g;
      while ((m = startRe.exec(stderr))) starts.push(parseFloat(m[1]));
      while ((m = endRe.exec(stderr))) ends.push(parseFloat(m[1]));
      const silences = [];
      for (let i = 0; i < starts.length; i++) {
        silences.push({ start: starts[i], end: ends[i] ?? starts[i] + 0.5 });
      }
      resolve(silences);
    });
  });
}

async function detectIntroOutro(filePath, duration, config) {
  const opts = config.media.extras || {};
  const minLen = opts.introMinSeconds ?? 10;
  const maxLen = opts.introMaxSeconds ?? 180;
  const silences = await detectSilences(filePath);
  if (!silences.length || !duration) return { intro: null, outro: null, source: 'auto' };

  const round1 = n => Math.round(n * 10) / 10;
  let intro = null;
  let outro = null;

  for (const gap of silences.filter(s => s.start > 5 && s.start < duration * 0.4)) {
    const start = gap.end;
    const next = silences.find(s => s.start > start + minLen);
    const end = next ? next.start : Math.min(duration, start + 90);
    if (end - start >= minLen && end - start <= maxLen) {
      intro = { start: round1(start), end: round1(end) };
      break;
    }
  }

  const outroCandidates = silences.filter(s => s.start > duration * 0.85);
  if (outroCandidates.length) {
    const last = outroCandidates[outroCandidates.length - 1];
    outro = { start: round1(last.start), end: round1(duration) };
  }

  return { intro, outro, source: 'auto', detectedAt: new Date().toISOString() };
}

async function scanDirectory(dirPath, recursive = true, options = {}) {
  const config = getConfig();
  const allExtensions = [
    ...config.media.supportedExtensions.video,
    ...config.media.supportedExtensions.audio,
    '.cbz', '.cbr', '.pdf', '.epub',
  ];
  const ignorePatterns = [...(config.media.ignore || []), ...(options.ignore || [])];
  const root = path.resolve(dirPath);

  let files = [];
  try {
    const exists = await fs.pathExists(dirPath);
    if (!exists) {
      logger.warn(`Directory does not exist: ${dirPath}`);
      return [];
    }

    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        logger.warn(`Failed to read dir ${dir}: ${err.message}`);
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relative = path.relative(root, fullPath) || entry.name;
        if (ignoreRules.isIgnored(relative, ignorePatterns, entry.name)) continue;
        if (entry.isDirectory() && recursive) {
          if (entry.name === 'cache') continue;
          // eslint-disable-next-line no-await-in-loop
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(fullPath).toLowerCase();
          if (isMediaFile(fullPath, allExtensions) || ['.cbz', '.cbr', '.pdf', '.epub'].includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    await walk(dirPath);
  } catch (err) {
    logger.error(`Failed to scan directory ${dirPath}: ${err.message}`);
    return [];
  }

  logger.info(`Found ${files.length} media files in ${dirPath}`);
  // Process in batches to avoid overwhelming
  const results = [];
  let done = 0;
  const batchSize = 10;
  const jobId = options.jobId || null;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await Promise.all(batch.map(async f => {
      const result = await scanFile(f);
      done++;
      return result;
    }));
    results.push(...batchResults.filter(Boolean));
    if (jobId) events.jobProgress(jobId, done, files.length);
  }
  return results;
}

async function scanAll() {
  if (isScanning) {
    logger.warn('Scan already in progress, skipping');
    return { scanned: 0, removed: 0, elapsed: 0, skipped: true };
  }
  isScanning = true;
  logger.info('Starting full library scan...');

  const config = getConfig();
  const startTime = Date.now();

  try {
    // Ensure media dirs exist (async)
    await Promise.all(Object.values(config.media.paths).map(p => fs.ensureDir(p)));

    const libraries = getLibraries(config);
    const jobId = `scan_${Date.now()}`;
    events.jobStart(jobId, 'scan', 'Scanning library', 0);
    const allResults = [];
    for (const library of libraries) {
      for (const root of library.paths) {
        logger.info(`Scanning ${library.name} (${library.type}): ${root}`);
        // eslint-disable-next-line no-await-in-loop
        const results = await scanDirectory(root, true, { ignore: library.ignore, jobId });
        allResults.push(...results);
      }
    }

    // Remove items whose files no longer exist (batched)
    const existing = libraryService.getAll();
    let removed = 0;
    const checks = await Promise.all(existing.map(async item => {
      const exists = await fs.pathExists(item.path);
      return { item, exists };
    }));
    for (const { item, exists } of checks) {
      if (!exists) {
        libraryService.removeItem(item.id);
        removed++;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`Scan complete: ${allResults.length} items, ${removed} removed, ${elapsed}s`);
    events.jobFinish(jobId, 'done', { scanned: allResults.length, removed });
    events.broadcast('library:changed', { scanned: allResults.length, removed, reason: 'scan' });

    return { scanned: allResults.length, removed, elapsed };
  } catch (err) {
    logger.error('Scan failed:', err.message);
    throw err;
  } finally {
    isScanning = false;
  }
}

/** Re-detect poster/backdrop/trailer for every item whose file lives in `dir`. */
async function refreshArtworkInDir(dir) {
  let changed = 0;
  for (const item of libraryService.getAll()) {
    if (path.dirname(item.path) !== dir) continue;
    const patch = {};
    const poster = metadataService.findSidecarArtwork(item.path);
    const backdrop = metadataService.findBackdrop(item.path);
    const trailer = metadataService.findTrailer(item.path);
    if (poster && poster !== item.posterPath) patch.posterPath = poster;
    if (backdrop && backdrop !== item.backdropPath) patch.backdropPath = backdrop;
    if (trailer && trailer !== item.trailerPath) patch.trailerPath = trailer;
    if (Object.keys(patch).length) {
      libraryService.updateItem(item.id, patch);
      changed++;
    }
  }
  if (changed) events.broadcast('library:changed', { reason: 'artwork', count: changed });
  return changed;
}

function startWatcher() {
  const config = getConfig();
  const paths = getLibraries(config).flatMap(lib => lib.paths);

  // Ensure dirs exist (sync is okay at startup, but use async-safe)
  paths.forEach(p => {
    try { fs.ensureDirSync(p); } catch {}
  });

  watcher = chokidar.watch(paths, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    depth: 10,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  watcher
    .on('add', async (filePath) => {
      if (/\.(jpg|jpeg|png|webp)$/i.test(path.basename(filePath))) {
        await refreshArtworkInDir(path.dirname(filePath));
        return;
      }
      logger.info(`File added: ${filePath}`);
      const item = await scanFile(filePath);
      if (item) events.broadcast('library:changed', { reason: 'add', id: item.id, title: item.title });
    })
    .on('change', async (filePath) => {
      if (/\.(jpg|jpeg|png|webp)$/i.test(path.basename(filePath))) {
        await refreshArtworkInDir(path.dirname(filePath));
        return;
      }
      logger.info(`File changed: ${filePath}`);
      const item = await scanFile(filePath);
      if (item) events.broadcast('library:changed', { reason: 'change', id: item.id });
    })
    .on('unlink', (filePath) => {
      logger.info(`File removed: ${filePath}`);
      const id = generateId(filePath);
      const item = libraryService.getById(id);
      libraryService.removeItem(id);
      events.broadcast('library:changed', { reason: 'remove', id, title: item?.title });
    })
    .on('error', err => {
      logger.error('Watcher error:', err.message);
    });

  logger.info(`File watcher started for: ${paths.join(', ')}`);
  return watcher;
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    logger.info('File watcher stopped');
  }
}

module.exports = {
  isScanning: () => isScanning,
  scanFile,
  scanDirectory,
  scanAll,
  startWatcher,
  stopWatcher,
  generateId,
  getLibraries,
  findLibraryFor,
  seriesKeyFor,
  detectIntroOutro,
  detectSilences,
  refreshArtworkInDir,
};
