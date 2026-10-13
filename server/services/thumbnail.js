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


// ---------------------------------------------------------------------------
// Trickplay sprites (scrub-preview storyboards) — YouTube/Plex style.
// One ffmpeg pass produces `sprite-%03d.jpg` sheets of N tiles each.
// ---------------------------------------------------------------------------
function getTrickplayDir(id) {
  const dir = path.join(__dirname, '../cache/trickplay', String(id));
  fs.ensureDirSync(dir);
  return dir;
}

function getTrickplayManifestPath(id) {
  return path.join(__dirname, '../cache/trickplay', `${id}.json`);
}

async function generateTrickplay(videoPath, id, { intervalSeconds = 10, width = 160, tilesPerSheet = 25, duration = 0 } = {}) {
  if (!ffmpeg || !duration) return null;
  const manifestPath = getTrickplayManifestPath(id);
  if (fs.existsSync(manifestPath)) {
    try {
      const existing = fs.readJsonSync(manifestPath);
      if (existing && existing.count) return existing;
    } catch {}
  }

  const dir = getTrickplayDir(id);
  return new Promise((resolve) => {
    try {
      ffmpeg(videoPath)
        .outputOptions([
          `-vf fps=1/${intervalSeconds},scale=${width}:-1,tile=5x5`,
          '-qscale:v 6',
          '-frames:v', String(Math.ceil(duration / (intervalSeconds * tilesPerSheet))),
        ])
        .output(path.join(dir, 'sprite-%03d.jpg'))
        .on('end', () => {
          const sheets = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
          const manifest = {
            id,
            interval: intervalSeconds,
            width,
            tilesX: 5,
            tilesY: 5,
            tileWidth: width,
            tileHeight: Math.round((width * 9) / 16),
            tilesPerSheet,
            sheets,
            count: Math.floor(duration / intervalSeconds),
            generatedAt: new Date().toISOString(),
          };
          try {
            fs.writeJsonSync(manifestPath, manifest);
          } catch {}
          logger.info(`Trickplay generated for ${id}: ${sheets} sheets`);
          resolve(manifest);
        })
        .on('error', (err) => {
          logger.warn(`Trickplay failed for ${videoPath}: ${err.message}`);
          resolve(null);
        })
        .run();
    } catch (err) {
      logger.warn(`Trickplay error: ${err.message}`);
      resolve(null);
    }
  });
}

function getTrickplayManifest(id) {
  const manifestPath = getTrickplayManifestPath(id);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return fs.readJsonSync(manifestPath);
  } catch {
    return null;
  }
}

function getTrickplaySheetPath(id, index) {
  const dir = path.join(__dirname, '../cache/trickplay', String(id));
  const file = `sprite-${String(index).padStart(3, '0')}.jpg`;
  const full = path.join(dir, file);
  return fs.existsSync(full) ? full : null;
}

/** Resized cover/artwork variants so grids don't download 8 MB album art. */
async function getOrGenerateResizedImage(sourcePath, id, size = 320) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const dir = path.join(__dirname, '../cache/images');
  fs.ensureDirSync(dir);
  const out = path.join(dir, `${require('crypto').createHash('md5').update(`${sourcePath}:${size}`).digest('hex')}.jpg`);
  if (fs.existsSync(out)) return out;
  if (!ffmpeg) return sourcePath;
  return new Promise((resolve) => {
    ffmpeg(sourcePath)
      .outputOptions(['-vf', `scale=${size}:-1`, '-frames:v', '1'])
      .output(out)
      .on('end', () => resolve(out))
      .on('error', () => resolve(sourcePath))
      .run();
  });
}

module.exports = {
  getThumbnailPath,
  getCoverPath,
  getOrGenerateThumbnail,
  generateThumbnailAtTime,
  getTrickplayDir,
  getTrickplayManifest,
  getTrickplaySheetPath,
  generateTrickplay,
  getOrGenerateResizedImage,
};
