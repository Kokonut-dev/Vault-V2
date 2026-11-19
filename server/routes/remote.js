/**
 * /api/remote — "use Vault on another device" (admin only).
 *
 *   GET    /           same-network addresses + tunnel/cloudflared status
 *   POST   /tunnel     start a Cloudflare quick tunnel (installs cloudflared
 *                      first if needed); returns at once, progress over SSE
 *                      `remote:changed` and GET /
 *   DELETE /tunnel     stop it
 *   PUT    /settings   { tunnelOnStartup?, autoStopHours? (0|1|4|8|24, 0 = never) }
 */
const express = require('express');
const router = express.Router();
const { getConfig, saveConfig } = require('../config');
const remoteAccess = require('../services/remoteAccess');
const logger = require('../utils/logger');

router.get('/', async (req, res) => {
  res.json(await remoteAccess.status());
});

router.post('/tunnel', (req, res) => {
  const current = remoteAccess.publicState();
  if (['installing', 'starting', 'on'].includes(current.status)) return res.status(202).json(current);
  remoteAccess.startTunnel({ install: req.body?.install !== false })
    .catch(err => logger.warn(`[Remote] Tunnel failed: ${err.message}`));
  // startTunnel sets the state synchronously before its first await resolves.
  setImmediate(() => res.status(202).json(remoteAccess.publicState()));
});

router.delete('/tunnel', (req, res) => {
  res.json(remoteAccess.stopTunnel());
});

router.put('/settings', (req, res) => {
  const config = getConfig();
  config.remoteAccess = { ...(config.remoteAccess || {}) };
  if (typeof req.body?.tunnelOnStartup === 'boolean') config.remoteAccess.tunnelOnStartup = req.body.tunnelOnStartup;
  if (req.body?.autoStopHours !== undefined) {
    const hours = Number(req.body.autoStopHours);
    if (!remoteAccess.AUTO_STOP_CHOICES.includes(hours)) {
      return res.status(400).json({ error: `autoStopHours must be one of ${remoteAccess.AUTO_STOP_CHOICES.join(', ')}`, code: 'INVALID' });
    }
    config.remoteAccess.autoStopHours = hours;
  }
  saveConfig(config);
  // A running tunnel follows the new choice (counted from when it started).
  remoteAccess.scheduleAutoStop();
  res.json({
    tunnelOnStartup: Boolean(config.remoteAccess.tunnelOnStartup),
    autoStopHours: remoteAccess.autoStopHours(config),
    tunnel: remoteAccess.publicState(),
  });
});

module.exports = router;
