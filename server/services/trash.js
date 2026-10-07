/**
 * Soft-delete trash with a restore window.
 *
 * Deleting a media file used to be permanent. Now the file is *moved* into
 * `server/data/trash/` (same filesystem → instant rename, no copying) and can be
 * restored for `retentionDays`. The library entry is removed immediately so the
 * UI matches what the user asked for.
 */
const fs = require('fs-extra');
const path = require('path');
const { createJsonStore } = require('../utils/jsonStore');
const { writeJsonAtomic } = require('../utils/fileUtils');
const logger = require('../utils/logger');

const TRASH_DIR = path.join(__dirname, '..', 'data', 'trash');
const store = createJsonStore('trash.json', []);

function uniqueName(name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  return `${base}-${Date.now().toString(36)}${ext}`;
}

/**
 * Move a file into the trash. Returns the trash entry, or null if the file
 * could not be moved (cross-device, permissions, missing).
 */
async function moveToTrash(filePath, meta = {}) {
  if (!filePath) return null;
  try {
    if (!(await fs.pathExists(filePath))) return null;
    await fs.ensureDir(TRASH_DIR);
    const storedName = uniqueName(path.basename(filePath));
    const storedPath = path.join(TRASH_DIR, storedName);
    try {
      await fs.move(filePath, storedPath, { overwrite: false });
    } catch (err) {
      // Different volume → fall back to copy + unlink (keep disk-space check honest)
      const stat = await fs.stat(filePath);
      await fs.copy(filePath, storedPath, { overwrite: false });
      await fs.remove(filePath);
      logger.warn(`[Trash] Cross-device move for ${path.basename(filePath)} (${stat.size} bytes) — copied instead`);
    }
    const entry = {
      id: `trash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      originalPath: filePath,
      storedPath,
      name: path.basename(filePath),
      size: (await fs.stat(storedPath)).size,
      type: meta.type || null,
      title: meta.title || path.basename(filePath),
      itemId: meta.itemId || null,
      deletedAt: new Date().toISOString(),
      retentionDays: meta.retentionDays ?? 30,
    };
    const list = store.get();
    list.unshift(entry);
    store.set(list);
    return entry;
  } catch (err) {
    logger.warn(`[Trash] Failed to trash ${filePath}: ${err.message}`);
    return null;
  }
}

function list() {
  return store.get();
}

function get(id) {
  return store.get().find(t => t.id === id) || null;
}

async function restore(id) {
  const entry = get(id);
  if (!entry) return null;
  try {
    if (!(await fs.pathExists(entry.storedPath))) return null;
    await fs.ensureDir(path.dirname(entry.originalPath));
    let target = entry.originalPath;
    if (await fs.pathExists(target)) {
      target = path.join(path.dirname(entry.originalPath), uniqueName(entry.name));
    }
    await fs.move(entry.storedPath, target, { overwrite: false });
    store.set(store.get().filter(t => t.id !== id));
    return { ...entry, restoredTo: target };
  } catch (err) {
    logger.warn(`[Trash] Restore failed for ${id}: ${err.message}`);
    return null;
  }
}

async function purge(id) {
  const entry = get(id);
  if (!entry) return false;
  try {
    await fs.remove(entry.storedPath);
  } catch {}
  store.set(store.get().filter(t => t.id !== id));
  return true;
}

async function empty() {
  const list = store.get();
  let removed = 0;
  for (const entry of list) {
    try {
      await fs.remove(entry.storedPath);
      removed++;
    } catch {}
  }
  store.set([]);
  await writeJsonAtomic(store.path, []);
  return removed;
}

/** Delete entries past their retention window. Called on a daily timer. */
async function pruneExpired() {
  const now = Date.now();
  const list = store.get();
  const keep = [];
  let pruned = 0;
  for (const entry of list) {
    const ageDays = (now - new Date(entry.deletedAt).getTime()) / 86400000;
    if (ageDays > (entry.retentionDays ?? 30)) {
      try {
        await fs.remove(entry.storedPath);
      } catch {}
      pruned++;
    } else {
      keep.push(entry);
    }
  }
  if (pruned) store.set(keep);
  return pruned;
}

async function totalSize() {
  let total = 0;
  for (const entry of store.get()) {
    try {
      total += (await fs.stat(entry.storedPath)).size;
    } catch {}
  }
  return total;
}

async function flush() {
  await store.flush();
}

module.exports = {
  moveToTrash,
  list,
  get,
  restore,
  purge,
  empty,
  pruneExpired,
  totalSize,
  flush,
  TRASH_DIR,
};
