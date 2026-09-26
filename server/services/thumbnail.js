const path = require('path');
const fs = require('fs-extra');
const { getConfig } = require('../config');
const logger = require('../utils/logger');

let ffmpeg = null;
try {
  const ffmpegStatic = require('ffmpeg-static');
  const ffprobeStatic = require('ffprobe-static');
  ffmpeg = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegStatic);
  ffmpeg.setFfprobePath(ffprobeStatic.path);
} catch {
  try {
    ffmpeg = require('fluent-ffmpeg');
  } catch {
    logger.warn('[Thumbnail] ffmpeg not available');
  }
}

function getThumbnailPath(id) {
  const config = getConfig();
  const thumbDir = path.join(__dirname, '../cache/thumbnails');
  fs.ensureDirSync(thumbDir);
  return path.join(thumbDir, `${id}.jpg`);
}

function getCoverPath(id) {
  const config = getConfig();
  const coverDir = path.join(__dirname, '../cache/covers');
  fs.ensureDirSync(coverDir);
  return path.join(coverDir, `${id}.jpg`);
}

async function getOrGenerateThumbnail(videoPath, id) {
  const thumbPath = getThumbnailPath(id);
  if (fs.existsSync(thumbPath)) {
    return thumbPath;
  }

  if (!ffmpeg) return null;

  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: ['25%'],
        filename: `${id}.jpg`,
        folder: path.dirname(thumbPath),
        size: '320x?',
      })
      .on('end', () => {
        logger.info(`Thumbnail generated: ${thumbPath}`);
        resolve(thumbPath);
      })
      .on('error', (err) => {
        logger.warn(`Thumbnail generation failed for ${videoPath}: ${err.message}`);
        resolve(null);
      });
  });
}

async function generateThumbnailAtTime(videoPath, outputPath, timeSeconds) {
  if (!ffmpeg) return null;
  fs.ensureDirSync(path.dirname(outputPath));

  return new Promise((resolve) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: [timeSeconds],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: '320x?',
      })
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        logger.warn(`Thumbnail at ${timeSeconds}s failed: ${err.message}`);
        resolve(null);
      });
  });
}

module.exports = {
  getThumbnailPath,
  getCoverPath,
  getOrGenerateThumbnail,
  generateThumbnailAtTime,
};
