/**
 * /api/transfer — move Vault to another computer.
 *
 *   GET  /                    status of the running export/import + defaults
 *   GET  /summary?media=1     what a package would contain and how big it is
 *   POST /export-link         { media } → a download link (valid 2 hours)
 *   GET  /download/:ticket    the .zip itself, streamed (no auth header needed,
 *                             so it also works opened on another device)
 *   POST /export-folder       { dir, media } write the package as a folder
 *                             (e.g. straight onto a USB drive)
 *   POST /inspect             { source } read a package's manifest
 *   POST /import              { source, mediaDir, copyMedia } import from a
 *                             .zip or folder on this computer
 *   POST /import/upload       raw .zip body (?mediaDir=) — import a package
 *                             uploaded from the browser
 *   POST /cancel              stop the running export/import
 *
 * Export is admin-only. Import is admin-only too — except on a brand-new
 * server that hasn't been set up yet, where the setup wizard offers
 * "Import from another Vault" (the same trust level as /api/setup/complete).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const transfer = require('../services/transfer');
const zip = require('../utils/zipStream');
const lifecycle = require('../services/lifecycle');
const { authMiddleware } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/requireAdmin');
const { CONFIG_PATH } = require('../config');
const logger = require('../utils/logger');

const router = express.Router();
const TICKET_TTL_MS = 2 * 60 * 60 * 1000;
const tickets = new Map();
let job = null;
let controller = null;

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------
function needsSetup() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return !cfg?.auth?.passwordHash;
  } catch {
    return true;
  }
}

const admin = [authMiddleware, requireAdmin];
const access = { needsSetup };

function adminOrSetup(req, res, next) {
  if (access.needsSetup()) {
    // Importing a package onto a brand-new server sets its account, so the
    // same rule as the setup wizard applies: this computer, or the setup code.
    if (!require('../services/setupGuard').allow(req, res)) return;
    req.setupMode = true;
    return next();
  }
  return authMiddleware(req, res, () => requireAdmin(req, res, next));
}

// ---------------------------------------------------------------------------
// Background job (one at a time)
// ---------------------------------------------------------------------------
function events() {
  try { return require('../services/events'); } catch { return null; }
}

function publicJob() {
  if (!job) return null;
  const { kind, status, phase, bytesDone, bytesTotal, filesDone, filesTotal, current, startedAt, finishedAt, error, code, result, restarting } = job;
  return { kind, status, phase, bytesDone, bytesTotal, filesDone, filesTotal, current, startedAt, finishedAt, error, code, result, restarting };
}

function busy(res) {
  if (job?.status === 'running') {
    res.status(409).json({ error: `A${job.kind === 'import' ? 'n import' : 'n export'} is already running`, code: 'BUSY', job: publicJob() });
    return true;
  }
  return false;
}

function runJob(kind, label, work, { onDone } = {}) {
  controller = new AbortController();
  const id = `transfer_${Date.now()}`;
  job = { id, kind, status: 'running', phase: 'prepare', bytesDone: 0, bytesTotal: 0, filesDone: 0, filesTotal: 0, current: null, startedAt: new Date().toISOString() };
  events()?.jobStart(id, `transfer-${kind}`, label, 0);
  const progress = (p) => {
    Object.assign(job, p);
    events()?.jobProgress(id, Math.round((p.bytesDone || 0) / 1048576), Math.round((p.bytesTotal || 0) / 1048576));
  };
  const current = job;
  Promise.resolve()
    .then(() => work({ onProgress: progress, signal: controller.signal }))
    .then((result) => {
      Object.assign(current, { status: 'done', phase: 'done', result, finishedAt: new Date().toISOString() });
      events()?.jobFinish(id, 'done', {});
      onDone?.(result, current);
    })
    .catch((err) => {
      const cancelled = err.code === 'CANCELLED' || err.name === 'AbortError';
      Object.assign(current, { status: cancelled ? 'cancelled' : 'error', error: cancelled ? 'Cancelled' : err.message, code: err.code || null, finishedAt: new Date().toISOString() });
      events()?.jobFinish(id, cancelled ? 'cancelled' : 'error', { error: err.message });
      if (!cancelled) logger.error(`[Transfer] ${kind} failed: ${err.message}`);
    });
  return current;
}

/** Write everything the running server holds in memory to disk first. */
async function flushAll() {
  const flushers = [
    () => require('../services/library').flush(),
    () => require('../services/library').flushScoped(),
    () => require('../services/extras').flush(),
    () => require('../services/profiles').flush(),
    () => require('../services/sessions').flush(),
    () => require('../services/notifications').flush(),
    () => require('../services/livetv').flush(),
  ];
  await Promise.all(flushers.map(fn => Promise.resolve().then(fn).catch(() => {})));
}

function pauseWatcher() {
  try { require('../services/scanner').stopWatcher(); } catch { /* not loaded */ }
}

function resumeWatcher() {
  try { require('../services/scanner').startWatcher(); } catch { /* not loaded */ }
}

/** After an import: restart (under the launcher) so the new data is loaded. */
function afterImport(result, current) {
  if (lifecycle.supervised()) {
    current.restarting = true;
    logger.info('[Transfer] Import ready — restarting to load it');
    lifecycle.exitSoon(lifecycle.RESTART_CODE, { delayMs: 2500 });
  } else {
    logger.info('[Transfer] Import ready — restart Vault (Ctrl+C, then npm start) to load it');
    resumeWatcher();
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
router.get('/', adminOrSetup, (req, res) => {
  res.json({
    job: publicJob(),
    pendingImport: transfer.hasPendingImport(),
    supervised: lifecycle.supervised(),
    setupMode: Boolean(req.setupMode),
    defaults: { mediaDir: path.join(transfer.SERVER_DIR, 'media') },
    platform: process.platform,
    hostname: require('os').hostname(),
  });
});

router.get('/summary', admin, async (req, res) => {
  try {
    await flushAll();
    res.json(await transfer.summarize({ includeMedia: req.query.media !== '0' }));
  } catch (err) {
    res.status(500).json({ error: err.message, code: 'SUMMARY_FAILED' });
  }
});

router.post('/export-link', admin, (req, res) => {
  const now = Date.now();
  for (const [key, t] of tickets) if (t.expires < now) tickets.delete(key);
  const ticket = crypto.randomBytes(24).toString('base64url');
  const media = req.body?.media !== false;
  tickets.set(ticket, { media, expires: now + TICKET_TTL_MS });
  res.json({
    url: `/api/transfer/download/${ticket}`,
    expiresAt: new Date(now + TICKET_TTL_MS).toISOString(),
    fileName: `${transfer.packageName()}${media ? '' : ' (settings only)'}.zip`,
  });
});

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

router.get('/download/:ticket', async (req, res) => {
  const t = tickets.get(req.params.ticket);
  if (!t || t.expires < Date.now() || t.used) {
    res.status(410).type('text/plain').send('This download link has expired or was already used. Create a new one in Vault: Settings → Move to another server.');
    return;
  }
  // The package holds your library and settings, so a link works for one
  // download only (HEAD checks from download managers don't use it up).
  if (req.method !== 'HEAD') {
    t.used = true;
    logger.info(`[Transfer] Download link used from ${req.ip}`);
  }
  let plan;
  try {
    await flushAll();
    const { entries } = await transfer.planExport({ includeMedia: t.media });
    plan = zip.layout(entries);
  } catch (err) {
    t.used = false; // nothing was sent — the link can be tried again
    logger.error(`[Transfer] Couldn't prepare the download: ${err.message}`);
    res.status(500).type('text/plain').send(`Couldn't prepare the download: ${err.message}`);
    return;
  }
  const fileName = `${transfer.packageName()}${t.media ? '' : ' (settings only)'}.zip`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': String(plan.totalBytes),
    'Content-Disposition': contentDisposition(fileName),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  });
  if (req.method === 'HEAD') return res.end();
  logger.info(`[Transfer] Download started: ${plan.entries.length} files, ${transfer.formatBytes(plan.totalBytes)}`);
  try {
    await zip.writeZip(plan, res);
    res.end();
    logger.info('[Transfer] Download finished');
  } catch (err) {
    logger.warn(`[Transfer] Download stopped: ${err.message}`);
    res.destroy();
  }
});

router.post('/export-folder', admin, async (req, res) => {
  if (busy(res)) return;
  const dir = String(req.body?.dir || '').trim();
  const includeMedia = req.body?.media !== false;
  if (!dir || !path.isAbsolute(dir)) return res.status(400).json({ error: 'Enter a full folder path, e.g. /Volumes/MyDrive', code: 'INVALID' });
  if (!fs.existsSync(dir)) return res.status(400).json({ error: `The folder ${dir} doesn’t exist (is the drive plugged in?)`, code: 'NOT_FOUND' });
  await flushAll();
  runJob('export', 'Saving a transfer copy', ({ onProgress, signal }) => transfer.exportToFolder({ dir, includeMedia, onProgress, signal }));
  res.status(202).json({ job: publicJob() });
});

router.post('/inspect', adminOrSetup, async (req, res) => {
  try {
    res.json(await transfer.inspect(String(req.body?.source || '').trim()));
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code || 'INVALID' });
  }
});

function startImport(source, { mediaDir, copyMedia, cleanup }) {
  pauseWatcher();
  return runJob('import', 'Importing from another Vault', async ({ onProgress, signal }) => {
    try {
      return await transfer.importTransfer({ source, mediaDir, copyMedia, onProgress, signal });
    } finally {
      if (cleanup) fs.promises.rm(cleanup, { force: true }).catch(() => {});
    }
  }, { onDone: afterImport });
}

router.post('/import', adminOrSetup, async (req, res) => {
  if (busy(res)) return;
  const source = String(req.body?.source || '').trim();
  const mediaDir = String(req.body?.mediaDir || '').trim() || path.join(transfer.SERVER_DIR, 'media');
  if (!path.isAbsolute(mediaDir)) return res.status(400).json({ error: 'Enter a full folder path for your media', code: 'INVALID', field: 'mediaDir' });
  try {
    await transfer.inspect(source);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code || 'INVALID', field: 'source' });
  }
  startImport(source, { mediaDir, copyMedia: req.body?.copyMedia !== false });
  res.status(202).json({ job: publicJob() });
});

router.post('/import/upload', adminOrSetup, async (req, res) => {
  if (busy(res)) return;
  const mediaDir = String(req.query.mediaDir || '').trim() || path.join(transfer.SERVER_DIR, 'media');
  if (!path.isAbsolute(mediaDir)) return res.status(400).json({ error: 'Enter a full folder path for your media', code: 'INVALID', field: 'mediaDir' });
  const length = Number(req.headers['content-length'] || 0);
  try {
    await fs.promises.mkdir(mediaDir, { recursive: true });
  } catch (err) {
    return res.status(400).json({ error: `Can’t use ${mediaDir}: ${err.message}`, code: 'INVALID', field: 'mediaDir' });
  }
  const free = await transfer.freeBytes(mediaDir);
  // The upload and the unpacked media both need room until the import ends.
  if (free !== null && length && free < length * 2) {
    return res.status(507).json({ error: `Not enough space in ${mediaDir}: importing this ${transfer.formatBytes(length)} package needs about ${transfer.formatBytes(length * 2)} free, and ${transfer.formatBytes(free)} is free. Copy the .zip to this computer and import it by path, or pick a bigger drive.`, code: 'NO_SPACE' });
  }
  const temp = path.join(mediaDir, `.vault-transfer-upload-${Date.now()}.zip`);
  job = { kind: 'import', status: 'running', phase: 'upload', bytesDone: 0, bytesTotal: length, filesDone: 0, filesTotal: 0, startedAt: new Date().toISOString() };
  const uploading = job;
  controller = new AbortController();
  controller.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })));
  req.on('data', (chunk) => { uploading.bytesDone += chunk.length; });
  try {
    await pipeline(req, fs.createWriteStream(temp));
    await transfer.inspect(temp);
  } catch (err) {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    const cancelled = err.code === 'CANCELLED' || req.destroyed;
    Object.assign(uploading, { status: cancelled ? 'cancelled' : 'error', error: cancelled ? 'Cancelled' : err.message, finishedAt: new Date().toISOString() });
    if (!res.headersSent) res.status(400).json({ error: err.message, code: err.code || 'UPLOAD_FAILED' });
    return;
  }
  startImport(temp, { mediaDir, copyMedia: true, cleanup: temp });
  res.status(202).json({ job: publicJob() });
});

router.post('/cancel', adminOrSetup, (req, res) => {
  if (job?.status !== 'running' || !controller) return res.json({ job: publicJob() });
  controller.abort();
  resumeWatcher();
  res.json({ job: publicJob(), cancelling: true });
});

module.exports = router;
module.exports._internals = { tickets, access };
