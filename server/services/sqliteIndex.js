/**
 * Optional SQLite index (Node 22+ `node:sqlite`, no native dependency).
 *
 * The JSON index stays the source of truth — this mirrors it into a database
 * file that serves filtered/sorted/paged queries with SQL, which is what keeps
 * 10k-item libraries fast. If `node:sqlite` is unavailable (Node < 22) the
 * service degrades to the in-memory index and says so in `/api/system/index`.
 */
const path = require('path');
const fs = require('fs-extra');
const logger = require('../utils/logger');
const { getConfig } = require('../config');

const DB_PATH = path.join(__dirname, '..', 'data', 'library.db');

let db = null;
let available = null;
let lastSync = 0;

function tryLoad() {
  if (available !== null) return available;
  try {
    // eslint-disable-next-line global-require
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        type TEXT,
        title TEXT,
        artist TEXT,
        album TEXT,
        genre TEXT,
        year INTEGER,
        rating REAL,
        duration REAL,
        file_size INTEGER,
        added_at TEXT,
        updated_at TEXT,
        path TEXT,
        video_codec TEXT,
        resolution TEXT,
        library_id TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
      CREATE INDEX IF NOT EXISTS idx_items_title ON items(title);
      CREATE INDEX IF NOT EXISTS idx_items_album ON items(album);
      CREATE INDEX IF NOT EXISTS idx_items_added ON items(added_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    available = true;
    logger.info('[Index] SQLite index enabled (node:sqlite)');
  } catch (err) {
    available = false;
    logger.info(`[Index] SQLite unavailable (${err.message.split('\n')[0]}), using in-memory index`);
  }
  return available;
}

function status() {
  const loaded = tryLoad();
  const config = getConfig();
  let count = 0;
  let size = 0;
  try {
    if (loaded) count = db.prepare('SELECT COUNT(*) AS c FROM items').get().c;
    size = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  } catch {}
  return {
    storage: config.media?.storage || 'json',
    sqliteAvailable: loaded,
    sqliteRows: count,
    dbBytes: size,
    lastSync: lastSync ? new Date(lastSync).toISOString() : null,
    node: process.version,
    path: loaded ? DB_PATH : null,
  };
}

const UPSERT = `INSERT INTO items (id, type, title, artist, album, genre, year, rating, duration, file_size, added_at, updated_at, path, video_codec, resolution, library_id, data)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  type=excluded.type, title=excluded.title, artist=excluded.artist, album=excluded.album,
  genre=excluded.genre, year=excluded.year, rating=excluded.rating, duration=excluded.duration,
  file_size=excluded.file_size, added_at=excluded.added_at, updated_at=excluded.updated_at,
  path=excluded.path, video_codec=excluded.video_codec, resolution=excluded.resolution,
  library_id=excluded.library_id, data=excluded.data`;

function rowFor(item) {
  return [
    item.id,
    item.type || null,
    item.title || null,
    item.artist || null,
    item.album || null,
    Array.isArray(item.genre) ? item.genre.join(', ') : (item.genre || null),
    item.year ? Number(item.year) : null,
    item.rating ? Number(item.rating) : null,
    item.duration ? Number(item.duration) : null,
    item.fileSize || null,
    item.addedAt || null,
    item.updatedAt || null,
    item.path || null,
    item.videoCodec || null,
    item.resolution || null,
    item.libraryId || null,
    JSON.stringify(item),
  ];
}

/** Rebuild the whole index from the in-memory library. */
function sync(items = []) {
  if (!tryLoad()) return { synced: 0, available: false };
  try {
    db.exec('BEGIN');
    db.exec('DELETE FROM items');
    const stmt = db.prepare(UPSERT);
    for (const item of items) stmt.run(...rowFor(item));
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('synced_at', new Date().toISOString());
    db.exec('COMMIT');
    lastSync = Date.now();
    return { synced: items.length, available: true };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    logger.warn(`[Index] sync failed: ${err.message}`);
    return { synced: 0, available: true, error: err.message };
  }
}

/** Incremental update for a single item (add/update/delete). */
function upsert(item) {
  if (!tryLoad() || !item) return false;
  try {
    db.prepare(UPSERT).run(...rowFor(item));
    return true;
  } catch (err) {
    logger.warn(`[Index] upsert failed: ${err.message}`);
    return false;
  }
}

function remove(id) {
  if (!tryLoad()) return false;
  try {
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Query the SQL index. Returns null when SQLite is unavailable so callers can
 * fall back to the in-memory implementation.
 */
function query({ type = null, search = null, genre = null, year = null, sort = 'added_at', order = 'desc', page = 1, limit = 50 } = {}) {
  if (!tryLoad()) return null;
  const where = [];
  const params = [];
  if (type && type !== 'all') {
    where.push('type = ?');
    params.push(type);
  }
  if (search) {
    where.push('(LOWER(title) LIKE ? OR LOWER(artist) LIKE ? OR LOWER(album) LIKE ?)');
    const like = `%${String(search).toLowerCase()}%`;
    params.push(like, like, like);
  }
  if (genre) {
    where.push('LOWER(genre) LIKE ?');
    params.push(`%${String(genre).toLowerCase()}%`);
  }
  if (year) {
    where.push('year = ?');
    params.push(Number(year));
  }
  const sortColumn = {
    addedAt: 'added_at',
    title: 'title',
    artist: 'artist',
    album: 'album',
    year: 'year',
    rating: 'rating',
    duration: 'duration',
    fileSize: 'file_size',
  }[sort] || 'added_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';

  try {
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS c FROM items ${clause}`).get(...params).c;
    const size = Math.min(1000, Math.max(1, parseInt(limit, 10) || 50));
    const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * size;
    const rows = db.prepare(`SELECT data FROM items ${clause} ORDER BY ${sortColumn} ${direction} LIMIT ? OFFSET ?`)
      .all(...params, size, offset);
    return { items: rows.map(r => JSON.parse(r.data)), total, page, limit: size };
  } catch (err) {
    logger.warn(`[Index] query failed: ${err.message}`);
    return null;
  }
}

module.exports = { status, sync, upsert, remove, query, tryLoad, DB_PATH };
