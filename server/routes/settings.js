const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getConfig, saveConfig } = require('../config');
const { sanitizeString, isValidGridPattern } = require('../utils/validators');
const logger = require('../utils/logger');
const links = require('../services/links');
const { validateUrl } = require('../utils/safeFetch');
const { requireAdmin, isAdminProfile } = require('../middleware/requireAdmin');
const crypto = require('crypto');
const sessions = require('../services/sessions');
const authService = require('../services/authService');

const SERVER_VERSION = require('../package.json').version;

/** The settings a browser may see — never secrets (JWT secret, password hash, tokens). */
function safeSettings(config) {
  return {
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
    version: SERVER_VERSION,
  };
}

router.get('/', (req, res) => {
  try {
    res.json(safeSettings(getConfig()));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Server-wide settings: admin profiles only. (This used to be open to every
// profile — including Kids profiles — and answered with the raw config,
// JWT secret and password hash included.)
router.put('/', requireAdmin, (req, res) => {
  try {
    const config = getConfig();
    const { auth, cors } = req.body;
    // Every `media.*` branch below is guarded individually; several sit
    // outside `if (media)`, so a body without `media` used to throw (500).
    const media = req.body.media && typeof req.body.media === 'object' ? req.body.media : {};

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
    if (media.missing && media.missing.retentionDays !== undefined) {
      const days = parseInt(media.missing.retentionDays, 10);
      config.media.missing = { ...(config.media.missing || {}), retentionDays: Number.isFinite(days) ? Math.min(365, Math.max(0, days)) : 30 };
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

    // Notification targets are not taken here: PUT /notifications validates
    // each link (SSRF guard) and keeps the secrets write-only.
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

    res.json({ message: 'Settings updated', settings: safeSettings(config) });
  } catch (err) {
    logger.error('Failed to update settings:', err.message);
    res.status(500).json({ error: 'Failed to update settings', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Notifications (SR-8). Targets are write-only: the browser sees whether each
// one is configured plus a redacted hint, never the URL/token itself.
// PUT semantics: absent key → keep, '' → remove, value → validate + replace.
// ---------------------------------------------------------------------------
function notificationTargets(config) {
  const n = config.notifications || {};
  return {
    webhookUrl: links.describeSecret(n.webhookUrl),
    ntfyUrl: links.describeSecret(n.ntfyUrl),
    discordWebhook: links.describeSecret(n.discordWebhook),
    telegram: {
      configured: Boolean(n.telegram?.botToken && n.telegram?.chatId),
      hint: n.telegram?.chatId ? `chat ${String(n.telegram.chatId).replace(/.(?=.{3})/g, '•')}` : '',
      botToken: { configured: Boolean(n.telegram?.botToken), hint: n.telegram?.botToken ? `bot ${String(n.telegram.botToken).split(':')[0].replace(/.(?=.{3})/g, '•')}:•••` : '' },
      chatId: { configured: Boolean(n.telegram?.chatId), hint: n.telegram?.chatId ? String(n.telegram.chatId).replace(/.(?=.{3})/g, '•') : '' },
    },
  };
}

const NOTIFY_FIELDS = {
  webhookUrl: { label: 'Webhook link' },
  ntfyUrl: { label: 'ntfy topic link' },
  discordWebhook: {
    label: 'Discord webhook link',
    check: (url) => /^(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)$/i.test(url.hostname) && /^\/api\/webhooks\/\d+\/[^/]+/.test(url.pathname)
      ? null : 'Paste the full Discord webhook link (https://discord.com/api/webhooks/…) from Server Settings → Integrations',
  },
};

router.get('/notifications', (req, res) => {
  res.json({ targets: notificationTargets(getConfig()), canEdit: isAdminProfile(req.profileId) });
});

router.put('/notifications', requireAdmin, (req, res) => {
  const body = req.body || {};
  const config = getConfig();
  const next = { ...(config.notifications || {}) };
  const fields = {};

  for (const [key, spec] of Object.entries(NOTIFY_FIELDS)) {
    if (body[key] === undefined) continue;
    const value = String(body[key] || '').trim();
    if (!value) { next[key] = ''; continue; }
    try {
      const url = validateUrl(value);
      if (url.protocol !== 'https:' && key === 'discordWebhook') throw new Error('Discord webhooks must use https://');
      const problem = spec.check ? spec.check(url) : null;
      if (problem) throw new Error(problem);
      next[key] = value.slice(0, 2048);
    } catch (err) {
      fields[key] = err.message.startsWith('Enter a full link') ? `${spec.label}: ${err.message.toLowerCase()}` : err.message;
    }
  }

  if (body.telegram !== undefined) {
    const t = body.telegram || {};
    const current = { botToken: '', chatId: '', ...(next.telegram || {}) };
    if (t.botToken !== undefined) {
      const token = String(t.botToken || '').trim();
      if (token && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) fields['telegram.botToken'] = 'A bot token looks like 123456789:ABC… — copy it from @BotFather';
      else current.botToken = token;
    }
    if (t.chatId !== undefined) {
      const chat = String(t.chatId || '').trim();
      if (chat && !/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chat)) fields['telegram.chatId'] = 'A chat ID is a number (e.g. -1001234567890) or @channelname';
      else current.chatId = chat;
    }
    next.telegram = current;
  }

  if (Object.keys(fields).length) {
    return res.status(400).json({ error: 'Some notification settings need fixing', fields });
  }
  config.notifications = next;
  saveConfig(config);
  logger.info('Notification targets updated');
  res.json({ targets: notificationTargets(getConfig()) });
});

router.post('/notifications/test', requireAdmin, async (req, res) => {
  const notifications = require('../services/notifications');
  const results = await notifications.send('Vault test notification', 'If you can read this, notifications from Vault are working.', 'info', { detailed: true });
  const targets = Object.keys(results);
  res.json({
    results,
    sent: targets.length,
    ok: targets.filter(key => results[key].ok).length,
    message: targets.length ? undefined : 'No notification targets are set up yet',
  });
});

// The account's sign-in details: admin profiles only, like every other
// server-wide setting.
router.put('/credentials', requireAdmin, (req, res) => {
  try {
    const config = getConfig();
    const { currentPassword, newUsername, newPassword, newGridPattern } = req.body || {};
    if ((currentPassword !== undefined && typeof currentPassword !== 'string')
      || (newPassword !== undefined && newPassword !== null && typeof newPassword !== 'string')
      || (newUsername !== undefined && newUsername !== null && typeof newUsername !== 'string')) {
      return res.status(400).json({ error: 'Invalid credentials payload', code: 'INVALID' });
    }

    if (!currentPassword) {
      return res.status(400).json({ error: 'Enter your current password to make changes', code: 'PASSWORD_REQUIRED', fields: { currentPassword: 'Enter your current password to make changes' } });
    }

    // Verify current password
    if (!bcrypt.compareSync(currentPassword, config.auth.passwordHash)) {
      // 400, not 401: the client treats any 401 as an expired session and
      // signs the user out — a typo must not do that.
      return res.status(400).json({ error: 'Current password is incorrect', code: 'WRONG_PASSWORD', fields: { currentPassword: 'Current password is incorrect' } });
    }

    let changed = false;

    if (newUsername) {
      const cleanUsername = sanitizeString(newUsername, 50);
      if (cleanUsername.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters' });
      }
      // Must not clash with an account made with "Create a new account".
      const taken = require('../services/accounts').findByUsername(cleanUsername);
      if (taken) {
        return res.status(409).json({ error: 'That username is already used by another account', code: 'USERNAME_TAKEN', fields: { newUsername: 'That username is already used by another account' } });
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

    // A new password or grid ends every other sign-in: other devices'
    // sessions are revoked and the token-signing secret is rotated, so tokens
    // issued before the change (or forged with a leaked secret) stop working.
    // This device gets a fresh token for its own session.
    const secretsChanged = Boolean(newPassword || newGridPattern);
    if (secretsChanged) config.auth.jwtSecret = crypto.randomBytes(64).toString('hex');
    saveConfig(config);
    logger.info('Credentials updated');

    let token;
    let signedOut = 0;
    if (secretsChanged) {
      signedOut = sessions.revokeOthers(req.user?.sid);
      token = authService.generateAccessToken(config.auth.username, {
        sid: req.user?.sid,
        profileId: req.profileId || 'default',
        remember: !!req.user?.remember,
      });
    }

    res.json({ message: 'Credentials updated successfully', token, signedOut });
  } catch (err) {
    logger.error('Failed to update credentials:', err.message);
    res.status(500).json({ error: 'Failed to update credentials', details: err.message });
  }
});

module.exports = router;
