/**
 * /api/torrents — mounted behind authMiddleware + requireAdmin.
 *
 *   GET    /                status, settings, VPN guard, job list
 *   GET    /interfaces      network interfaces (for the VPN guard picker)
 *   PUT    /settings        { enabled, acknowledged, maxActive, … }
 *   POST   /                { magnet, type } JSON, or multipart field "torrent"
 *   POST   /:id/start       { files: [index…], type }
 *   POST   /:id/pause       pause (or, when sharing, stop sharing)
 *   POST   /:id/resume
 *   DELETE /:id             remove from the list (library files stay)
 */
const express = require('express');
const multer = require('multer');
const torrent = require('../services/torrent');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 4 },
});

function send(res, err) {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'That .torrent file is too big' : err.message;
  res.status(status).json({ error: message, code: err.code || 'ERROR', fields: err.fields || {} });
}

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    send(res, err);
  }
};

router.get('/', wrap(async (_req, res) => {
  res.json(await torrent.status());
}));

router.get('/interfaces', wrap(async (_req, res) => {
  res.json({ interfaces: torrent.listInterfaces() });
}));

router.put('/settings', wrap(async (req, res) => {
  const allowed = ['enabled', 'acknowledged', 'maxActive', 'downloadLimitKBs', 'uploadLimitKBs', 'seedRatio', 'requireInterface', 'upnp', 'dht'];
  const patch = {};
  for (const key of allowed) if (req.body?.[key] !== undefined) patch[key] = req.body[key];
  torrent.updateSettings(patch);
  res.json(await torrent.status());
}));

router.post('/', (req, res, next) => {
  if (req.is('multipart/form-data')) {
    upload.single('torrent')(req, res, (err) => (err ? send(res, err) : next()));
  } else next();
}, wrap(async (req, res) => {
  const body = req.body || {};
  const job = await torrent.add({
    magnet: req.file ? undefined : body.magnet,
    torrentFile: req.file?.buffer,
    type: body.type || 'auto',
    profileId: req.profileId || null,
  });
  res.status(201).json({ job });
}));

router.post('/:id/start', wrap(async (req, res) => {
  const { files, type } = req.body || {};
  res.json({ job: await torrent.start(req.params.id, { files, type }) });
}));

router.post('/:id/pause', wrap(async (req, res) => {
  res.json({ job: await torrent.pause(req.params.id) });
}));

router.post('/:id/resume', wrap(async (req, res) => {
  res.json({ job: await torrent.resume(req.params.id) });
}));

router.delete('/:id', wrap(async (req, res) => {
  res.json(await torrent.remove(req.params.id));
}));

module.exports = router;
