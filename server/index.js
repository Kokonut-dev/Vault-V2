require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');

const { loadConfig, getConfig } = require('./config');
const createCorsMiddleware = require('./middleware/cors');
const createCompression = require('./middleware/compression');
const { authMiddleware } = require('./middleware/auth');
const createRateLimiters = require('./middleware/rateLimiter');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { startCacheCleanupScheduler } = require('./services/transcoder');
const libraryService = require('./services/library');
const scannerService = require('./services/scanner');
const logger = require('./utils/logger');

// Load config
const config = loadConfig();

// Init services
libraryService.init();

// Express app
const app = express();

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // We set custom CSP via helmet config if needed
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

app.use(createCorsMiddleware());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Response compression (br > gzip > deflate) — zero-dependency middleware.
// Media (video/audio), Range requests and SSE are explicitly untouched.
app.use(createCompression());

// Access log — same shape as morgan's 'combined' format, but auth tokens in
// query strings are redacted: media URLs may carry ?token=<jwt> and those must
// never be written to disk. (F-6)
morgan.token('redacted-url', req => {
  const raw = req.originalUrl || req.url || '';
  return raw.replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]');
});
app.use(morgan(
  ':remote-addr - :remote-user [:date[clf]] ":method :redacted-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'
));

// Rate limiters
const { generalLimiter, authLimiter, uploadLimiter } = createRateLimiters();
app.use('/api/', generalLimiter);
// Auth limiter applies ONLY to the credential-checking endpoints (login/grid).
// Mounting it on all of /api/auth/ used to rate-limit /api/auth/verify, which
// the frontend calls on every page load — locking users out with a
// "Too many login attempts" error even when their credentials were correct.
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/grid', authLimiter);
app.use('/api/upload/', uploadLimiter);

// Ensure data dirs
fs.ensureDirSync(path.join(__dirname, 'data'));
fs.ensureDirSync(path.join(__dirname, 'cache'));
fs.ensureDirSync(path.join(__dirname, 'cache/thumbnails'));
fs.ensureDirSync(path.join(__dirname, 'cache/covers'));
fs.ensureDirSync(path.join(__dirname, 'cache/transcoded'));
fs.ensureDirSync(path.join(__dirname, 'media/movies'));
fs.ensureDirSync(path.join(__dirname, 'media/music'));
fs.ensureDirSync(path.join(__dirname, 'media/videos'));
fs.ensureDirSync(path.join(__dirname, 'uploads'));

// Public routes (no auth)
app.get('/api/health', (req, res) => {
  const stats = libraryService.getStats();
  res.json({
    status: 'ok',
    version: '2.0.0',
    uptime: process.uptime(),
    library: {
      total: stats.totalItems,
      movies: stats.totalMovies,
      music: stats.totalMusic,
      videos: stats.totalVideos,
    },
    timestamp: new Date().toISOString(),
  });
});

// Setup / Onboarding routes (public — handles first-time config)
app.use('/api/setup', require('./routes/setup'));

// Auth routes (no auth middleware)
app.use('/api/auth', require('./routes/auth'));

// Protected routes
app.use('/api/library', authMiddleware, require('./routes/library'));
app.use('/api/media', authMiddleware, require('./routes/media'));
app.use('/api/transcode', authMiddleware, require('./routes/transcode'));
app.use('/api/upload', authMiddleware, require('./routes/upload'));
const playlistsRouter = require('./routes/playlists');
app.use('/api/playlists', authMiddleware, playlistsRouter);
// Favourites and history are handled via /api/playlists/favourites and /api/playlists/history
// The frontend api client uses /api/playlists/* paths, so no duplicate mounts needed
// For backwards compatibility, also support direct /api/favourites and /api/history via same handler
app.use('/api/favourites', authMiddleware, (req, res, next) => {
  // Rewrite url to /favourites for the router
  req.url = '/favourites' + (req.url === '/' ? '' : req.url);
  playlistsRouter(req, res, next);
});
app.use('/api/history', authMiddleware, (req, res, next) => {
  req.url = '/history' + (req.url === '/' ? '' : req.url);
  playlistsRouter(req, res, next);
});
app.use('/api/settings', authMiddleware, require('./routes/settings'));

// SSE for real-time updates (optional)
app.get('/api/events', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('connected', { message: 'Connected to Vault events' });

  const interval = setInterval(() => {
    sendEvent('ping', { timestamp: Date.now() });
  }, 30000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// Serve static frontend (same origin as API — required for playback without mixed-content)
const docsPath = path.join(__dirname, '../docs');
if (fs.existsSync(docsPath)) {
  app.use(express.static(docsPath, {
    index: 'index.html',
    fallthrough: true,
    setHeaders: (res, filePath) => {
      const name = path.basename(filePath);
      // Service worker + runtime config + HTML must always revalidate so
      // deploys take effect immediately and SW updates are detected.
      if (name === 'sw.js' || name === 'config.js' || /\.(html|json|webmanifest)$/i.test(name)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      // Everything else: 1h guaranteed-fresh, then serve stale while a
      // background revalidation runs (fast repeat loads, never minutes stale).
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=604800');
    },
  }));
  logger.info(`Serving static frontend from ${docsPath}`);
}

// 404 handler for unmatched API routes
app.use('/api', notFoundHandler);

// SPA fallback so /movies, /music, etc. work when the UI is served by this server.
// Without this, refreshing or navigating via history API 404s and "switching pages
// didn't work".
if (fs.existsSync(docsPath)) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(path.join(docsPath, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
}

// Error handler
app.use(errorHandler);

// Start server
function startServer() {
  const port = config.server.port;
  const host = config.server.host;

  // Check HTTPS
  if (config.server.https && config.server.https.enabled) {
    try {
      const keyPath = path.resolve(__dirname, config.server.https.keyPath);
      const certPath = path.resolve(__dirname, config.server.https.certPath);
      if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
        const options = {
          key: fs.readFileSync(keyPath),
          cert: fs.readFileSync(certPath),
        };
        https.createServer(options, app).listen(port, host, () => {
          logger.info(`Vault server (HTTPS) running at https://${host}:${port}`);
          onServerStart();
        });
        return;
      } else {
        logger.warn('HTTPS enabled but cert files not found, falling back to HTTP');
      }
    } catch (err) {
      logger.warn(`Failed to start HTTPS server: ${err.message}, falling back to HTTP`);
    }
  }

  app.listen(port, host, () => {
    logger.info(`Vault server (HTTP) running at http://${host}:${port}`);
    logger.info(`Health check: http://${host}:${port}/api/health`);
    logger.info(`Media paths: Movies=${config.media.paths.movies}, Music=${config.media.paths.music}, Videos=${config.media.paths.videos}`);
    onServerStart();
  });
}

async function onServerStart() {
  // Periodic transcode-cache cleanup — cleanupCache() was previously defined
  // but never invoked, so stale transcodes grew without bound (F-8).
  startCacheCleanupScheduler();
  try {
    // Initial scan
    logger.info('Starting initial library scan...');
    await scannerService.scanAll();
    // Start watcher
    scannerService.startWatcher();
    logger.info('Vault server ready!');
    logger.info(`Default credentials: username=${config.auth.username} (password is hashed, check setup)`);
    logger.info(`Grid pattern: [${config.auth.gridPattern.join(', ')}] — CHANGE THIS IN PRODUCTION!`);
  } catch (err) {
    logger.error('Failed during startup scan:', err.message);
  }
}

// Graceful shutdown — flush library debounced saves
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  try {
    scannerService.stopWatcher();
    await libraryService.flush();
  } catch {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  try {
    scannerService.stopWatcher();
    await libraryService.flush();
  } catch {}
  process.exit(0);
});

startServer();

module.exports = app;
