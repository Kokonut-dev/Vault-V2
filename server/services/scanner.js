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

let watcher = null;
let isScanning = false;

function generateId(filePath) {
  return crypto.createHash('md5').update(filePath).digest('hex');
}

function determineType(filePath, config) {
  const ext = getExtension(filePath);
  if (config.media.supportedExtensions.video.includes(ext)) {
    // Heuristic: if path contains movies or series, classify as movie
    const lower = filePath.toLowerCase();
    if (lower.includes('movie') || lower.includes('film') || lower.includes('series') || lower.includes('show') || lower.includes('season')) {
      return 'movie';
    }
    // Default video files to video, but if duration > 10min and has year in name, likely movie
    return 'video';
  }
  if (config.media.supportedExtensions.audio.includes(ext)) {
    return 'music';
  }
  return null;
}

async function scanFile(filePath) {
  try {
    const config = getConfig();
    const type = determineType(filePath, config);
    if (!type) return null;

    const stat = fs.statSync(filePath);
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

    if (type === 'music') {
      const audioMeta = await metadataService.extractAudioMetadata(filePath);
      metadata = {
        title: audioMeta.title,
        artist: audioMeta.artist,
        album: audioMeta.album,
        year: audioMeta.year,
        genre: audioMeta.genre,
        track: audioMeta.track,
        duration: audioMeta.duration,
        bitrate: audioMeta.bitrate,
        sampleRate: audioMeta.sampleRate,
        codec: audioMeta.codec,
      };
      if (audioMeta.coverArtPath) {
        coverArtPath = audioMeta.coverArtPath;
      }
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
        format: videoMeta.format,
        subtitles: videoMeta.subtitles,
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
    }

    const item = {
      id,
      path: filePath,
      filename: path.basename(filePath),
      fileSize: stat.size,
      mtime: stat.mtimeMs,
      type,
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

async function scanDirectory(dirPath, recursive = true) {
  const config = getConfig();
  const allExtensions = [
    ...config.media.supportedExtensions.video,
    ...config.media.supportedExtensions.audio,
  ];

  let files = [];
  try {
    if (!fs.existsSync(dirPath)) {
      logger.warn(`Directory does not exist: ${dirPath}`);
      return [];
    }

    const walk = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && recursive) {
          // Skip hidden and cache dirs
          if (entry.name.startsWith('.') || entry.name === 'cache' || entry.name === 'node_modules') continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          if (isMediaFile(fullPath, allExtensions)) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(dirPath);
  } catch (err) {
    logger.error(`Failed to scan directory ${dirPath}: ${err.message}`);
    return [];
  }

  logger.info(`Found ${files.length} media files in ${dirPath}`);
  const results = [];
  for (const file of files) {
    const item = await scanFile(file);
    if (item) results.push(item);
  }
  return results;
}

async function scanAll() {
  if (isScanning) {
    logger.warn('Scan already in progress, skipping');
    return;
  }
  isScanning = true;
  logger.info('Starting full library scan...');

  const config = getConfig();
  const startTime = Date.now();

  try {
    // Ensure media dirs exist
    for (const type of Object.keys(config.media.paths)) {
      fs.ensureDirSync(config.media.paths[type]);
    }

    const allResults = [];
    for (const [type, dirPath] of Object.entries(config.media.paths)) {
      logger.info(`Scanning ${type}: ${dirPath}`);
      const results = await scanDirectory(dirPath, true);
      allResults.push(...results);
    }

    // Remove items whose files no longer exist
    const existing = libraryService.getAll();
    let removed = 0;
    for (const item of existing) {
      if (!fs.existsSync(item.path)) {
        libraryService.removeItem(item.id);
        removed++;
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`Scan complete: ${allResults.length} items, ${removed} removed, ${elapsed}s`);

    return { scanned: allResults.length, removed, elapsed };
  } catch (err) {
    logger.error('Scan failed:', err.message);
    throw err;
  } finally {
    isScanning = false;
  }
}

function startWatcher() {
  const config = getConfig();
  const paths = Object.values(config.media.paths);

  // Ensure dirs exist
  paths.forEach(p => fs.ensureDirSync(p));

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
      logger.info(`File added: ${filePath}`);
      await scanFile(filePath);
    })
    .on('change', async (filePath) => {
      logger.info(`File changed: ${filePath}`);
      await scanFile(filePath);
    })
    .on('unlink', (filePath) => {
      logger.info(`File removed: ${filePath}`);
      const id = generateId(filePath);
      libraryService.removeItem(id);
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
  scanFile,
  scanDirectory,
  scanAll,
  startWatcher,
  stopWatcher,
  generateId,
};
