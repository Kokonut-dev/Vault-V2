const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const fileSizeCache = new Map();
const parseCache = new Map();
const CACHE_TTL = 60000;

function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function ensureDir(dir) {
  fs.ensureDirSync(dir);
}

function getFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function getFileSizeAsync(filePath) {
  const cached = fileSizeCache.get(filePath);
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.size;
  try {
    const stat = await fs.stat(filePath);
    fileSizeCache.set(filePath, { size: stat.size, t: Date.now() });
    return stat.size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getExtension(filePath) {
  return path.extname(filePath).toLowerCase();
}

function isMediaFile(filePath, supportedExtensions) {
  const ext = getExtension(filePath);
  return supportedExtensions.includes(ext);
}

function parseMovieFilename(filename) {
  if (parseCache.has(filename)) return parseCache.get(filename);
  
  const base = path.basename(filename, path.extname(filename));
  let title = base;
  let year = null;
  let season = null;
  let episode = null;

  const yearMatch = base.match(/[\(\[]?((?:19|20)\d{2})[\)\]]?/);
  if (yearMatch) {
    year = parseInt(yearMatch[1], 10);
    title = base.substring(0, yearMatch.index).replace(/[\.\-_]+$/g, '').replace(/[\.\-_]/g, ' ').trim();
  }

  const seMatch = base.match(/[Ss](\d{1,2})[Ee](\d{1,3})|(\d{1,2})x(\d{1,3})|[Ss]eason\s*(\d+)\s*[Ee]pisode\s*(\d+)/i);
  if (seMatch) {
    if (seMatch[1] && seMatch[2]) {
      season = parseInt(seMatch[1], 10);
      episode = parseInt(seMatch[2], 10);
    } else if (seMatch[3] && seMatch[4]) {
      season = parseInt(seMatch[3], 10);
      episode = parseInt(seMatch[4], 10);
    } else if (seMatch[5] && seMatch[6]) {
      season = parseInt(seMatch[5], 10);
      episode = parseInt(seMatch[6], 10);
    }
    const seIndex = base.search(/[Ss]\d+[Ee]\d+|\d+x\d+/i);
    if (seIndex > 0) {
      title = base.substring(0, seIndex).replace(/[\.\-_]+$/g, '').replace(/[\.\-_]/g, ' ').trim();
    }
  }

  if (!title) title = base.replace(/[\.\-_]/g, ' ').trim();

  const result = { title: title || base, year, season, episode };
  if (parseCache.size > 500) {
    const firstKey = parseCache.keys().next().value;
    parseCache.delete(firstKey);
  }
  parseCache.set(filename, result);
  return result;
}

async function cleanCache(cacheDir, maxSizeMB) {
  try {
    if (!fs.existsSync(cacheDir)) return;
    const files = await fs.readdir(cacheDir);
    let totalSize = 0;
    const fileInfos = [];
    // Batch stat for speed
    const statPromises = files.map(async (file) => {
      const fp = path.join(cacheDir, file);
      try {
        const stat = await fs.stat(fp);
        if (stat.isFile()) return { path: fp, size: stat.size, mtime: stat.mtimeMs };
      } catch {}
      return null;
    });
    const results = await Promise.all(statPromises);
    for (const info of results) {
      if (info) {
        totalSize += info.size;
        fileInfos.push(info);
      }
    }
    const maxBytes = maxSizeMB * 1024 * 1024;
    if (totalSize > maxBytes) {
      fileInfos.sort((a, b) => a.mtime - b.mtime);
      for (const info of fileInfos) {
        if (totalSize <= maxBytes * 0.8) break;
        try {
          await fs.remove(info.path);
          totalSize -= info.size;
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[Cache] Clean failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// F-15: non-blocking, crash-safe JSON persistence
// ---------------------------------------------------------------------------

// Per-file write chains — concurrent saves to the same path serialize instead
// of racing on the temp file.
const writeChains = new Map();

/**
 * Write JSON off the event loop and atomically: serialize to `<file>.tmp`,
 * then rename over the target. A crash mid-write can no longer truncate
 * library.json / playlists.json, and compact output (no `spaces: 2`) keeps
 * large libraries small and fast to write.
 *
 * @param {string} filePath destination path
 * @param {*} data JSON-serializable value
 * @returns {Promise<void>} resolves when the file is durably replaced
 */
function writeJsonAtomic(filePath, data) {
  const prev = writeChains.get(filePath) || Promise.resolve();
  const next = prev
    .then(async () => {
      await fs.ensureDir(path.dirname(filePath));
      const tmpPath = `${filePath}.tmp`;
      await fs.writeJson(tmpPath, data); // compact: no spaces → smaller + faster
      await fs.move(tmpPath, filePath, { overwrite: true });
    })
    .catch(err => {
      // Keep the chain alive after a failure; surface via rethrow to callers.
      throw err;
    });
  // Store the settled state so later writes proceed even after a failure.
  writeChains.set(filePath, next.catch(() => {}));
  return next;
}

/**
 * Wait for every in-flight atomic write (any module) to settle.
 * Called from libraryService.flush() on shutdown so nothing is lost.
 */
function flushWrites() {
  return Promise.allSettled([...writeChains.values()]);
}

// ---------------------------------------------------------------------------
// F-16: Range-aware file streaming (moved here from routes/media.js so the
// transcode cache can reuse the exact same solid implementation).
// ---------------------------------------------------------------------------

function sendFileWithRange(req, res, filePath) {
  const mime = require('mime-types');
  const logger = require('./logger');
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const contentType = mime.lookup(filePath) || 'application/octet-stream';

    // Use setHeader (not writeHead) so CORS headers from middleware are preserved.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    const onStreamError = (stream) => {
      stream.on('error', (err) => {
        logger.error(`Stream error ${filePath}: ${err.message}`);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
      });
    };

    if (range) {
      const parts = range.replace(/bytes=/i, '').split('-');
      let start = parseInt(parts[0], 10);
      let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
      if (start >= fileSize || start > end) {
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        return res.status(416).end();
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', chunkSize);
      const file = fs.createReadStream(filePath, { start, end });
      onStreamError(file);
      file.pipe(res);
    } else {
      res.status(200);
      res.setHeader('Content-Length', fileSize);
      const file = fs.createReadStream(filePath);
      onStreamError(file);
      file.pipe(res);
    }
  } catch (err) {
    logger.error(`Failed to stream ${filePath}: ${err.message}`);
    if (!res.headersSent) res.status(404).json({ error: 'File not found' });
  }
}

module.exports = {
  getFileHash,
  ensureDir,
  getFileSize,
  getFileSizeAsync,
  formatBytes,
  getExtension,
  isMediaFile,
  parseMovieFilename,
  cleanCache,
  writeJsonAtomic,
  flushWrites,
  sendFileWithRange,
};
