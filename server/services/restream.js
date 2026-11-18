/**
 * Restream — play Live TV / IPTV entries through the server.
 *
 * Why: IPTV playlists point at streams browsers mostly cannot play on their
 * own — MPEG-TS (.ts), MKV, HEVC video, AC-3/DTS audio — usually over plain
 * http (blocked as mixed content on an https page) and without CORS headers.
 * Handing the provider URL straight to <video> therefore fails with a bare
 * MEDIA_ERR_SRC_NOT_SUPPORTED, and the old fallbacks (library transcode by id)
 * could never work for an entry that is not in the library.
 *
 * Instead the server opens the stream with ffmpeg and repackages it as HLS,
 * which every browser can play (Safari natively, everything else through the
 * vendored hls.js):
 *   - H.264 video is copied, anything else is re-encoded to H.264;
 *   - AAC audio is copied, anything else becomes stereo AAC;
 *   - `transcode: true` forces both re-encodes (the client's second attempt).
 *
 * Provider URLs (which usually embed the account's username and password)
 * stay on the server: the browser only ever sees /api/livetv/stream/<session>.
 */
const fs = require('fs-extra');
const path = require('path');
const dns = require('dns');
const net = require('net');
const crypto = require('crypto');
const childProcess = require('child_process');
const logger = require('../utils/logger');
const transcodePlan = require('./transcodePlan');
const { validateUrl, blockedReason } = require('../utils/safeFetch');
const { redactUrl } = require('./links');

const deps = {
  spawn: (...args) => childProcess.spawn(...args),
  lookup: (host) => dns.promises.lookup(host, { all: true }),
};

const CACHE_ROOT = path.join(__dirname, '..', 'cache', 'restream');
const SEGMENT_SECONDS = 4;
const LIVE_WINDOW = 8; // segments kept in a live playlist
const START_TIMEOUT_MS = 25000;
const PROBE_TIMEOUT_MS = 15000;
const IDLE_LIVE_MS = 45000;
const IDLE_VOD_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 4;
// Many IPTV panels reject ffmpeg's default "Lavf/x.y" agent outright.
const DEFAULT_USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';
// ffmpeg must never read local files, pipes or other exotic protocols on
// behalf of a playlist entry — only network streams.
const PROTOCOLS = 'http,https,tcp,tls,crypto,httpproxy';

const sessions = new Map(); // sessionId -> session
let reaper = null;

class StreamError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MESSAGES = {
  NO_FFMPEG: 'The Vault server can\'t convert this stream because ffmpeg isn\'t installed. Install ffmpeg on the server (or set FFMPEG_PATH) and restart Vault.',
  AUTH: 'The provider refused this stream (access denied). The subscription may have expired, or the username/password in the channel list link is wrong.',
  NOT_FOUND: 'The provider no longer has this stream (404). The entry may have been removed — test the channel list again in Settings → Live TV.',
  UNREACHABLE: 'The Vault server couldn\'t reach the provider for this stream. Check the server\'s internet connection, or try again in a minute.',
  TIMEOUT: 'The provider took too long to start sending this stream.',
  PROVIDER_ERROR: 'The provider\'s server returned an error for this stream. Try again later.',
  NOT_MEDIA: 'This link didn\'t return video — the provider sent something else (often a login or error page).',
  BLOCKED: 'This entry points at an address Vault won\'t open (a local file, the server itself or a cloud metadata address).',
  UNSUPPORTED_SCHEME: 'Vault can only play http:// and https:// streams.',
  TOO_MANY_STREAMS: 'Too many streams are running on the Vault server right now. Close another player and try again.',
  NO_STREAMS: 'This link contains no audio or video.',
  CRASHED: 'ffmpeg crashed on the Vault server while opening this stream. Update ffmpeg on the server (or set FFMPEG_PATH to your system ffmpeg) and restart Vault — the server log has details.',
  FAILED: 'The Vault server couldn\'t convert this stream.',
};

function messageFor(code) {
  return MESSAGES[code] || MESSAGES.FAILED;
}

/**
 * ffmpeg killed by a signal (SIGSEGV, SIGILL, SIGBUS, SIGABRT…) rather than
 * exiting with an error. Our own SIGKILL/SIGTERM on stop isn't a crash.
 */
function isCrash(exitCode, signal) {
  if (signal) return !['SIGKILL', 'SIGTERM', 'SIGINT'].includes(signal);
  return exitCode === 132 || exitCode === 134 || exitCode === 135 || exitCode === 139; // 128 + ILL/ABRT/BUS/SEGV
}

function describeExit(exitCode, signal) {
  return signal ? `signal ${signal}` : `code ${exitCode}`;
}

/** Map ffmpeg's stderr (and spawn errors) to a stable error code. */
function classifyFailure(stderr = '', spawnError = null, exit = null) {
  if (spawnError && (spawnError.code === 'ENOENT' || spawnError.code === 'EACCES')) return 'NO_FFMPEG';
  if (exit && isCrash(exit.code, exit.signal)) return 'CRASHED';
  const text = String(stderr);
  if (/\b(401|403)\b|Forbidden|Unauthorized/i.test(text)) return 'AUTH';
  if (/\b404\b|Not Found|\b410\b/i.test(text)) return 'NOT_FOUND';
  if (/Protocol not on whitelist|not on whitelist/i.test(text)) return 'BLOCKED';
  if (/timed out|Operation timed out|ETIMEDOUT/i.test(text)) return 'TIMEOUT';
  if (/Connection refused|Failed to resolve|Name or service not known|No route to host|Network is unreachable|Temporary failure in name resolution|Connection reset/i.test(text)) return 'UNREACHABLE';
  if (/\b5\d\d\b.*(reply|Server Error)|Server returned 5/i.test(text)) return 'PROVIDER_ERROR';
  if (/Invalid data found|could not find codec parameters|Unknown input format|moov atom not found/i.test(text)) return 'NOT_MEDIA';
  if (/does not contain any stream|Output file .* does not contain/i.test(text)) return 'NO_STREAMS';
  return 'FAILED';
}

/** Remove credentials from anything that could end up in a log line. */
function scrub(text, url) {
  let out = String(text || '');
  if (url) out = out.split(url).join(redactUrl(url));
  return out.replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1•••@');
}

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------
/**
 * Validate a playlist entry before ffmpeg touches it: http(s) only, and the
 * host must not resolve to link-local / metadata / reserved space. Private
 * LAN addresses stay allowed — HDHomeRun tuners and TVHeadend live there.
 */
async function assertPlayableUrl(input) {
  let url;
  try {
    url = validateUrl(input);
  } catch (err) {
    const code = err.code === 'BAD_SCHEME' || err.code === 'INVALID_URL' ? 'UNSUPPORTED_SCHEME' : 'BLOCKED';
    throw new StreamError(messageFor(code), code, 400);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await deps.lookup(host);
    } catch {
      throw new StreamError(messageFor('UNREACHABLE'), 'UNREACHABLE');
    }
  }
  for (const entry of [].concat(addresses || [])) {
    if (blockedReason(entry.address || entry, { allowPrivate: true })) {
      throw new StreamError(messageFor('BLOCKED'), 'BLOCKED', 400);
    }
  }
  return url.toString();
}

/** [major, minor] of the installed ffmpeg; nightly builds count as new. */
function ffmpegVersion() {
  const line = transcodePlan.detectCapabilities().version || '';
  const m = line.match(/ffmpeg version n?(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : [99, 0];
}

function atLeast(major, minor = 0) {
  const [a, b] = ffmpegVersion();
  return a > major || (a === major && b >= minor);
}

function inputArgs(url, { userAgent, referrer, live, loglevel = 'error' } = {}) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', loglevel,
    '-protocol_whitelist', PROTOCOLS,
    '-user_agent', userAgent || DEFAULT_USER_AGENT,
    '-rw_timeout', '15000000',
  ];
  if (referrer) args.push('-referer', referrer);
  if (live) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (atLeast(4, 4)) args.push('-reconnect_on_network_error', '1');
  }
  return args;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------
/** Parse the "Input #0 … Stream #0:1: Audio: ac3 …" block ffmpeg prints. */
function parseProbe(stderr) {
  const text = String(stderr || '');
  const result = { container: null, duration: null, video: null, audio: null };
  const input = text.match(/Input #0, ([^\n]+?), from /);
  if (input) result.container = input[1].trim();
  const duration = text.match(/Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)/);
  if (duration) result.duration = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
  for (const line of text.split('\n')) {
    const stream = line.match(/Stream #0:\d+[^:]*: (Video|Audio): (\w+)(.*)$/);
    if (!stream) continue;
    const [, type, codec, rest] = stream;
    if (type === 'Video' && !result.video && !/attached pic/.test(rest)) {
      const size = rest.match(/\b(\d{2,5})x(\d{2,5})\b/);
      const pix = rest.match(/,\s*(yuv\w+|gbr\w*|nv\d+|p010\w*)/);
      result.video = {
        codec: codec.toLowerCase(),
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        pixFmt: pix ? pix[1] : null,
      };
    } else if (type === 'Audio' && !result.audio) {
      const channels = rest.match(/Hz, ([^,]+)/);
      result.audio = { codec: codec.toLowerCase(), layout: channels ? channels[1].trim() : null };
    }
  }
  return result;
}

/** Spawn ffmpeg just long enough to read the stream headers. */
function probe(url, { userAgent, referrer, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let settled = false;
    let proc;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc?.kill('SIGKILL'); } catch { /* already gone */ }
      fn(value);
    };
    try {
      proc = deps.spawn(transcodePlan.ffmpegBinary(), [
        ...inputArgs(url, { userAgent, referrer, loglevel: 'info' }),
        '-i', url,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      reject(new StreamError(messageFor('NO_FFMPEG'), 'NO_FFMPEG', 503));
      return;
    }
    const timer = setTimeout(() => {
      const parsed = parseProbe(stderr);
      if (parsed.video || parsed.audio) finish(resolve, parsed);
      else finish(reject, new StreamError(messageFor('TIMEOUT'), 'TIMEOUT', 504));
    }, timeoutMs);
    proc.on('error', (err) => {
      const code = classifyFailure('', err);
      finish(reject, new StreamError(messageFor(code), code, code === 'NO_FFMPEG' ? 503 : 502));
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    proc.on('close', (exitCode, signal) => {
      if (settled) return; // already answered (spawn error / timeout)
      const parsed = parseProbe(stderr);
      if (parsed.video || parsed.audio) return finish(resolve, parsed);
      const code = classifyFailure(stderr, null, { code: exitCode, signal });
      const tail = scrub(stderr, url).trim().split('\n').slice(-3).join(' | ') || '(no output)';
      logger.warn(`[Restream] probe failed (${code}, ffmpeg ${describeExit(exitCode, signal)}, ${transcodePlan.ffmpegBinary()}): ${tail}`);
      return finish(reject, new StreamError(messageFor(code), code));
    });
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------
const CODEC_NAMES = {
  h264: 'H.264', hevc: 'HEVC (H.265)', mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', vc1: 'VC-1',
  aac: 'AAC', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus', dts: 'DTS', truehd: 'Dolby TrueHD', mp2: 'MP2', mp3: 'MP3', opus: 'Opus', flac: 'FLAC', pcm_s16le: 'PCM',
};
function codecName(codec) {
  return CODEC_NAMES[codec] || String(codec || 'unknown').toUpperCase();
}

const BROWSER_VIDEO = new Set(['h264']);
const BROWSER_AUDIO = new Set(['aac']);

/** Decide copy vs. re-encode per track. `source` is a parseProbe() result. */
function planFor(source, { transcode = false } = {}) {
  const video = source?.video;
  const audio = source?.audio;
  const tenBit = /10(le|be)?$|p010/.test(video?.pixFmt || '');
  const videoMode = !video ? 'none' : (!transcode && BROWSER_VIDEO.has(video.codec) && !tenBit ? 'copy' : 'transcode');
  const audioMode = !audio ? 'none' : (!transcode && BROWSER_AUDIO.has(audio.codec) ? 'copy' : 'transcode');
  const reasons = [];
  if (videoMode === 'transcode') reasons.push(transcode ? 'conversion requested' : `${codecName(video.codec)}${tenBit ? ' 10-bit' : ''} video needs converting for browsers`);
  if (audioMode === 'transcode' && !transcode) reasons.push(`${codecName(audio.codec)} audio needs converting for browsers`);
  return {
    video: videoMode,
    audio: audioMode,
    directPlayable: videoMode !== 'transcode' && audioMode !== 'transcode',
    reason: reasons.join('; ') || 'Browser-friendly codecs — repackaged without re-encoding',
  };
}

function describeSource(source) {
  if (!source) return '';
  const parts = [];
  if (source.video) parts.push(`${codecName(source.video.codec)}${source.video.height ? ` ${source.video.height}p` : ''}`);
  if (source.audio) parts.push(`${codecName(source.audio.codec)}${source.audio.layout ? ` ${source.audio.layout.replace(/\(.*\)/, '')}` : ''}`);
  return parts.join(' · ');
}

function outputArgs(plan, { live, height }) {
  const args = ['-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn'];
  if (plan.video === 'copy') {
    args.push('-c:v', 'copy');
  } else if (plan.video === 'transcode') {
    let encoder = transcodePlan.preferredEncoder('1080p');
    // VAAPI needs a device + upload filter chain; keep the restreamer simple.
    if (encoder.kind === 'vaapi') encoder = { encoder: 'libx264', hardware: false };
    args.push('-c:v', encoder.encoder);
    if (height && height > 1080) args.push('-vf', 'scale=-2:1080');
    if (encoder.hardware) {
      args.push('-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M');
    } else {
      args.push('-preset', 'veryfast', '-crf', '23', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p', '-profile:v', 'high');
    }
    // Regular keyframes so the segmenter can cut every SEGMENT_SECONDS.
    args.push('-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`, '-sc_threshold', '0');
  }
  if (plan.audio === 'copy') args.push('-c:a', 'copy');
  else if (plan.audio === 'transcode') args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');

  args.push('-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_segment_type', 'mpegts');
  if (live) {
    args.push('-hls_list_size', String(LIVE_WINDOW), '-hls_flags', 'delete_segments+independent_segments+omit_endlist');
  } else {
    args.push('-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments');
  }
  return args;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
function maxSessions() {
  try {
    const { getConfig } = require('../config');
    const n = Number(getConfig().livetv?.maxStreams);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : DEFAULT_MAX_SESSIONS;
  } catch {
    return DEFAULT_MAX_SESSIONS;
  }
}

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const session of sessions.values()) {
      const limit = session.live ? IDLE_LIVE_MS : IDLE_VOD_MS;
      if (now - session.lastAccess > limit) stopSession(session.id, 'idle');
    }
    if (!sessions.size) {
      clearInterval(reaper);
      reaper = null;
    }
  }, 10000);
  reaper.unref?.();
}

function stopSession(id, why = 'stopped') {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  try { session.proc?.kill('SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { session.proc?.kill('SIGKILL'); } catch { /* already gone */ }
    fs.remove(session.dir).catch(() => {});
  }, 1500).unref?.();
  logger.info(`[Restream] ${session.label} ${why}`);
  return true;
}

function stopAll() {
  for (const id of [...sessions.keys()]) stopSession(id, 'shutdown');
}

function touch(id) {
  const session = sessions.get(id);
  if (session) session.lastAccess = Date.now();
  return session || null;
}

async function waitForFirstSegment(session) {
  const playlist = path.join(session.dir, 'index.m3u8');
  const started = Date.now();
  while (Date.now() - started < START_TIMEOUT_MS) {
    if (session.exited && !session.exitOk) break;
    const text = await fs.readFile(playlist, 'utf8').catch(() => '');
    if (/\.ts\s*$/m.test(text)) return true;
    if (session.exited) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/**
 * Start (or join) a restream for one channel.
 * @param {{id:string,name:string,url:string,kind?:string,userAgent?:string,referrer?:string}} channel
 */
async function start(channel, { transcode = false } = {}) {
  const live = channel.kind !== 'vod';
  const key = `${channel.id}:${transcode ? 'transcode' : 'auto'}`;

  for (const session of sessions.values()) {
    if (session.key === key && !session.exited) {
      session.lastAccess = Date.now();
      session.viewers += 1;
      return publicSession(session);
    }
  }

  const url = await assertPlayableUrl(channel.url);

  // Free a slot: drop the stalest idle session before refusing.
  if (sessions.size >= maxSessions()) {
    const idle = [...sessions.values()].filter(s => Date.now() - s.lastAccess > 15000)
      .sort((a, b) => a.lastAccess - b.lastAccess)[0];
    if (idle) stopSession(idle.id, 'evicted');
    else throw new StreamError(messageFor('TOO_MANY_STREAMS'), 'TOO_MANY_STREAMS', 503);
  }

  const source = await probe(url, channel);
  if (!source.video && !source.audio) throw new StreamError(messageFor('NO_STREAMS'), 'NO_STREAMS');
  const plan = planFor(source, { transcode });

  const id = crypto.randomBytes(12).toString('base64url');
  const dir = path.join(CACHE_ROOT, id);
  await fs.ensureDir(dir);
  const args = [
    ...inputArgs(url, { userAgent: channel.userAgent, referrer: channel.referrer, live }),
    // VOD files arrive much faster than real time; don't pull a whole movie
    // onto disk the moment someone presses play.
    ...(live || !atLeast(5) ? [] : ['-readrate', '4']),
    '-i', url,
    ...outputArgs(plan, { live, height: source.video?.height }),
    '-hls_segment_filename', path.join(dir, 'seg-%05d.ts'),
    path.join(dir, 'index.m3u8'),
  ];

  const session = {
    id,
    key,
    dir,
    live,
    label: `"${channel.name}"`,
    channelId: channel.id,
    plan,
    source,
    lastAccess: Date.now(),
    viewers: 1,
    stderr: '',
    exited: false,
    exitOk: false,
    proc: null,
  };
  try {
    session.proc = deps.spawn(transcodePlan.ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    await fs.remove(dir).catch(() => {});
    throw new StreamError(messageFor('NO_FFMPEG'), 'NO_FFMPEG', 503);
  }
  session.proc.stderr?.on('data', (chunk) => {
    session.stderr = (session.stderr + chunk.toString()).slice(-16 * 1024);
  });
  session.proc.on('error', (err) => {
    session.exited = true;
    session.spawnError = err;
  });
  session.proc.on('close', (code, signal) => {
    session.exited = true;
    session.exitOk = code === 0;
    session.exitInfo = { code, signal };
    // A crash arrives as (null, 'SIGSEGV') — log it too, not just non-zero codes.
    if ((code || isCrash(code, signal)) && sessions.has(id)) {
      const tail = scrub(session.stderr, url).trim().split('\n').slice(-2).join(' | ') || '(no output)';
      logger.warn(`[Restream] ${session.label} ffmpeg exited (${describeExit(code, signal)}): ${tail}`);
    }
  });
  sessions.set(id, session);
  startReaper();
  logger.info(`[Restream] ${session.label} → video ${plan.video}, audio ${plan.audio} (${describeSource(source)})`);

  const ready = await waitForFirstSegment(session);
  if (!ready) {
    const code = session.spawnError ? classifyFailure('', session.spawnError) : (session.exited ? classifyFailure(session.stderr, null, session.exitInfo) : 'TIMEOUT');
    stopSession(id, `failed (${code})`);
    throw new StreamError(messageFor(code), code, code === 'NO_FFMPEG' ? 503 : (code === 'TIMEOUT' ? 504 : 502));
  }
  return publicSession(session);
}

function publicSession(session) {
  return {
    sessionId: session.id,
    playlist: `/api/livetv/stream/${session.id}/index.m3u8`,
    live: session.live,
    plan: session.plan,
    source: { ...session.source, summary: describeSource(session.source) },
  };
}

/** Viewer left. The process stops once nobody is watching. */
function release(id) {
  const session = sessions.get(id);
  if (!session) return false;
  session.viewers = Math.max(0, session.viewers - 1);
  if (session.viewers === 0) stopSession(id, 'closed');
  return true;
}

/** Playlist text with segment URIs carrying the caller's media token. */
async function playlistFor(id, token) {
  const session = touch(id);
  if (!session) return null;
  const text = await fs.readFile(path.join(session.dir, 'index.m3u8'), 'utf8').catch(() => null);
  if (text == null) return null;
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  return text.split('\n').map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    return `${path.basename(t)}${suffix}`;
  }).join('\n');
}

function segmentFile(id, file) {
  if (!/^seg-\d{5}\.ts$/.test(String(file))) return null;
  const session = touch(id);
  if (!session) return null;
  return path.join(session.dir, file);
}

function status() {
  return {
    active: sessions.size,
    max: maxSessions(),
    sessions: [...sessions.values()].map(s => ({ id: s.id, channelId: s.channelId, live: s.live, plan: s.plan, viewers: s.viewers, idleSeconds: Math.round((Date.now() - s.lastAccess) / 1000) })),
  };
}

module.exports = {
  start,
  release,
  stopSession,
  stopAll,
  playlistFor,
  segmentFile,
  status,
  probe,
  parseProbe,
  planFor,
  describeSource,
  classifyFailure,
  assertPlayableUrl,
  messageFor,
  StreamError,
  deps,
  _sessions: sessions,
};
