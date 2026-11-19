const validator = require('validator');
const path = require('path');

function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  let s = validator.trim(str);
  s = validator.escape(s);
  if (s.length > maxLen) s = s.substring(0, maxLen);
  return s;
}

function sanitizeFilename(filename) {
  if (typeof filename !== 'string') return 'untitled';
  // Remove path traversal
  let name = path.basename(filename);
  // Allow only safe chars: alphanumeric, dash, underscore, dot, space, parentheses
  name = name.replace(/[^a-zA-Z0-9\-_.\s()\[\]]/g, '_');
  // Prevent hidden files and excessive dots
  name = name.replace(/^\.+/, '');
  if (!name) name = 'untitled';
  // Limit length
  if (name.length > 255) {
    const ext = path.extname(name);
    name = name.substring(0, 255 - ext.length) + ext;
  }
  return name;
}

/**
 * One folder or file name from a folder upload. Unlike sanitizeFilename this
 * keeps accented and non-Latin letters ("Björk", "東京事変"): album and show
 * folders are shown in the library, so mangling them to "Bj_rk" would be
 * worse than useless. Still strips everything that could escape the target
 * directory or break on Windows/macOS/Linux. Returns '' for names to drop.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function sanitizePathSegment(name) {
  if (typeof name !== 'string') return '';
  let s = name.normalize('NFC');
  // Control characters and the characters reserved on Windows (incl. / and \).
  s = s.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_');
  s = s.trim();
  if (s === '.' || s === '..') return '';
  // No hidden files / dot-dot tricks, no trailing dots or spaces (Windows).
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!s) return '';
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  if (s.length > 180) {
    const ext = path.extname(s).slice(0, 16);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

/**
 * "Artist/Album/01 Track.flac" → ['Artist', 'Album', '01 Track.flac'], with
 * every part sanitised and '', '.', '..' dropped. At most `maxDepth` folders
 * are kept; extra levels are dropped from the top, so the folders closest to
 * the file (album, season) survive. Returns [] when nothing usable is left.
 */
function safeRelativeParts(relativePath, { maxDepth = 8 } = {}) {
  const raw = String(relativePath || '').split(/[\\/]+/);
  const parts = raw.map(sanitizePathSegment).filter(Boolean);
  if (!parts.length) return [];
  const file = parts.pop();
  const dirs = parts.slice(-maxDepth);
  return [...dirs, file];
}

function isValidMediaType(type) {
  return ['movie', 'music', 'video'].includes(type);
}

function isValidGridPattern(pattern) {
  if (!Array.isArray(pattern)) return false;
  if (pattern.length !== 8) return false;
  const seen = new Set();
  for (const idx of pattern) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 15) return false;
    if (seen.has(idx)) return false;
    seen.add(idx);
  }
  return true;
}

function isValidUsername(username) {
  return typeof username === 'string' && username.length >= 3 && username.length <= 50 && /^[a-zA-Z0-9_\-]+$/.test(username);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 4 && password.length <= 128;
}

module.exports = {
  sanitizeString,
  sanitizeFilename,
  sanitizePathSegment,
  safeRelativeParts,
  isValidMediaType,
  isValidGridPattern,
  isValidUsername,
  isValidPassword,
};
