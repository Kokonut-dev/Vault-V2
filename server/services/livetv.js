/**
 * Live TV & DVR.
 *
 * Sources: M3U/M3U8 channel playlists (works with IPTV providers, ErsatzTV,
 * TVHeadend's playlist output, xTeVe…) and/or HDHomeRun tuners discovered on the
 * LAN. EPG comes from XMLTV files or URLs. Recording shells out to ffmpeg and
 * writes straight into the videos library, where the scanner indexes it.
 *
 * Several channel lists: the original `livetv.m3uUrl` / `epgUrl` is the
 * "main" list (its channel ids are unchanged, so favourites and recordings
 * keep working); `livetv.sources[]` adds more, each with its own guide,
 * on/off switch and streams-at-once cap. Channels are grouped by list.
 */
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { getConfig, saveConfig } = require('../config');
const logger = require('../utils/logger');
const events = require('./events');
const { createJsonStore } = require('../utils/jsonStore');

const recordingsStore = createJsonStore('recordings.json', []);
const { ffmpegBinary } = require('./transcodePlan');
const zlib = require('zlib');
const { safeFetchText, validateUrl, friendlyError } = require('../utils/safeFetch');
const links = require('./links');

const M3U_MAX_BYTES = 25 * 1024 * 1024;
const EPG_MAX_BYTES = 120 * 1024 * 1024;
const LOCAL_SOURCE_EXT = /\.(m3u8?|xml|xmltv|gz)$/i;

/** Read an M3U/XMLTV source: http(s) via the SSRF-hardened fetcher, or a local file. */
async function readSource(source, { maxBytes, accept } = {}) {
  if (/^https?:\/\//i.test(source)) {
    const { text } = await safeFetchText(source, { maxBytes, accept, timeoutMs: 30000 });
    return text;
  }
  if (!path.isAbsolute(source) || !LOCAL_SOURCE_EXT.test(source)) {
    throw new Error('Local sources must be an absolute path to a .m3u, .m3u8, .xml or .xml.gz file');
  }
  const buffer = await fs.readFile(source);
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return zlib.gunzipSync(buffer, { maxOutputLength: maxBytes }).toString('utf8');
  return buffer.toString('utf8');
}

// Guides are cached per URL (main list + one per extra list) and merged.
let epgCache = { fetchedAt: 0, programs: [], source: null };
const guideCache = new Map(); // url → { fetchedAt, programs }
const MAIN_SOURCE_ID = 'main';
const MAX_SOURCES = 20;
const activeRecordings = new Map();

// ---------------------------------------------------------------------------
// Channel list (M3U)
// ---------------------------------------------------------------------------
/**
 * Channel ids: `ch_<index>_<name>` for the main list (as before — favourites
 * and recordings store them), `ch_<sourceId>_<index>_<name>` for extra lists.
 * Extra source ids start with "s", so the two shapes can't collide.
 */
function parseM3U(text, { sourceId = MAIN_SOURCE_ID } = {}) {
  const lines = String(text).split(/\r?\n/);
  const channels = [];
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(line))) attrs[m[1].toLowerCase()] = m[2];
      const name = links.extinfName(line);
      const chno = attrs['tvg-chno'] || attrs['channel-number'] || attrs['tvg-num'] || '';
      const idMatch = line.match(/^#EXTINF:(-?\d+(?:\.\d+)?)\s*(.*)$/);
      pending = {
        name: name || attrs['tvg-name'] || 'Unknown channel',
        tvgId: attrs['tvg-id'] || null,
        logo: attrs['tvg-logo'] || null,
        group: attrs['group-title'] || 'Ungrouped',
        number: /^\d+(\.\d+)?$/.test(chno.trim()) ? chno.trim() : null,
        duration: idMatch ? Number(idMatch[1]) : -1,
        url: null,
      };
    } else if (line.startsWith('#')) {
      if (line.startsWith('#EXTVLCOPT') && pending) {
        const opt = line.replace('#EXTVLCOPT:', '').split('=');
        const value = opt.slice(1).join('=').trim();
        if (/http-referr?er/i.test(opt[0] || '')) pending.referrer = value;
        if (/http-user-agent/i.test(opt[0] || '')) pending.userAgent = value;
      }
    } else if (pending) {
      pending.url = line;
      pending.kind = entryKind(pending);
      channels.push(pending);
      pending = null;
    }
  }
  const prefix = sourceId && sourceId !== MAIN_SOURCE_ID ? `ch_${sourceId}_` : 'ch_';
  return channels.map((c, i) => ({ ...c, id: `${prefix}${i}_${Buffer.from(c.name).toString('base64url').slice(0, 10)}` }));
}

const VOD_EXT = /\.(mkv|mp4|m4v|avi|mov|wmv|webm|mpg|mpeg|flv)(\?|$)/i;

/**
 * IPTV "M3U Plus" lists mix live channels with on-demand movies and series
 * episodes. Live entries have #EXTINF:-1 and point at an endless stream; VOD
 * entries usually live under /movie/ or /series/ (Xtream Codes layout), carry
 * a real duration or end in a file extension. The player treats them
 * differently (no live window, resumable), so tag them here.
 */
function entryKind(entry) {
  let pathname = '';
  try { pathname = new URL(entry.url).pathname; } catch { pathname = String(entry.url || ''); }
  if (/\/live\//i.test(pathname)) return 'live';
  if (/\/(movie|movies|series|vod)\//i.test(pathname)) return 'vod';
  if (VOD_EXT.test(pathname)) return 'vod';
  if (entry.duration > 0) return 'vod';
  return 'live';
}

// Playback looks channels up by id; re-reading a 20 MB playlist on every
// click would be slow and hammer the provider, so keep the parsed list briefly.
const CHANNEL_CACHE_MS = 5 * 60 * 1000;
let channelCache = { at: 0, channels: null, key: '' };

function channelCacheKey() {
  const lt = getConfig().livetv || {};
  return JSON.stringify([lt.enabled, lt.hdhrDiscover, activeSources().map(s => [s.id, s.name, s.url, s.maxStreams])]);
}

const cleanLimit = (n) => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 32) : 0;
};

/** Every configured channel list, main first: { id, name, url, epgUrl, enabled, maxStreams }. */
function allSources(livetv = getConfig().livetv || {}) {
  const list = [];
  list.push({
    id: MAIN_SOURCE_ID,
    name: String(livetv.mainName || '').trim() || 'Main list',
    url: livetv.m3uUrl || '',
    epgUrl: livetv.epgUrl || '',
    enabled: true,
    maxStreams: cleanLimit(livetv.mainMaxStreams),
  });
  for (const src of Array.isArray(livetv.sources) ? livetv.sources : []) {
    if (!src || !src.id) continue;
    list.push({
      id: String(src.id),
      name: String(src.name || '').trim() || 'Channel list',
      url: src.url || '',
      epgUrl: src.epgUrl || '',
      enabled: src.enabled !== false,
      maxStreams: cleanLimit(src.maxStreams),
    });
  }
  return list;
}

/** Lists that contribute channels right now (switched on and with a link). */
function activeSources(livetv = getConfig().livetv || {}) {
  return allSources(livetv).filter(s => s.enabled && s.url);
}

// Last load result per list, so the Live TV page can say which one failed.
let sourceStatus = [];

async function loadChannels({ fresh = false } = {}) {
  const key = channelCacheKey();
  if (!fresh && channelCache.channels && channelCache.key === key && Date.now() - channelCache.at < CHANNEL_CACHE_MS) {
    return channelCache.channels;
  }
  const channels = await readChannels();
  channelCache = { at: Date.now(), channels, key };
  return channels;
}

/** One channel by id (from the cached list, re-reading once on a miss). */
async function getChannel(id) {
  let channel = (await loadChannels()).find(c => c.id === id);
  if (!channel) channel = (await loadChannels({ fresh: true })).find(c => c.id === id);
  return channel || null;
}

/**
 * Providers that number channels (tvg-chno) expect them in that order;
 * unnumbered channels keep their list order after the numbered ones.
 * Sorted per list, so lists stay grouped.
 */
function sortByNumber(channels) {
  if (!channels.some(c => c.number)) return channels;
  return channels
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const an = a.c.number ? parseFloat(a.c.number) : Infinity;
      const bn = b.c.number ? parseFloat(b.c.number) : Infinity;
      return an - bn || a.i - b.i;
    })
    .map(({ c }) => c);
}

async function readChannels() {
  const config = getConfig();
  const channels = [];
  const status = [];

  if (config.livetv?.enabled) {
    // Lists load in parallel; one provider being down doesn't hide the rest.
    const sources = activeSources(config.livetv);
    const loaded = await Promise.all(sources.map(async (src) => {
      try {
        const text = await readSource(src.url, { maxBytes: M3U_MAX_BYTES, accept: 'audio/x-mpegurl, application/vnd.apple.mpegurl, */*' });
        const parsed = parseM3U(text, { sourceId: src.id }).map(c => ({
          ...c,
          sourceId: src.id,
          sourceName: src.name,
          sourceMaxStreams: src.maxStreams,
        }));
        return { src, channels: sortByNumber(parsed), error: null };
      } catch (err) {
        logger.warn(`[LiveTV] failed to load channel list "${src.name}": ${err.message}`);
        return { src, channels: [], error: friendlyError(err) };
      }
    }));
    for (const { src, channels: list, error } of loaded) {
      channels.push(...list);
      status.push({ id: src.id, name: src.name, count: list.length, error });
    }

    if (config.livetv.hdhrDiscover) {
      try {
        const tuners = (await discoverHDHomeRun()).map(c => ({ ...c, sourceId: 'hdhr', sourceName: 'HDHomeRun' }));
        channels.push(...sortByNumber(tuners));
        status.push({ id: 'hdhr', name: 'HDHomeRun', count: tuners.length, error: null });
      } catch (err) {
        logger.warn(`[LiveTV] HDHomeRun discovery failed: ${err.message}`);
        status.push({ id: 'hdhr', name: 'HDHomeRun', count: 0, error: err.message });
      }
    }
  }

  sourceStatus = status;
  return channels;
}

/** Per-list counts / errors from the last channel load. */
function getSourceStatus() {
  return sourceStatus;
}

async function discoverHDHomeRun() {
  // SSDP M-SEARCH for HDHomeRun tuners, then pull their lineup.
  const dgram = require('dgram');
  const message = Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    'HOST: 239.255.255.250:1900\r\n' +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 2\r\n' +
    'ST: urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n'
  );

  const devices = await new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const found = new Set();
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      resolve([...found]);
    }, 2500);
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (/hdhomerun/i.test(text)) {
        const location = text.match(/LOCATION:\s*(\S+)/i);
        if (location) found.add(location[1].trim());
        else found.add(`http://${rinfo.address}`);
      }
    });
    socket.on('error', () => { clearTimeout(timer); resolve([...found]); });
    socket.send(message, 0, message.length, 1900, '239.255.255.250', () => {});
  });

  const channels = [];
  for (const url of devices) {
    try {
      const base = url.replace(/\/discover\.json.*$/, '').replace(/\/$/, '');
      // eslint-disable-next-line no-await-in-loop
      // The address comes from an SSDP reply anyone on the LAN can send, so
      // it is fetched with the same guards (and size/time caps) as playlists.
      const { safeFetchText } = require('../utils/safeFetch');
      const { text: lineupText } = await safeFetchText(`${base}/lineup.json`, { maxBytes: 2 * 1024 * 1024, timeoutMs: 8000, accept: 'application/json' });
      const lineup = JSON.parse(lineupText);
      if (!Array.isArray(lineup)) continue;
      for (const entry of lineup) {
        channels.push({
          id: `hdhr_${entry.GuideNumber}`,
          name: entry.GuideName || `Channel ${entry.GuideNumber}`,
          tvgId: entry.GuideNumber,
          logo: null,
          group: 'HDHomeRun',
          url: entry.URL,
          duration: -1,
        });
      }
    } catch (err) {
      logger.warn(`[LiveTV] tuner ${url} failed: ${err.message}`);
    }
  }
  return channels;
}

// ---------------------------------------------------------------------------
// EPG (XMLTV)
// ---------------------------------------------------------------------------
function parseXmltv(xml) {
  const programs = [];
  const re = /<programme([^>]*)>([\s\S]*?)<\/programme>/gi;
  let match;
  while ((match = re.exec(xml))) {
    const attrs = match[1];
    const body = match[2];
    const attr = name => {
      const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
      return m ? m[1] : null;
    };
    const pick = tag => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
    };
    programs.push({
      channel: attr('channel'),
      start: attr('start'),
      stop: attr('stop'),
      title: pick('title'),
      description: pick('desc'),
      category: pick('category'),
    });
  }
  return programs;
}

function parseXmltvDate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00', tz = '+0000'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${tz.slice(0, 3)}:${tz.slice(3)}`;
  const date = new Date(iso);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

const EPG_TTL = 30 * 60 * 1000;

async function loadGuide(url, force) {
  const cached = guideCache.get(url);
  if (!force && cached && Date.now() - cached.fetchedAt < EPG_TTL) return cached;
  try {
    const xml = await readSource(url, { maxBytes: EPG_MAX_BYTES, accept: 'application/xml, text/xml, */*' });
    const programs = parseXmltv(xml).map(p => ({
      ...p,
      startIso: parseXmltvDate(p.start),
      stopIso: parseXmltvDate(p.stop),
    }));
    const entry = { fetchedAt: Date.now(), programs };
    guideCache.set(url, entry);
    return entry;
  } catch (err) {
    logger.warn(`[LiveTV] EPG load failed: ${err.message}`);
    // Keep serving the last good copy rather than blanking the guide.
    return cached || { fetchedAt: 0, programs: [] };
  }
}

/**
 * The TV guide: the main list's guide plus every switched-on extra list's
 * guide, merged. Guides are keyed by tvg-id, so lists sharing a channel
 * share its programmes; duplicates (same channel + start) are dropped.
 */
async function getEpg(force = false) {
  const lt = getConfig().livetv || {};
  const urls = [...new Set(allSources(lt).filter(s => s.enabled && s.epgUrl).map(s => s.epgUrl))];
  const mainUrl = lt.epgUrl || null;
  if (!urls.length) return { ...epgCache, programs: [], source: null };

  const key = urls.join('\n');
  if (!force && epgCache.key === key && epgCache.programs.length && Date.now() - epgCache.fetchedAt < EPG_TTL) return epgCache;

  const guides = await Promise.all(urls.map(url => loadGuide(url, force)));
  let programs;
  if (guides.length === 1) programs = guides[0].programs;
  else {
    const seen = new Set();
    programs = [];
    for (const guide of guides) {
      for (const p of guide.programs) {
        const id = `${p.channel}|${p.start}`;
        if (seen.has(id)) continue;
        seen.add(id);
        programs.push(p);
      }
    }
  }
  const fetchedAt = Math.min(...guides.map(g => g.fetchedAt || Date.now()));
  epgCache = { fetchedAt, programs, source: mainUrl || urls[0], key };
  return epgCache;
}

async function getNowNext(channelIds) {
  const { programs } = await getEpg();
  const now = Date.now();
  const result = {};
  for (const id of channelIds) {
    const forChannel = programs
      .filter(p => p.channel === id && p.stopIso)
      .sort((a, b) => new Date(a.startIso) - new Date(b.startIso));
    const current = forChannel.find(p => new Date(p.startIso) <= now && new Date(p.stopIso) > now) || null;
    const next = forChannel.find(p => new Date(p.startIso) > now) || null;
    result[id] = { now: current, next };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recording (DVR)
// ---------------------------------------------------------------------------
async function record({ channelUrl, title, durationSeconds = 3600, channelId = null, startAt = null }) {
  if (channelId && !channelUrl) {
    const channel = await getChannel(channelId);
    if (!channel) throw new Error('Channel not found');
    channelUrl = channel.url;
    title = title || channel.name;
  }
  channelUrl = await require('./restream').assertPlayableUrl(channelUrl);
  const config = getConfig();
  const videosDir = config.media.paths.videos || path.join(__dirname, '../media/videos');
  const recordingsDir = path.join(videosDir, 'Recordings');
  await fs.ensureDir(recordingsDir);

  const safe = String(title || 'Recording').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const output = path.join(recordingsDir, `${safe} ${stamp}.ts`);
  const recording = {
    id: `rec_${Date.now()}`,
    title: safe,
    channelId,
    channelUrl,
    output,
    startedAt: new Date().toISOString(),
    durationSeconds,
    status: 'scheduled',
    startAt,
  };

  const list = recordingsStore.get();
  list.unshift(recording);
  recordingsStore.set(list);

  const begin = async () => {
    const jobId = `record_${recording.id}`;
    events.jobStart(jobId, 'record', `Recording ${safe}`, durationSeconds);
    recording.status = 'recording';
    recording.startedAt = new Date().toISOString();
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error',
      // Only network inputs — a playlist entry must never make ffmpeg read
      // local files (file:, concat:, pipe: …).
      '-protocol_whitelist', 'http,https,tcp,tls,crypto,httpproxy',
      '-i', channelUrl, '-c', 'copy', '-t', String(durationSeconds), '-f', 'mpegts', output];
    const proc = spawn(ffmpegBinary(), args);
    // Without this listener a missing ffmpeg (ENOENT) is an unhandled
    // 'error' event and takes the whole server down.
    proc.on('error', (err) => logger.warn(`[LiveTV] recording could not start ffmpeg: ${err.message}`));
    activeRecordings.set(recording.id, proc);

    const started = Date.now();
    const progressTimer = setInterval(() => {
      events.jobProgress(jobId, Math.round((Date.now() - started) / 1000), durationSeconds);
    }, 5000);

    proc.on('close', async code => {
      clearInterval(progressTimer);
      activeRecordings.delete(recording.id);
      recording.status = code === 0 ? 'completed' : 'failed';
      recording.finishedAt = new Date().toISOString();
      const store = recordingsStore.get();
      const idx = store.findIndex(r => r.id === recording.id);
      if (idx >= 0) {
        store[idx] = recording;
        recordingsStore.set(store);
      }
      events.jobFinish(jobId, code === 0 ? 'done' : 'error', { output });
      if (code === 0) {
        try {
          const { scanFile } = require('./scanner');
          await scanFile(output);
          events.broadcast('library:changed', { reason: 'recording', title: safe });
        } catch {}
      }
    });
    return recording;
  };

  if (startAt && new Date(startAt).getTime() > Date.now()) {
    const delay = new Date(startAt).getTime() - Date.now();
    setTimeout(begin, Math.min(delay, 2147483647));
    return recording;
  }

  return begin();
}

function stopRecording(id) {
  const proc = activeRecordings.get(id);
  if (!proc) return false;
  proc.kill('SIGINT');
  activeRecordings.delete(id);
  return true;
}

function listRecordings() {
  return recordingsStore.get().map(r => ({ ...r, channelUrl: r.channelUrl ? links.redactUrl(r.channelUrl) : r.channelUrl }));
}

async function deleteRecording(id) {
  const list = recordingsStore.get();
  const rec = list.find(r => r.id === id);
  if (!rec) return false;
  try {
    await fs.remove(rec.output);
  } catch {}
  recordingsStore.set(list.filter(r => r.id !== id));
  return true;
}

/**
 * Validate one source field. Returns the cleaned string ('' clears it).
 * Throws an Error with a field-specific, fixable message.
 */
function cleanSource(value, label) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.length > 2048) throw new Error(`${label} is too long`);
  if (/^https?:\/\//i.test(v)) {
    validateUrl(v);
    return v;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[a-z]:[\\/]/i.test(v)) {
    throw new Error(`${label} must start with http:// or https:// (or be a full path to a local file)`);
  }
  if (!path.isAbsolute(v) || !LOCAL_SOURCE_EXT.test(v)) {
    throw new Error(`${label} must be a link, or a full path to a .m3u, .m3u8, .xml or .xml.gz file`);
  }
  return v;
}

/**
 * Patch semantics (write-only secrets, SR-5): a source key that is *absent*
 * keeps the saved value, '' clears it, anything else replaces it.
 */
async function updateSettings(patch = {}) {
  const config = getConfig();
  const current = { enabled: false, m3uUrl: '', epgUrl: '', hdhrDiscover: false, ...(config.livetv || {}) };
  const next = { ...current };
  const errors = {};

  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (patch.hdhrDiscover !== undefined) next.hdhrDiscover = Boolean(patch.hdhrDiscover);
  if (patch.mainName !== undefined) next.mainName = String(patch.mainName || '').trim().slice(0, 60);
  if (patch.mainMaxStreams !== undefined) next.mainMaxStreams = cleanLimit(patch.mainMaxStreams);
  for (const [key, label] of [['m3uUrl', 'Channel list link'], ['epgUrl', 'TV guide link']]) {
    if (patch[key] === undefined) continue;
    try { next[key] = cleanSource(patch[key], label); } catch (err) { errors[key] = err.message; }
  }
  if (Object.keys(errors).length) {
    const err = new Error('Some Live TV settings need fixing');
    err.fields = errors;
    throw err;
  }

  if (next.epgUrl !== current.epgUrl) resetGuides();
  config.livetv = next;
  saveConfig(config);
  return publicSettings(next);
}

function resetGuides() {
  epgCache = { fetchedAt: 0, programs: [], source: null };
  guideCache.clear();
}

// ---------------------------------------------------------------------------
// Extra channel lists (livetv.sources[])
// ---------------------------------------------------------------------------
function sourceError(message, fields = {}, status = 400) {
  const err = new Error(message);
  err.fields = fields;
  err.status = status;
  return err;
}

function cleanSourceFields(patch, existing = null) {
  const errors = {};
  const out = {};
  if (patch.name !== undefined || !existing) {
    const name = String(patch.name ?? '').trim().slice(0, 60);
    if (!name) errors.name = 'Give this channel list a name, e.g. the provider’s';
    else out.name = name;
  }
  for (const [key, field, label] of [['url', 'm3uUrl', 'Channel list link'], ['epgUrl', 'epgUrl', 'TV guide link']]) {
    if (patch[field] === undefined) continue;
    try { out[key] = cleanSource(patch[field], label); } catch (err) { errors[field] = err.message; }
  }
  const url = out.url !== undefined ? out.url : existing?.url;
  if (!url && !errors.m3uUrl) errors.m3uUrl = 'Add the channel list link (M3U)';
  if (patch.maxStreams !== undefined) out.maxStreams = cleanLimit(patch.maxStreams);
  if (patch.enabled !== undefined) out.enabled = Boolean(patch.enabled);
  if (Object.keys(errors).length) throw sourceError('Some fields need fixing', errors);
  return out;
}

function addSource(patch = {}) {
  const config = getConfig();
  const livetv = { enabled: false, m3uUrl: '', epgUrl: '', hdhrDiscover: false, ...(config.livetv || {}) };
  const sources = Array.isArray(livetv.sources) ? [...livetv.sources] : [];
  if (sources.length >= MAX_SOURCES) throw sourceError(`You can add up to ${MAX_SOURCES} extra channel lists`);
  const fields = cleanSourceFields(patch);
  let id;
  do { id = `s${require('crypto').randomBytes(4).toString('hex')}`; } while (sources.some(s => s.id === id));
  const source = { id, name: fields.name, url: fields.url, epgUrl: fields.epgUrl || '', enabled: fields.enabled !== false, maxStreams: fields.maxStreams || 0 };
  sources.push(source);
  livetv.sources = sources;
  config.livetv = livetv;
  saveConfig(config);
  if (source.epgUrl) resetGuides();
  return publicSettings(livetv);
}

function updateSource(id, patch = {}) {
  const config = getConfig();
  const livetv = { ...(config.livetv || {}) };
  const sources = Array.isArray(livetv.sources) ? [...livetv.sources] : [];
  const idx = sources.findIndex(s => s.id === id);
  if (idx < 0) throw sourceError('That channel list no longer exists. Reload the page.', {}, 404);
  const before = sources[idx];
  const fields = cleanSourceFields(patch, before);
  sources[idx] = { ...before, ...fields };
  livetv.sources = sources;
  config.livetv = livetv;
  saveConfig(config);
  if (sources[idx].epgUrl !== before.epgUrl || sources[idx].enabled !== before.enabled) resetGuides();
  return publicSettings(livetv);
}

function removeSource(id) {
  const config = getConfig();
  const livetv = { ...(config.livetv || {}) };
  const sources = Array.isArray(livetv.sources) ? livetv.sources : [];
  if (!sources.some(s => s.id === id)) throw sourceError('That channel list no longer exists. Reload the page.', {}, 404);
  livetv.sources = sources.filter(s => s.id !== id);
  config.livetv = livetv;
  saveConfig(config);
  resetGuides();
  return publicSettings(livetv);
}

/** What the browser may see: flags + redacted hints, never the raw URLs. */
function publicSettings(livetv = getConfig().livetv || {}) {
  return {
    enabled: Boolean(livetv.enabled),
    hdhrDiscover: Boolean(livetv.hdhrDiscover),
    m3u: links.describeSecret(livetv.m3uUrl),
    epg: links.describeSecret(livetv.epgUrl),
    mainName: String(livetv.mainName || ''),
    mainMaxStreams: cleanLimit(livetv.mainMaxStreams),
    sources: allSources(livetv).filter(s => s.id !== MAIN_SOURCE_ID).map(s => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      maxStreams: s.maxStreams,
      m3u: links.describeSecret(s.url),
      epg: links.describeSecret(s.epgUrl),
    })),
  };
}

/**
 * Dry-run a channel list and/or guide before saving (TiviMate-style "fetch
 * and show a channel count"). Omitted values fall back to the saved ones.
 */
let sampleStreamsEnabled = true;

/**
 * "Test" used to stop at "the list parsed". A list can parse perfectly and
 * still be unplayable (expired account → 403 on every stream, HEVC/AC-3 that
 * browsers can't decode, ffmpeg missing on the server). Open a few entries —
 * the first live channel, the first movie, and the next entry — and report
 * what would actually happen when someone presses play.
 */
async function sampleStreams(channels, { limit = 3, timeoutMs = 10000 } = {}) {
  const restream = require('./restream');
  const { detectCapabilities } = require('./transcodePlan');
  const playable = channels.filter(c => /^https?:\/\//i.test(c.url || ''));
  const summary = {
    ffmpeg: Boolean(detectCapabilities().ffmpeg),
    unsupported: channels.length - playable.length,
    checked: [],
  };
  if (!summary.ffmpeg) return summary;

  const picks = [];
  const add = c => { if (c && !picks.includes(c) && picks.length < limit) picks.push(c); };
  add(playable.find(c => c.kind === 'live'));
  add(playable.find(c => c.kind === 'vod'));
  for (const c of playable) add(c);

  summary.checked = await Promise.all(picks.map(async (channel) => {
    const base = { name: channel.name, kind: channel.kind };
    try {
      const url = await restream.assertPlayableUrl(channel.url);
      const source = await restream.probe(url, { userAgent: channel.userAgent, referrer: channel.referrer, timeoutMs });
      const plan = restream.planFor(source);
      return { ...base, ok: true, format: restream.describeSource(source), converted: !plan.directPlayable, reason: plan.reason };
    } catch (err) {
      return { ...base, ok: false, code: err.code || 'FAILED', error: err.code ? restream.messageFor(err.code) : 'Could not open this stream' };
    }
  }));
  return summary;
}

async function testSources({ m3uUrl, epgUrl, sourceId } = {}) {
  let saved = getConfig().livetv || {};
  if (sourceId && sourceId !== MAIN_SOURCE_ID) {
    // Testing an extra list: omitted values fall back to *its* saved links.
    const src = allSources(saved).find(s => s.id === sourceId);
    if (!src) throw sourceError('That channel list no longer exists. Reload the page.', {}, 404);
    saved = { m3uUrl: src.url, epgUrl: src.epgUrl };
  }
  const m3uSource = m3uUrl === undefined ? saved.m3uUrl : String(m3uUrl || '').trim();
  const epgSource = epgUrl === undefined ? saved.epgUrl : String(epgUrl || '').trim();
  const result = { m3u: null, epg: null, match: null };
  let m3uText = null;
  let epgText = null;

  if (m3uSource) {
    try {
      cleanSource(m3uSource, 'Channel list link');
      m3uText = await readSource(m3uSource, { maxBytes: M3U_MAX_BYTES });
      const kind = links.classify(m3uText);
      if (kind.kind !== 'm3u-live' && kind.kind !== 'm3u-audio') {
        result.m3u = { ok: false, error: kind.hint || `That link is a ${kind.label.toLowerCase()}, not a channel list` };
        m3uText = null;
      } else {
        const { entries, epgUrl: playlistGuide } = links.readM3U(m3uText);
        const parsed = parseM3U(m3uText);
        result.m3u = {
          live: parsed.filter(c => c.kind === 'live').length,
          vod: parsed.filter(c => c.kind === 'vod').length,
          ok: entries.length > 0,
          channels: entries.length,
          groups: kind.summary.groups || [],
          sample: entries.slice(0, 6).map(e => e.name).filter(Boolean),
          withGuideIds: entries.filter(e => e.tvgId).length,
          playlistGuide: playlistGuide ? links.redactUrl(playlistGuide) : null,
          hasPlaylistGuide: Boolean(playlistGuide),
          error: entries.length ? undefined : 'The playlist is empty',
        };
        if (entries.length && sampleStreamsEnabled) result.m3u.streams = await sampleStreams(parsed);
      }
    } catch (err) {
      result.m3u = { ok: false, error: friendlyError(err) };
    }
  }

  if (epgSource) {
    try {
      cleanSource(epgSource, 'TV guide link');
      epgText = await readSource(epgSource, { maxBytes: EPG_MAX_BYTES });
      const kind = links.classify(epgText);
      if (kind.kind !== 'xmltv') {
        result.epg = { ok: false, error: kind.hint || `That link is a ${kind.label.toLowerCase()}, not an XMLTV guide` };
        epgText = null;
      } else {
        result.epg = { ok: true, channels: kind.summary.channels, programmes: kind.summary.programmes };
      }
    } catch (err) {
      result.epg = { ok: false, error: friendlyError(err) };
    }
  }

  if (m3uText && epgText) result.match = links.guideMatch(m3uText, epgText);
  return result;
}

/** Copy the guide URL embedded in the saved/given playlist (url-tvg) into epgUrl. */
async function adoptPlaylistGuide({ m3uUrl, sourceId } = {}) {
  const extra = sourceId && sourceId !== MAIN_SOURCE_ID
    ? allSources().find(s => s.id === sourceId)
    : null;
  if (sourceId && sourceId !== MAIN_SOURCE_ID && !extra) throw sourceError('That channel list no longer exists. Reload the page.', {}, 404);
  const saved = extra ? extra.url : (getConfig().livetv || {}).m3uUrl;
  const source = m3uUrl === undefined ? saved : String(m3uUrl || '').trim();
  if (!source) throw new Error('Add a channel list link first');
  cleanSource(source, 'Channel list link');
  const text = await readSource(source, { maxBytes: M3U_MAX_BYTES });
  const { epgUrl } = links.readM3U(text);
  if (!epgUrl) throw new Error('This playlist doesn\'t name a guide (no url-tvg in its header)');
  return extra ? updateSource(extra.id, { epgUrl }) : updateSettings({ epgUrl });
}

function stopAll() {
  for (const [, proc] of activeRecordings) {
    try { proc.kill('SIGINT'); } catch { /* already gone */ }
  }
  activeRecordings.clear();
  require('./restream').stopAll();
}

async function flush() {
  await recordingsStore.flush();
}

module.exports = {
  parseM3U,
  entryKind,
  loadChannels,
  allSources,
  activeSources,
  getSourceStatus,
  addSource,
  updateSource,
  removeSource,
  MAIN_SOURCE_ID,
  getChannel,
  stopAll,
  sampleStreams,
  _setSampleStreams: (on) => { sampleStreamsEnabled = on; },
  discoverHDHomeRun,
  parseXmltv,
  getEpg,
  getNowNext,
  record,
  stopRecording,
  listRecordings,
  deleteRecording,
  updateSettings,
  publicSettings,
  testSources,
  adoptPlaylistGuide,
  cleanSource,
  readSource,
  flush,
};
