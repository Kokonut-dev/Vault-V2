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
};
