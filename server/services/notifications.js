/**
 * Outbound notifications and scrobbling.
 *
 * Targets are configured in `config.notifications` and are all no-ops until a
 * URL/token is filled in. Events come from the SSE bus (scan finished, upload
 * complete, new item) plus explicit "now playing" hooks from the player.
 */
const crypto = require('crypto');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const events = require('./events');
const { createJsonStore } = require('../utils/jsonStore');

const scrobbleStore = createJsonStore('scrobbles.json', []);
const MIN_INTERVAL_MS = 1500;
const lastSent = new Map();

function throttle(key) {
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < MIN_INTERVAL_MS) return false;
  lastSent.set(key, now);
  return true;
}

async function post(url, body, headers = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Vault/3.0', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return true;
  } catch (err) {
    logger.warn(`[Notify] ${url.slice(0, 40)}… failed: ${err.message}`);
    return false;
  }
}

async function send(title, message, level = 'info') {
  const config = getConfig();
  const n = config.notifications || {};
  const results = {};

  if (n.webhookUrl) {
    if (throttle('webhook')) {
      results.webhook = await post(n.webhookUrl, {
        source: 'vault',
        level,
        title,
        message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (n.ntfyUrl) {
    if (throttle('ntfy')) {
      const topic = n.ntfyUrl.replace(/\/$/, '');
      results.ntfy = await post(topic, message, {
        Title: encodeURIComponent(title),
        Priority: level === 'error' ? 'high' : 'default',
        Tags: level === 'error' ? 'warning' : 'vault',
      });
    }
  }

  if (n.discordWebhook) {
    if (throttle('discord')) {
      results.discord = await post(n.discordWebhook, {
        content: `**${title}**\n${message}`,
      });
    }
  }

  if (n.telegram?.botToken && n.telegram?.chatId) {
    if (throttle('telegram')) {
      results.telegram = await post(
        `https://api.telegram.org/bot${n.telegram.botToken}/sendMessage`,
        { chat_id: n.telegram.chatId, text: `${title}\n${message}` }
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Library-event bridge
// ---------------------------------------------------------------------------
function wireLibraryEvents() {
  let scanTimer = null;
  let pending = 0;

  events.broadcast; // no-op; keeps intent obvious for readers
  const originalBroadcast = events.broadcast;

  events.broadcast = function patchedBroadcast(event, data = {}) {
    originalBroadcast(event, data);
    if (event === 'library:changed' && data.reason === 'scan') {
      clearTimeout(scanTimer);
      pending += data.scanned || 0;
      scanTimer = setTimeout(() => {
        send('Library scan complete', `${pending} item(s) indexed`, 'info');
        pending = 0;
      }, 2000);
    }
    if (event === 'job:finish' && data.kind === 'upload') {
      send('Upload complete', `${data.label || 'Files'} added to your library`, 'info');
    }
  };
}

// ---------------------------------------------------------------------------
// Scrobbling (Last.fm + ListenBrainz)
// ---------------------------------------------------------------------------
function md5(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

async function lastfm(method, params) {
  const config = getConfig();
  const cfg = config.notifications?.scrobble?.lastfm || {};
  if (!cfg.apiKey || !cfg.apiSecret) return null;
  const body = new URLSearchParams({ method, api_key: cfg.apiKey, format: 'json', ...params });
  if (cfg.sessionKey) body.set('sk', cfg.sessionKey);
  body.set('api_sig', md5(
    Object.keys(Object.fromEntries(body.entries())).sort().map(k => `${k}${body.get(k)}`).join('') + cfg.apiSecret
  ));
  return post('https://ws.audioscrobbler.com/2.0/', body.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
}

async function nowPlaying(item) {
  const config = getConfig();
  const lb = config.notifications?.scrobble?.listenbrainz || {};
  const tasks = [];

  if (item.type === 'music' || item.type === 'audiobook') {
    tasks.push(lastfm('track.updateNowPlaying', {
      artist: item.artist || 'Unknown Artist',
      track: item.title,
      album: item.album || '',
      duration: Math.round(item.duration || 0),
    }));
  }

  if (lb.token) {
    tasks.push(post('https://api.listenbrainz.org/1/submit-listens', {
      listen_type: 'playing_now',
      payload: [{
        track_metadata: {
          artist_name: item.artist || item.albumArtist || 'Unknown Artist',
          track_name: item.title,
          release_name: item.album || undefined,
        },
      }],
    }, { Authorization: `Token ${lb.token}` }));
  }

  await Promise.allSettled(tasks.filter(Boolean));
}

async function scrobble(item, playedAt = new Date()) {
  const config = getConfig();
  const lb = config.notifications?.scrobble?.listenbrainz || {};
  const entry = {
    id: `sc_${Date.now()}`,
    itemId: item.id,
    title: item.title,
    artist: item.artist || null,
    album: item.album || null,
    playedAt: playedAt.toISOString(),
    submitted: { lastfm: false, listenbrainz: false },
  };

  if (config.notifications?.scrobble?.lastfm?.sessionKey) {
    const ok = await lastfm('track.scrobble', {
      artist: item.artist || 'Unknown Artist',
      track: item.title,
      album: item.album || '',
      timestamp: String(Math.floor(playedAt.getTime() / 1000)),
      duration: Math.round(item.duration || 0),
    });
    entry.submitted.lastfm = !!ok;
  }

  if (lb.token) {
    const ok = await post('https://api.listenbrainz.org/1/submit-listens', {
      listen_type: 'single',
      payload: [{
        listened_at: Math.floor(playedAt.getTime() / 1000),
        track_metadata: {
          artist_name: item.artist || item.albumArtist || 'Unknown Artist',
          track_name: item.title,
          release_name: item.album || undefined,
        },
      }],
    }, { Authorization: `Token ${lb.token}` });
    entry.submitted.listenbrainz = !!ok;
  }

  const list = scrobbleStore.get();
  list.unshift(entry);
  scrobbleStore.set(list.slice(0, 1000));
  return entry;
}

function recentScrobbles(limit = 50) {
  return scrobbleStore.get().slice(0, limit);
}

async function test() {
  return send('Vault test notification', 'If you can read this, notifications are wired up correctly.', 'info');
}

async function flush() {
  await scrobbleStore.flush();
}

module.exports = { send, test, nowPlaying, scrobble, recentScrobbles, wireLibraryEvents, flush };
