/**
 * Mounts the Subsonic API subset. Auth is per-request (u/p or u/t/s), so this
 * router is intentionally *not* wrapped in the JWT middleware.
 */
const express = require('express');
const fs = require('fs-extra');
const subsonic = require('../services/subsonic');
const { sendFileWithRange } = require('../utils/fileUtils');

const router = express.Router();

subsonic.register(router, {
  streamHandler(req, res, item) {
    const maxBitRate = parseInt(req.query.maxBitRate, 10);
    const { shouldTranscode, transcodeAudioStream } = require('../services/transcoder');
    const wantsTranscode = (maxBitRate && maxBitRate < 320) || shouldTranscode(item);
    if (wantsTranscode) {
      const bitrate = maxBitRate ? `${Math.min(320, maxBitRate)}k` : '192k';
      return transcodeAudioStream(item.path, res, { codec: 'mp3', bitrate });
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    return sendFileWithRange(req, res, item.path);
  },
  coverHandler(req, res, item) {
    const cover = [item.posterPath, item.coverArtPath, item.thumbnailPath].find(p => p && fs.existsSync(p));
    if (!cover) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(cover).pipe(res);
  },
});

module.exports = router;
