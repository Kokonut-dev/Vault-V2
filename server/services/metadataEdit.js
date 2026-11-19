/**
 * Hand-edited metadata: which fields a person may type in, how they are
 * checked, and which of them can be put back to what the file says.
 *
 * Values are stored as plain text. The routes used to run them through
 * validator.escape, so "Rock & Roll" was saved as "Rock &amp; Roll" and shown
 * with the entity spelled out (the UI escapes on render, as it should).
 */
const path = require('path');

// Single-line text fields and their maximum length.
const TEXT_FIELDS = {
  title: 500,
  artist: 500,
  albumArtist: 500,
  album: 500,
  composer: 500,
  genre: 200,
  author: 500,
  narrator: 500,
  series: 500,
  issue: 20,
  seriesTitle: 500,
};

// Multi-line text.
const LONG_TEXT_FIELDS = { description: 5000 };

// Whole numbers; an empty value clears the field.
const NUMBER_FIELDS = {
  year: [1800, 2100],
  track: [0, 10000],
  disc: [0, 1000],
  season: [0, 1000],
  episode: [0, 100000],
};

const LABELS = {
  title: 'Title', artist: 'Artist', albumArtist: 'Album artist', album: 'Album',
  composer: 'Composer', genre: 'Genre', author: 'Author', narrator: 'Narrator',
  series: 'Series', issue: 'Issue', seriesTitle: 'Show', description: 'Description',
  year: 'Year', track: 'Track number', disc: 'Disc number', season: 'Season',
  episode: 'Episode', rating: 'Rating', tags: 'Tags',
};

/**
 * Fields whose automatic value comes from the file (tags, file name, folder
 * artwork), so "revert" can read it again. Description, tags, rating and the
 * age rating have no file source, so they are just edited.
 */
const RESETTABLE_FIELDS = new Set([
  'title', 'artist', 'albumArtist', 'album', 'year', 'genre', 'track', 'disc',
  'composer', 'season', 'episode', 'seriesTitle', 'author', 'narrator', 'series',
  'issue', 'coverArtPath',
]);

// Reverting one of these also puts back the fields it drives.
const LINKED_FIELDS = {
  seriesTitle: ['seriesKey'],
  coverArtPath: ['posterPath'],
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function cleanLine(value, max) {
  return String(value).replace(CONTROL_CHARS, '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);
}

function cleanBlock(value, max) {
  return String(value).replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

const isBlank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Turn a request body into library updates.
 *
 * Only the fields in `allowed` (default: all of the above) are looked at;
 * anything else in the body is ignored. Returns `{ updates, errors }`, where
 * `errors` maps a field to a message the edit dialog shows next to it.
 */
function parseEdits(body, { allowed = null } = {}) {
  const updates = {};
  const errors = {};
  const src = body && typeof body === 'object' ? body : {};
  const wants = key => Object.prototype.hasOwnProperty.call(src, key)
    && src[key] !== undefined && (!allowed || allowed.includes(key));

  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (!wants(key)) continue;
    const raw = src[key];
    if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number') {
      errors[key] = `${LABELS[key]} must be text`;
      continue;
    }
    const value = raw === null ? '' : cleanLine(raw, max);
    if (key === 'title' && !value) {
      errors.title = 'Title can’t be empty';
      continue;
    }
    updates[key] = key === 'seriesTitle' ? (value || null) : value;
  }

  for (const [key, max] of Object.entries(LONG_TEXT_FIELDS)) {
    if (!wants(key)) continue;
    const raw = src[key];
    if (raw !== null && typeof raw !== 'string') {
      errors[key] = `${LABELS[key]} must be text`;
      continue;
    }
    updates[key] = raw === null ? '' : cleanBlock(raw, max);
  }

  for (const [key, [min, max]] of Object.entries(NUMBER_FIELDS)) {
    if (!wants(key)) continue;
    const raw = src[key];
    if (isBlank(raw)) { updates[key] = null; continue; }
    const text = String(raw).trim();
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      errors[key] = `${LABELS[key]} must be a whole number from ${min} to ${max}`;
      continue;
    }
    updates[key] = n;
  }

  if (wants('rating')) {
    const raw = src.rating;
    const r = isBlank(raw) ? 0 : Number(raw);
    if (!Number.isFinite(r) || r < 0 || r > 5) errors.rating = 'Rating must be between 0 and 5';
    else updates.rating = Math.round(r * 10) / 10;
  }

  if (wants('tags')) {
    const raw = src.tags;
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : null);
    if (!list) errors.tags = 'Tags must be a list';
    else {
      updates.tags = [...new Set(list
        .filter(t => typeof t === 'string' || typeof t === 'number')
        .map(t => cleanLine(t, 100))
        .filter(Boolean))].slice(0, 30);
    }
  }

  // The show name groups episodes: the Shows page keys them on seriesKey.
  if (updates.seriesTitle) updates.seriesKey = updates.seriesTitle.toLowerCase();

  return { updates, errors };
}

/** First message of an errors map, for the plain `error` string. */
function firstError(errors) {
  const keys = Object.keys(errors || {});
  return keys.length ? errors[keys[0]] : null;
}

/** The fields a revert touches, with linked fields added. */
function expandReset(fields) {
  const out = new Set();
  for (const f of fields) {
    if (!RESETTABLE_FIELDS.has(f)) continue;
    out.add(f);
    for (const linked of LINKED_FIELDS[f] || []) out.add(linked);
  }
  return [...out];
}

/** File name without extension — the scanner's fallback title. */
function baseTitle(filePath) {
  return filePath ? path.basename(filePath, path.extname(filePath)) : '';
}

module.exports = {
  TEXT_FIELDS,
  LONG_TEXT_FIELDS,
  NUMBER_FIELDS,
  RESETTABLE_FIELDS,
  parseEdits,
  firstError,
  expandReset,
  baseTitle,
  cleanLine,
};
