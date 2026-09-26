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
  isValidMediaType,
  isValidGridPattern,
  isValidUsername,
  isValidPassword,
};
