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

    // Embedded lyrics (ID3 USLT / Vorbis LYRICS / iTunes lyric).
    let lyrics = null;
    try {
      const raw = common.lyrics;
      if (Array.isArray(raw) && raw.length) {
        lyrics = typeof raw[0] === 'string' ? raw[0] : (raw[0].text || raw[0].lyrics || null);
      } else if (typeof raw === 'string') {
        lyrics = raw;
      }
      if (!lyrics && common.lyricsText) lyrics = common.lyricsText;
    } catch {}

    // Sidecar .lrc next to the audio file (takes precedence — it is synced).
    let lyricsLrc = null;
    try {
      const base = filePath.slice(0, filePath.length - path.extname(filePath).length);
      for (const candidate of [`${base}.lrc`, `${base}.LRC`]) {
        if (fs.existsSync(candidate)) {
          lyricsLrc = fs.readFileSync(candidate, 'utf8');
          break;
        }
      }
    } catch {}

    // Sidecar cover (folder.jpg / cover.jpg) when the tag has no picture —
    // this is what Plex/Jellyfin do and it is the single biggest artwork win.
    if (!coverArtPath) {
      coverArtPath = findSidecarArtwork(filePath);
    }

    return {
      title: common.title || path.basename(filePath, path.extname(filePath)),
      artist: common.artist || common.albumartist || 'Unknown Artist',
      albumArtist: common.albumartist || common.artist || null,
      album: common.album || 'Unknown Album',
      year: common.year || null,
      genre: common.genre ? common.genre[0] : null,
      genres: common.genre || [],
      track: common.track ? common.track.no : null,
      disc: common.disk ? common.disk.no : null,
      composer: common.composer ? common.composer[0] : null,
      duration: format.duration || 0,
      bitrate: format.bitrate || 0,
      sampleRate: format.sampleRate || 0,
      codec: format.codec || format.dataformat || 'unknown',
      lossless: ['flac', 'alac', 'wav', 'aiff', 'ape'].includes(String(format.codec || format.dataformat || '').toLowerCase()),
      lyrics,
      lyricsLrc,
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


// ---------------------------------------------------------------------------
// Sidecar artwork / extras detection (poster.jpg, backdrop.jpg, folder.jpg,
// trailer files, extras folders) — the conventions every media server uses.
// ---------------------------------------------------------------------------
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];
const POSTER_NAMES = ['poster', 'folder', 'cover', 'movie', 'default'];
const BACKDROP_NAMES = ['backdrop', 'fanart', 'background', 'art'];
const TRAILER_HINTS = ['trailer', 'teaser'];
const EXTRA_DIRS = ['extras', 'featurettes', 'behind the scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts', 'specials'];

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function findNamedImage(dir, names, { exclude = [] } = {}) {
  const files = listDirSafe(dir);
  for (const name of names) {
    const match = files.find(f => {
      const stem = f.slice(0, f.length - path.extname(f).length).toLowerCase();
      const ext = path.extname(f).toLowerCase();
      return stem === name && IMAGE_EXTS.includes(ext) && !exclude.includes(stem);
    });
    if (match) return path.join(dir, match);
  }
  return null;
}

/** Poster/cover art for a media file (sibling, then parent folder). */
function findSidecarArtwork(filePath) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  // `<name>-poster.jpg` next to the file wins, then generic poster names.
  const own = listDirSafe(dir).find(f => {
    const ext = path.extname(f).toLowerCase();
    return IMAGE_EXTS.includes(ext) && f.toLowerCase().startsWith(`${stem}-poster`);
  });
  if (own) return path.join(dir, own);
  return (
    findNamedImage(dir, POSTER_NAMES, { exclude: BACKDROP_NAMES }) ||
    findNamedImage(path.dirname(dir), POSTER_NAMES, { exclude: BACKDROP_NAMES }) ||
    null
  );
}

function findBackdrop(filePath) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const own = listDirSafe(dir).find(f => {
    const ext = path.extname(f).toLowerCase();
    return IMAGE_EXTS.includes(ext) && f.toLowerCase().startsWith(`${stem}-backdrop`);
  });
  if (own) return path.join(dir, own);
  return (
    findNamedImage(dir, BACKDROP_NAMES) ||
    findNamedImage(path.dirname(dir), BACKDROP_NAMES) ||
    null
  );
}

/** Trailers: `<name>-trailer.mp4`, `Trailers/` folder, or a sibling with "trailer". */
function findTrailer(filePath, allFiles = null) {
  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const videoExts = ['.mp4', '.mkv', '.webm', '.mov', '.m4v'];
  const files = allFiles || listDirSafe(dir);
  const own = files.find(f => {
    const lower = f.toLowerCase();
    return videoExts.includes(path.extname(f).toLowerCase()) && lower.startsWith(stem) && TRAILER_HINTS.some(h => lower.includes(h));
  });
  if (own) return path.join(dir, own);
  for (const trailerDir of ['trailers', 'trailer']) {
    const candidate = listDirSafe(path.join(dir, trailerDir)).find(f => videoExts.includes(path.extname(f).toLowerCase()));
    if (candidate) return path.join(dir, trailerDir, candidate);
  }
  return null;
}

function findExtras(filePath, allFiles = null) {
  const dir = path.dirname(filePath);
  const videoExts = ['.mp4', '.mkv', '.webm', '.mov', '.m4v'];
  const files = allFiles || listDirSafe(dir);
  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const extras = [];

  for (const extraDir of EXTRA_DIRS) {
    const full = path.join(dir, extraDir);
    for (const f of listDirSafe(full)) {
      if (videoExts.includes(path.extname(f).toLowerCase())) {
        extras.push({ path: path.join(full, f), title: path.basename(f, path.extname(f)), kind: extraDir });
      }
    }
  }
  for (const f of files) {
    const lower = f.toLowerCase();
    const ext = path.extname(f).toLowerCase();
    if (!videoExts.includes(ext)) continue;
    if (lower.startsWith(`${stem}-`) && !TRAILER_HINTS.some(h => lower.includes(h))) {
      extras.push({ path: path.join(dir, f), title: path.basename(f, ext), kind: 'extra' });
    }
  }
  return extras;
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

      const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
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
        // Chapters: ffprobe exposes them on format.chapters (id/start_time/tags.title)
        chapters: (metadata.chapters || []).map((c, i) => ({
          index: i,
          start: parseFloat(c.start_time) || 0,
          end: c.end_time !== undefined ? parseFloat(c.end_time) : null,
          title: (c.tags && (c.tags.title || c.tags.TITLE)) || `Chapter ${i + 1}`,
        })),
        // Technical badges (4K / HDR / surround) come from these.
        audioTracks: audioStreams.map(s => ({
          index: s.index,
          codec: s.codec_name,
          language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || 'und',
          title: s.tags && (s.tags.title || s.tags.TITLE) || null,
          channels: s.channels || 2,
          channelLayout: s.channel_layout || null,
          bitrate: parseInt(s.bit_rate) || 0,
        })),
        colorTransfer: videoStream ? (videoStream.color_transfer || null) : null,
        colorPrimaries: videoStream ? (videoStream.color_primaries || null) : null,
        pixelFormat: videoStream ? videoStream.pix_fmt : null,
        frameRate: videoStream ? videoStream.r_frame_rate : null,
        profile: videoStream ? videoStream.profile : null,
        level: videoStream ? videoStream.level : null,
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
  let dirFiles = [];
  try {
    dirFiles = fs.readdirSync(dir);
    for (const file of dirFiles) {
      if (file.startsWith(baseName) && subtitleExts.includes(path.extname(file).toLowerCase())) {
        const stem = file.slice(0, file.length - path.extname(file).length);
        // `Movie.en.srt` / `Movie.eng.forced.srt` → language + forced flags,
        // which the player uses to auto-pick a track.
        const suffix = stem.slice(baseName.length).replace(/^[.\-_ ]+/, '');
        const parts = suffix.split(/[.\-_ ]+/).filter(Boolean);
        const LANG_RE = /^(en|eng|english|nl|nld|dut|de|deu|ger|fr|fra|fre|es|spa|it|ita|pt|por|ru|rus|ja|jpn|ko|kor|zh|chi|pl|pol|sv|swe|no|nor|da|dan|fi|fin|tr|tur|ar|ara|he|heb|hi|hin)$/i;
        const langPart = parts.find(p => LANG_RE.test(p) && p.length <= 7) || null;
        subtitles.push({
          id: `${baseName}_${path.extname(file)}`,
          path: path.join(dir, file),
          label: stem.slice(baseName.length).replace(/^[.\-_ ]+/, '') || 'Default',
          language: langPart ? langPart.toLowerCase() : 'unknown',
          forced: /forced/i.test(suffix) || /sdh/i.test(suffix),
          default: !suffix,
          format: path.extname(file).substring(1),
        });
      }
    }
  } catch {}

  const posterPath = findNamedImage(dir, POSTER_NAMES, { exclude: BACKDROP_NAMES }) ||
    findNamedImage(path.dirname(dir), POSTER_NAMES, { exclude: BACKDROP_NAMES });
  const backdropPath = findNamedImage(dir, BACKDROP_NAMES) || findNamedImage(path.dirname(dir), BACKDROP_NAMES);
  const trailerPath = findTrailer(filePath, dirFiles);
  const extraFiles = findExtras(filePath, dirFiles);

  const isHdr = /smpte2084|arib-std-b67|bt2020/i.test(String(probe.colorTransfer || '') + String(probe.colorPrimaries || ''));

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
    audioTracks: probe.audioTracks || [],
    format: probe.format,
    subtitles,
    chapters: probe.chapters || [],
    posterPath: posterPath || null,
    backdropPath: backdropPath || null,
    trailerPath: trailerPath || null,
    extras: extraFiles,
    hdr: isHdr,
    fourK: (probe.width || 0) >= 3500,
    surround: (probe.audioTracks || []).some(a => a.channels >= 6),
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
  findSidecarArtwork,
  findBackdrop,
  findTrailer,
  findExtras,
};
