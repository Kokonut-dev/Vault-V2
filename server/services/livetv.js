/**
 * Live TV & DVR.
 *
 * Sources: an M3U/M3U8 channel playlist (works with IPTV providers, ErsatzTV,
 * TVHeadend's playlist output, xTeVe…) and/or HDHomeRun tuners discovered on the
 * LAN. EPG comes from an XMLTV file or URL. Recording shells out to ffmpeg and
 * writes straight into the videos library, where the scanner indexes it.
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

let epgCache = { fetchedAt: 0, programs: [], source: null };
const activeRecordings = new Map();

// ---------------------------------------------------------------------------
// Channel list (M3U)
// ---------------------------------------------------------------------------
function parseM3U(text) {
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
        if (opt[0]?.includes('http-referrer')) pending.referrer = opt.slice(1).join('=');
      }
    } else if (pending) {
      pending.url = line;
      channels.push(pending);
      pending = null;
    }
  }
  return channels.map((c, i) => ({ ...c, id: `ch_${i}_${Buffer.from(c.name).toString('base64url').slice(0, 10)}` }));
}

async function loadChannels() {
  const config = getConfig();
  const channels = [];

  if (config.livetv?.enabled) {
    const source = config.livetv.m3uUrl;
    if (source) {
      try {
        const text = await readSource(source, { maxBytes: M3U_MAX_BYTES, accept: 'audio/x-mpegurl, application/vnd.apple.mpegurl, */*' });
        channels.push(...parseM3U(text));
      } catch (err) {
        logger.warn(`[LiveTV] failed to load channel list: ${err.message}`);
      }
    }

    if (config.livetv.hdhrDiscover) {
      try {
        channels.push(...await discoverHDHomeRun());
      } catch (err) {
        logger.warn(`[LiveTV] HDHomeRun discovery failed: ${err.message}`);
      }
    }
  }

  // Providers that number channels (tvg-chno) expect them in that order;
  // unnumbered channels keep their list order after the numbered ones.
  if (channels.some(c => c.number)) {
    return channels
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        const an = a.c.number ? parseFloat(a.c.number) : Infinity;
        const bn = b.c.number ? parseFloat(b.c.number) : Infinity;
        return an - bn || a.i - b.i;
      })
      .map(({ c }) => c);
  }
  return channels;
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
      const lineup = await (await fetch(`${base}/lineup.json`)).json();
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

async function getEpg(force = false) {
  const config = getConfig();
  const ttl = 30 * 60 * 1000;
  if (!force && epgCache.programs.length && Date.now() - epgCache.fetchedAt < ttl) return epgCache;

  const source = config.livetv?.epgUrl;
  if (!source) return { ...epgCache, programs: [], source: null };

  try {
    const xml = await readSource(source, { maxBytes: EPG_MAX_BYTES, accept: 'application/xml, text/xml, */*' });
    const programs = parseXmltv(xml).map(p => ({
      ...p,
      startIso: parseXmltvDate(p.start),
      stopIso: parseXmltvDate(p.stop),
    }));
    epgCache = { fetchedAt: Date.now(), programs, source };
    return epgCache;
  } catch (err) {
    logger.warn(`[LiveTV] EPG load failed: ${err.message}`);
    return { ...epgCache, programs: [], source };
  }
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
    const args = ['-hide_banner', '-loglevel', 'error', '-i', channelUrl, '-c', 'copy', '-t', String(durationSeconds), '-f', 'mpegts', output];
    const proc = spawn(ffmpegBinary(), args);
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
  return recordingsStore.get();
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
  for (const [key, label] of [['m3uUrl', 'Channel list link'], ['epgUrl', 'TV guide link']]) {
    if (patch[key] === undefined) continue;
    try { next[key] = cleanSource(patch[key], label); } catch (err) { errors[key] = err.message; }
  }
  if (Object.keys(errors).length) {
    const err = new Error('Some Live TV settings need fixing');
    err.fields = errors;
    throw err;
  }

  if (next.epgUrl !== current.epgUrl) epgCache = { fetchedAt: 0, programs: [], source: null };
  config.livetv = next;
  saveConfig(config);
  return publicSettings(next);
}

/** What the browser may see: flags + redacted hints, never the raw URLs. */
function publicSettings(livetv = getConfig().livetv || {}) {
  return {
    enabled: Boolean(livetv.enabled),
    hdhrDiscover: Boolean(livetv.hdhrDiscover),
    m3u: links.describeSecret(livetv.m3uUrl),
    epg: links.describeSecret(livetv.epgUrl),
  };
}

/**
 * Dry-run a channel list and/or guide before saving (TiviMate-style "fetch
 * and show a channel count"). Omitted values fall back to the saved ones.
 */
async function testSources({ m3uUrl, epgUrl } = {}) {
  const saved = getConfig().livetv || {};
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
        result.m3u = {
          ok: entries.length > 0,
          channels: entries.length,
          groups: kind.summary.groups || [],
          sample: entries.slice(0, 6).map(e => e.name).filter(Boolean),
          withGuideIds: entries.filter(e => e.tvgId).length,
          playlistGuide: playlistGuide ? links.redactUrl(playlistGuide) : null,
          hasPlaylistGuide: Boolean(playlistGuide),
          error: entries.length ? undefined : 'The playlist is empty',
        };
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
async function adoptPlaylistGuide({ m3uUrl } = {}) {
  const source = m3uUrl === undefined ? (getConfig().livetv || {}).m3uUrl : String(m3uUrl || '').trim();
  if (!source) throw new Error('Add a channel list link first');
  cleanSource(source, 'Channel list link');
  const text = await readSource(source, { maxBytes: M3U_MAX_BYTES });
  const { epgUrl } = links.readM3U(text);
  if (!epgUrl) throw new Error('This playlist doesn\'t name a guide (no url-tvg in its header)');
  return updateSettings({ epgUrl });
}

async function flush() {
  await recordingsStore.flush();
}

module.exports = {
  parseM3U,
  loadChannels,
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
