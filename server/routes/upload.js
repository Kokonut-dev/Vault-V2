const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { getConfig } = require('../config');
const { sanitizeFilename, isValidMediaType } = require('../utils/validators');
const scannerService = require('../services/scanner');
const logger = require('../utils/logger');

function getUploadStorage(type) {
  const config = getConfig();
  let dest = config.media.paths[type === 'movie' ? 'movies' : type === 'music' ? 'music' : 'videos'];
  fs.ensureDirSync(dest);

  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, dest);
    },
    filename: (req, file, cb) => {
      const safeName = sanitizeFilename(file.originalname);
      // Avoid collisions
      const ext = path.extname(safeName);
      const base = path.basename(safeName, ext);
      let finalName = safeName;
      let counter = 1;
      while (fs.existsSync(path.join(dest, finalName))) {
        finalName = `${base}_${counter}${ext}`;
        counter++;
      }
      cb(null, finalName);
    }
  });
}

function createUploader(type) {
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
    storage: getUploadStorage(type),
    limits: { fileSize: maxSize, files: 25 },
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

router.post('/:type', (req, res) => {
  const type = req.params.type;

  if (!isValidMediaType(type)) {
    return res.status(400).json({ error: 'Invalid media type. Must be movie, music, or video', code: 'INVALID_TYPE' });
  }

  const uploader = createUploader(type);
  const upload = uploader.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: 20 },
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

      const results = [];
      for (const file of files) {
        // Scan the file to index it
        const item = await scannerService.scanFile(file.path);
        if (item) {
          // Apply metadata overrides if provided
          if (metadata.title) item.title = metadata.title;
          if (metadata.artist) item.artist = metadata.artist;
          if (metadata.album) item.album = metadata.album;
          if (metadata.year) item.year = parseInt(metadata.year, 10) || item.year;
          if (metadata.genre) item.genre = metadata.genre;
          if (metadata.description) item.description = metadata.description;
          if (metadata.season) item.season = parseInt(metadata.season, 10);
          if (metadata.episode) item.episode = parseInt(metadata.episode, 10);
          if (metadata.tags) item.tags = Array.isArray(metadata.tags) ? metadata.tags : [metadata.tags];

          // If cover uploaded, handle
          if (req.files['cover'] && req.files['cover'][0]) {
            const coverFile = req.files['cover'][0];
            const coverDest = path.join(__dirname, '../cache/covers', `${item.id}${path.extname(coverFile.path)}`);
            fs.ensureDirSync(path.dirname(coverDest));
            fs.moveSync(coverFile.path, coverDest, { overwrite: true });
            item.coverArtPath = coverDest;
            item.thumbnailPath = coverDest;
          }

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
          libraryService.updateItem(item.id, item);
          results.push(item);
        }
      }

      logger.info(`Uploaded ${results.length} files as ${type}`);

      res.json({
        message: `Successfully uploaded ${results.length} file(s)`,
        items: results,
      });
    } catch (err) {
      logger.error('Upload processing error:', err.message);
      res.status(500).json({ error: 'Failed to process upload', details: err.message });
    }
  });
});

module.exports = router;
