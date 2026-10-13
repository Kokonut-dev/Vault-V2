/**
 * System operations for the in-app server console: log tailing, disk usage,
 * cache management, backup/restore of the data folder, and a library health
 * report (missing files, duplicates, missing artwork, unplayable codecs).
 */
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createJsonStore } = require('../utils/jsonStore');
const logger = require('../utils/logger');
const libraryService = require('./library');
const trash = require('./trash');
const comics = require('./comics');

const SERVER_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(SERVER_DIR, 'data');
const CACHE_DIR = path.join(SERVER_DIR, 'cache');
const LOGS_DIR = path.join(SERVER_DIR, 'logs');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// ---------------------------------------------------------------------------
// Logs — a small ring buffer the UI can read without shell access.
// ---------------------------------------------------------------------------
function attachLogBuffer(limit = 500) {
  const buffer = [];
  const levels = { info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
  const original = {};
  for (const [level, name] of Object.entries(levels)) {
    if (typeof logger[name] !== 'function') continue;
    original[name] = logger[name];
    logger[name] = (...args) => {
      const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      buffer.push({ at: new Date().toISOString(), level, line });
      if (buffer.length > limit) buffer.shift();
      original[name](...args);
    };
  }
  return buffer;
}

const logBuffer = attachLogBuffer();

function getLogs(limit = 200) {
  return logBuffer.slice(-limit);
}

async function writeLogFile() {
  try {
    await fs.ensureDir(LOGS_DIR);
    const file = path.join(LOGS_DIR, `vault-${new Date().toISOString().slice(0, 10)}.log`);
    await fs.appendFile(file, logBuffer.map(l => `[${l.at}] [${l.level.toUpperCase()}] ${l.line}`).join('\n') + '\n');
    return file;
  } catch (err) {
    logger.warn(`[System] log write failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------
/**
 * One pass over a tree: total bytes/files plus a breakdown for every
 * immediate child directory. `diskUsage()` used to walk the cache folder four
 * times (the whole tree, then transcoded/, thumbnails/ and covers/ again);
 * now the sub-totals come out of the same walk. `fs.stat` is issued in
 * parallel batches instead of one awfully serialised await per file.
 */
async function dirSizeTree(root, { batch = 64 } = {}) {
  const children = new Map();
  const files = [];
  const pendingDirs = [''];
  let bytes = 0;
  let count = 0;

  while (pendingDirs.length) {
    const rel = pendingDirs.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) pendingDirs.push(childRel);
      else if (entry.isFile()) files.push([path.join(abs, entry.name), childRel.split('/')[0]]);
    }
  }

  for (let i = 0; i < files.length; i += batch) {
    const slice = files.slice(i, i + batch);
    // eslint-disable-next-line no-await-in-loop
    const sizes = await Promise.all(slice.map(([file]) => fs.stat(file).then(stat => stat.size).catch(() => 0)));
    sizes.forEach((size, index) => {
      const child = slice[index][1];
      const bucket = children.get(child) || { bytes: 0, files: 0 };
      bucket.bytes += size;
      bucket.files += 1;
      children.set(child, bucket);
      bytes += size;
      count += 1;
    });
  }

  return { bytes, files: count, children };
}

/** Total for a single directory (kept for callers that only need one number). */
async function dirSize(dir) {
  const { bytes, files } = await dirSizeTree(dir);
  return { bytes, files };
}

/** Tiny in-flight-aware TTL memo for read-only reports the console polls. */
const reportCache = new Map();
function memoReport(key, ttlMs, producer) {
  const hit = reportCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve()
    .then(producer)
    .catch(err => {
      reportCache.delete(key); // never cache failures
      throw err;
    });
  reportCache.set(key, { at: Date.now(), promise });
  return promise;
}

function invalidateReports() {
  reportCache.clear();
}

async function diskUsage() {
  return memoReport('disk', 15000, diskUsageUncached);
}

async function diskUsageUncached() {
  const [cache, data, trashSize] = await Promise.all([
    dirSizeTree(CACHE_DIR),
    dirSizeTree(DATA_DIR),
    trash.totalSize(),
  ]);
  const cacheChild = name => cache.children.get(name) || { bytes: 0, files: 0 };
  const transcoded = cacheChild('transcoded');
  const thumbnails = cacheChild('thumbnails');
  const covers = cacheChild('covers');

  const library = libraryService.getAll();
  const mediaBytes = library.reduce((sum, i) => sum + (i.fileSize || 0), 0);

  return {
    cache: { bytes: cache.bytes, files: cache.files, transcoded: transcoded.bytes, thumbnails: thumbnails.bytes, covers: covers.bytes },
    data: { bytes: data.bytes, files: data.files },
    trash: { bytes: trashSize, count: trash.list().length },
    media: { bytes: mediaBytes, items: library.length },
    host: { platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, uptime: os.uptime(), totalMem: os.totalmem(), freeMem: os.freemem(), node: process.version },
  };
}

// ---------------------------------------------------------------------------
// Backup / restore (zip of the data folder, written without dependencies)
// ---------------------------------------------------------------------------
function crc32(buffer) {
  let crc = ~0;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

async function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);      // local file header signature
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(0, 8);               // method: stored
    local.writeUInt16LE(0, 10);              // time
    local.writeUInt16LE(0x21, 12);           // date (1980-01-01-ish; harmless)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);    // compressed size
    local.writeUInt32LE(data.length, 22);    // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 30);                // extra + comment lengths
    cen.writeUInt32LE(0, 34);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

async function createBackup({ includeMedia = false } = {}) {
  await fs.ensureDir(BACKUP_DIR);
  const entries = [];

  const collect = async (dir, prefix) => {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      const name = `${prefix}/${item.name}`;
      if (item.isDirectory()) {
        if (item.name === 'backups' || item.name === 'trash') continue;
        // eslint-disable-next-line no-await-in-loop
        await collect(full, name);
      } else if (item.isFile()) {
        if (/\.tmp$/.test(item.name) || /\.log$/.test(item.name)) continue;
        entries.push({ name, data: await fs.readFile(full) });
      }
    }
  };

  if (includeMedia) {
    for (const [key, dir] of Object.entries(require('../config').getConfig().media.paths)) {
      if (await fs.pathExists(dir)) await collect(dir, `media/${key}`);
    }
  }
  await collect(DATA_DIR, 'data');
  entries.push({ name: 'BACKUP_INFO.txt', data: Buffer.from(
    `Vault backup\nCreated: ${new Date().toISOString()}\nIncludes media: ${includeMedia}\n`, 'utf8'
  ) });

  const buffer = await createZip(entries);
  const file = path.join(BACKUP_DIR, `vault-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
  await fs.writeFile(file, buffer);
  return { file, bytes: buffer.length, entries: entries.length };
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.zip'))
      .map(name => {
        const full = path.join(BACKUP_DIR, name);
        return { name, path: full, bytes: fs.statSync(full).size, createdAt: fs.statSync(full).mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

async function readZip(filePath) {
  const entries = await comics.readCentralDirectory(filePath);
  const out = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    // eslint-disable-next-line no-await-in-loop
    const data = await comics.readEntry(filePath, entry);
    out.push({ name: entry.name, data });
  }
  return out;
}

async function restoreBackup(filePath) {
  // A restore rewrites the data folder; sizes must be re-measured.
  invalidateReports();
  const entries = await readZip(filePath);
  const restored = [];
  for (const entry of entries) {
    const clean = entry.name.replace(/^\/+/, '');
    if (clean.startsWith('data/')) {
      const relative = clean.slice('data/'.length);
      if (!relative || relative === 'trash' || relative.startsWith('backups/')) continue;
      const target = path.join(DATA_DIR, relative);
      // eslint-disable-next-line no-await-in-loop
      await fs.ensureDir(path.dirname(target));
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(target, entry.data);
      restored.push(relative);
    } else if (clean.startsWith('media/')) {
      const relative = clean.slice('media/'.length);
      const config = require('../config').getConfig();
      const [key, ...rest] = relative.split('/');
      const root = config.media.paths[key];
      if (!root || !rest.length) continue;
      const target = path.join(root, rest.join('/'));
      // eslint-disable-next-line no-await-in-loop
      await fs.ensureDir(path.dirname(target));
      // eslint-disable-next-line no-await-in-loop
      await fs.writeFile(target, entry.data);
      restored.push(relative);
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Library health
// ---------------------------------------------------------------------------
async function libraryHealth(options = {}) {
  const { deep = false } = options;
  // Cached briefly: the console polls this and a large library makes the
  // filesystem sweep the most expensive request in the app.
  return memoReport(`health:${deep ? 'deep' : 'quick'}`, 30000, () => libraryHealthUncached(options));
}

/** Run `worker` over `values` with bounded concurrency, preserving order. */
async function mapLimit(values, limit, worker) {
  const results = new Array(values.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      // eslint-disable-next-line no-await-in-loop
      results[index] = await worker(values[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function libraryHealthUncached({ deep = false } = {}) {
  const items = libraryService.getAll();
  const missing = [];
  const duplicates = [];
  const missingArtwork = [];
  const unknownCodecs = new Set();
  const unplayable = [];
  const bySize = new Map();

  // Phase 1: probe the filesystem in parallel (64 at a time) instead of one
  // serialised await per item — the old loop took ~1 stat round-trip per item.
  const exists = await mapLimit(items, 64, item => fs.pathExists(item.path).catch(() => false));
  const comicPages = new Map();
  const comicsToCheck = items.filter(item => item.type === 'comic');
  if (comicsToCheck.length) {
    const counts = await mapLimit(comicsToCheck, 8, item => comics.getPageCount(item.path).catch(() => 0));
    comicsToCheck.forEach((item, index) => comicPages.set(item.id, counts[index]));
  }

  // Phase 2: pure in-memory classification (order matches the library).
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!exists[i]) missing.push({ id: item.id, title: item.title, path: item.path });

    if (item.type === 'music' || item.type === 'audiobook') {
      const hasArt = item.coverArtPath && fs.existsSync(item.coverArtPath);
      if (!hasArt) missingArtwork.push({ id: item.id, title: item.title, type: item.type });
    } else if (!item.thumbnailPath && !item.posterPath) {
      missingArtwork.push({ id: item.id, title: item.title, type: item.type });
    }

    if (item.type === 'comic') {
      if (!comicPages.get(item.id)) unplayable.push({ id: item.id, title: item.title, reason: 'archive could not be read' });
    }

    const codec = String(item.videoCodec || '').toLowerCase();
    if (codec && !['h264', 'avc', 'avc1', 'hevc', 'h265', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video', 'vc1', 'wmv3', 'theora'].includes(codec)) {
      unknownCodecs.add(codec);
      unplayable.push({ id: item.id, title: item.title, reason: `unusual video codec: ${codec}` });
    }

    const key = item.fileSize ? `${item.fileSize}` : null;
    if (key) {
      if (!bySize.has(key)) bySize.set(key, []);
      bySize.get(key).push(item);
    }
  }

  for (const [, group] of bySize) {
    if (group.length > 1) {
      const title = group[0].title;
      const sameTitle = group.filter(g => g.title === title);
      duplicates.push({
        title,
        size: group[0].fileSize,
        items: group.map(g => ({ id: g.id, path: g.path, title: g.title })),
        likelyDuplicate: sameTitle.length > 1,
      });
    }
  }

  const knownSidecars = new Set(['.srt', '.vtt', '.ass', '.ssa', '.lrc', '.nfo', '.jpg', '.jpeg', '.png', '.webp']);
  const orphanSidecars = [];
  if (deep) {
    // Stems of every known media file, keyed per directory: the old version
    // re-scanned the whole library for every sidecar file it found (O(n²)).
    const ownedStems = new Set();
    for (const item of items) {
      ownedStems.add(`${path.dirname(item.path)}\u0000${path.basename(item.path, path.extname(item.path))}`);
    }
    const dirs = [...new Set(items.map(item => path.dirname(item.path)))];
    const listings = await mapLimit(dirs, 32, dir => fs.readdir(dir).catch(() => []));
    dirs.forEach((dir, index) => {
      for (const file of listings[index]) {
        const ext = path.extname(file).toLowerCase();
        if (!knownSidecars.has(ext)) continue;
        const stem = file.slice(0, file.length - ext.length);
        if (!ownedStems.has(`${dir}\u0000${stem}`)) orphanSidecars.push(path.join(dir, file));
      }
    });
  }

  const trashList = trash.list();

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      items: items.length,
      missing: missing.length,
      duplicates: duplicates.length,
      missingArtwork: missingArtwork.length,
      unplayable: unplayable.length,
      trash: trashList.length,
      orphanSidecars: orphanSidecars.length,
    },
    missing: missing.slice(0, 200),
    duplicates: duplicates.slice(0, 100),
    missingArtwork: missingArtwork.slice(0, 200),
    unplayable: unplayable.slice(0, 100),
    unknownCodecs: [...unknownCodecs],
    orphanSidecars: orphanSidecars.slice(0, 200),
    trash: trashList.map(t => ({ id: t.id, name: t.name, size: t.size, deletedAt: t.deletedAt })),
  };
}

/** Remove entries whose files vanished (one-click fix for "missing"). */
async function pruneMissing() {
  const items = libraryService.getAll();
  const exists = await mapLimit(items, 64, item => fs.pathExists(item.path).catch(() => true));
  let removed = 0;
  items.forEach((item, index) => {
    if (!exists[index]) {
      libraryService.removeItem(item.id);
      removed++;
    }
  });
  invalidateReports();
  return removed;
}

async function clearCache() {
  const results = {};
  for (const sub of ['transcoded', 'thumbnails', 'covers', 'trickplay', 'images']) {
    const dir = path.join(CACHE_DIR, sub);
    try {
      const entries = await fs.readdir(dir);
      await Promise.all(entries.map(e => fs.remove(path.join(dir, e))));
      results[sub] = entries.length;
    } catch {
      results[sub] = 0;
    }
  }
  invalidateReports();
  return results;
}

function dedupeHash(filePath) {
  return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
}

module.exports = {
  getLogs,
  writeLogFile,
  diskUsage,
  invalidateReports,
  createBackup,
  listBackups,
  restoreBackup,
  readZip,
  createZip,
  libraryHealth,
  pruneMissing,
  clearCache,
  dedupeHash,
  dirSize,
  LOGS_DIR,
  BACKUP_DIR,
};
