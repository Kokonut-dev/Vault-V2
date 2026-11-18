/**
 * "Paste a link" helpers: recognise what a fetched URL is (M3U channel list,
 * audio playlist, XMLTV guide, podcast feed, web page), redact credentials
 * before a URL is shown back to the browser, and match playlist entries
 * against the library. See SETTINGS_REVAMP_PLAN.md SR-6.
 */
const path = require('path');

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
const SECRET_PARAM = /^(pass(word)?|pwd|token|access_token|api_?key|key|secret|auth|sig(nature)?|hash)$/i;
const MASK = '•••';

/**
 * Hide anything credential-like so a saved URL can be *described* without
 * being *revealed*: userinfo passwords, secret-looking query params, Xtream
 * style /live/<user>/<pass>/ paths, Discord/Slack webhook tokens and
 * Telegram bot tokens.
 */
function redactUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    // Local file path or something unparsable — show only the file name.
    return raw.includes('/') || raw.includes('\\') ? `…/${path.basename(raw)}` : MASK;
  }
  if (url.password) url.password = 'x';
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, 'x');
  }
  let out = url.toString();
  if (url.password) out = out.replace(/:x@/, `:${MASK}@`);
  out = out.replace(/([?&][^=&]+=)x(?=&|$|#)/g, (m, prefix) => {
    const key = prefix.slice(1, -1);
    return SECRET_PARAM.test(key) ? `${prefix}${MASK}` : m;
  });
  // Xtream Codes: /live/<user>/<pass>/123.ts, /movie/…, /series/…, and the
  // bare /<user>/<pass>/<id> form.
  out = out.replace(/\/(live|movie|series|timeshift)\/([^/]+)\/([^/]+)\//i, (m, kind, user) => `/${kind}/${user}/${MASK}/`);
  // Discord / Slack style webhook secrets in the path
  out = out.replace(/(\/api\/webhooks\/\d+\/)[^/?#]+/i, `$1${MASK}`);
  out = out.replace(/(hooks\.slack\.com\/services\/[^/]+\/[^/]+\/)[^/?#]+/i, `$1${MASK}`);
  // Telegram bot tokens
  out = out.replace(/\/bot\d+:[A-Za-z0-9_-]+/i, `/bot${MASK}`);
  return out;
}

/** Describe a saved secret-ish value for the UI without returning it. */
function describeSecret(value) {
  const configured = typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
  return { configured, hint: configured && typeof value === 'string' ? redactUrl(value) : '' };
}

// ---------------------------------------------------------------------------
// M3U
// ---------------------------------------------------------------------------
function parseAttrs(line) {
  const attrs = {};
  const re = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

/** Light-weight M3U reader used for previews (the Live TV service has its own). */
/**
 * Display name of an #EXTINF line: the text after the comma that ends the
 * attribute list. Attribute values may themselves contain commas
 * (group-title="News, UK"), so strip quoted attributes before splitting.
 */
function extinfName(line) {
  const rest = String(line).replace(/^#EXTINF:[^\s,]*/, '').replace(/([a-zA-Z0-9_-]+)="[^"]*"/g, '');
  const i = rest.indexOf(',');
  return i === -1 ? '' : rest.slice(i + 1).trim();
}

function readM3U(text) {
  const lines = String(text).split(/\r?\n/);
  const header = lines.find(l => l.trim()) || '';
  const headerAttrs = header.trim().startsWith('#EXTM3U') ? parseAttrs(header) : {};
  const entries = [];
  let pending = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = parseAttrs(line);
      const durationMatch = line.match(/^#EXTINF:\s*(-?\d+(?:\.\d+)?)/);
      pending = {
        name: extinfName(line) || attrs['tvg-name'] || '',
        duration: durationMatch ? Number(durationMatch[1]) : null,
        tvgId: attrs['tvg-id'] || '',
        group: attrs['group-title'] || '',
        hasTvgAttrs: Object.keys(attrs).some(k => k.startsWith('tvg-') || k === 'group-title'),
      };
    } else if (line.startsWith('#')) {
      continue;
    } else {
      entries.push({ ...(pending || { name: '', duration: null, tvgId: '', group: '', hasTvgAttrs: false }), location: line });
      pending = null;
    }
  }
  const epgRaw = headerAttrs['url-tvg'] || headerAttrs['x-tvg-url'] || '';
  const epgUrl = epgRaw.split(',').map(s => s.trim()).find(s => /^https?:\/\//i.test(s)) || '';
  return { entries, epgUrl, hasHeader: header.trim().startsWith('#EXTM3U') };
}

function summariseGroups(entries, limit = 6) {
  const counts = new Map();
  for (const e of entries) {
    const key = e.group || 'Ungrouped';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count }));
}

// ---------------------------------------------------------------------------
// XMLTV
// ---------------------------------------------------------------------------
function readXmltv(text) {
  const channelIds = new Set();
  const re = /<channel\s[^>]*id="([^"]+)"/gi;
  let m;
  while ((m = re.exec(text))) channelIds.add(m[1]);
  const programmes = (String(text).match(/<programme[\s>]/gi) || []).length;
  return { channelIds, programmes };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
/**
 * @returns {{kind: string, label: string, summary: object, actions: string[], hint?: string}}
 */
function classify(text, { contentType = '', truncated = false } = {}) {
  const head = String(text || '').slice(0, 4096).replace(/^\uFEFF/, '').trimStart();
  const lowerHead = head.toLowerCase();
  const type = String(contentType).toLowerCase();

  const looksM3U = head.startsWith('#EXTM3U') || /#EXTINF/i.test(String(text).slice(0, 65536)) || /mpegurl/.test(type);
  if (looksM3U) {
    const { entries, epgUrl } = readM3U(text);
    const live = entries.filter(e => e.duration === -1 || e.duration === 0);
    const remote = entries.filter(e => /^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(e.location));
    // An HLS media playlist (#EXT-X-TARGETDURATION) is a single stream, not a list.
    if (/#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/i.test(String(text).slice(0, 65536))) {
      return {
        kind: 'hls-stream',
        label: 'Single video stream (HLS)',
        summary: {},
        actions: [],
        hint: 'This is one stream, not a channel list. Add it to an M3U playlist to use it as a channel.',
      };
    }
    const isLive = epgUrl || entries.some(e => e.hasTvgAttrs) || (entries.length && live.length / entries.length > 0.6 && remote.length / entries.length > 0.6);
    if (isLive) {
      return {
        kind: 'm3u-live',
        label: 'TV channel list (M3U)',
        summary: {
          channels: entries.length,
          approximate: truncated,
          groups: summariseGroups(entries),
          sample: entries.slice(0, 5).map(e => e.name).filter(Boolean),
          withGuideIds: entries.filter(e => e.tvgId).length,
          epgUrl: epgUrl || null,
        },
        actions: ['livetv-source', ...(epgUrl ? ['livetv-guide-from-playlist'] : []), 'import-playlist'],
      };
    }
    return {
      kind: 'm3u-audio',
      label: 'Playlist (M3U)',
      summary: {
        entries: entries.length,
        approximate: truncated,
        remote: remote.length,
        sample: entries.slice(0, 5).map(e => e.name || path.basename(e.location)).filter(Boolean),
      },
      actions: ['import-playlist', 'livetv-source'],
    };
  }

  if (/<tv[\s>]/i.test(head) || (/<\?xml/i.test(head) && /<(channel|programme)\s[^>]*(id|channel)=/i.test(String(text).slice(0, 65536)) && !/<rss/i.test(head))) {
    const { channelIds, programmes } = readXmltv(text);
    return {
      kind: 'xmltv',
      label: 'TV guide (XMLTV)',
      summary: { channels: channelIds.size, programmes, approximate: truncated },
      actions: ['livetv-guide'],
    };
  }

  if (/<rss[\s>]/i.test(head) || /<feed[\s>][^>]*xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/i.test(head)) {
    const titleMatch = String(text).match(/<channel>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const episodes = (String(text).match(/<enclosure\s/gi) || []).length;
    return {
      kind: 'podcast',
      label: episodes ? 'Podcast feed (RSS)' : 'RSS feed',
      summary: { title: titleMatch ? titleMatch[1].trim().slice(0, 120) : null, episodes, approximate: truncated },
      actions: episodes ? ['podcast-subscribe'] : [],
      hint: episodes ? undefined : 'This feed has no audio episodes, so it can\'t be added as a podcast.',
    };
  }

  if (lowerHead.startsWith('<!doctype html') || lowerHead.startsWith('<html') || /text\/html/.test(type)) {
    const login = /type=["']?password|log ?in|sign ?in/i.test(String(text).slice(0, 65536));
    return {
      kind: 'html',
      label: 'Web page',
      summary: {},
      actions: [],
      hint: login
        ? 'This is a sign-in page, not a playlist. Copy the M3U or XMLTV link from your provider\'s account area instead.'
        : 'This is a web page, not a playlist or guide. Look for a link ending in .m3u, .m3u8, .xml or .xml.gz.',
    };
  }

  return {
    kind: 'unknown',
    label: 'Unrecognised file',
    summary: {},
    actions: [],
    hint: 'Vault couldn\'t recognise this file. Supported: M3U/M3U8 playlists, XMLTV guides and podcast RSS feeds.',
  };
}

/** How many playlist channels the guide has data for (tvg-id ↔ <channel id>). */
function guideMatch(m3uText, xmltvText) {
  const { entries } = readM3U(m3uText);
  const { channelIds, programmes } = readXmltv(xmltvText);
  const withIds = entries.filter(e => e.tvgId);
  const matched = withIds.filter(e => channelIds.has(e.tvgId)).length;
  return {
    channels: entries.length,
    withGuideIds: withIds.length,
    matched,
    guideChannels: channelIds.size,
    programmes,
    unmatchedSample: withIds.filter(e => !channelIds.has(e.tvgId)).slice(0, 5).map(e => e.name || e.tvgId),
  };
}

// ---------------------------------------------------------------------------
// Playlist matching (shared by file import and import-from-link)
// ---------------------------------------------------------------------------
function matchEntries(lines, libraryItems) {
  const matched = [];
  let considered = 0;
  let remote = 0;
  const byBase = new Map();
  for (const item of libraryItems) {
    if (!item?.path) continue;
    const base = path.basename(item.path).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, item);
  }
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || line.startsWith('#')) continue;
    considered += 1;
    let hit = libraryItems.find(i => i.path === line);
    if (!hit) {
      let candidate = line;
      if (/%[0-9a-f]{2}/i.test(line)) {
        try { candidate = decodeURIComponent(line); } catch { /* keep raw */ }
      }
      if (/^[a-z]+:\/\//i.test(line)) {
        if (/^https?:\/\//i.test(line) && !/\.(mp3|flac|m4a|aac|ogg|opus|wav|mp4|mkv|webm)(\?|$)/i.test(line)) remote += 1;
        try { candidate = decodeURIComponent(new URL(line).pathname); } catch { /* keep raw */ }
      }
      const normalised = candidate.replace(/\\/g, '/');
      hit = libraryItems.find(i => i.path && i.path.replace(/\\/g, '/').endsWith(normalised))
        || byBase.get(path.basename(normalised).toLowerCase());
    }
    if (hit) matched.push(hit.id);
  }
  return { matched, considered, missed: considered - matched.length, remote };
}

module.exports = { redactUrl, describeSecret, extinfName, readM3U, readXmltv, classify, guideMatch, matchEntries };
