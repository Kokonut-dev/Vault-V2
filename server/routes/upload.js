const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const paths = require('../utils/paths');
const fs = require('fs-extra');
const { getConfig } = require('../config');
const { sanitizeFilename, safeRelativeParts, isValidMediaType } = require('../utils/validators');
const scannerService = require('../services/scanner');
const logger = require('../utils/logger');

// Folder uploads send many files per request (and keep each folder's
// cover/subtitles in the same request as its media, so the scan finds them).
const MAX_FILES_PER_REQUEST = 50;
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];

function libraryRootFor(type) {
  const config = getConfig();
  return config.media.paths[type === 'movie' ? 'movies' : type === 'music' ? 'music' : 'videos'];
}

/**
 * Where an uploaded file goes. Plain uploads land flat in the library root,
 * as before. Folder uploads (`?keepFolders=1`, file names like
 * "Artist/Album/01.flac") recreate their folders inside the root: the
 * scanner and metadata code read album/show/season and sidecar artwork from
 * that structure. Every segment is sanitised; the result is verified to stay
 * inside the root.
 */
function plannedTarget(root, originalname, keepFolders) {
  if (keepFolders) {
    const parts = safeRelativeParts(originalname);
    if (parts.length) {
      const dir = path.resolve(root, ...parts.slice(0, -1));
      const resolvedRoot = path.resolve(root);
      if (dir === resolvedRoot || dir.startsWith(resolvedRoot + path.sep)) {
        return { dir, name: parts[parts.length - 1] };
      }
    }
  }
  return { dir: root, name: sanitizeFilename(path.basename(String(originalname || '').replace(/\\/g, '/'))) };
}

/**
 * Browsers put the file name in the multipart header as raw UTF-8, but
 * busboy decodes header parameters as Latin-1 by default, so "Björk" arrives
 * as "BjÃ¶rk". Re-decode when the name is pure Latin-1 and is valid UTF-8
 * underneath; leave it alone otherwise (already-correct names, RFC 5987
 * filename* values that busboy decoded properly).
 */
function fixMultipartName(name) {
  const s = String(name || '');
  if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  const decoded = Buffer.from(s, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? s : decoded;
}

function getUploadStorage(type, keepFolders) {
  const dest = libraryRootFor(type);
  fs.ensureDirSync(dest);

  // multer asks for the file name *before* the destination, so work both
  // out once per file and remember the answer on the file object.
  const target = (file) => {
    if (!file._vaultTarget) {
      if (keepFolders) file.originalname = fixMultipartName(file.originalname);
      const { dir, name } = plannedTarget(dest, file.originalname, keepFolders);
      fs.ensureDirSync(dir);
      // Avoid collisions
      const ext = path.extname(name);
      const base = path.basename(name, ext);
      let finalName = name;
      let counter = 1;
      while (fs.existsSync(path.join(dir, finalName))) {
        finalName = `${base}_${counter}${ext}`;
        counter++;
      }
      file._vaultTarget = { dir, name: finalName };
    }
    return file._vaultTarget;
  };

  return multer.diskStorage({
    destination: (req, file, cb) => {
      try { cb(null, target(file).dir); } catch (err) { cb(err); }
    },
    filename: (req, file, cb) => {
      try { cb(null, target(file).name); } catch (err) { cb(err); }
    }
  });
}

function createUploader(type, { keepFolders = false } = {}) {
  const config = getConfig();
  const maxSize = config.media.maxUploadSizeMB * 1024 * 1024;

  // Allowed mime types for extra validation (defense in depth)
  const allowedMimePrefixes = ['video/', 'audio/', 'image/', 'text/'];
  const allowedMimes = [
    'application/octet-stream', // some browsers send this for mkv etc.
    'application/x-subrip',
    'application/x-matroska',
  ];

  return multer({
    storage: getUploadStorage(type, keepFolders),
    // Folder uploads need the relative path ("Album/01.flac") that the
    // browser sends as the file name; busboy strips it unless told not to.
    preservePath: keepFolders,
    limits: { fileSize: maxSize, files: MAX_FILES_PER_REQUEST + 8 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const allExts = [
        ...config.media.supportedExtensions.video,
        ...config.media.supportedExtensions.audio,
        ...config.media.supportedExtensions.subtitle,
        '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'
      ];

      // Block dangerous extensions
      const blockedExts = ['.exe', '.bat', '.sh', '.js', '.php', '.py', '.dll', '.so', '.dmg', '.app'];
      if (blockedExts.includes(ext)) {
        return cb(new Error(`Blocked file type: ${ext}`));
      }

      // Validate extension
      const isExtAllowed = allExts.includes(ext);
      const isFieldAllowed = ['cover', 'subtitle', 'thumbnail', 'file', 'files'].includes(file.fieldname);

      if (!isExtAllowed && !isFieldAllowed) {
        return cb(new Error(`Unsupported file type: ${ext}`));
      }
      // A folder holds all sorts of things (.nfo, .txt, .DS_Store…). The
      // page filters them out; refuse anything else that slips through
      // rather than filling the library with junk.
      if (keepFolders && !isExtAllowed) {
        return cb(new Error(`Unsupported file type in folder upload: ${ext || path.basename(file.originalname)}`));
      }

      // Validate mime type (if provided by browser)
      if (file.mimetype) {
        const mimeOk = allowedMimePrefixes.some(prefix => file.mimetype.startsWith(prefix)) ||
                       allowedMimes.includes(file.mimetype) ||
                       file.mimetype === 'application/octet-stream';
        if (!mimeOk) {
          // For subtitle field, allow text
          if (file.fieldname === 'subtitle' && file.mimetype.startsWith('text/')) {
            // ok
          } else if (file.fieldname === 'cover' && file.mimetype.startsWith('image/')) {
            // ok
          } else if (!isExtAllowed) {
            return cb(new Error(`Blocked mime type: ${file.mimetype}`));
          }
          // If extension is allowed, be permissive with mime (some browsers misreport)
        }
      }

      // Specific field checks
      if (file.fieldname === 'cover' || file.fieldname === 'thumbnail') {
        if (ext && !['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) {
          return cb(new Error(`Cover must be image, got: ${ext}`));
        }
      }
      if (file.fieldname === 'subtitle') {
        if (ext && !config.media.supportedExtensions.subtitle.includes(ext)) {
          return cb(new Error(`Subtitle must be ${config.media.supportedExtensions.subtitle.join(', ')}, got: ${ext}`));
        }
      }

      cb(null, true);
    }
  });
}

/**
 * Before a folder upload: which of these files are already in the library?
 * Body: { type, files: [{ path: "Album/01.flac", size }] }. A file counts as
 * present when the same relative path exists in that library with the same
 * size, so re-dropping a half-uploaded folder only sends what's missing.
 */
router.post('/check', (req, res) => {
  const { type, files } = req.body || {};
  if (!isValidMediaType(type)) {
    return res.status(400).json({ error: 'Invalid media type. Must be movie, music, or video', code: 'INVALID_TYPE' });
  }
  if (!Array.isArray(files) || files.length > 20000) {
    return res.status(400).json({ error: 'files must be a list (max 20000)', code: 'INVALID_FILES' });
  }
  const root = libraryRootFor(type);
  const existing = [];
  files.forEach((entry, index) => {
    if (!entry || typeof entry.path !== 'string') return;
    const { dir, name } = plannedTarget(root, entry.path, true);
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile() && (entry.size === undefined || stat.size === Number(entry.size))) existing.push(index);
    } catch { /* not there */ }
  });
  res.json({ existing, maxFilesPerRequest: MAX_FILES_PER_REQUEST });
});

router.post('/:type', (req, res) => {
  const type = req.params.type;

  if (!isValidMediaType(type)) {
    return res.status(400).json({ error: 'Invalid media type. Must be movie, music, or video', code: 'INVALID_TYPE' });
  }

  const keepFolders = req.query.keepFolders === '1' || req.query.keepFolders === 'true';
  const uploader = createUploader(type, { keepFolders });
  const upload = uploader.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: MAX_FILES_PER_REQUEST },
    { name: 'cover', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
    { name: 'subtitle', maxCount: 5 },
  ]);

  upload(req, res, async (err) => {
    if (err) {
      logger.error('Upload error:', err.message);
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Max ${getConfig().media.maxUploadSizeMB}MB`, code: 'FILE_TOO_LARGE' });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: `Too many files in one upload (max ${MAX_FILES_PER_REQUEST}). Update the Vault page and try again.`, code: 'TOO_MANY_FILES' });
      }
      return res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
    }

    try {
      let metadata = {};
      if (req.body.metadata) {
        try {
          metadata = JSON.parse(req.body.metadata);
        } catch {
          return res.status(400).json({ error: 'Invalid metadata JSON', code: 'INVALID_METADATA' });
        }
      }
      const files = [];

      if (req.files['file']) files.push(...req.files['file']);
      if (req.files['files']) files.push(...req.files['files']);

      if (files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
      }

      // Store optional artwork once and share it across every uploaded item.
      // Previously the first item moved Multer's temporary cover file, then a
      // batch upload tried to move that now-missing file again and failed.
      let uploadedCoverPath = null;
      const coverFile = req.files['cover']?.[0];
      if (coverFile) {
        const coverExt = path.extname(coverFile.originalname || coverFile.path).toLowerCase();
        const coverName = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}${coverExt}`;
        uploadedCoverPath = paths.cacheDir('covers', coverName);
        fs.ensureDirSync(path.dirname(uploadedCoverPath));
        fs.moveSync(coverFile.path, uploadedCoverPath, { overwrite: false });
      }

      // In a folder upload, covers and subtitles travel as ordinary files.
      // They're already next to their media (same folder), where the
      // metadata code looks for them — they aren't library items themselves.
      const sidecarExts = new Set([...IMAGE_EXTS, ...getConfig().media.supportedExtensions.subtitle]);
      const mediaFiles = keepFolders
        ? files.filter(f => !sidecarExts.has(path.extname(f.path).toLowerCase()))
        : files;
      const sidecars = files.length - mediaFiles.length;
      // Per-item overrides (one title for one file) make no sense for a
      // whole folder of tracks or episodes.
      if (keepFolders && mediaFiles.length > 1) {
        for (const key of ['title', 'season', 'episode']) delete metadata[key];
      }

      const results = [];
      for (const file of mediaFiles) {
        // Scan the file to index it
        const item = await scannerService.scanFile(file.path);
        if (item) {
          // Apply metadata overrides if provided. They're recorded as set by
          // hand so the watcher's rescan (and every later one) keeps them
          // instead of falling back to the file's own tags.
          const overrides = {};
          if (metadata.title) overrides.title = String(metadata.title);
          if (metadata.artist) overrides.artist = String(metadata.artist);
          if (metadata.album) overrides.album = String(metadata.album);
          if (metadata.year) {
            const year = parseInt(metadata.year, 10);
            if (year) overrides.year = year;
          }
          if (metadata.genre) overrides.genre = String(metadata.genre);
          if (metadata.description) overrides.description = String(metadata.description);
          if (metadata.season) overrides.season = parseInt(metadata.season, 10);
          if (metadata.episode) overrides.episode = parseInt(metadata.episode, 10);
          if (metadata.tags) overrides.tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];
          if (Array.isArray(overrides.tags) && !overrides.tags.length) delete overrides.tags;

          if (uploadedCoverPath) {
            overrides.coverArtPath = uploadedCoverPath;
            overrides.thumbnailPath = uploadedCoverPath;
            overrides.posterPath = uploadedCoverPath;
          }
          Object.assign(item, overrides);

          // If subtitle uploaded
          if (req.files['subtitle']) {
            for (const subFile of req.files['subtitle']) {
              // Move subtitle next to media file with same base name
              const subExt = path.extname(subFile.path);
              const mediaBase = path.basename(file.path, path.extname(file.path));
              const subDest = path.join(path.dirname(file.path), `${mediaBase}${subExt}`);
              if (subFile.path !== subDest) {
                fs.moveSync(subFile.path, subDest, { overwrite: true });
              }
              if (!item.subtitles) item.subtitles = [];
              item.subtitles.push({
                id: path.basename(subDest),
                path: subDest,
                language: 'unknown',
                format: subExt.substring(1),
              });
            }
          }

          // Update library with overrides
          const libraryService = require('../services/library');
          if (item.subtitles) libraryService.updateItem(item.id, { subtitles: item.subtitles });
          const stored = Object.keys(overrides).length
            ? libraryService.updateItem(item.id, overrides, { manual: true })
            : null;
          results.push(stored ? { ...stored } : item);
        }
      }

      if (results.length === 0 && uploadedCoverPath) {
        fs.removeSync(uploadedCoverPath);
      }

      logger.info(`Uploaded ${results.length} files as ${type}${sidecars ? ` (+${sidecars} cover/subtitle files)` : ''}`);

      res.json({
        message: `Successfully uploaded ${results.length} file(s)`,
        items: results,
        sidecars,
      });
    } catch (err) {
      logger.error('Upload processing error:', err.message);
      res.status(500).json({ error: 'Failed to process upload', details: err.message });
    }
  });
});

module.exports = router;
module.exports._internals = { plannedTarget, fixMultipartName, MAX_FILES_PER_REQUEST };
