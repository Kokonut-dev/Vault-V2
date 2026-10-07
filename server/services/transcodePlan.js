/**
 * Transcode planning: hardware-acceleration detection, quality ladder, and the
 * "why is this transcoding?" explanation surfaced in the player's stats panel.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { getConfig } = require('../config');
const logger = require('../utils/logger');

const ENCODERS = {
  nvenc: { h264: 'h264_nvenc', hevc: 'hevc_nvenc', label: 'NVIDIA NVENC' },
  vaapi: { h264: 'h264_vaapi', hevc: 'hevc_vaapi', label: 'VAAPI' },
  qsv: { h264: 'h264_qsv', hevc: 'hevc_qsv', label: 'Intel QuickSync' },
  videotoolbox: { h264: 'h264_videotoolbox', hevc: 'hevc_videotoolbox', label: 'VideoToolbox' },
  amf: { h264: 'h264_amf', hevc: 'hevc_amf', label: 'AMD AMF' },
};

const QUALITY_LADDER = [
  { name: 'original', height: 0, videoBitrate: 0, audioBitrate: 256 },
  { name: '1080p', height: 1080, videoBitrate: 6000, audioBitrate: 192 },
  { name: '720p', height: 720, videoBitrate: 3000, audioBitrate: 160 },
  { name: '480p', height: 480, videoBitrate: 1200, audioBitrate: 128 },
  { name: '360p', height: 360, videoBitrate: 700, audioBitrate: 96 },
];

let cachedCapabilities = null;

function ffmpegBinary() {
  try {
    return require('ffmpeg-static');
  } catch {
    return 'ffmpeg';
  }
}

function ffprobeBinary() {
  try {
    return require('ffprobe-static').path;
  } catch {
    return 'ffprobe';
  }
}

/**
 * Ask ffmpeg which encoders exist. Cached for the process lifetime — encoder
 * availability does not change while the server runs.
 */
function detectCapabilities(force = false) {
  if (cachedCapabilities && !force) return cachedCapabilities;

  const caps = {
    ffmpeg: false,
    version: null,
    encoders: {},
    hardware: [],
    platform: `${os.platform()} ${os.arch()}`,
    cpus: os.cpus().length,
    detectedAt: new Date().toISOString(),
  };

  try {
    const result = spawnSync(ffmpegBinary(), ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000 });
    if (result.status === 0 || result.stdout) {
      caps.ffmpeg = true;
      const out = `${result.stdout || ''}`;
      const version = spawnSync(ffmpegBinary(), ['-version'], { encoding: 'utf8', timeout: 10000 });
      caps.version = (version.stdout || '').split('\n')[0] || null;
      for (const [key, set] of Object.entries(ENCODERS)) {
        const present = Object.values(set).filter(v => typeof v === 'string' && out.includes(v));
        caps.encoders[key] = present.length > 0;
        if (present.length) caps.hardware.push({ key, label: set.label, encoders: present, h264: out.includes(set.h264) });
      }
    }
  } catch (err) {
    logger.warn(`[Transcode] ffmpeg capability probe failed: ${err.message}`);
  }

  cachedCapabilities = caps;
  return caps;
}

function preferredEncoder(quality) {
  const config = getConfig();
  const pref = config.media?.transcoding?.hardwareAcceleration || 'auto';
  const caps = detectCapabilities();
  const source = quality === 'original' ? 'h264' : 'h264';

  if (pref !== 'auto' && pref !== 'software' && ENCODERS[pref]) {
    const set = ENCODERS[pref];
    if (caps.encoders[pref] && set[source]) return { encoder: set[source], hardware: true, kind: pref, label: set.label };
  }
  if (pref === 'auto') {
    for (const hw of caps.hardware) {
      const set = ENCODERS[hw.key];
      if (set && set[source]) return { encoder: set[source], hardware: true, kind: hw.key, label: set.label };
    }
  }
  return { encoder: config.media?.transcoding?.videoCodec || 'libx264', hardware: false, kind: 'software', label: 'CPU (libx264)' };
}

function qualityFor(name) {
  return QUALITY_LADDER.find(q => q.name === name) || QUALITY_LADDER.find(q => q.name === '720p');
}

/**
 * Decide what needs to happen for a given item + requested quality.
 * `reason` is what the "stats for nerds" panel shows.
 */
function plan(item, requestedQuality = 'auto') {
  const config = getConfig();
  const caps = detectCapabilities();
  const targetHeight = item.height || 1080;
  const quality = requestedQuality === 'auto' || !requestedQuality
    ? (targetHeight > 1080 ? '1080p' : 'original')
    : requestedQuality;
  const ladder = qualityFor(quality);

  const reasons = [];
  const videoCodec = String(item.videoCodec || '').toLowerCase();
  const audioCodec = String(item.audioCodec || '').toLowerCase();
  const container = String(item.format || '').toLowerCase();

  const directVideo = ['h264', 'avc', 'avc1', 'vp8', 'vp9', 'av1'].includes(videoCodec);
  const directAudio = ['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(audioCodec);
  const directContainer = /mp4|webm|mov|ogg/.test(container);

  if (!directVideo) reasons.push(`video codec ${videoCodec || 'unknown'} is not browser-playable`);
  if (!directAudio) reasons.push(`audio codec ${audioCodec || 'unknown'} is not browser-playable`);
  if (!directContainer) reasons.push(`container ${container || 'unknown'} is not browser-playable`);
  if (ladder.height && targetHeight > ladder.height) reasons.push(`downscaling to ${ladder.height}p`);

  const directPlay = reasons.length === 0;
  const encoder = directPlay ? null : preferredEncoder(quality);

  return {
    directPlay,
    transcode: !directPlay,
    quality,
    ladder,
    encoder,
    reasons: directPlay ? ['direct play'] : reasons,
    source: {
      height: targetHeight,
      width: item.width || 0,
      videoCodec: videoCodec || 'unknown',
      audioCodec: audioCodec || 'unknown',
      container: container || 'unknown',
      bitrate: item.bitrate || 0,
    },
    capabilities: {
      ffmpeg: caps.ffmpeg,
      version: caps.version,
      hardwareAcceleration: caps.hardware.map(h => h.label),
      configured: config.media?.transcoding?.hardwareAcceleration || 'auto',
    },
  };
}

/** ffmpeg args for a plan (hardware encoders need different flags). */
function buildArgs(planResult, sourcePath, options = {}) {
  const ladder = planResult.ladder;
  const encoder = planResult.encoder?.encoder || 'libx264';
  const hardware = planResult.encoder?.hardware;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (options.startSeconds) args.push('-ss', String(options.startSeconds));
  args.push('-i', sourcePath);
  if (options.startSeconds) args.push('-ss', '0');

  const videoFilters = [];
  if (ladder.height && (planResult.source.height || 0) > ladder.height) {
    videoFilters.push(`scale=-2:${ladder.height}`);
  }
  if (hardware && !['videotoolbox'].includes(planResult.encoder.kind)) {
    // NVENC/QSV/AMF accept filters directly; VAAPI needs hwupload.
    if (planResult.encoder.kind === 'vaapi') videoFilters.push('format=nv12,hwupload');
  }

  args.push('-map', '0:v:0?', '-map', '0:a:0?');
  args.push('-c:v', encoder);
  if (videoFilters.length) args.push('-vf', videoFilters.join(','));
  if (ladder.videoBitrate) args.push('-b:v', `${ladder.videoBitrate}k`, '-maxrate', `${Math.round(ladder.videoBitrate * 1.4)}k`, '-bufsize', `${ladder.videoBitrate * 2}k`);
  if (!hardware) args.push('-preset', options.preset || 'veryfast', '-crf', String(options.crf ?? 23));
  args.push('-c:a', options.audioCodec || 'aac', '-b:a', `${ladder.audioBitrate}k`, '-ac', '2');
  if (options.copyAudio) {
    args.splice(args.indexOf('-c:a'), 2, '-c:a', 'copy');
  }
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  return args;
}

/** HLS variant playlist for adaptive streaming. */
function buildHlsArgs(sourcePath, variant) {
  const encoder = preferredEncoder(variant.name);
  const args = ['-hide_banner', '-loglevel', 'error', '-i', sourcePath,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c:v', encoder.encoder,
    '-vf', `scale=-2:${variant.height}`,
    '-b:v', `${variant.videoBitrate}k`,
    '-c:a', 'aac', '-b:a', `${variant.audioBitrate}k`, '-ac', '2',
    '-preset', 'veryfast', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-f', 'hls'];
  return args;
}

function ladder(above = 1080) {
  return QUALITY_LADDER.filter(q => q.height > 0 && q.height <= above).sort((a, b) => b.height - a.height);
}

module.exports = {
  detectCapabilities,
  preferredEncoder,
  plan,
  buildArgs,
  buildHlsArgs,
  ladder,
  qualityFor,
  QUALITY_LADDER,
  ffmpegBinary,
  ffprobeBinary,
};
