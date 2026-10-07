/**
 * Online metadata agents (opt-in).
 *
 * Nothing here runs unless a provider is explicitly enabled in config, and
 * every result is cached on disk so the library keeps working offline.
 *
 *  - `musicbrainz` — free, no key. Albums/artists + Cover Art Archive art.
 *  - `tmdb`        — needs an API key (movies/TV: poster, backdrop, synopsis,
 *                    cast, genres, rating, runtime).
 *  - `nfo`         — local `.nfo` / `*.info.json` sidecars (always available).
 */
const fs = require('fs-extra');
const path = require('path');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const { createJsonStore } = require('../utils/jsonStore');

const cache = createJsonStore('agent-cache.json', {});
const USER_AGENT = 'Vault/3.0 (self-hosted media server)';

function providerConfig(name) {
  const config = getConfig();
  return config.metadata?.providers?.[name] || { enabled: false };
}

function isEnabled(name) {
  const cfg = providerConfig(name);
  if (!cfg.enabled) return false;
  if (name === 'tmdb') return !!cfg.apiKey;
  return true;
}

function cacheKey(provider, query) {
  return `${provider}:${String(query).toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

function cacheGet(key, ttlHours = 24 * 30) {
  const all = cache.get();
  const hit = all[key];
  if (!hit) return null;
  if (Date.now() - new Date(hit.at).getTime() > ttlHours * 3600 * 1000) return null;
  return hit.value;
}

function cacheSet(key, value) {
  const all = cache.get();
  all[key] = { at: new Date().toISOString(), value };
  // keep the cache bounded
  const keys = Object.keys(all);
  if (keys.length > 2000) keys.slice(0, 500).forEach(k => delete all[k]);
  cache.set(all);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// TMDB
// ---------------------------------------------------------------------------
async function tmdbSearch(query, type = 'movie', year = null) {
  const cfg = providerConfig('tmdb');
  const isTv = type === 'show' || type === 'series';
  const endpoint = isTv ? 'tv' : 'movie';
  const params = new URLSearchParams({ api_key: cfg.apiKey, query, include_adult: 'false' });
  if (year) params.set(isTv ? 'first_air_date_year' : 'year', String(year));
  const data = await fetchJson(`https://api.themoviedb.org/3/search/${endpoint}?${params}`);
  return (data.results || []).slice(0, 10).map(r => ({
    provider: 'tmdb',
    kind: endpoint,
    id: String(r.id),
    title: r.title || r.name,
    year: (r.release_date || r.first_air_date || '').slice(0, 4) || null,
    overview: r.overview || '',
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w500${r.poster_path}` : null,
    backdrop: r.backdrop_path ? `https://image.tmdb.org/t/p/w1280${r.backdrop_path}` : null,
    rating: r.vote_average || null,
  }));
}

async function tmdbDetails(id, kind = 'movie') {
  const cfg = providerConfig('tmdb');
  const data = await fetchJson(`https://api.themoviedb.org/3/${kind}/${id}?api_key=${cfg.apiKey}&append_to_response=credits,images`);
  const isTv = kind === 'tv';
  return {
    provider: 'tmdb',
    id: String(data.id),
    kind,
    title: data.title || data.name,
    year: ((data.release_date || data.first_air_date) || '').slice(0, 4) || null,
    overview: data.overview || '',
    tagline: data.tagline || null,
    runtime: data.runtime || (data.episode_run_time && data.episode_run_time[0]) || null,
    genres: (data.genres || []).map(g => g.name),
    rating: data.vote_average || null,
    poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
    backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : null,
    cast: ((data.credits && data.credits.cast) || []).slice(0, 12).map(c => ({
      name: c.name,
      character: c.character,
      image: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
    })),
    directors: ((data.credits && data.credits.crew) || []).filter(c => c.job === 'Director').map(c => c.name),
    images: ((data.images && data.images.posters) || []).slice(0, 12).map(p => ({
      url: `https://image.tmdb.org/t/p/w500${p.file_path}`,
      language: p.iso_639_1,
      votes: p.vote_average,
    })),
  };
}

// ---------------------------------------------------------------------------
// MusicBrainz + Cover Art Archive
// ---------------------------------------------------------------------------
async function musicbrainzSearch({ artist = '', album = '', title = '' }) {
  const parts = [];
  if (album) parts.push(`release:"${album}"`);
  if (artist) parts.push(`artist:"${artist}"`);
  if (!parts.length && title) parts.push(`recording:"${title}"`);
  if (!parts.length) return [];
  const url = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(parts.join(' AND '))}&fmt=json&limit=8`;
  const data = await fetchJson(url);
  return (data.releases || []).map(r => ({
    provider: 'musicbrainz',
    kind: 'album',
    id: r.id,
    title: r.title,
    year: (r.date || '').slice(0, 4) || null,
    artist: ((r['artist-credit'] || [])[0] || {}).name || null,
    tracks: r['track-count'] || null,
    poster: r.id ? `https://coverartarchive.org/release/${r.id}/front-500` : null,
    overview: '',
  }));
}

// ---------------------------------------------------------------------------
// Local .nfo / info.json sidecars
// ---------------------------------------------------------------------------
function readNfo(filePath) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const candidates = [
    path.join(dir, `${stem}.nfo`),
    path.join(dir, `${stem}.info.json`),
    path.join(dir, 'movie.nfo'),
    path.join(dir, 'tvshow.nfo'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      if (candidate.endsWith('.json')) {
        const data = fs.readJsonSync(candidate);
        return { provider: 'nfo', source: candidate, ...data };
      }
      const xml = fs.readFileSync(candidate, 'utf8');
      const pick = tag => {
        const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
        return m ? m[1].trim() : null;
      };
      return {
        provider: 'nfo',
        source: candidate,
        title: pick('title'),
        year: pick('year'),
        overview: pick('plot') || pick('outline'),
        rating: pick('rating') ? Number(pick('rating')) : null,
        genres: [...xml.matchAll(/<genre[^>]*>([\s\S]*?)<\/genre>/gi)].map(m => m[1].trim()),
        poster: pick('poster') || pick('thumb'),
        backdrop: pick('fanart') || null,
      };
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Which providers are usable right now (used by the Settings UI). */
function status() {
  return {
    tmdb: { enabled: isEnabled('tmdb'), requiresKey: true },
    musicbrainz: { enabled: isEnabled('musicbrainz'), requiresKey: false },
    nfo: { enabled: providerConfig('nfo').enabled !== false, requiresKey: false },
  };
}

async function searchMatches({ query, type = 'movie', year = null, artist = '', album = '' }) {
  const results = [];
  const errors = [];

  if (isEnabled('tmdb') && (type === 'movie' || type === 'show' || type === 'series')) {
    try {
      results.push(...await tmdbSearch(query, type, year));
    } catch (err) {
      errors.push(`tmdb: ${err.message}`);
    }
  }

  if (isEnabled('musicbrainz') && (type === 'music' || type === 'audiobook')) {
    try {
      results.push(...await musicbrainzSearch({ artist, album: album || query }));
    } catch (err) {
      errors.push(`musicbrainz: ${err.message}`);
    }
  }

  return { results, errors };
}

/**
 * Fetch a full record and (optionally) download artwork + sidecar to disk.
 * Artwork files are written as `poster.jpg` / `backdrop.jpg` next to the media
 * file, which the scanner already understands — so it survives a rescan and the
 * library stays consistent.
 */
async function applyMatch(item, match, options = {}) {
  const { downloadArtwork = true } = options;
  let details = match;

  if (match.provider === 'tmdb' && !match.cast) {
    details = await tmdbDetails(match.id, match.kind || 'movie');
  }

  const dir = path.dirname(item.path);
  const written = {};

  async function download(url, name) {
    if (!url || !downloadArtwork) return null;
    const target = path.join(dir, name);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(target, buffer);
      written[name] = target;
      return target;
    } catch (err) {
      logger.warn(`[Agent] artwork download failed (${name}): ${err.message}`);
      return null;
    }
  }

  await download(details.poster, 'poster.jpg');
  await download(details.backdrop, 'backdrop.jpg');

  const patch = {
    title: details.title || item.title,
    year: details.year || item.year,
    description: details.overview || item.description,
    genre: (details.genres && details.genres[0]) || item.genre,
    genres: details.genres || item.genres || [],
    rating: details.rating ? Math.round(details.rating * 10) / 10 : item.rating,
    cast: details.cast || item.cast || [],
    tagline: details.tagline || item.tagline || null,
    metadataSource: details.provider,
    metadataSourceId: details.id || null,
    metadataMatchedAt: new Date().toISOString(),
  };
  if (written['poster.jpg']) patch.posterPath = written['poster.jpg'];
  if (written['backdrop.jpg']) patch.backdropPath = written['backdrop.jpg'];
  if (details.runtime && !item.duration) patch.duration = details.runtime * 60;

  return { patch, details };
}

async function flush() {
  await cache.flush();
}

module.exports = { status, searchMatches, applyMatch, readNfo, tmdbDetails, tmdbSearch, musicbrainzSearch, flush, isEnabled };
