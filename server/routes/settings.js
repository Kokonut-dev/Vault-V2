const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getConfig, saveConfig } = require('../config');
const { sanitizeString, isValidGridPattern } = require('../utils/validators');
const logger = require('../utils/logger');

router.get('/', (req, res) => {
  try {
    const config = getConfig();
    // Return safe settings (no secrets)
    res.json({
      server: {
        port: config.server.port,
        host: config.server.host,
      },
      media: {
        paths: config.media.paths,
        maxUploadSizeMB: config.media.maxUploadSizeMB,
        thumbnail: config.media.thumbnail,
        transcoding: {
          enabled: config.media.transcoding.enabled,
          cacheMaxSizeMB: config.media.transcoding.cacheMaxSizeMB,
        },
      },
      auth: {
        username: config.auth.username,
        sessionTimeout: config.auth.sessionTimeout,
        gridOrderMatters: config.auth.gridOrderMatters,
        maxAttempts: config.auth.maxAttempts,
        lockoutDurationMinutes: config.auth.lockoutDurationMinutes,
      },
      cors: config.cors,
      version: '2.0.0',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.put('/', (req, res) => {
  try {
    const config = getConfig();
    const { media, auth, cors } = req.body;

    if (media) {
      if (media.paths) {
        // Validate paths exist or can be created
        for (const [key, p] of Object.entries(media.paths)) {
          if (typeof p === 'string' && p.length > 0) {
            config.media.paths[key] = p;
          }
        }
      }
      if (media.maxUploadSizeMB) {
        const size = parseInt(media.maxUploadSizeMB, 10);
        if (!isNaN(size) && size > 0 && size <= 102400) {
          config.media.maxUploadSizeMB = size;
        }
      }
    }

    if (auth) {
      if (auth.sessionTimeout) {
        const validTimeouts = ['1h', '6h', '12h', '24h', '7d', '30d'];
        if (validTimeouts.includes(auth.sessionTimeout) || /^\d+[hmd]$/.test(auth.sessionTimeout)) {
          config.auth.sessionTimeout = auth.sessionTimeout;
        }
      }
      if (auth.gridOrderMatters !== undefined) {
        config.auth.gridOrderMatters = !!auth.gridOrderMatters;
      }
      if (auth.maxAttempts !== undefined) {
        const ma = parseInt(auth.maxAttempts, 10);
        if (!isNaN(ma) && ma >= 3 && ma <= 20) config.auth.maxAttempts = ma;
      }
      if (auth.lockoutDurationMinutes !== undefined) {
        const ld = parseInt(auth.lockoutDurationMinutes, 10);
        if (!isNaN(ld) && ld >= 1 && ld <= 1440) config.auth.lockoutDurationMinutes = ld;
      }
    }

    if (cors && cors.origins && Array.isArray(cors.origins)) {
      config.cors.origins = cors.origins.map(o => sanitizeString(o, 500)).filter(Boolean);
    }

    saveConfig(config);
    logger.info('Settings updated');

    res.json({ message: 'Settings updated', settings: config });
  } catch (err) {
    logger.error('Failed to update settings:', err.message);
    res.status(500).json({ error: 'Failed to update settings', details: err.message });
  }
});

router.put('/credentials', (req, res) => {
  try {
    const config = getConfig();
    const { currentPassword, newUsername, newPassword, newGridPattern } = req.body;

    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password required' });
    }

    // Verify current password
    if (!bcrypt.compareSync(currentPassword, config.auth.passwordHash)) {
      return res.status(401).json({ error: 'Current password incorrect' });
    }

    let changed = false;

    if (newUsername) {
      const cleanUsername = sanitizeString(newUsername, 50);
      if (cleanUsername.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
      }
      config.auth.username = cleanUsername;
      changed = true;
    }

    if (newPassword) {
      if (newPassword.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
      }
      config.auth.passwordHash = bcrypt.hashSync(newPassword, 10);
      changed = true;
    }

    if (newGridPattern) {
      if (!isValidGridPattern(newGridPattern)) {
        return res.status(400).json({ error: 'Grid pattern must be array of 8 unique numbers 0-15' });
      }
      config.auth.gridPattern = newGridPattern;
      changed = true;
    }

    if (!changed) {
      return res.status(400).json({ error: 'No changes provided' });
    }

    saveConfig(config);
    logger.info('Credentials updated');

    res.json({ message: 'Credentials updated successfully' });
  } catch (err) {
    logger.error('Failed to update credentials:', err.message);
    res.status(500).json({ error: 'Failed to update credentials', details: err.message });
  }
});

module.exports = router;
