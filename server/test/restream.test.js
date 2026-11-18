/**
 * Live TV / IPTV playback through the server (services/restream.js).
 *
 * Regression: opening an IPTV movie handed the provider's URL (MKV, HEVC,
 * AC-3, plain http) straight to <video>; every fallback then asked for
 * /api/transcode/<library id>, which 404s for non-library items. These tests
 * pin the replacement: probe → plan (copy vs. convert) → HLS session, the
 * error codes the player explains, and the guards that keep playlist entries
 * from reading local files or cloud metadata.
 *
 * ffmpeg isn't available in CI, so `restream.deps.spawn` is replaced by a
 * fake that prints what real ffmpeg prints and writes the files it writes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const express = require('express');

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.livetv = { enabled: true, m3uUrl: '', epgUrl: '', hdhrDiscover: false };
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

const profiles = require('../services/profiles');
profiles.get = (id) => ({ default: { id: 'default', isAdmin: true }, kid: { id: 'kid', isAdmin: false } }[id] || null);

const transcodePlan = require('../services/transcodePlan');
transcodePlan.detectCapabilities = () => ({ ffmpeg: true, version: 'ffmpeg version 6.1.1', hardware: [], encoders: {} });
transcodePlan.preferredEncoder = () => ({ encoder: 'libx264', hardware: false, kind: 'software' });

const restream = require('../services/restream');
const livetv = require('../services/livetv');

// ---------------------------------------------------------------------------
// Fake ffmpeg
// ---------------------------------------------------------------------------
const PROBES = {
  hevcMkv: `Input #0, matroska,webm, from 'http://provider.test/movie/bob/pw/123.mkv':
  Duration: 01:42:10.04, start: 0.000000, bitrate: 4120 kb/s
  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 23.98 fps, 23.98 tbr, 1k tbn
  Stream #0:1(eng): Audio: ac3, 48000 Hz, 5.1(side), fltp, 640 kb/s
  Stream #0:2(eng): Subtitle: subrip
At least one output file must be specified`,
  mpeg2Ts: `Input #0, mpegts, from 'http://provider.test/live/bob/pw/1.ts':
  Duration: N/A, start: 1.400000, bitrate: N/A
  Program 1
  Stream #0:0[0x100]: Video: mpeg2video (Main) ([2][0][0][0] / 0x0002), yuv420p(tv, top first), 720x576 [SAR 16:15 DAR 4:3], 25 fps, 25 tbr, 90k tbn
  Stream #0:1[0x101]: Audio: mp2 ([3][0][0][0] / 0x0003), 48000 Hz, stereo, fltp, 192 kb/s`,
  h264Aac: `Input #0, hls, from 'http://provider.test/live/bob/pw/2.m3u8':
  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(progressive), 1280x720, 50 fps
  Stream #0:1: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp`,
  forbidden: "[http @ 0x5] HTTP error 403 Forbidden\nError opening input: Server returned 403 Forbidden (access denied)\nError opening input file http://provider.test/movie/bob/pw/1.mkv.",
  notFound: 'Error opening input: Server returned 404 Not Found',
  html: 'Error opening input: Invalid data found when processing input',
};

const spawned = [];
let probeFor = () => PROBES.h264Aac;
let failSpawn = null;

function fakeSpawn(bin, args) {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { if (!proc.killed) { proc.killed = true; setImmediate(() => proc.emit('close', null)); } };
  spawned.push({ bin, args, proc });
  if (failSpawn) {
    const err = Object.assign(new Error(`spawn ${bin} ENOENT`), { code: failSpawn });
    setImmediate(() => proc.emit('error', err));
    return proc;
  }
  const isProbe = !args.includes('-f');
  if (isProbe) {
    const url = args[args.indexOf('-i') + 1];
    setImmediate(() => {
      proc.stderr.emit('data', Buffer.from(probeFor(url)));
      proc.emit('close', 1);
    });
  } else {
    // A session: write a playlist + first segment the way ffmpeg's HLS muxer does.
    const playlist = args[args.length - 1];
    const pattern = args[args.indexOf('-hls_segment_filename') + 1];
    setTimeout(() => {
      fs.writeFileSync(pattern.replace('%05d', '00000'), Buffer.alloc(188, 0x47));
      fs.writeFileSync(playlist, `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000000,\n${pattern.replace('%05d', '00000')}\n`);
    }, 50);
  }
  return proc;
}
restream.deps.spawn = fakeSpawn;
restream.deps.lookup = async (host) => (host === 'rebind.test' ? [{ address: '169.254.169.254' }] : [{ address: '203.0.113.10' }]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test('parseProbe reads container, duration and the first video/audio streams', () => {
  const p = restream.parseProbe(PROBES.hevcMkv);
  assert.equal(p.container, 'matroska,webm');
  assert.equal(Math.round(p.duration), 6130);
  assert.deepEqual(p.video, { codec: 'hevc', width: 1920, height: 1080, pixFmt: 'yuv420p10le' });
  assert.deepEqual(p.audio, { codec: 'ac3', layout: '5.1(side)' });
  const ts = restream.parseProbe(PROBES.mpeg2Ts);
  assert.equal(ts.duration, null, 'live streams have no duration');
  assert.equal(ts.video.codec, 'mpeg2video');
  assert.equal(ts.audio.codec, 'mp2');
});

test('planFor copies browser-friendly tracks and converts the rest', () => {
  const copy = restream.planFor(restream.parseProbe(PROBES.h264Aac));
  assert.deepEqual([copy.video, copy.audio, copy.directPlayable], ['copy', 'copy', true]);

  const movie = restream.planFor(restream.parseProbe(PROBES.hevcMkv));
  assert.deepEqual([movie.video, movie.audio, movie.directPlayable], ['transcode', 'transcode', false]);
  assert.match(movie.reason, /HEVC \(H\.265\) 10-bit video/);
  assert.match(movie.reason, /Dolby Digital \(AC-3\) audio/);

  const tenBitH264 = restream.planFor({ video: { codec: 'h264', pixFmt: 'yuv420p10le' }, audio: { codec: 'aac' } });
  assert.equal(tenBitH264.video, 'transcode', '10-bit H.264 does not decode in browsers');

  const forced = restream.planFor(restream.parseProbe(PROBES.h264Aac), { transcode: true });
  assert.deepEqual([forced.video, forced.audio], ['transcode', 'transcode']);

  const radio = restream.planFor({ video: null, audio: { codec: 'mp3' } });
  assert.deepEqual([radio.video, radio.audio], ['none', 'transcode']);
});

test('classifyFailure maps ffmpeg output to codes the player can explain', () => {
  const cases = {
    AUTH: PROBES.forbidden,
    NOT_FOUND: PROBES.notFound,
    NOT_MEDIA: PROBES.html,
    UNREACHABLE: 'tcp://provider.test:80: Connection refused',
    TIMEOUT: 'Connection timed out',
    BLOCKED: 'Protocol not on whitelist \'http,https\'!',
    PROVIDER_ERROR: 'Server returned 5XX Server Error reply',
    FAILED: 'something unexpected',
  };
  for (const [code, stderr] of Object.entries(cases)) assert.equal(restream.classifyFailure(stderr), code, code);
  assert.equal(restream.classifyFailure('', { code: 'ENOENT' }), 'NO_FFMPEG');
});

test('assertPlayableUrl allows LAN tuners but refuses files, metadata and rebinding hosts', async () => {
  assert.equal(await restream.assertPlayableUrl('http://192.168.1.20:5004/auto/v2.1'), 'http://192.168.1.20:5004/auto/v2.1');
  assert.equal(await restream.assertPlayableUrl('https://provider.test/live/a/b/1.ts'), 'https://provider.test/live/a/b/1.ts');
  const refused = {
    'file:///etc/passwd': 'UNSUPPORTED_SCHEME',
    'concat:/etc/passwd|/etc/shadow': 'UNSUPPORTED_SCHEME',
    'rtmp://provider.test/live': 'UNSUPPORTED_SCHEME',
    'http://169.254.169.254/latest/meta-data/': 'BLOCKED',
    'http://[::ffff:169.254.169.254]/': 'BLOCKED',
    'http://metadata.google.internal/computeMetadata/v1/': 'BLOCKED',
    'http://rebind.test/stream.ts': 'BLOCKED',
  };
  for (const [url, code] of Object.entries(refused)) {
    await assert.rejects(restream.assertPlayableUrl(url), (err) => err.code === code, url);
  }
});

test('M3U Plus entries are tagged live or vod, and VLC options are kept', () => {
  const channels = livetv.parseM3U(`#EXTM3U
#EXTINF:-1 tvg-id="bbc1" group-title="UK",BBC One
#EXTVLCOPT:http-user-agent=SmartIPTV/1.0
#EXTVLCOPT:http-referrer=https://portal.test/
http://p.test/live/u/p/101.ts
#EXTINF:-1 group-title="UK",Sky Sports (mp4 relay)
http://p.test/live/u/p/102.mp4
#EXTINF:-1 group-title="Movies",Copper Fields (2018)
http://p.test/movie/u/p/5001.mkv
#EXTINF:-1 group-title="Series",Show S01E01
http://p.test/series/u/p/7001.mp4
#EXTINF:5400,Old Film
http://cdn.test/files/old-film
#EXTINF:-1,Radio Stream
http://radio.test/stream`);
  assert.deepEqual(channels.map(c => c.kind), ['live', 'live', 'vod', 'vod', 'vod', 'live']);
  assert.equal(channels[0].userAgent, 'SmartIPTV/1.0');
  assert.equal(channels[0].referrer, 'https://portal.test/');
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.profileId = req.headers['x-profile'] || 'default'; next(); });
  app.use('/api/livetv', require('../routes/livetv'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function call(port, method, urlPath, body, profile) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { 'Content-Type': 'application/json', ...(profile ? { 'X-Profile': profile } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString()); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, raw, type: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const PLAYLIST = `#EXTM3U
#EXTINF:-1 tvg-id="news" group-title="News",Harbour News
http://provider.test/live/bob/hunter2/1.ts
#EXTINF:-1 group-title="Movies",Copper Fields (2018)
http://provider.test/movie/bob/hunter2/123.mkv
#EXTINF:-1 group-title="Movies",Expired Movie
http://provider.test/movie/bob/hunter2/403.mkv
#EXTINF:-1 group-title="Evil",Local File
file:///etc/passwd
`;
let ctx;
let tmpDir;

test.before(async () => {
  tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vault-restream-'));
  const m3uPath = path.join(tmpDir, 'list.m3u');
  fs.writeFileSync(m3uPath, PLAYLIST);
  memory.livetv.m3uUrl = m3uPath;
  probeFor = (url) => (url.includes('403') ? PROBES.forbidden : url.includes('.mkv') ? PROBES.hevcMkv : PROBES.mpeg2Ts);
  ctx = await startApp();
});

test.after(() => {
  restream.stopAll();
  ctx?.server.close();
  ctx?.server.closeAllConnections?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('channel list never sends provider URLs (they carry the account password)', async () => {
  const res = await call(ctx.port, 'GET', '/api/livetv/channels');
  assert.equal(res.status, 200);
  assert.equal(res.body.channels.length, 4);
  assert.doesNotMatch(res.raw.toString(), /hunter2|provider\.test|etc\/passwd/);
  const byName = Object.fromEntries(res.body.channels.map(c => [c.name, c]));
  assert.equal(byName['Copper Fields (2018)'].kind, 'vod');
  assert.equal(byName['Harbour News'].kind, 'live');
  assert.equal(byName['Local File'].playable, false);
});

test('playing an IPTV movie starts an HLS session that converts HEVC/AC-3', async () => {
  spawned.length = 0;
  const { body: list } = await call(ctx.port, 'GET', '/api/livetv/channels');
  const movie = list.channels.find(c => c.kind === 'vod' && c.name.startsWith('Copper'));
  const res = await call(ctx.port, 'POST', `/api/livetv/channels/${movie.id}/play`, {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.live, false);
  assert.equal(res.body.plan.video, 'transcode');
  assert.equal(res.body.plan.audio, 'transcode');
  assert.match(res.body.playlist, /^\/api\/livetv\/stream\/[\w-]+\/index\.m3u8$/);
  assert.doesNotMatch(JSON.stringify(res.body), /hunter2/);

  const session = spawned.find(s => s.args.includes('-f'));
  const args = session.args;
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,https,tcp,tls,crypto,httpproxy', 'ffmpeg may not open local files');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p', '10-bit sources are converted to 8-bit');
  assert.ok(args.includes('-readrate'), 'VOD is paced instead of pulled to disk at full speed');
  assert.equal(args[args.indexOf('-hls_playlist_type') + 1], 'event');

  // Playlist URIs carry the media token; segments are served; others 404.
  const playlist = await call(ctx.port, 'GET', `${res.body.playlist}?token=abc.def`);
  assert.equal(playlist.status, 200);
  assert.match(playlist.type, /mpegurl/);
  assert.match(playlist.raw.toString(), /^seg-00000\.ts\?token=abc\.def$/m);
  assert.doesNotMatch(playlist.raw.toString(), new RegExp(tmpDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no server paths leak');
  const base = res.body.playlist.replace('index.m3u8', '');
  const seg = await call(ctx.port, 'GET', `${base}seg-00000.ts`);
  assert.equal(seg.status, 200);
  assert.equal(seg.type, 'video/mp2t');
  assert.equal((await call(ctx.port, 'GET', `${base}..%2F..%2Fconfig.json`)).status, 404);
  assert.equal((await call(ctx.port, 'GET', `${base}index.m3u8.bak`)).status, 404);

  // A second viewer joins the same session instead of spawning ffmpeg again.
  const before = spawned.length;
  const again = await call(ctx.port, 'POST', `/api/livetv/channels/${movie.id}/play`, {});
  assert.equal(again.body.sessionId, res.body.sessionId);
  assert.equal(spawned.length, before);

  // Both leave → ffmpeg is stopped.
  await call(ctx.port, 'DELETE', `/api/livetv/stream/${res.body.sessionId}`);
  assert.equal(session.proc.killed, false, 'one viewer still watching');
  await call(ctx.port, 'DELETE', `/api/livetv/stream/${res.body.sessionId}`);
  assert.equal(session.proc.killed, true);
  assert.equal((await call(ctx.port, 'GET', res.body.playlist)).status, 404);
});

test('live MPEG-2 channel: sliding window, reconnects, forced conversion on retry', async () => {
  spawned.length = 0;
  const { body: list } = await call(ctx.port, 'GET', '/api/livetv/channels');
  const news = list.channels.find(c => c.name === 'Harbour News');
  const res = await call(ctx.port, 'POST', `/api/livetv/channels/${news.id}/play`, { transcode: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.live, true);
  assert.equal(res.body.plan.reason, 'conversion requested');
  const args = spawned.find(s => s.args.includes('-f')).args;
  assert.ok(args.includes('-reconnect_streamed'));
  assert.match(args[args.indexOf('-hls_flags') + 1], /delete_segments/);
  assert.ok(!args.includes('-readrate'), 'live input is already real-time');
  await call(ctx.port, 'DELETE', `/api/livetv/stream/${res.body.sessionId}`);
});

test('failures come back as explained codes, not a generic media error', async () => {
  const { body: list } = await call(ctx.port, 'GET', '/api/livetv/channels');
  const id = name => list.channels.find(c => c.name === name).id;

  const expired = await call(ctx.port, 'POST', `/api/livetv/channels/${id('Expired Movie')}/play`, {});
  assert.equal(expired.status, 502);
  assert.equal(expired.body.code, 'AUTH');
  assert.match(expired.body.error, /subscription may have expired/);

  const local = await call(ctx.port, 'POST', `/api/livetv/channels/${id('Local File')}/play`, {});
  assert.equal(local.status, 400);
  assert.equal(local.body.code, 'UNSUPPORTED_SCHEME');

  const gone = await call(ctx.port, 'POST', '/api/livetv/channels/ch_99_nope/play', {});
  assert.equal(gone.status, 404);
  assert.equal(gone.body.code, 'CHANNEL_NOT_FOUND');

  failSpawn = 'ENOENT';
  try {
    const noFfmpeg = await call(ctx.port, 'POST', `/api/livetv/channels/${id('Harbour News')}/play`, {});
    assert.equal(noFfmpeg.status, 503);
    assert.equal(noFfmpeg.body.code, 'NO_FFMPEG');
    assert.match(noFfmpeg.body.error, /ffmpeg isn't installed/);
  } finally {
    failSpawn = null;
  }
});

test('Test links samples real streams and reports what pressing play would do', async () => {
  const result = await livetv.testSources({ m3uUrl: memory.livetv.m3uUrl });
  assert.equal(result.m3u.ok, true);
  assert.equal(result.m3u.live, 2);
  assert.equal(result.m3u.vod, 2);
  const { streams } = result.m3u;
  assert.equal(streams.ffmpeg, true);
  assert.equal(streams.unsupported, 1, 'file:// entry counted');
  const byName = Object.fromEntries(streams.checked.map(c => [c.name, c]));
  assert.equal(byName['Harbour News'].ok, true);
  assert.equal(byName['Harbour News'].converted, true);
  assert.match(byName['Copper Fields (2018)'].format, /HEVC/);
  assert.equal(byName['Expired Movie'].ok, false);
  assert.equal(byName['Expired Movie'].code, 'AUTH');
  assert.doesNotMatch(JSON.stringify(streams), /hunter2/);
});

test('recording: non-admins record by channel id only; URLs never echo back', async () => {
  const custom = await call(ctx.port, 'POST', '/api/livetv/recordings', { channelUrl: 'http://169.254.169.254/' }, 'kid');
  assert.equal(custom.status, 403);
  const blocked = await call(ctx.port, 'POST', '/api/livetv/recordings', { channelUrl: 'file:///etc/passwd' });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, 'UNSUPPORTED_SCHEME');
});
