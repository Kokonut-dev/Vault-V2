/**
 * The one place that decides which ffmpeg / ffprobe binaries Vault runs.
 *
 * Order: FFMPEG_PATH / FFPROBE_PATH → the bundled ffmpeg-static /
 * ffprobe-static binary *if the file actually exists* → `ffmpeg` / `ffprobe`
 * on PATH.
 *
 * Why this matters: the bundled packages export a path string even when the
 * binary was never downloaded (npm install --ignore-scripts, a failed
 * postinstall, ARM boards, Docker images that apt-install ffmpeg instead).
 * fluent-ffmpeg's binary path is process-global, so a single module calling
 * setFfmpegPath(<missing file>) broke audio conversion, video transcoding
 * and thumbnails for the whole server ("spawn …/ffmpeg-static/ffmpeg ENOENT").
 */
const fs = require('fs');
const path = require('path');

function existing(candidate) {
  try {
    return candidate && fs.existsSync(path.resolve(candidate)) ? candidate : null;
  } catch {
    return null;
  }
}

function ffmpegBinary() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  let bundled = null;
  try { bundled = require('ffmpeg-static'); } catch { /* not installed */ }
  return existing(bundled) || 'ffmpeg';
}

function ffprobeBinary() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  let bundled = null;
  try { bundled = require('ffprobe-static').path; } catch { /* not installed */ }
  return existing(bundled) || 'ffprobe';
}

/** Load fluent-ffmpeg pointed at the right binaries (null if not installed). */
function fluentFfmpeg() {
  let ffmpeg;
  try { ffmpeg = require('fluent-ffmpeg'); } catch { return null; }
  ffmpeg.setFfmpegPath(ffmpegBinary());
  ffmpeg.setFfprobePath(ffprobeBinary());
  return ffmpeg;
}

module.exports = { ffmpegBinary, ffprobeBinary, fluentFfmpeg };
