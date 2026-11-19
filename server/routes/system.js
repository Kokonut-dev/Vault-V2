/**
 * System console: jobs, logs, disk usage, backups, library health, cache,
 * notifications, metadata agents, the optional SQLite index and downloads.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const system = require('../services/system');
const events = require('../services/events');
const notifications = require('../services/notifications');
const agent = require('../services/agent');
const sqlite = require('../services/sqliteIndex');
const trash = require('../services/trash');
const transcodePlan = require('../services/transcodePlan');
const libraryService = require('../services/library');
const subsonic = require('../services/subsonic');
const scanner = require('../services/scanner');
const { getConfig, saveConfig } = require('../config');
const logger = require('../utils/logger');
const { requireAdmin } = require('../middleware/requireAdmin');

// Anything that changes the server — and the reads that expose its internals
// (logs, backup archives, Subsonic settings) — is for admins. A kids' profile
// could otherwise restore an old backup over everyone's library.
// The trash lists deleted files from every library (and every profile); the
// health report, disk, cache and index views list files and titles from the
// whole library (past any age limit) and server paths; scrobbles are
// everyone's listening history. Jobs, capabilities and agents stay open.
const ADMIN_READS = /^\/(logs|backups|subsonic|trash|health|disk|cache|index|scrobbles)(\/|$)/;
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return ADMIN_READS.test(req.path) ? requireAdmin(req, res, next) : next();
  }
  return requireAdmin(req, res, next);
});

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
  try {
    res.json(await system.diskUsage());
  } catch (err) {
    res.status(500).json({ error: 'Could not measure disk usage', details: err.message });
  }
});

router.get('/index', (req, res) => {
  res.json(sqlite.status());
});

router.post('/index/rebuild', (req, res) => {
  try {
    const result = sqlite.sync(libraryService.getAll());
    res.json({ ...result, ...sqlite.status() });
  } catch (err) {
    res.status(500).json({ error: 'Could not rebuild the index', details: err.message });
  }
});

// --- Library health --------------------------------------------------------
router.get('/health', async (req, res) => {
  try {
    const deep = req.query.deep === 'true';
    const report = await system.libraryHealth({ deep });
    // Cheap, always-fresh extras the Server page shows next to the report.
    res.json({
      ...report,
      deep,
      lastScan: scanner.getLastScan(),
      scanning: scanner.isScanning(),
      index: sqlite.status(),
    });
  } catch (err) {
    logger.error(`[System] health report failed: ${err.message}`);
    res.status(500).json({ error: 'Could not build the health report', details: err.message });
  }
});

router.post('/health/prune-missing', async (req, res) => {
  try {
    const removed = await system.pruneMissing();
    res.json({ message: `Removed ${removed} missing item(s)`, removed });
  } catch (err) {
    res.status(500).json({ error: 'Could not remove missing items', details: err.message });
  }
});

// --- Caches ---------------------------------------------------------------
router.get('/cache', async (req, res) => {
  const usage = await system.diskUsage();
  res.json(usage.cache);
});

router.delete('/cache', async (req, res) => {
  try {
    const result = await system.clearCache();
    res.json({ message: 'Caches cleared', cleared: result });
  } catch (err) {
    res.status(500).json({ error: 'Could not clear caches', details: err.message });
  }
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
    if (!safe.endsWith('.zip') || !(await fs.pathExists(full))) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    const restored = await system.restoreBackup(full);
    libraryService.loadLibrary();
    res.json({ message: `Restored ${restored.length} file(s)`, restored: restored.length });
  } catch (err) {
    res.status(500).json({ error: 'Restore failed', details: err.message });
  }
});

router.delete('/backups/:name', async (req, res) => {
  try {
    const safe = path.basename(req.params.name);
    if (!safe.endsWith('.zip')) return res.status(400).json({ error: 'Not a backup file' });
    const full = path.join(system.BACKUP_DIR, safe);
    if (!(await fs.pathExists(full))) return res.status(404).json({ error: 'Backup not found' });
    await fs.remove(full);
    res.json({ message: 'Backup deleted', name: safe });
  } catch {
    res.status(500).json({ error: 'Could not delete backup' });
  }
});

// --- Notifications & scrobbling -------------------------------------------
// Same shape as /api/settings/notifications/test: per-target results, so the
// page can say which targets worked instead of always claiming success.
router.post('/notifications/test', async (req, res) => {
  const results = await notifications.send('Vault test notification', 'If you can read this, notifications from Vault are working.', 'info', { detailed: true });
  const targets = Object.keys(results || {});
  res.json({
    results,
    sent: targets.length,
    ok: targets.filter(key => results[key].ok).length,
    message: targets.length ? undefined : 'No notification targets are set up yet',
  });
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
  // Only the two settings the page edits. The body used to be spread into the
  // config verbatim, so any key could be written into config.json.
  const body = req.body || {};
  const next = { ...(config.metadata.providers[provider] || {}) };
  if (body.apiKey !== undefined) {
    if (provider !== 'tmdb') return res.status(400).json({ error: `${provider} doesn't use an API key` });
    const key = String(body.apiKey || '').trim();
    if (key.length > 200) return res.status(400).json({ error: 'That API key is too long' });
    if (key) next.apiKey = key;
    else delete next.apiKey;
  }
  next.enabled = body.enabled !== undefined ? !!body.enabled : true;
  config.metadata.providers[provider] = next;
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
  const { password, username, profileId } = req.body || {};
  // Choosing which profile's library (and age limits) Subsonic apps see.
  if (profileId !== undefined) {
    try {
      subsonic.setSubsonicProfile(profileId);
    } catch (err) {
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Profile not found', code: 'NOT_FOUND' });
      throw err;
    }
    if (password === undefined) return res.json({ message: 'Subsonic profile saved', ...subsonic.subsonicStatus() });
  }
  const result = subsonic.setSubsonicPassword(password, username);
  res.json({ message: password ? 'Subsonic password set' : 'Subsonic access disabled', ...result });
});

module.exports = router;
