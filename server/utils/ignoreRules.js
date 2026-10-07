/**
 * Glob-ish ignore matching for library scanners — patterns such as "*.tmp" or
 * a Sample folder tree (wildcards allowed), plus the built-in noise filters
 * every media server applies (dotfiles, @eaDir, AppleDouble files, Thumbs.db…).
 */
const BUILTIN_DIRS = new Set(['@eadir', '.ds_store', '.trash', '#recycle', '@recycle', 'lost+found', 'node_modules', '.git']);
const BUILTIN_FILE_PATTERNS = [
  /^\._/, // macOS AppleDouble resource forks
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
  /^desktop\.ini$/i,
  /\.part$/i,
  /\.tmp$/i,
  /\.!ut$/i,
];

function patternToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`(^|[/\\\\])${escaped}($|[/\\\\])`, 'i');
}

function compile(patterns = []) {
  return patterns.filter(Boolean).map(p => patternToRegex(String(p).trim()));
}

function isIgnored(relativePath, patterns = [], name = '') {
  const lowerName = String(name).toLowerCase();
  if (BUILTIN_DIRS.has(lowerName)) return true;
  if (BUILTIN_FILE_PATTERNS.some(re => re.test(name))) return true;
  for (const re of compile(patterns)) {
    if (re.test(relativePath)) return true;
  }
  return false;
}

function isIgnoredDir(name, relativePath, patterns = []) {
  return isIgnored(relativePath, patterns, name);
}

module.exports = { isIgnored, isIgnoredDir, compile, BUILTIN_DIRS };
