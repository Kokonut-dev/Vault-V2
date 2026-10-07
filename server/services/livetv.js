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
      const name = line.split(',').slice(1).join(',').trim();
      const idMatch = line.match(/^#EXTINF:(-?\d+(?:\.\d+)?)\s*(.*)$/);
      pending = {
        name: name || attrs['tvg-name'] || 'Unknown channel',
        tvgId: attrs['tvg-id'] || null,
        logo: attrs['tvg-logo'] || null,
        group: attrs['group-title'] || 'Ungrouped',
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
        const text = source.startsWith('http')
          ? await (await fetch(source)).text()
          : await fs.readFile(source, 'utf8');
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
    const xml = source.startsWith('http')
      ? await (await fetch(source)).text()
      : await fs.readFile(source, 'utf8');
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

async function updateSettings(patch) {
  const config = getConfig();
  config.livetv = { ...config.livetv, ...patch };
  saveConfig(config);
  return config.livetv;
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
  flush,
};
