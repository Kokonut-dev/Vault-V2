/**
 * HLS (adaptive) streaming.
 *
 * Instead of one long chunked ffmpeg pipe — which cannot be seeked, resumed or
 * quality-switched — the player fetches a playlist and segment files. Segments
 * are produced on demand per (item, variant), cached on disk, and the playlist
 * is rewritten to point at this server's segment URLs.
 *
 * Renditions depend on the source: a 1080p source gets 1080/720/480, a 4K
 * source gets 1080/720/480 (downscaling 4K on a home server is the sane
 * default; "original" is still available as a single-variant playlist).
 */
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const transcodePlan = require('./transcodePlan');

const running = new Map(); // key -> child process

function cacheDir(itemId, variant) {
  const base = path.join(__dirname, '..', 'cache', 'hls', String(itemId), variant);
  fs.ensureDirSync(base);
  return base;
}

function variantsFor(item) {
  const height = item.height || 1080;
  const ladder = transcodePlan.QUALITY_LADDER.filter(q => q.height > 0)
    .sort((a, b) => b.height - a.height);
  const usable = ladder.filter(q => q.height <= Math.max(480, Math.min(height, 1080)));
  const names = usable.map(q => q.name);
  return names.length ? names : ['720p'];
}

/** Master playlist with bandwidth/ resolution annotations. */
function masterPlaylist(item, variants) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const name of variants) {
    const q = transcodePlan.qualityFor(name);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${q.videoBitrate * 1000 + q.audioBitrate * 1000},RESOLUTION=${Math.round((q.height * 16) / 9)}x${q.height},NAME="${name}"`);
    lines.push(`/api/transcode/hls/${item.id}/${name}/index.m3u8`);
  }
  return lines.join('\n');
}

/** Start (or reuse) the segmenter for one variant, then wait for its playlist. */
function ensureVariant(item, name) {
  const dir = cacheDir(item.id, name);
  const playlistPath = path.join(dir, 'index.m3u8');
  const key = `${item.id}:${name}`;

  if (running.has(key)) {
    const proc = running.get(key);
    if (!proc.killed) return playlistPath;
  }

  const config = getConfig();
  const segmentSeconds = config.media.transcoding?.segmentSeconds || 6;
  const quality = transcodePlan.qualityFor(name);
  const encoder = transcodePlan.preferredEncoder(name);

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', item.path,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', encoder.encoder,
    '-vf', `scale=-2:${quality.height}`,
    '-b:v', `${quality.videoBitrate}k`,
    '-maxrate', `${Math.round(quality.videoBitrate * 1.4)}k`,
    '-bufsize', `${quality.videoBitrate * 2}k`,
    '-c:a', 'aac', '-b:a', `${quality.audioBitrate}k`, '-ac', '2',
  ];
  if (!encoder.hardware) args.push('-preset', 'veryfast');
  args.push(
    '-g', String(segmentSeconds * 24), '-keyint_min', String(segmentSeconds * 24), '-sc_threshold', '0',
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(dir, 'seg-%05d.ts'),
    '-hls_flags', 'independent_segments',
    playlistPath
  );

  const proc = spawn(transcodePlan.ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  proc.stderr.on('data', chunk => logger.warn(`[HLS ${item.id}/${name}] ${chunk.toString().trim()}`));
  proc.on('close', () => running.delete(key));
  proc.on('error', err => {
    logger.warn(`[HLS] ffmpeg failed: ${err.message}`);
    running.delete(key);
  });
  running.set(key, proc);
  logger.info(`[HLS] Segmenting ${item.title} → ${name}`);
  return playlistPath;
}

async function waitForPlaylist(playlistPath, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(playlistPath)) {
      const content = await fs.readFile(playlistPath, 'utf8').catch(() => '');
      if (/\.ts/.test(content)) return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  return fs.existsSync(playlistPath);
}

/** Rewrite absolute segment paths so the client can fetch them through the API. */
async function variantPlaylist(item, name) {
  const playlistPath = ensureVariant(item, name);
  const ready = await waitForPlaylist(playlistPath);
  if (!ready) return null;
  const content = await fs.readFile(playlistPath, 'utf8');
  return content
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const file = path.basename(trimmed);
      return `/api/transcode/hls/${item.id}/${name}/${file}`;
    })
    .join('\n');
}

function segmentPath(itemId, variant, file) {
  if (!/^[\w.-]+$/.test(file)) return null;
  return path.join(cacheDir(itemId, variant), path.basename(file));
}

function stopAll() {
  for (const [, proc] of running) {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
  running.clear();
}

function status() {
  return {
    active: running.size,
    renditions: [...running.keys()],
    cacheDir: path.join(__dirname, '..', 'cache', 'hls'),
  };
}

async function clearCache() {
  const dir = path.join(__dirname, '..', 'cache', 'hls');
  let removed = 0;
  try {
    const entries = await fs.readdir(dir);
    await Promise.all(entries.map(e => fs.remove(path.join(dir, e))));
    removed = entries.length;
  } catch {}
  return removed;
}

module.exports = {
  masterPlaylist,
  variantPlaylist,
  variantsFor,
  segmentPath,
  stopAll,
  status,
  clearCache,
};
