const fs = require('fs');
const path = require('path');

/**
 * For a request that looks like a file (/movie/css/vault.css), find the docs
 * file it was meant to be (css/vault.css) by dropping leading route
 * segments. Returns the absolute path, `false` for a missing asset (-> 404),
 * or null when the request is a page route (-> index.html).
 */
function resolveNestedAsset(root, requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch { return false; }
  const parts = decoded.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  // Only real asset types: /artist/will.i.am is still a page route.
  if (!/\.(css|m?js|json|map|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|webmanifest|txt|xml|html?)$/i.test(last)) return null;
  if (parts.some(p => p === '..' || p.includes('\\'))) return false;
  for (let i = 1; i < parts.length; i++) {
    const candidate = path.join(root, ...parts.slice(i));
    if (!candidate.startsWith(root + path.sep)) return false;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* keep looking */ }
  }
  return false;
}

module.exports = { resolveNestedAsset };
