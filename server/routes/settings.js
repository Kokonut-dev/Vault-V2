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

    if (media.libraries !== undefined && Array.isArray(media.libraries)) {
      // Named libraries: validated + normalised so the scanner can trust them.
      config.media.libraries = media.libraries
        .filter(l => l && typeof l === 'object')
        .slice(0, 40)
        .map((l, index) => ({
          id: l.id || `lib_${index}_${String(l.name || l.type || 'library').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24)}`,
          name: String(l.name || l.type || `Library ${index + 1}`).slice(0, 80),
          type: ['movie', 'show', 'music', 'video', 'audiobook', 'podcast', 'comic'].includes(l.type) ? l.type : 'video',
          paths: (Array.isArray(l.paths) ? l.paths : [l.path]).filter(p => typeof p === 'string' && p.trim()).map(p => p.trim()),
          ignore: Array.isArray(l.ignore) ? l.ignore.map(i => String(i).slice(0, 200)).slice(0, 50) : [],
          scanSchedule: ['off', 'hourly', '6h', 'daily'].includes(l.scanSchedule) ? l.scanSchedule : 'off',
        }))
        .filter(l => l.paths.length);
    }
    if (media.ignore !== undefined && Array.isArray(media.ignore)) {
      config.media.ignore = media.ignore.map(i => String(i).slice(0, 200)).filter(Boolean).slice(0, 100);
    }
    if (media.scanSchedule && ['off', 'hourly', '6h', 'daily'].includes(media.scanSchedule)) {
      config.media.scanSchedule = media.scanSchedule;
    }
    if (media.storage && ['json', 'sqlite'].includes(media.storage)) {
      config.media.storage = media.storage;
    }
    if (media.transcoding) {
      const t = media.transcoding;
      const current = config.media.transcoding;
      if (['auto', 'software', 'nvenc', 'vaapi', 'qsv', 'videotoolbox', 'amf'].includes(t.hardwareAcceleration)) {
        current.hardwareAcceleration = t.hardwareAcceleration;
      }
      if (t.maxHeight) current.maxHeight = Math.min(4320, Math.max(240, parseInt(t.maxHeight, 10) || 1080));
      if (t.segmentSeconds) current.segmentSeconds = Math.min(30, Math.max(2, parseInt(t.segmentSeconds, 10) || 6));
      if (t.cacheMaxSizeMB) current.cacheMaxSizeMB = Math.min(102400, Math.max(256, parseInt(t.cacheMaxSizeMB, 10) || 5120));
      if (typeof t.enabled === 'boolean') current.enabled = t.enabled;
    }
    if (media.trash) {
      const t = media.trash;
      if (typeof t.enabled === 'boolean') config.media.trash.enabled = t.enabled;
      if (t.retentionDays) config.media.trash.retentionDays = Math.min(365, Math.max(1, parseInt(t.retentionDays, 10) || 30));
    }
    if (media.trickplay) {
      const t = media.trickplay;
      if (typeof t.enabled === 'boolean') config.media.trickplay.enabled = t.enabled;
      if (t.intervalSeconds) config.media.trickplay.intervalSeconds = Math.min(60, Math.max(2, parseInt(t.intervalSeconds, 10) || 10));
    }
    if (media.extras && typeof media.extras === 'object') {
      config.media.extras = { ...config.media.extras, ...media.extras };
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
      if (auth.profiles !== undefined && typeof auth.profiles === 'object') {
        config.auth.profiles = { ...config.auth.profiles, ...auth.profiles };
      }
    }

    if (req.body.notifications && typeof req.body.notifications === 'object') {
      config.notifications = { ...config.notifications, ...req.body.notifications };
    }
    if (req.body.metadata && typeof req.body.metadata === 'object') {
      config.metadata = { ...config.metadata, ...req.body.metadata };
      if (req.body.metadata.providers) {
        config.metadata.providers = { ...config.metadata.providers, ...req.body.metadata.providers };
      }
    }

    if (cors && cors.origins && Array.isArray(cors.origins)) {
      // CORS origins must NOT be HTML-escaped — that breaks https://
      config.cors.origins = cors.origins
        .filter(o => typeof o === 'string' && o.trim())
        .map(o => o.trim().replace(/\/$/, '').substring(0, 500))
        .filter(Boolean);
      // Deduplicate and ensure GitHub Pages always allowed
      config.cors.origins = [...new Set(config.cors.origins)];
      if (!config.cors.origins.includes('https://kokonut-dev.github.io')) {
        config.cors.origins.push('https://kokonut-dev.github.io');
      }
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
