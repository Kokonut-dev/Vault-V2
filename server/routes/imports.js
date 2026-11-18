/**
 * /api/import — bring media in from elsewhere (admin only).
 *
 *   GET    /gdrive/config          { clientId, apiKeyConfigured }
 *   PUT    /gdrive/config          { clientId?, apiKey? } ('' removes)
 *   POST   /gdrive/inspect         { link, accessToken? } → what would import
 *   POST   /gdrive                 { link | files[], selection?, destination, accessToken? } → job
 *   GET    /gdrive/browse          ?folder=&q= + X-Google-Token (account mode)
 *   GET    /jobs                   recent import jobs (progress also over SSE
 *                                  `import:progress`)
 *   DELETE /jobs/:id               cancel
 */
const express = require('express');
const router = express.Router();
const { getConfig, saveConfig } = require('../config');
const gdrive = require('../services/gdrive');
const scanner = require('../services/scanner');

/** Saved keys never go back to the browser — only a recognisable hint. */
const keyHint = key => (key ? `${key.slice(0, 4)}…${key.slice(-4)}` : null);

const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

function tokenFrom(req) {
  const token = req.body?.accessToken || req.get('X-Google-Token') || '';
  if (!token) return undefined;
  if (!TOKEN_RE.test(token)) throw new gdrive.DriveError('That Google sign-in token looks malformed', 'BAD_TOKEN', 400);
  return token;
}

function fail(res, err) {
  const status = err instanceof gdrive.DriveError ? err.status : 500;
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: err.message, code: err.code || 'IMPORT_FAILED' });
}

router.get('/gdrive/config', (req, res) => {
  const cfg = getConfig().integrations?.googleDrive || {};
  res.json({ ...gdrive.publicConfig(), apiKeyHint: keyHint(cfg.apiKey) });
});

router.put('/gdrive/config', (req, res) => {
  const { clientId, apiKey } = req.body || {};
  const config = getConfig();
  config.integrations = { ...(config.integrations || {}) };
  const current = { ...(config.integrations.googleDrive || {}) };
  if (typeof clientId === 'string') {
    const id = clientId.trim();
    if (id && !/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
      return res.status(400).json({ error: 'A Google OAuth client ID ends in .apps.googleusercontent.com', code: 'INVALID_CLIENT_ID', field: 'clientId' });
    }
    current.clientId = id || null;
  }
  if (typeof apiKey === 'string') {
    const key = apiKey.trim();
    if (key && !/^[\w-]{30,60}$/.test(key)) {
      return res.status(400).json({ error: 'That doesn’t look like a Google API key (it usually starts with AIza)', code: 'INVALID_API_KEY', field: 'apiKey' });
    }
    current.apiKey = key || null;
  }
  config.integrations.googleDrive = current;
  saveConfig(config);
  res.json({ ...gdrive.publicConfig(), apiKeyHint: keyHint(current.apiKey) });
});

router.post('/gdrive/inspect', async (req, res) => {
  try {
    res.json(await gdrive.inspect(req.body?.link, { accessToken: tokenFrom(req) }));
  } catch (err) { fail(res, err); }
});

router.post('/gdrive', async (req, res) => {
  try {
    const { link, files, selection, destination } = req.body || {};
    for (const list of [selection, files]) {
      if (list != null && (!Array.isArray(list) || list.some(s => typeof s !== 'string'))) {
        return res.status(400).json({ error: 'selection/files must be lists of file ids', code: 'INVALID_SELECTION' });
      }
    }
    const job = await gdrive.startImport({
      link,
      files: files || null,
      selection: selection || null,
      destination: destination || 'auto',
      accessToken: tokenFrom(req),
      scanFile: scanner.scanFile,
      profileId: req.profileId,
    });
    res.status(202).json(job);
  } catch (err) { fail(res, err); }
});

router.get('/gdrive/browse', async (req, res) => {
  try {
    res.json(await gdrive.browse({ accessToken: tokenFrom(req), folderId: String(req.query.folder || 'root'), query: String(req.query.q || '') }));
  } catch (err) { fail(res, err); }
});

router.get('/jobs', (req, res) => res.json({ jobs: gdrive.listJobs() }));

router.get('/jobs/:id', (req, res) => {
  const job = gdrive.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such import', code: 'NOT_FOUND' });
  res.json(job);
});

router.delete('/jobs/:id', (req, res) => {
  if (!gdrive.cancelImport(req.params.id)) return res.status(404).json({ error: 'That import isn’t running', code: 'NOT_RUNNING' });
  res.json({ cancelled: true });
});

module.exports = router;
