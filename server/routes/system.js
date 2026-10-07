/**
 * System console: jobs, logs, disk usage, backups, library health, cache,
 * notifications, metadata agents, the optional SQLite index and downloads.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const system = require('../services/system');
const events = require('../services/events');
const notifications = require('../services/notifications');
const agent = require('../services/agent');
const sqlite = require('../services/sqliteIndex');
const trash = require('../services/trash');
const transcodePlan = require('../services/transcodePlan');
const libraryService = require('../services/library');
const subsonic = require('../services/subsonic');
const { getConfig, saveConfig } = require('../config');
const logger = require('../utils/logger');

// --- Jobs (scan / upload / download progress) -------------------------------
router.get('/jobs', (req, res) => {
  res.json({ jobs: events.jobList(), clients: events.clientCount() });
});

// --- Logs ------------------------------------------------------------------
router.get('/logs', (req, res) => {
  const limit = Math.min(2000, parseInt(req.query.limit, 10) || 200);
  res.json({ lines: system.getLogs(limit) });
});

router.post('/logs/export', async (req, res) => {
  const file = await system.writeLogFile();
  if (!file) return res.status(500).json({ error: 'Could not write log file' });
  res.json({ message: 'Log exported', file: path.basename(file) });
});

// --- Disk / index status ---------------------------------------------------
router.get('/disk', async (req, res) => {
  res.json(await system.diskUsage());
});

router.get('/index', (req, res) => {
  res.json(sqlite.status());
});

router.post('/index/rebuild', (req, res) => {
  const result = sqlite.sync(libraryService.getAll());
  res.json({ ...result, ...sqlite.status() });
});

// --- Library health --------------------------------------------------------
router.get('/health', async (req, res) => {
  const deep = req.query.deep === 'true';
  res.json(await system.libraryHealth({ deep }));
});

router.post('/health/prune-missing', async (req, res) => {
  const removed = await system.pruneMissing();
  res.json({ message: `Removed ${removed} missing item(s)`, removed });
});

// --- Caches ---------------------------------------------------------------
router.get('/cache', async (req, res) => {
  const usage = await system.diskUsage();
  res.json(usage.cache);
});

router.delete('/cache', async (req, res) => {
  const result = await system.clearCache();
  res.json({ message: 'Caches cleared', cleared: result });
});

// --- Trash maintenance ----------------------------------------------------
router.post('/trash/prune', async (req, res) => {
  const pruned = await trash.pruneExpired();
  res.json({ message: `Purged ${pruned} expired item(s)`, pruned });
});

router.get('/trash', async (req, res) => {
  res.json({ items: trash.list(), bytes: await trash.totalSize() });
});

// --- Backups --------------------------------------------------------------
router.get('/backups', (req, res) => {
  res.json({ backups: system.listBackups() });
});

router.post('/backups', async (req, res) => {
  try {
    const result = await system.createBackup({ includeMedia: req.body?.includeMedia === true });
    res.json({ message: 'Backup created', ...result });
  } catch (err) {
    logger.error(`[Backup] failed: ${err.message}`);
    res.status(500).json({ error: 'Backup failed', details: err.message });
  }
});

router.post('/backups/restore', async (req, res) => {
  try {
    const { file } = req.body || {};
    if (!file) return res.status(400).json({ error: 'file required' });
    const safe = path.basename(String(file));
    const full = path.join(system.BACKUP_DIR, safe);
    const restored = await system.restoreBackup(full);
    libraryService.loadLibrary();
    res.json({ message: `Restored ${restored.length} file(s)`, restored: restored.length });
  } catch (err) {
    res.status(500).json({ error: 'Restore failed', details: err.message });
  }
});

router.delete('/backups/:name', async (req, res) => {
  try {
    const fs = require('fs-extra');
    const safe = path.basename(req.params.name);
    await fs.remove(path.join(system.BACKUP_DIR, safe));
    res.json({ message: 'Backup deleted', name: safe });
  } catch {
    res.status(500).json({ error: 'Could not delete backup' });
  }
});

// --- Notifications & scrobbling -------------------------------------------
router.post('/notifications/test', async (req, res) => {
  const result = await notifications.test();
  res.json({ message: 'Test sent', result });
});

router.get('/scrobbles', (req, res) => {
  res.json({ scrobbles: notifications.recentScrobbles(Math.min(200, parseInt(req.query.limit, 10) || 50)) });
});

// --- Metadata agents ------------------------------------------------------
router.get('/agents', (req, res) => {
  res.json({ providers: agent.status() });
});

router.post('/agents/:provider', (req, res) => {
  const allowed = ['tmdb', 'musicbrainz', 'nfo'];
  const { provider } = req.params;
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
  const config = getConfig();
  config.metadata = config.metadata || { providers: {} };
  config.metadata.providers = config.metadata.providers || {};
  config.metadata.providers[provider] = {
    ...(config.metadata.providers[provider] || {}),
    ...req.body,
    enabled: req.body?.enabled !== undefined ? !!req.body.enabled : true,
  };
  saveConfig(config);
  res.json({ message: `${provider} updated`, providers: agent.status() });
});

// --- Media capabilities / transcoding -------------------------------------
router.get('/capabilities', (req, res) => {
  const caps = transcodePlan.detectCapabilities();
  res.json({
    ...caps,
    preferred: transcodePlan.preferredEncoder('1080p'),
    ladder: transcodePlan.QUALITY_LADDER,
  });
});

// --- Subsonic compatibility ----------------------------------------------
router.get('/subsonic', (req, res) => {
  res.json(subsonic.subsonicStatus());
});

router.put('/subsonic', (req, res) => {
  const { password, username } = req.body || {};
  const result = subsonic.setSubsonicPassword(password, username);
  res.json({ message: password ? 'Subsonic password set' : 'Subsonic access disabled', ...result });
});

module.exports = router;
