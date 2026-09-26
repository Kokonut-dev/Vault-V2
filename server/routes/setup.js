/**
 * Setup Routes — First-time onboarding for Vault V2
 * Public endpoints to initialize server config when no config.json exists
 * 
 * GET  /api/setup/status   — Check if setup is required
 * POST /api/setup/complete — Complete onboarding (creates config.json)
 * POST /api/setup/test     — Test media paths / connection
 * GET  /api/setup/defaults — Get default config template
 */

const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getConfig, saveConfig, CONFIG_PATH, DEFAULT_CONFIG } = require('../config');
const { isValidGridPattern, isValidUsername, isValidPassword, sanitizeString } = require('../utils/validators');
const logger = require('../utils/logger');
const authService = require('../services/authService');

// Helper: does config file exist on disk?
function hasConfigFile() {
  try {
    return fs.existsSync(CONFIG_PATH);
  } catch {
    return false;
  }
}

// Helper: check if current config is still using factory defaults
function isUsingDefaults() {
  if (!hasConfigFile()) return true;
  try {
    const fileConfig = fs.readJsonSync(CONFIG_PATH);
    // If passwordHash is missing or file is basically empty, treat as needing setup
    if (!fileConfig.auth || !fileConfig.auth.passwordHash) return true;
    // If file exists but username is admin and grid is default, we still consider setup done
    // unless explicitly forced. So only file existence matters for needsSetup.
    return false;
  } catch {
    return true;
  }
}

/**
 * GET /api/setup/status
 * Public — tells frontend whether onboarding wizard should be shown
 */
router.get('/status', (req, res) => {
  try {
    const hasConfig = hasConfigFile();
    const needsSetup = !hasConfig || isUsingDefaults();

    let currentConfig = null;
    if (hasConfig) {
      try {
        const cfg = getConfig();
        currentConfig = {
          username: cfg.auth.username,
          mediaPaths: cfg.media.paths,
          port: cfg.server.port,
          hasCustomGrid: JSON.stringify(cfg.auth.gridPattern) !== JSON.stringify([0, 1, 4, 5, 8, 9, 12, 13]),
        };
      } catch {}
    }

    res.json({
      needsSetup,
      hasConfig,
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      current: currentConfig,
      message: needsSetup
        ? 'First-time setup required — no config.json found. Please complete onboarding.'
        : 'Server already configured',
    });
  } catch (err) {
    logger.error('Setup status error:', err.message);
    res.status(500).json({ error: 'Failed to check setup status', code: 'SETUP_STATUS_ERROR' });
  }
});

/**
 * GET /api/setup/defaults
 * Public — returns safe defaults for onboarding UI to pre-fill
 */
router.get('/defaults', (req, res) => {
  res.json({
    server: {
      port: DEFAULT_CONFIG.server.port,
      host: DEFAULT_CONFIG.server.host,
    },
    media: {
      paths: DEFAULT_CONFIG.media.paths,
      maxUploadSizeMB: DEFAULT_CONFIG.media.maxUploadSizeMB,
    },
    auth: {
      username: DEFAULT_CONFIG.auth.username,
      gridPattern: DEFAULT_CONFIG.auth.gridPattern,
      gridOrderMatters: DEFAULT_CONFIG.auth.gridOrderMatters,
      sessionTimeout: DEFAULT_CONFIG.auth.sessionTimeout,
    },
    cors: DEFAULT_CONFIG.cors,
    supportedExtensions: DEFAULT_CONFIG.media.supportedExtensions,
  });
});

/**
 * POST /api/setup/test
 * Public — validates server URL connectivity and optional media paths
 * Body: { apiUrl?: string, mediaPaths?: object }
 */
router.post('/test', async (req, res) => {
  try {
    const { mediaPaths } = req.body || {};
    const results = {
      server: { ok: true, message: 'Server reachable' },
      media: {},
    };

    if (mediaPaths && typeof mediaPaths === 'object') {
      for (const [key, p] of Object.entries(mediaPaths)) {
        if (typeof p !== 'string' || !p.trim()) {
          results.media[key] = { ok: false, message: 'Path empty' };
          continue;
        }
        try {
          const fullPath = path.isAbsolute(p) ? p : path.resolve(__dirname, '..', p);
          const exists = await fs.pathExists(fullPath);
          if (exists) {
            const stat = await fs.stat(fullPath);
            results.media[key] = {
              ok: stat.isDirectory(),
              exists: true,
              isDirectory: stat.isDirectory(),
              path: fullPath,
              message: stat.isDirectory() ? 'Directory exists' : 'Path exists but not a directory',
            };
          } else {
            results.media[key] = {
              ok: true, // we can create it
              exists: false,
              path: fullPath,
              message: 'Directory will be created',
              willCreate: true,
            };
          }
        } catch (err) {
          results.media[key] = { ok: false, message: err.message, path: p };
        }
      }
    }

    res.json(results);
  } catch (err) {
    logger.error('Setup test error:', err.message);
    res.status(500).json({ error: 'Test failed', details: err.message });
  }
});

/**
 * POST /api/setup/complete
 * Public if needsSetup, otherwise requires auth (to allow re-configuration)
 * Body: {
 *   username: string,
 *   password: string,
 *   confirmPassword?: string,
 *   gridPattern: number[8],
 *   gridOrderMatters?: boolean,
 *   mediaPaths?: { movies, music, videos },
 *   server?: { port?, host? },
 *   corsOrigins?: string[],
 *   theme?: string
 * }
 */
router.post('/complete', async (req, res) => {
  const ip = authService.getClientIp(req);

  // Rate limit setup attempts via same bruteforce mechanism
  if (authService.isLocked(ip)) {
    const remaining = authService.getLockoutTimeRemaining(ip);
    return res.status(429).json({
      error: `Too many setup attempts. Try again in ${Math.ceil(remaining / 60)} minutes.`,
      code: 'LOCKED_OUT',
      retryAfter: remaining,
    });
  }

  try {
    const hasConfig = hasConfigFile();
    const needsSetup = !hasConfig || isUsingDefaults();

    // If setup already done, require auth token
    if (!needsSetup) {
      const authHeader = req.headers.authorization;
      let token = null;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
      if (!token) {
        return res.status(403).json({
          error: 'Setup already completed. Authentication required to re-configure.',
          code: 'SETUP_ALREADY_DONE',
          needsSetup: false,
        });
      }
      const decoded = authService.verifyToken(token);
      if (!decoded || decoded.step === 'grid') {
        return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
      }
    }

    const {
      username,
      password,
      confirmPassword,
      gridPattern,
      gridOrderMatters,
      mediaPaths,
      server: serverSettings,
      corsOrigins,
      theme,
    } = req.body;

    // Validation
    if (!username || !password || !gridPattern) {
      return res.status(400).json({
        error: 'Missing required fields: username, password, gridPattern',
        code: 'MISSING_FIELDS',
      });
    }

    const cleanUsername = typeof username === 'string' ? username.trim() : '';
    if (!isValidUsername(cleanUsername)) {
      return res.status(400).json({
        error: 'Username must be 3-50 chars, alphanumeric, underscore, dash only',
        code: 'INVALID_USERNAME',
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: 'Password must be 4-128 characters',
        code: 'INVALID_PASSWORD',
      });
    }

    if (confirmPassword && password !== confirmPassword) {
      return res.status(400).json({
        error: 'Passwords do not match',
        code: 'PASSWORD_MISMATCH',
      });
    }

    if (!isValidGridPattern(gridPattern)) {
      return res.status(400).json({
        error: 'Grid pattern must be array of 8 unique numbers 0-15',
        code: 'INVALID_GRID',
      });
    }

    // Media paths validation (optional)
    let validatedMediaPaths = { ...DEFAULT_CONFIG.media.paths };
    if (mediaPaths && typeof mediaPaths === 'object') {
      for (const key of ['movies', 'music', 'videos']) {
        if (mediaPaths[key] && typeof mediaPaths[key] === 'string' && mediaPaths[key].trim()) {
          const p = mediaPaths[key].trim();
          // Prevent path traversal outside server dir? Allow absolute but sanitize
          if (p.includes('..') && !path.isAbsolute(p)) {
            return res.status(400).json({
              error: `Invalid media path for ${key}: must not contain ..`,
              code: 'INVALID_PATH',
            });
          }
          validatedMediaPaths[key] = p;
        }
      }
    }

    // Server settings
    let validatedPort = DEFAULT_CONFIG.server.port;
    let validatedHost = DEFAULT_CONFIG.server.host;
    if (serverSettings) {
      if (serverSettings.port) {
        const port = parseInt(serverSettings.port, 10);
        if (!isNaN(port) && port >= 1024 && port <= 65535) {
          validatedPort = port;
        }
      }
      if (serverSettings.host && typeof serverSettings.host === 'string') {
        validatedHost = serverSettings.host.trim() || validatedHost;
      }
    }

    // CORS
    let validatedCorsOrigins = [...DEFAULT_CONFIG.cors.origins];
    if (corsOrigins && Array.isArray(corsOrigins) && corsOrigins.length > 0) {
      validatedCorsOrigins = corsOrigins
        .filter(o => typeof o === 'string' && o.trim())
        .map(o => sanitizeString(o, 500))
        .filter(Boolean);
      // Always include GitHub Pages origin
      if (!validatedCorsOrigins.includes('https://kokonut-dev.github.io')) {
        validatedCorsOrigins.push('https://kokonut-dev.github.io');
      }
    }

    // Build final config
    const jwtSecret = hasConfig
      ? (() => {
          try {
            return getConfig().auth.jwtSecret;
          } catch {
            return crypto.randomBytes(64).toString('hex');
          }
        })()
      : crypto.randomBytes(64).toString('hex');

    const passwordHash = bcrypt.hashSync(password, 10);

    // Load existing or default config as base
    let baseConfig;
    try {
      baseConfig = hasConfig ? getConfig() : DEFAULT_CONFIG;
    } catch {
      baseConfig = DEFAULT_CONFIG;
    }

    const finalConfig = {
      server: {
        port: validatedPort,
        host: validatedHost,
        https: baseConfig.server?.https || { enabled: false, keyPath: './certs/key.pem', certPath: './certs/cert.pem' },
      },
      auth: {
        username: cleanUsername,
        passwordHash,
        jwtSecret,
        sessionTimeout: baseConfig.auth?.sessionTimeout || '24h',
        gridPattern,
        gridOrderMatters: typeof gridOrderMatters === 'boolean' ? gridOrderMatters : false,
        maxAttempts: baseConfig.auth?.maxAttempts || 5,
        lockoutDurationMinutes: baseConfig.auth?.lockoutDurationMinutes || 15,
      },
      media: {
        paths: validatedMediaPaths,
        maxUploadSizeMB: baseConfig.media?.maxUploadSizeMB || 10240,
      },
      cors: {
        origins: validatedCorsOrigins,
      },
      security: baseConfig.security || DEFAULT_CONFIG.security,
      onboarding: {
        completedAt: new Date().toISOString(),
        completedBy: cleanUsername,
        version: '2.0.0',
        theme: theme || 'dark',
        enablement: true,
      },
    };

    // Save config
    saveConfig(finalConfig);

    // Ensure media dirs exist
    const serverDir = path.join(__dirname, '..');
    for (const p of Object.values(validatedMediaPaths)) {
      const fullPath = path.isAbsolute(p) ? p : path.resolve(serverDir, p);
      await fs.ensureDir(fullPath);
      logger.info(`Ensured media dir: ${fullPath}`);
    }

    // Ensure data/cache dirs
    await fs.ensureDir(path.join(serverDir, 'data'));
    await fs.ensureDir(path.join(serverDir, 'cache/thumbnails'));
    await fs.ensureDir(path.join(serverDir, 'cache/covers'));
    await fs.ensureDir(path.join(serverDir, 'cache/transcoded'));
    await fs.ensureDir(path.join(serverDir, 'uploads'));

    // Reset bruteforce attempts for this IP on success
    authService.resetAttempts(ip);

    // Generate access token for immediate login
    const token = authService.generateAccessToken(cleanUsername);
    const decoded = authService.verifyToken(token);

    logger.info(`Setup completed by ${cleanUsername} from ${ip} — config saved to ${CONFIG_PATH}`);

    res.json({
      message: 'Setup completed successfully',
      config: {
        username: cleanUsername,
        mediaPaths: validatedMediaPaths,
        port: validatedPort,
        host: validatedHost,
        gridPatternLength: gridPattern.length,
        gridOrderMatters: finalConfig.auth.gridOrderMatters,
        corsOrigins: validatedCorsOrigins,
      },
      token,
      expiresAt: decoded ? new Date(decoded.exp * 1000).toISOString() : null,
      user: { username: cleanUsername },
      enablement: true,
    });
  } catch (err) {
    logger.error('Setup complete error:', err.message, err.stack);
    authService.recordFailedAttempt(ip);
    res.status(500).json({ error: 'Failed to complete setup', details: err.message, code: 'SETUP_FAILED' });
  }
});

/**
 * POST /api/setup/reset (dev only, requires auth)
 * Allows resetting setup for testing
 */
router.post('/reset', (req, res) => {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);
  if (!token) return res.status(401).json({ error: 'Auth required' });

  const decoded = authService.verifyToken(token);
  if (!decoded || decoded.step === 'grid') return res.status(401).json({ error: 'Invalid token' });

  // Only allow if explicitly enabled via env
  if (process.env.ALLOW_SETUP_RESET !== 'true') {
    return res.status(403).json({ error: 'Reset not allowed. Set ALLOW_SETUP_RESET=true to enable.' });
  }

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      fs.removeSync(CONFIG_PATH);
    }
    logger.warn(`Setup reset by ${decoded.username}`);
    res.json({ message: 'Config removed, setup required again', needsSetup: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset', details: err.message });
  }
});

module.exports = router;
