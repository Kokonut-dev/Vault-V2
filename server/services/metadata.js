const path = require('path');
const fs = require('fs-extra');
const { parseFile } = require('music-metadata');
const logger = require('../utils/logger');
const { parseMovieFilename } = require('../utils/fileUtils');

let ffmpeg = null;
let ffprobe = null;

try {
  const ffmpegStatic = require('ffmpeg-static');
  const ffprobeStatic = require('ffprobe-static');
  ffmpeg = require('fluent-ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegStatic);
  ffmpeg.setFfprobePath(ffprobeStatic.path);
  logger.info('[Metadata] Using static ffmpeg/ffprobe');
} catch (err) {
  try {
    ffmpeg = require('fluent-ffmpeg');
    logger.info('[Metadata] Using system ffmpeg/ffprobe');
  } catch {
    logger.warn('[Metadata] ffmpeg not available, video metadata will be limited');
  }
}

async function extractAudioMetadata(filePath) {
  try {
    const metadata = await parseFile(filePath, { duration: true });
    const common = metadata.common || {};
    const format = metadata.format || {};

    // Extract cover art if present
    let coverArtPath = null;
    if (common.picture && common.picture.length > 0) {
      try {
        const coverDir = path.join(__dirname, '../cache/covers');
        fs.ensureDirSync(coverDir);
        const hash = require('crypto').createHash('md5').update(filePath).digest('hex');
        const pic = common.picture[0];
        const ext = pic.format ? pic.format.split('/')[1] : 'jpg';
        coverArtPath = path.join(coverDir, `${hash}.${ext}`);
        if (!fs.existsSync(coverArtPath)) {
          fs.writeFileSync(coverArtPath, pic.data);
        }
      } catch (err) {
        logger.warn('Failed to extract cover art:', err.message);
      }
    }

    return {
      title: common.title || path.basename(filePath, path.extname(filePath)),
      artist: common.artist || common.albumartist || 'Unknown Artist',
      album: common.album || 'Unknown Album',
      year: common.year || null,
      genre: common.genre ? common.genre[0] : null,
      track: common.track ? common.track.no : null,
      duration: format.duration || 0,
      bitrate: format.bitrate || 0,
      sampleRate: format.sampleRate || 0,
      codec: format.codec || format.dataformat || 'unknown',
      coverArtPath,
      common,
      format,
    };
  } catch (err) {
    logger.warn(`Failed to extract audio metadata for ${filePath}: ${err.message}`);
    return {
      title: path.basename(filePath, path.extname(filePath)),
      artist: 'Unknown Artist',
      album: 'Unknown Album',
      duration: 0,
    };
  }
}

function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) {
      return resolve({
        duration: 0,
        width: 0,
        height: 0,
        bitrate: 0,
        videoCodec: 'unknown',
        audioCodec: 'unknown',
        format: path.extname(filePath).substring(1),
      });
    }

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        logger.warn(`ffprobe failed for ${filePath}: ${err.message}`);
        return resolve({
          duration: 0,
          width: 0,
          height: 0,
          bitrate: 0,
          videoCodec: 'unknown',
          audioCodec: 'unknown',
          format: path.extname(filePath).substring(1),
        });
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

      resolve({
        duration: parseFloat(metadata.format.duration) || 0,
        width: videoStream ? videoStream.width : 0,
        height: videoStream ? videoStream.height : 0,
        bitrate: parseInt(metadata.format.bit_rate) || 0,
        videoCodec: videoStream ? videoStream.codec_name : 'unknown',
        audioCodec: audioStream ? audioStream.codec_name : 'unknown',
        format: metadata.format.format_name || path.extname(filePath).substring(1),
        size: parseInt(metadata.format.size) || 0,
        streams: metadata.streams,
      });
    });
  });
}

async function extractVideoMetadata(filePath, type = 'video') {
  const parsed = parseMovieFilename(filePath);
  const probe = await probeVideo(filePath);

  // Look for subtitles alongside
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const subtitleExts = ['.srt', '.vtt', '.ass', '.ssa'];
  const subtitles = [];
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (file.startsWith(baseName) && subtitleExts.includes(path.extname(file).toLowerCase())) {
        subtitles.push({
          id: `${baseName}_${path.extname(file)}`,
          path: path.join(dir, file),
          language: 'unknown',
          format: path.extname(file).substring(1),
        });
      }
    }
  } catch {}

  return {
    title: parsed.title,
    year: parsed.year,
    season: parsed.season,
    episode: parsed.episode,
    duration: probe.duration,
    width: probe.width,
    height: probe.height,
    resolution: probe.width && probe.height ? `${probe.width}x${probe.height}` : 'unknown',
    bitrate: probe.bitrate,
    videoCodec: probe.videoCodec,
    audioCodec: probe.audioCodec,
    format: probe.format,
    subtitles,
    fileSize: probe.size || fs.statSync(filePath).size,
  };
}

async function generateThumbnail(videoPath, outputPath, time = null) {
  return new Promise((resolve, reject) => {
    if (!ffmpeg) return resolve(null);
    const dir = path.dirname(outputPath);
    fs.ensureDirSync(dir);

    // Use 25% of duration if time not specified
    const getTime = async () => {
      if (time !== null) return time;
      const probe = await probeVideo(videoPath);
      return probe.duration ? probe.duration * 0.25 : 1;
    };

    getTime().then(seekTime => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: [seekTime],
          filename: path.basename(outputPath),
          folder: dir,
          size: '320x?',
        })
        .on('end', () => resolve(outputPath))
        .on('error', err => {
          logger.warn(`Thumbnail generation failed for ${videoPath}: ${err.message}`);
          resolve(null);
        });
    });
  });
}

function canBrowserPlayDirectly(codec, format) {
  // Simplified check: H.264 in MP4 is universal
  const directPlayVideo = ['h264', 'avc'];
  const directPlayAudio = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];
  const directPlayFormat = ['mp4', 'webm', 'ogg'];

  if (format === 'mp4' && directPlayVideo.includes(codec.toLowerCase())) return true;
  if (directPlayAudio.includes(codec.toLowerCase())) return true;
  return false;
}

module.exports = {
  extractAudioMetadata,
  extractVideoMetadata,
  probeVideo,
  generateThumbnail,
  canBrowserPlayDirectly,
};
