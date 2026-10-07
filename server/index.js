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
const events = require('./services/events');
const notifications = require('./services/notifications');
const extrasService = require('./services/extras');
const trashService = require('./services/trash');
const profilesService = require('./services/profiles');
const sessionsService = require('./services/sessions');
const sqliteIndex = require('./services/sqliteIndex');
const hlsService = require('./services/hls');
const livetvService = require('./services/livetv');
const podcastsService = require('./services/podcasts');
const agentService = require('./services/agent');
const systemService = require('./services/system');
const mdnsService = require('./services/mdns');
const logger = require('./utils/logger');

// Load config
const config = loadConfig();

// Init services
libraryService.init();

// Express app
const app = express();

// Middleware
// Content-Security-Policy: previously disabled while the docs claimed CSP
// protection. The policy below allows exactly what the app needs:
//   * self-hosted scripts/styles and the small number of inline handlers the
//     zero-build SPA still uses,
//   * media/images from the API base URL (which is this server, or the tunnel
//     origin the user configured),
//   * connect to the same origins for fetch()/SSE.
// `frame-ancestors 'none'` + `object-src 'none'` keep the clickjacking and
// plugin vectors closed.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      mediaSrc: ["'self'", 'blob:', 'data:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https:', 'http:', 'blob:'],
      workerSrc: ["'self'", 'blob:'],
      frameSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      manifestSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: config.server?.https?.enabled ? undefined : false,
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
    version: require('./package.json').version || '3.0.0',
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
app.use('/api/extras', authMiddleware, require('./routes/extras'));
app.use('/api/series', authMiddleware, require('./routes/series'));
app.use('/api/profiles', authMiddleware, require('./routes/profiles'));
app.use('/api/system', authMiddleware, require('./routes/system'));
app.use('/api/podcasts', authMiddleware, require('./routes/podcasts'));
app.use('/api/comics', authMiddleware, require('./routes/comics'));
app.use('/api/livetv', authMiddleware, require('./routes/livetv'));
app.use('/api/syncplay', authMiddleware, require('./routes/syncplay'));

// Metadata agents (search + apply a match to an item).
const agentRouter = express.Router();
agentRouter.get('/search', async (req, res) => {
  const { query, type, year, artist, album } = req.query;
  if (!query && !album && !artist) return res.status(400).json({ error: 'query required' });
  const result = await agentService.searchMatches({ query, type, year, artist, album });
  res.json(result);
});
agentRouter.post('/apply/:id', async (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  try {
    const { patch, details } = await agentService.applyMatch(item, req.body?.match || {}, {
      downloadArtwork: req.body?.downloadArtwork !== false,
    });
    const updated = libraryService.updateItem(item.id, patch);
    events.broadcast('library:changed', { reason: 'metadata', id: item.id, title: updated.title });
    res.json({ item: updated, match: details });
  } catch (err) {
    logger.warn(`[Agent] apply failed: ${err.message}`);
    res.status(502).json({ error: `Metadata provider failed: ${err.message}` });
  }
});
agentRouter.get('/local/:id', (req, res) => {
  const item = libraryService.getById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  res.json({ match: agentService.readNfo(item.path) });
});
app.use('/api/agent', authMiddleware, agentRouter);

// Subsonic-compatible API so existing apps (Symfonium, play:Sub, Feishin…)
// work without a Vault client. Auth happens per-request inside the router.
app.use('/rest', require('./routes/subsonic'));

// SSE for real-time updates. Previously this endpoint only ever sent `ping`,
// so nothing consumed it (audit F-22). It now carries the live event bus:
// library changes, scan/upload jobs, now-playing, syncplay and playback state.
app.get('/api/events', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('connected', {
    message: 'Connected to Vault events',
    jobs: events.jobList(),
    version: require('./package.json').version || '3.0.0',
  });

  const interval = setInterval(() => {
    sendEvent('ping', { timestamp: Date.now() });
  }, 30000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// Public (unauthenticated) event stream used *only* while the auth gate is
// visible — it carries scan progress for the setup/first-run screens and
// nothing library-specific.
app.get('/api/events/public', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('connected', { jobs: events.jobList() });
  const interval = setInterval(() => send('ping', { timestamp: Date.now() }), 30000);
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
app.use(['/api', '/rest'], notFoundHandler);

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

  // First-run defaults + background maintenance.
  try {
    profilesService.ensureDefaults();
    notifications.wireLibraryEvents();
    if (getConfig().media?.storage === 'sqlite') {
      const result = sqliteIndex.sync(libraryService.getAll());
      logger.info(`[Index] SQLite sync: ${result.synced} item(s)`);
    }
  } catch (err) {
    logger.warn(`Startup extras failed: ${err.message}`);
  }

  // mDNS announcement (vault.local) — opt-in via server.mdns / VAULT_MDNS=1.
  try {
    const mdns = getConfig().server?.mdns || {};
    mdnsService.start({
      enabled: mdns.enabled || process.env.VAULT_MDNS === '1',
      hostname: mdns.hostname || 'vault',
      port: getConfig().server?.mdns?.announcePort || getConfig().server.port,
    });
  } catch (err) {
    logger.warn(`mDNS startup failed: ${err.message}`);
  }

  // Trash retention sweep (hourly) — soft-deleted media is purged after the
  // configured window.
  const trashTimer = setInterval(() => {
    trashService.pruneExpired().catch(() => {});
  }, 60 * 60 * 1000);
  trashTimer.unref?.();
  trashService.pruneExpired().catch(() => {});

  // Optional scan schedule (off | hourly | 6h | daily) per library.
  const scheduleAnswers = { hourly: 3600000, '6h': 21600000, daily: 86400000 };
  const schedule = getConfig().media?.scanSchedule || 'off';
  if (scheduleAnswers[schedule]) {
    const timer = setInterval(() => {
      scannerService.scanAll().catch(err => logger.warn(`Scheduled scan failed: ${err.message}`));
    }, scheduleAnswers[schedule]);
    timer.unref?.();
    logger.info(`Library scan scheduled (${schedule})`);
  }

  // Podcast auto-refresh (every 6 hours) when feeds exist.
  const podcastTimer = setInterval(() => {
    if (extrasService.getFeeds().length) podcastsService.refreshAll().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  podcastTimer.unref?.();
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
async function shutdown() {
  try {
    scannerService.stopWatcher();
    hlsService.stopAll();
    mdnsService.stop();
    livetvService.stopAll;
    await Promise.all([
      libraryService.flush(),
      libraryService.flushScoped(),
      extrasService.flush(),
      trashService.flush(),
      profilesService.flush(),
      sessionsService.flush(),
      notifications.flush(),
      agentService.flush(),
      livetvService.flush(),
    ]);
  } catch (err) {
    logger.warn(`Shutdown flush failed: ${err.message}`);
  }
}

process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  await shutdown();
  process.exit(0);
});

startServer();

module.exports = app;
