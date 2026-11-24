/**
 * Subsonic-compatible API subset.
 *
 * Any Subsonic client (Symfonium, play:Sub, DSub, Feishin, Sonixd, substreamer,
 * Amperfy…) can point at `/rest/*` on this server and get the music library,
 * artwork, streaming and playlists without a Vault app existing for that
 * platform. Responses are JSON when `f=json` (default here), XML otherwise.
 */
const path = require('path');
const fs = require('fs-extra');
const libraryService = require('./library');
const authService = require('./authService');
const profiles = require('./profiles');
const logger = require('../utils/logger');

const API_VERSION = '1.16.1';
const SERVER_NAME = 'Vault';
const SERVER_VERSION = '3.0.0';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toXml(name, value, attrs = '') {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(v => toXml(name, v)).join('');
  if (typeof value === 'object') return `<${name}${attrs}>${Object.entries(value).map(([k, v]) => toXml(k, v)).join('')}</${name}>`;
  return `<${name}${attrs}>${escapeXml(value)}</${name}>`;
}

/** Wrap a payload in the Subsonic envelope. */
function respond(req, res, payload) {
  const wantsJson = (req.query.f || 'json') === 'json';
  const envelope = {
    'subsonic-response': {
      xmlns: 'http://subsonic.org/restapi',
      status: 'ok',
      version: API_VERSION,
      type: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      ...payload,
    },
  };
  if (wantsJson) return res.json(envelope);
  res.type('application/xml');
  const body = Object.entries(envelope['subsonic-response'])
    .filter(([key]) => key !== 'xmlns')
    .map(([key, value]) => toXml(key, value))
    .join('');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="${API_VERSION}" type="${SERVER_NAME}" serverVersion="${SERVER_VERSION}">${body}</subsonic-response>`);
}

function error(req, res, code, message) {
  const wantsJson = (req.query.f || 'json') === 'json';
  const payload = { status: 'failed', version: API_VERSION, type: SERVER_NAME, serverVersion: SERVER_VERSION, error: { code, message } };
  if (wantsJson) return res.status(200).json({ 'subsonic-response': payload });
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="${API_VERSION}" type="${SERVER_NAME}" serverVersion="${SERVER_VERSION}"><error code="${code}" message="${escapeXml(message)}"/></subsonic-response>`);
}

const SUBSONIC_ERRORS = {
  0: 'Generic error',
  10: 'Required parameter is missing',
  40: 'Wrong username or password',
  50: 'User is not authorized for the given operation',
  70: 'The requested data was not found',
};

// ---------------------------------------------------------------------------
// Authentication
//
// Subsonic clients use `u` + `p` (plaintext or `enc:`hex) or `u` + `t`/`s`
// (md5(password + salt)). Vault stores the main password as a bcrypt hash, which
// cannot answer token auth, so an optional *Subsonic password* can be set in
// Settings; it is stored AES-256-GCM encrypted with the JWT secret.
//
// Security: Subsonic is OFF until that password is set, and the normal Vault
// password is never accepted here — Subsonic has no second step, so taking
// the account password would let it skip the grid / authenticator check.
// Wrong passwords count towards a per-IP lockout like the sign-in screen.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function encryptionKey() {
  const config = require('../config').getConfig();
  return crypto.createHash('sha256').update(`vault-subsonic:${config.auth.jwtSecret}`).digest();
}

function setSubsonicPassword(password, username = null) {
  const { getConfig, saveConfig } = require('../config');
  const config = getConfig();
  if (!password) {
    config.auth.subsonic = { enabled: false, username: null, passwordEnc: null, profileId: config.auth.subsonic?.profileId || 'default' };
    saveConfig(config);
    return { enabled: false };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  config.auth.subsonic = {
    enabled: true,
    username: username || config.auth.username,
    profileId: config.auth.subsonic?.profileId || 'default',
    passwordEnc: `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`,
  };
  saveConfig(config);
  return { enabled: true, username: config.auth.subsonic.username };
}

function getSubsonicPassword() {
  const config = require('../config').getConfig();
  const entry = config.auth.subsonic;
  if (!entry || !entry.enabled || !entry.passwordEnc) return null;
  try {
    const [ivB64, tagB64, dataB64] = entry.passwordEnc.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Profile
//
// Subsonic has one account, so it browses the library as one Vault profile
// (Settings → System → Services; default: the main profile). That profile's
// age limits apply to everything the API lists, streams or downloads — a kid
// profile's Subsonic app used to see the whole library. Its favourites
// ("starred"), playlists and play history are the ones Subsonic reads and
// changes.
// ---------------------------------------------------------------------------
function subsonicProfileId() {
  const config = require('../config').getConfig();
  return config.auth.subsonic?.profileId || 'default';
}

function setSubsonicProfile(profileId) {
  const { getConfig, saveConfig } = require('../config');
  const profile = profiles.get(String(profileId || ''));
  if (!profile) {
    const err = new Error('Profile not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const config = getConfig();
  config.auth.subsonic = { ...(config.auth.subsonic || { enabled: false }), profileId: profile.id };
  saveConfig(config);
  return subsonicStatus();
}

function subsonicStatus() {
  const config = require('../config').getConfig();
  const entry = config.auth.subsonic || {};
  const profile = profiles.get(entry.profileId || 'default');
  return {
    enabled: !!entry.enabled,
    username: entry.username || null,
    profileId: entry.profileId || 'default',
    profileName: profile?.name || null,
    // The chosen profile was deleted: Subsonic refuses to sign in until
    // another is picked (falling back to the main profile would lift limits).
    profileMissing: !profile,
    // Clients that only implement token auth (t/s) need this password.
    tokenAuthSupported: !!entry.enabled,
  };
}

/** Successful sign-in: browse as the Subsonic profile (fails closed). */
function bindProfile(req, res) {
  const profileId = subsonicProfileId();
  if (!profiles.get(profileId)) {
    error(req, res, 50, 'The Vault profile Subsonic uses was removed. Choose another in Vault → System → Services.');
    return false;
  }
  // Subsonic apps can't show the Terms of Use, so the profile they browse as
  // must have accepted the current version in Vault first.
  if (!require('./terms').isAccepted(profileId)) {
    error(req, res, 50, 'The Vault profile Subsonic uses has not accepted the current Terms of Use. Open Vault, sign in as that profile and accept them.');
    return false;
  }
  req.profileId = profileId;
  return true;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authenticate(req, res) {
  const config = require('../config').getConfig();
  const { u, p, t, s } = req.query;
  const username = u;

  if (!username) {
    error(req, res, 10, 'Required parameter is missing: u');
    return false;
  }

  const ip = authService.getClientIp(req);
  if (authService.isLocked(ip, 'subsonic')) {
    const minutes = Math.ceil(authService.getLockoutTimeRemaining(ip, 'subsonic') / 60);
    error(req, res, 40, `Too many wrong passwords. Try again in ${minutes} minutes.`);
    return false;
  }

  const stored = getSubsonicPassword();
  if (!stored) {
    error(req, res, 40, 'Subsonic access is off. Turn it on by setting a Subsonic password in Vault → System → Services.');
    return false;
  }

  const subsonic = config.auth.subsonic || {};
  const accountName = subsonic.username || config.auth.username;
  const fail = () => {
    authService.recordFailedAttempt(ip, 'subsonic');
    error(req, res, 40, 'Wrong username or password');
    return false;
  };

  // Token auth: md5(password + salt)
  if (t && s) {
    const expected = crypto.createHash('md5').update(`${stored}${s}`).digest('hex');
    if (String(username) !== accountName || !safeEqual(expected, String(t).toLowerCase())) return fail();
    return bindProfile(req, res);
  }

  if (!p) {
    error(req, res, 10, 'Required parameter is missing: p (or t and s)');
    return false;
  }

  let password = String(p);
  if (password.startsWith('enc:')) {
    try {
      password = Buffer.from(password.slice(4), 'hex').toString('utf8');
    } catch {
      return fail();
    }
  }

  if (String(username) !== accountName || !safeEqual(password, stored)) return fail();
  return bindProfile(req, res);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
/** Music the signed-in Subsonic profile may see. */
function musicItems(req) {
  return profiles.filterItems(req.profileId || 'default', libraryService.getAll().filter(i => i.type === 'music'));
}

/** One item by id, if the Subsonic profile may see it. */
function itemFor(req, id) {
  const item = libraryService.getById(String(id || ''));
  return item && profiles.canAccess(req.profileId || 'default', item) ? item : null;
}

function toSong(item) {
  return {
    id: item.id,
    parent: item.album || 'album',
    isDir: false,
    title: item.title,
    album: item.album || 'Unknown Album',
    artist: item.artist || 'Unknown Artist',
    track: item.track || 0,
    year: item.year || undefined,
    genre: item.genre || undefined,
    coverArt: item.id,
    size: item.fileSize || 0,
    contentType: 'audio/mpeg',
    suffix: (item.format || 'mp3'),
    duration: Math.round(item.duration || 0),
    bitRate: Math.round((item.bitrate || 0) / 1000),
    path: item.filename,
    playCount: item.playCount || 0,
    created: item.addedAt,
    albumId: `album:${item.album || 'unknown'}`,
    artistId: `artist:${item.artist || 'unknown'}`,
    type: 'music',
  };
}

function toAlbum(name, tracks) {
  const first = tracks[0] || {};
  return {
    id: `album:${name}`,
    name,
    artist: first.artist || 'Unknown Artist',
    artistId: `artist:${first.artist || 'unknown'}`,
    coverArt: first.id,
    songCount: tracks.length,
    duration: Math.round(tracks.reduce((sum, t) => sum + (t.duration || 0), 0)),
    created: first.addedAt,
    year: first.year || undefined,
    genre: first.genre || undefined,
    playCount: tracks.reduce((sum, t) => sum + (t.playCount || 0), 0),
  };
}

function groupAlbums(req) {
  return groupBy(musicItems(req), i => i.album || 'Unknown Album');
}

function groupArtists(req) {
  return groupBy(musicItems(req), i => i.artist || 'Unknown Artist');
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function playlistsFor(profileId) {
  return libraryService.forProfile(profileId).getPlaylists();
}

function playlistItems(playlist, req) {
  return (playlist.items || []).map(id => (req ? itemFor(req, id) : libraryService.getById(id))).filter(Boolean);
}

function toPlaylist(playlist, req = null) {
  const items = playlistItems(playlist, req);
  return {
    id: playlist.id,
    name: playlist.name,
    comment: playlist.description || undefined,
    owner: 'vault',
    public: false,
    songCount: items.length,
    duration: Math.round(items.reduce((sum, i) => sum + (i.duration || 0), 0)),
    created: playlist.createdAt,
    changed: playlist.updatedAt,
    coverArt: items[0]?.id,
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
function register(router, { streamHandler, coverHandler }) {
  // Apps call ping to check the password, so it must really check it.
  router.all('/ping', (req, res) => {
    if (!authenticate(req, res)) return;
    respond(req, res, {});
  });
  router.all('/getLicense', (req, res) => {
    if (!authenticate(req, res)) return;
    respond(req, res, { license: { valid: true } });
  });

  router.all('/getMusicFolders', (req, res) => {
    if (!authenticate(req, res)) return;
    respond(req, res, { musicFolders: { musicFolder: [{ id: 1, name: 'Vault Music' }] } });
  });

  router.all('/getArtists', (req, res) => {
    if (!authenticate(req, res)) return;
    const artists = [...groupArtists(req).entries()].map(([name, tracks]) => ({
      id: `artist:${name}`,
      name,
      albumCount: new Set(tracks.map(t => t.album)).size,
      coverArt: tracks[0]?.id,
      album: [...groupBy(tracks, t => t.album || 'Unknown Album').entries()].map(([album, list]) => toAlbum(album, list)),
    }));
    respond(req, res, { artists: { ignoredArticles: '', index: [{ name: '#', artist: artists }] } });
  });

  router.all('/getIndexes', (req, res) => {
    if (!authenticate(req, res)) return;
    const artists = [...groupArtists(req).entries()].map(([name, tracks]) => ({ id: `artist:${name}`, name, albumCount: new Set(tracks.map(t => t.album)).size }));
    respond(req, res, {
      indexes: {
        lastModified: Date.now(),
        ignoredArticles: '',
        index: [{ name: '#', artist: artists }],
      },
    });
  });

  router.all('/getArtist', (req, res) => {
    if (!authenticate(req, res)) return;
    const name = String(req.query.id || '').replace(/^artist:/, '');
    const tracks = musicItems(req).filter(i => (i.artist || 'Unknown Artist') === name);
    if (!tracks.length) return error(req, res, 70, 'Artist not found');
    respond(req, res, {
      artist: {
        id: `artist:${name}`,
        name,
        albumCount: new Set(tracks.map(t => t.album)).size,
        album: [...groupBy(tracks, t => t.album || 'Unknown Album').entries()].map(([album, list]) => toAlbum(album, list)),
      },
    });
  });

  router.all('/getAlbum', (req, res) => {
    if (!authenticate(req, res)) return;
    const id = String(req.query.id || '').replace(/^album:/, '');
    const tracks = musicItems(req).filter(i => (i.album || 'Unknown Album') === id);
    if (!tracks.length) return error(req, res, 70, 'Album not found');
    respond(req, res, {
      album: { ...toAlbum(id, tracks), song: tracks.map(toSong) },
    });
  });

  router.all('/getAlbumList2', (req, res) => {
    if (!authenticate(req, res)) return;
    const type = req.query.type || 'recent';
    const size = Math.min(500, parseInt(req.query.size, 10) || 50);
    const offset = parseInt(req.query.offset, 10) || 0;
    let albums = [...groupAlbums(req).entries()].map(([name, tracks]) => toAlbum(name, tracks));

    switch (type) {
      case 'newest':
        albums.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
        break;
      case 'alphabeticalByName':
        albums.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'alphabeticalByArtist':
        albums.sort((a, b) => a.artist.localeCompare(b.artist));
        break;
      case 'byYear':
        albums.sort((a, b) => (b.year || 0) - (a.year || 0));
        break;
      case 'frequent':
        albums.sort((a, b) => b.playCount - a.playCount);
        break;
      case 'random':
        albums = albums.sort(() => Math.random() - 0.5);
        break;
      default:
        albums.sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0));
    }
    respond(req, res, { albumList2: { album: albums.slice(offset, offset + size) } });
  });

  router.all('/getRandomSongs', (req, res) => {
    if (!authenticate(req, res)) return;
    const size = Math.min(500, parseInt(req.query.size, 10) || 20);
    const songs = [...musicItems(req)].sort(() => Math.random() - 0.5).slice(0, size).map(toSong);
    respond(req, res, { randomSongs: { song: songs } });
  });

  router.all('/search3', (req, res) => {
    if (!authenticate(req, res)) return;
    const query = String(req.query.query || '').toLowerCase();
    const limit = Math.min(200, parseInt(req.query.songCount, 10) || 50);
    const artists = [...groupArtists(req).entries()]
      .filter(([name]) => name.toLowerCase().includes(query))
      .map(([name, tracks]) => ({ id: `artist:${name}`, name, albumCount: new Set(tracks.map(t => t.album)).size }));
    const albums = [...groupAlbums(req).entries()]
      .filter(([name]) => name.toLowerCase().includes(query))
      .map(([name, tracks]) => toAlbum(name, tracks));
    const songs = musicItems(req).filter(i =>
      [i.title, i.artist, i.album].filter(Boolean).some(v => String(v).toLowerCase().includes(query))
    ).slice(0, limit).map(toSong);
    respond(req, res, { searchResult3: { artist: artists, album: albums, song: songs } });
  });

  router.all('/getGenres', (req, res) => {
    if (!authenticate(req, res)) return;
    const genres = [...groupBy(musicItems(req), i => i.genre || 'Unknown').entries()]
      .map(([name, tracks]) => ({ name, songCount: tracks.length, albumCount: new Set(tracks.map(t => t.album)).size }));
    respond(req, res, { genres: { genre: genres } });
  });

  router.all('/getSongsByGenre', (req, res) => {
    if (!authenticate(req, res)) return;
    const genre = String(req.query.genre || '').toLowerCase();
    const songs = musicItems(req).filter(i => String(i.genre || '').toLowerCase() === genre).map(toSong);
    respond(req, res, { songsByGenre: { song: songs } });
  });

  router.all('/star', (req, res) => {
    if (!authenticate(req, res)) return;
    const item = itemFor(req, req.query.id);
    if (item) libraryService.forProfile(req.profileId || 'default').addFavourite(item.id);
    respond(req, res, {});
  });

  router.all('/unstar', (req, res) => {
    if (!authenticate(req, res)) return;
    if (req.query.id) libraryService.forProfile(req.profileId || 'default').removeFavourite(String(req.query.id));
    respond(req, res, {});
  });

  router.all('/getStarred2', (req, res) => {
    if (!authenticate(req, res)) return;
    const favourites = profiles.filterItems(req.profileId || 'default',
      libraryService.forProfile(req.profileId || 'default').getFavourites().filter(i => i.type === 'music'));
    respond(req, res, {
      starred2: {
        song: favourites.map(toSong),
        album: [...groupBy(favourites, i => i.album || 'Unknown Album').entries()].map(([name, tracks]) => toAlbum(name, tracks)),
        artist: [...groupBy(favourites, i => i.artist || 'Unknown Artist').entries()].map(([name, tracks]) => ({ id: `artist:${name}`, name, albumCount: new Set(tracks.map(t => t.album)).size })),
      },
    });
  });

  router.all('/getPlaylists', (req, res) => {
    if (!authenticate(req, res)) return;
    respond(req, res, { playlists: { playlist: playlistsFor(req.profileId || 'default').map(p => toPlaylist(p, req)) } });
  });

  router.all('/getPlaylist', (req, res) => {
    if (!authenticate(req, res)) return;
    const playlist = playlistsFor(req.profileId || 'default').find(p => p.id === req.query.id);
    if (!playlist) return error(req, res, 70, 'Playlist not found');
    respond(req, res, {
      playlist: {
        ...toPlaylist(playlist, req),
        entry: playlistItems(playlist, req).map(toSong),
      },
    });
  });

  router.all('/createPlaylist', (req, res) => {
    if (!authenticate(req, res)) return;
    const ids = [].concat(req.query.songId || []);
    const scoped = libraryService.forProfile(req.profileId || 'default');
    const playlist = scoped.createPlaylist({ name: String(req.query.name || 'Playlist'), items: ids.filter(id => itemFor(req, id)) });
    respond(req, res, { playlist: toPlaylist(playlist, req) });
  });

  router.all('/updatePlaylist', (req, res) => {
    if (!authenticate(req, res)) return;
    const scoped = libraryService.forProfile(req.profileId || 'default');
    const playlist = scoped.getPlaylistById(req.query.playlistId);
    if (!playlist) return error(req, res, 70, 'Playlist not found');
    const add = [].concat(req.query.songIdToAdd || []).filter(id => itemFor(req, id));
    const removeIndexes = [].concat(req.query.songIndexToRemove || []).map(Number);
    let items = [...(playlist.items || [])];
    for (const index of removeIndexes.sort((a, b) => b - a)) items.splice(index, 1);
    items = [...items, ...add];
    scoped.updatePlaylist(playlist.id, {
      name: req.query.name !== undefined ? String(req.query.name) : undefined,
      comment: req.query.comment !== undefined ? String(req.query.comment) : undefined,
      items,
    });
    respond(req, res, {});
  });

  router.all('/deletePlaylist', (req, res) => {
    if (!authenticate(req, res)) return;
    libraryService.forProfile(req.profileId || 'default').deletePlaylist(req.query.id);
    respond(req, res, {});
  });

  router.all('/scrobble', (req, res) => {
    if (!authenticate(req, res)) return;
    const itemId = String(req.query.id || '');
    const submission = req.query.submission !== 'false';
    const item = itemId ? itemFor(req, itemId) : null;
    if (item) {
      const scoped = libraryService.forProfile(req.profileId || 'default');
      scoped.addHistoryEntry({ itemId, progress: submission ? 100 : 0, duration: item?.duration || 0, bumpPlayCount: submission });
    }
    respond(req, res, {});
  });

  router.all('/stream', (req, res) => {
    if (!authenticate(req, res)) return;
    const item = itemFor(req, req.query.id);
    if (!item || !fs.existsSync(item.path)) return error(req, res, 70, 'Song not found');
    return streamHandler(req, res, item);
  });

  router.all('/download', (req, res) => {
    if (!authenticate(req, res)) return;
    const item = itemFor(req, req.query.id);
    if (!item || !fs.existsSync(item.path)) return error(req, res, 70, 'File not found');
    res.download(item.path, path.basename(item.path));
  });

  router.all('/getCoverArt', (req, res) => {
    if (!authenticate(req, res)) return;
    const item = itemFor(req, req.query.id);
    if (!item) return error(req, res, 70, 'Cover not found');
    return coverHandler(req, res, item);
  });

  router.all('/getScanStatus', (req, res) => {
    if (!authenticate(req, res)) return;
    respond(req, res, { scanStatus: { scanning: false, count: musicItems(req).length } });
  });

  router.all('/startScan', async (req, res) => {
    if (!authenticate(req, res)) return;
    // Scanning is an admin action in Vault itself.
    if (!require('../middleware/requireAdmin').isAdminProfile(req.profileId)) return error(req, res, 50, 'Only an admin profile can start a scan');
    try {
      const scanner = require('./scanner');
      const result = await scanner.scanAll();
      respond(req, res, { scanStatus: { scanning: false, count: result.scanned } });
    } catch (err) {
      logger.warn(`[Subsonic] scan failed: ${err.message}`);
      error(req, res, 0, 'Scan failed');
    }
  });

  return router;
}

module.exports = { register, respond, error, toSong, toAlbum, toPlaylist, API_VERSION, SUBSONIC_ERRORS, setSubsonicPassword, setSubsonicProfile, subsonicProfileId, subsonicStatus, getSubsonicPassword };
