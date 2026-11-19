/**
 * GET /api/health — public "is a Vault running here?" check.
 *
 * Anyone can call it (the launcher, the setup wizard, uptime monitors), so it
 * only says `ok` and the version. Library counts and uptime are added for a
 * signed-in device: they told strangers how big your library is and when the
 * computer last restarted.
 */
const express = require('express');
const { optionalAuthMiddleware } = require('../middleware/auth');
const libraryService = require('../services/library');

const router = express.Router();

router.get('/', optionalAuthMiddleware, (req, res) => {
  const body = {
    status: 'ok',
    version: require('../package.json').version || '3.0.0',
    timestamp: new Date().toISOString(),
  };
  if (req.user) {
    const stats = libraryService.getStats();
    body.uptime = process.uptime();
    body.library = {
      total: stats.totalItems,
      movies: stats.totalMovies,
      music: stats.totalMusic,
      videos: stats.totalVideos,
    };
  }
  res.json(body);
});

module.exports = router;
