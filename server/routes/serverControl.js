/**
 * /api/server — run the server from the app (admin only for changes).
 *
 *   GET  /            status: version, uptime, supervised?, network, autostart
 *   POST /restart     restart (needs the launcher — `npm start`)
 *   POST /stop        stop; the app's Start button brings it back
 *   PUT  /autostart   { enabled, startServer } start the launcher at sign-in
 *   PUT  /network     { lan: true|false } listen for other devices or not
 *   PUT  /keep-awake  { enabled } stop the computer sleeping while Vault runs
 */
const express = require('express');
const os = require('os');
const router = express.Router();
const { getConfig, saveConfig } = require('../config');
const lifecycle = require('../services/lifecycle');
const autostart = require('../services/autostart');
const remoteAccess = require('../services/remoteAccess');
const keepAwake = require('../utils/keepAwake');
const { requireAdmin, isAdminProfile } = require('../middleware/requireAdmin');
const logger = require('../utils/logger');

function info() {
  const config = getConfig();
  return {
    version: require('../package.json').version || '3.0.0',
    pid: process.pid,
    uptime: process.uptime(),
    node: process.version,
    platform: process.platform,
    hostname: os.hostname(),
    supervised: lifecycle.supervised(),
    launcherPort: lifecycle.launcherPort(),
    network: {
      host: config.server.host,
      port: config.server.port,
      lan: remoteAccess.listensOnAllInterfaces(config.server.host),
    },
    autostart: autostart.status(),
    keepAwake: keepAwake.status(keepAwakeEnabled(config)),
  };
}

function keepAwakeEnabled(config = getConfig()) {
  if (process.env.VAULT_KEEP_AWAKE === '0') return false;
  return config.server?.keepAwake !== false;
}

const NOT_SUPERVISED = {
  error: 'This server was started without the Vault launcher, so it can\'t be restarted from here. Start it with "npm start" (or the Start Vault shortcut) once and these buttons will work.',
  code: 'NOT_SUPERVISED',
};

// Non-admin profiles see what the (read-only) settings page shows, not the
// process internals.
router.get('/', (req, res) => {
  const full = info();
  if (isAdminProfile(req.profileId)) return res.json(full);
  const { pid, launcherPort, uptime, node, ...shown } = full;
  return res.json(shown);
});

router.post('/restart', requireAdmin, (req, res) => {
  if (!lifecycle.supervised()) return res.status(409).json(NOT_SUPERVISED);
  logger.info('[Server] Restart requested from the app');
  lifecycle.exitSoon(lifecycle.RESTART_CODE);
  res.status(202).json({ message: 'Restarting', restarting: true });
});

router.post('/stop', requireAdmin, (req, res) => {
  if (!lifecycle.supervised()) return res.status(409).json(NOT_SUPERVISED);
  logger.info('[Server] Stop requested from the app');
  lifecycle.exitSoon(0);
  res.status(202).json({ message: 'Stopping', stopping: true, launcherPort: lifecycle.launcherPort() });
});

router.put('/autostart', requireAdmin, async (req, res) => {
  try {
    const { enabled, startServer } = req.body || {};
    const result = enabled
      ? await autostart.enable({ startServer: Boolean(startServer) })
      : await autostart.disable();
    res.json(result);
  } catch (err) {
    res.status(err.code === 'UNSUPPORTED' ? 409 : 500).json({ error: err.message, code: err.code || 'AUTOSTART_FAILED' });
  }
});

router.put('/network', requireAdmin, (req, res) => {
  const lan = req.body?.lan;
  if (typeof lan !== 'boolean') return res.status(400).json({ error: 'lan must be true or false', code: 'INVALID' });
  const config = getConfig();
  const next = lan ? '0.0.0.0' : '127.0.0.1';
  const changed = config.server.host !== next && remoteAccess.listensOnAllInterfaces(config.server.host) !== lan;
  if (changed) {
    config.server.host = next;
    saveConfig(config);
    logger.info(`[Server] Network access ${lan ? 'opened to the local network' : 'limited to this computer'}`);
  }
  res.json({ ...info(), restartRequired: changed });
});

router.put('/keep-awake', requireAdmin, (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false', code: 'INVALID' });
  const config = getConfig();
  if (config.server.keepAwake !== enabled) {
    config.server.keepAwake = enabled;
    saveConfig(config);
  }
  // Applies right away — no restart needed.
  keepAwake.apply(keepAwakeEnabled());
  logger.info(`[Power] Keep this computer awake: ${enabled ? 'on' : 'off'}`);
  res.json(info());
});

module.exports = router;
