/**
 * Links to an artist page (/artist/<name>, views/artists.js).
 *
 * The artist page lists the songs whose `artist` (or, when that is empty,
 * `albumArtist`) equals the name, so a link is only made when that page
 * would actually show something. "Various Artists" and unknown names stay
 * plain text.
 */
import { escapeHtml } from './format.js';
import { getBasePath } from '../config.js';

/** The name a track is filed under on the Artists page. */
export const artistKey = (track) => track?.artist || track?.albumArtist || 'Unknown artist';

export function artistPath(name) {
  return `/artist/${encodeURIComponent(name)}`;
}

/** True when /artist/<name> has songs to show. */
export function hasArtistPage(name, library = []) {
  if (!name || name === 'Various Artists') return false;
  return library.some((item) => item?.type === 'music' && artistKey(item) === name);
}

/**
 * The first of `names` that has an artist page, or null. Lets an album that
 * is credited to an album-artist tag fall back to its (single) track artist.
 */
export function pickArtist(names, library = []) {
  for (const name of names) {
    if (hasArtistPage(name, library)) return name;
  }
  return null;
}

/**
 * `label` as a link to `target`'s artist page, or as plain text when there is
 * no page. Router-handled (data-route), so it works on GitHub Pages too.
 */
export function artistLinkHtml(label, target, { className = 'artist-link' } = {}) {
  const text = escapeHtml(label || '');
  if (!target) return text;
  const path = artistPath(target);
  // href with the site's base path (/Vault-V2 on GitHub Pages) so opening it
  // in a new tab works; clicks go through the router via data-route.
  let base = '';
  try { base = (getBasePath() || '').replace(/\/$/, ''); } catch { /* no window (tests) */ }
  return `<a class="${className}" href="${escapeHtml(base + path)}" data-route="${escapeHtml(path)}" title="Go to ${escapeHtml(target)}">${text}</a>`;
}

export default { artistKey, artistPath, hasArtistPage, pickArtist, artistLinkHtml };
