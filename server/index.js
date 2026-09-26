require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');

const { loadConfig, getConfig } = require('./config');
const createCorsMiddleware = require('./middleware/cors');
const { authMiddleware } = require('./middleware/auth');
const createRateLimiters = require('./middleware/rateLimiter');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
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
app.use(morgan('combined'));

// Rate limiters
const { generalLimiter, authLimiter, uploadLimiter } = createRateLimiters();
app.use('/api/', generalLimiter);
app.use('/api/auth/', authLimiter);
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
app.use('/api/playlists', authMiddleware, require('./routes/playlists'));
app.use('/api/favourites', authMiddleware, require('./routes/playlists')); // same file handles /favourites
app.use('/api/history', authMiddleware, require('./routes/playlists'));
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

// Serve static for local dev if docs folder exists (optional)
const docsPath = path.join(__dirname, '../docs');
if (fs.existsSync(docsPath)) {
  app.use(express.static(docsPath));
  logger.info(`Serving static frontend from ${docsPath}`);
}

// 404 handler for API
app.use('/api/*', notFoundHandler);

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

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down...');
  scannerService.stopWatcher();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Shutting down...');
  scannerService.stopWatcher();
  process.exit(0);
});

startServer();

module.exports = app;
