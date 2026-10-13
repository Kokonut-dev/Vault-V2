/**
 * Tiny JSON-file store used by the newer Vault services.
 *
 * The original services each hand-rolled load/save/debounce logic; new features
 * (watchlist, collections, markers, bookmarks, profiles, sessions, podcasts…)
 * all need the same thing, so they share this instead.
 *
 * - debounced writes (default 200ms) via `save()`
 * - `saveNow()` forces a write and returns a promise
 * - `flush()` awaits any in-flight write (used on shutdown)
 * - atomic writes through utils/fileUtils.writeJsonAtomic
 */
const fs = require('fs-extra');
const path = require('path');
const { writeJsonAtomic } = require('./fileUtils');

const DATA_DIR = path.join(__dirname, '..', 'data');

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function createJsonStore(fileName, defaultValue, options = {}) {
  const debounceMs = options.debounceMs ?? 200;
  const filePath = path.join(DATA_DIR, fileName);

  let data = null;
  let timer = null;
  let inFlight = null;

  function load() {
    if (data !== null) return data;
    try {
      if (fs.existsSync(filePath)) {
        data = fs.readJsonSync(filePath);
      } else {
        data = clone(defaultValue);
      }
    } catch {
      data = clone(defaultValue);
    }
    return data;
  }

  function saveNow() {
    load();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    inFlight = writeJsonAtomic(filePath, data).catch(() => {});
    return inFlight;
  }

  function save() {
    load();
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      saveNow();
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  async function flush() {
    if (timer) saveNow();
    if (inFlight) await inFlight.catch(() => {});
  }

  return {
    path: filePath,
    get: () => load(),
    set: (value) => {
      data = value;
      save();
      return data;
    },
    update: (fn) => {
      const next = fn(load());
      if (next !== undefined) data = next;
      save();
      return data;
    },
    save,
    saveNow,
    flush,
  };
}

module.exports = { createJsonStore, DATA_DIR };
