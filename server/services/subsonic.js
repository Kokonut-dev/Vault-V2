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
// Settings; it is stored AES-256-GCM encrypted with the JWT secret. Plain
// `p=` auth additionally accepts the normal account password.
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
    config.auth.subsonic = { enabled: false, username: null, passwordEnc: null };
    saveConfig(config);
    return { enabled: false };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  config.auth.subsonic = {
    enabled: true,
    username: username || config.auth.username,
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

function subsonicStatus() {
  const config = require('../config').getConfig();
  const entry = config.auth.subsonic || {};
  return {
    enabled: !!entry.enabled,
    username: entry.username || null,
    // Clients that only implement token auth (t/s) need this password.
    tokenAuthSupported: !!entry.enabled,
  };
}

function authenticate(req, res) {
  const config = require('../config').getConfig();
  const { u, p, t, s } = req.query;
  const username = u;

  if (!username) {
    error(req, res, 10, 'Required parameter is missing: u');
    return false;
  }

  const subsonic = config.auth.subsonic || {};
  const accountName = subsonic.enabled && subsonic.username ? subsonic.username : config.auth.username;

  // Token auth: md5(password + salt)
  if (t && s) {
    const stored = getSubsonicPassword();
    if (!stored) {
      error(req, res, 40, 'This client uses token authentication. Set a Subsonic password in Vault → Settings → Server.');
      return false;
    }
    const expected = crypto.createHash('md5').update(`${stored}${s}`).digest('hex');
    if (String(username) !== accountName || expected !== String(t)) {
      error(req, res, 40, 'Wrong username or password');
      return false;
    }
    return true;
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
      error(req, res, 40, 'Wrong username or password');
      return false;
    }
  }

  const stored = getSubsonicPassword();
  const matchesSubsonic = stored && username === accountName && password === stored;
  const matchesMaster = authService.validateCredentials(String(username), password);
  if (!matchesSubsonic && !matchesMaster) {
    error(req, res, 40, 'Wrong username or password');
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function musicItems() {
  return libraryService.getAll().filter(i => i.type === 'music');
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

function groupAlbums() {
  return groupBy(musicItems(), i => i.album || 'Unknown Album');
}

function groupArtists() {
  return groupBy(musicItems(), i => i.artist || 'Unknown Artist');
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

function toPlaylist(playlist) {
  const items = (playlist.items || []).map(id => libraryService.getById(id)).filter(Boolean);
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
  router.all('/ping', (req, res) => respond(req, res, {}));
  router.all('/getLicense', (req, res) => respond(req, res, { license: { valid: true } }));

  router.all('/getMusicFolders', (req, res) => {
    if (!authenticate(req, res)) return;
    respond(req, res, { musicFolders: { musicFolder: [{ id: 1, name: 'Vault Music' }] } });
  });

  router.all('/getArtists', (req, res) => {
    if (!authenticate(req, res)) return;
    const artists = [...groupArtists().entries()].map(([name, tracks]) => ({
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
    const artists = [...groupArtists().entries()].map(([name, tracks]) => ({ id: `artist:${name}`, name, albumCount: new Set(tracks.map(t => t.album)).size }));
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
    const tracks = musicItems().filter(i => (i.artist || 'Unknown Artist') === name);
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
    const tracks = musicItems().filter(i => (i.album || 'Unknown Album') === id);
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
    let albums = [...groupAlbums().entries()].map(([name, tracks]) => toAlbum(name, tracks));

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
    const songs = [...musicItems()].sort(() => Math.random() - 0.5).slice(0, size).map(toSong);
    respond(req, res, { randomSongs: { song: songs } });
  });

  router.all('/search3', (req, res) => {
    if (!authenticate(req, res)) return;
    const query = String(req.query.query || '').toLowerCase();
    const limit = Math.min(200, parseInt(req.query.songCount, 10) || 50);
    const artists = [...groupArtists().entries()]
      .filter(([name]) => name.toLowerCase().includes(query))
      .map(([name, tracks]) => ({ id: `artist:${name}`, name, albumCount: new Set(tracks.map(t => t.album)).size }));
    const albums = [...groupAlbums().entries()]
      .filter(([name]) => name.toLowerCase().includes(query))
      .map(([name, tracks]) => toAlbum(name, tracks));
    const songs = musicItems().filter(i =>
      [i.title, i.artist, i.album].filter(Boolean).some(v => String(v).toLowerCase().includes(query))
    ).slice(0, limit).map(toSong);
    respond(req, res, { searchResult3: { artist: artists, album: albums, song: songs } });
  });

  router.all('/getGenres', (req, res) => {
    if (!authenticate(req, res)) return;
    const genres = [...groupBy(musicItems(), i => i.genre || 'Unknown').entries()]
      .map(([name, tracks]) => ({ name, songCount: tracks.length, albumCount: new Set(tracks.map(t => t.album)).size }));
    respond(req, res, { genres: { genre: genres } });
  });

  router.all('/getSongsByGenre', (req, res) => {
    if (!authenticate(req, res)) return;
    const genre = String(req.query.genre || '').toLowerCase();
    const songs = musicItems().filter(i => String(i.genre || '').toLowerCase() === genre).map(toSong);
    respond(req, res, { songsByGenre: { song: songs } });
  });

  router.all('/star', (req, res) => {
    if (!authenticate(req, res)) return;
    if (req.query.id) libraryService.addFavourite(String(req.query.id));
    respond(req, res, {});
  });

  router.all('/unstar', (req, res) => {
    if (!authenticate(req, res)) return;
    if (req.query.id) libraryService.removeFavourite(String(req.query.id));
    respond(req, res, {});
  });

  router.all('/getStarred2', (req, res) => {
    if (!authenticate(req, res)) return;
    const favourites = libraryService.getFavourites().filter(i => i.type === 'music');
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
    respond(req, res, { playlists: { playlist: playlistsFor(req.profileId || 'default').map(toPlaylist) } });
  });

  router.all('/getPlaylist', (req, res) => {
    if (!authenticate(req, res)) return;
    const playlist = playlistsFor(req.profileId || 'default').find(p => p.id === req.query.id);
    if (!playlist) return error(req, res, 70, 'Playlist not found');
    respond(req, res, {
      playlist: {
        ...toPlaylist(playlist),
        entry: (playlist.items || []).map(id => libraryService.getById(id)).filter(Boolean).map(toSong),
      },
    });
  });

  router.all('/createPlaylist', (req, res) => {
    if (!authenticate(req, res)) return;
    const ids = [].concat(req.query.songId || []);
    const scoped = libraryService.forProfile(req.profileId || 'default');
    const playlist = scoped.createPlaylist({ name: String(req.query.name || 'Playlist'), items: ids });
    respond(req, res, { playlist: toPlaylist(playlist) });
  });

  router.all('/updatePlaylist', (req, res) => {
    if (!authenticate(req, res)) return;
    const scoped = libraryService.forProfile(req.profileId || 'default');
    const playlist = scoped.getPlaylistById(req.query.playlistId);
    if (!playlist) return error(req, res, 70, 'Playlist not found');
    const add = [].concat(req.query.songIdToAdd || []);
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
    if (itemId) {
      const item = libraryService.getById(itemId);
      const scoped = libraryService.forProfile(req.profileId || 'default');
      scoped.addHistoryEntry({ itemId, progress: submission ? 100 : 0, duration: item?.duration || 0, bumpPlayCount: submission });
    }
    respond(req, res, {});
  });

  router.all('/stream', (req, res) => {
    if (!authenticate(req, res)) return;
    const item = libraryService.getById(String(req.query.id || ''));
    if (!item || !fs.existsSync(item.path)) return error(req, res, 70, 'Song not found');
    return streamHandler(req, res, item);
  });

  router.all('/download', (req, res) => {
    if (!authenticate(req, res)) return;
    const item = libraryService.getById(String(req.query.id || ''));
    if (!item || !fs.existsSync(item.path)) return error(req, res, 70, 'File not found');
    res.download(item.path, path.basename(item.path));
  });

  router.all('/getCoverArt', (req, res) => {
    if (!authenticate(req, res)) return;
    const item = libraryService.getById(String(req.query.id || ''));
    if (!item) return error(req, res, 70, 'Cover not found');
    return coverHandler(req, res, item);
  });

  router.all('/getScanStatus', (req, res) => {
    if (!authenticate(req, res)) return;
    respond(req, res, { scanStatus: { scanning: false, count: musicItems().length } });
  });

  router.all('/startScan', async (req, res) => {
    if (!authenticate(req, res)) return;
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

module.exports = { register, respond, error, toSong, toAlbum, toPlaylist, API_VERSION, SUBSONIC_ERRORS, setSubsonicPassword, subsonicStatus, getSubsonicPassword };
