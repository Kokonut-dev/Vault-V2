const path = require('path');
const fs = require('fs-extra');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const { cleanCache } = require('../utils/fileUtils');

let ffmpeg = null;
try {
  // Same fallback as transcodePlan: a bundled path that does not exist on
  // disk (installs with --ignore-scripts, containers with apt ffmpeg) must
  // not stop us from using the system binaries.
  const path_ = require('path');
  const fs_ = require('fs-extra');
  let ffmpegPath = 'ffmpeg';
  let ffprobePath = 'ffprobe';
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs_.existsSync(path_.resolve(bundled))) ffmpegPath = bundled;
  } catch { /* not installed */ }
  try {
    const bundled = require('ffprobe-static').path;
    if (bundled && fs_.existsSync(path_.resolve(bundled))) ffprobePath = bundled;
  } catch { /* not installed */ }
  ffmpeg = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
} catch {
  try {
    ffmpeg = require('fluent-ffmpeg');
  } catch {
    logger.warn('[Transcoder] ffmpeg not available, transcoding disabled');
  }
}

function getCachePath(id, quality, format) {
  const config = getConfig();
  const cacheDir = config.media.transcoding.cacheDir;
  fs.ensureDirSync(cacheDir);
  return path.join(cacheDir, `${id}_${quality}_${format}.mp4`);
}

function shouldTranscode(videoCodec, audioCodec, format) {
  // Direct play if H.264 + AAC in MP4
  const videoDirect = ['h264', 'avc', 'avc1'].includes((videoCodec || '').toLowerCase());
  const audioDirect = ['aac', 'mp3'].includes((audioCodec || '').toLowerCase());
  const formatDirect = ['mp4', 'mov', 'm4v'].includes((format || '').toLowerCase());

  if (videoDirect && audioDirect && formatDirect) return false;
  // If video codec is not H.264, need transcode
  if (!videoDirect) return true;
  // If audio codec not compatible, need transcode (but could just transcode audio)
  if (!audioDirect) return true;
  return false;
}

function transcodeVideo(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) return reject(new Error('ffmpeg not available'));

    const {
      quality = '720p',
      videoCodec = 'libx264',
      audioCodec = 'aac',
      format = 'mp4',
    } = options;

    let size = '1280x?';
    let crf = '23';
    let preset = 'veryfast';

    switch (quality) {
      case '1080p':
        size = '1920x?';
        crf = '23';
        break;
      case '720p':
        size = '1280x?';
        crf = '23';
        break;
      case '480p':
        size = '854x?';
        crf = '26';
        break;
      case '360p':
        size = '640x?';
        crf = '28';
        break;
      default:
        size = '1280x?';
    }

    fs.ensureDirSync(path.dirname(outputPath));

    const command = ffmpeg(inputPath)
      .videoCodec(videoCodec)
      .audioCodec(audioCodec)
      .size(size)
      .outputOptions([
        `-crf ${crf}`,
        `-preset ${preset}`,
        '-movflags frag_keyframe+empty_moov',
        '-pix_fmt yuv420p',
      ])
      .format(format)
      .on('start', (cmdLine) => {
        logger.info(`Transcoding started: ${cmdLine}`);
      })
      .on('error', (err) => {
        logger.error(`Transcoding error: ${err.message}`);
        reject(err);
      })
      .on('end', () => {
        logger.info(`Transcoding finished: ${outputPath}`);
        // Post-transcode sweep: keep the cache within its size cap as soon as
        // new content lands (the periodic scheduler also runs every 6h).
        cleanupCache().catch(err =>
          logger.warn(`[Transcoder] post-transcode cache cleanup failed: ${err.message}`)
        );
        resolve(outputPath);
      });

    command.save(outputPath);
  });
}

function transcodeStream(inputPath, res, options = {}) {
  if (!ffmpeg) {
    res.status(500).json({ error: 'Transcoding not available' });
    return;
  }

  const {
    quality = '720p',
    videoCodec = 'libx264',
    audioCodec = 'aac',
  } = options;

  let size = '1280x?';
  let crf = '23';

  switch (quality) {
    case '1080p':
      size = '1920x?';
      break;
    case '720p':
      size = '1280x?';
      break;
    case '480p':
      size = '854x?';
      crf = '26';
      break;
    case '360p':
      size = '640x?';
      crf = '28';
      break;
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Accept-Ranges', 'none');

  const command = ffmpeg(inputPath)
    .videoCodec(videoCodec)
    .audioCodec(audioCodec)
    .size(size)
    .outputOptions([
      `-crf ${crf}`,
      '-preset veryfast',
      '-movflags frag_keyframe+empty_moov',
      '-pix_fmt yuv420p',
    ])
    .format('mp4')
    .on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Transcoding failed', details: err.message });
      } else {
        res.end();
      }
      logger.error(`Transcode stream error: ${err.message}`);
    });

  const stream = command.pipe();
  stream.pipe(res);

  reqCleanup(res, command);
}

function transcodeAudioStream(inputPath, res, options = {}) {
  if (!ffmpeg) {
    res.status(500).json({ error: 'Transcoding not available' });
    return;
  }

  const { codec = 'aac', bitrate = '128k' } = options;

  let audioCodec = 'aac';
  let format = 'adts';
  let contentType = 'audio/aac';

  switch (codec) {
    case 'opus':
      audioCodec = 'libopus';
      format = 'ogg';
      contentType = 'audio/ogg';
      break;
    case 'mp3':
      audioCodec = 'libmp3lame';
      format = 'mp3';
      contentType = 'audio/mpeg';
      break;
    case 'aac':
    default:
      audioCodec = 'aac';
      format = 'adts';
      contentType = 'audio/aac';
      break;
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Transfer-Encoding', 'chunked');

  const command = ffmpeg(inputPath)
    .audioCodec(audioCodec)
    .audioBitrate(bitrate)
    .format(format)
    .on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Audio transcoding failed', details: err.message });
      } else {
        res.end();
      }
      logger.error(`Audio transcode error: ${err.message}`);
    });

  const stream = command.pipe();
  stream.pipe(res);

  reqCleanup(res, command);
}

function reqCleanup(res, command) {
  const cleanup = () => {
    try {
      command.kill('SIGKILL');
    } catch {}
  };
  res.on('close', cleanup);
  res.on('finish', cleanup);
}

async function cleanupCache() {
  const config = getConfig();
  await cleanCache(config.media.transcoding.cacheDir, config.media.transcoding.cacheMaxSizeMB);
}

// ---------------------------------------------------------------------------
// Cache cleanup scheduling (F-8)
// cleanCache() enforced the size cap but was never invoked anywhere, so
// stale transcodes could grow without bound. Schedule it at startup and then
// periodically; transcodeVideo() also triggers a sweep after each run.
// ---------------------------------------------------------------------------
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
let cleanupTimer = null;

function startCacheCleanupScheduler({ intervalMs = CLEANUP_INTERVAL_MS, runOnStart = true } = {}) {
  if (cleanupTimer) return; // idempotent — safe to call more than once
  const run = () => {
    cleanupCache().catch(err => logger.warn(`[Transcoder] cache cleanup failed: ${err.message}`));
  };
  if (runOnStart) run();
  cleanupTimer = setInterval(run, intervalMs);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref(); // never hold the process open
  logger.info(`[Transcoder] cache cleanup scheduled (every ${Math.round(intervalMs / 60000)} min)`);
}

function stopCacheCleanupScheduler() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

module.exports = {
  getCachePath,
  shouldTranscode,
  transcodeVideo,
  transcodeStream,
  transcodeAudioStream,
  cleanupCache,
  startCacheCleanupScheduler,
  stopCacheCleanupScheduler,
};
