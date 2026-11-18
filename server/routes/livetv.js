const express = require('express');
const router = express.Router();
const { requireAdmin, isAdminProfile } = require('../middleware/requireAdmin');
const { friendlyError } = require('../utils/safeFetch');
const livetv = require('../services/livetv');

router.get('/channels', async (req, res) => {
  const channels = await livetv.loadChannels();
  const withEpg = req.query.epg === 'true' && channels.length ? await livetv.getNowNext(channels.map(c => c.tvgId || c.id)) : {};
  res.json({
    channels: channels.map(c => ({
      ...c,
      now: withEpg[c.tvgId || c.id]?.now || null,
      next: withEpg[c.tvgId || c.id]?.next || null,
    })),
    total: channels.length,
  });
});

router.get('/epg', async (req, res) => {
  const epg = await livetv.getEpg(req.query.refresh === 'true');
  const channels = (req.query.channel || '').split(',').filter(Boolean);
  const programs = channels.length ? epg.programs.filter(p => channels.includes(p.channel)) : epg.programs;
  res.json({ source: epg.source, programs: programs.slice(0, 2000), fetchedAt: epg.fetchedAt });
});

router.get('/recordings', (req, res) => {
  res.json({ recordings: livetv.listRecordings() });
});

router.post('/recordings', async (req, res) => {
  try {
    const { channelUrl, title, durationSeconds, channelId, startAt } = req.body || {};
    if (!channelUrl) return res.status(400).json({ error: 'channelUrl required' });
    const recording = await livetv.record({ channelUrl, title, durationSeconds, channelId, startAt });
    res.json(recording);
  } catch (err) {
    res.status(500).json({ error: `Recording failed: ${err.message}` });
  }
});

router.post('/recordings/:id/stop', (req, res) => {
  const ok = livetv.stopRecording(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Recording not active' });
  res.json({ message: 'Recording stopped', id: req.params.id });
});

router.delete('/recordings/:id', async (req, res) => {
  const ok = await livetv.deleteRecording(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Recording not found' });
  res.json({ message: 'Recording deleted', id: req.params.id });
});

// Settings → Live TV (SR-5). Raw source URLs never leave the server; the
// browser gets `configured` + a redacted hint.
router.get('/settings', (req, res) => {
  res.json({ ...livetv.publicSettings(), canEdit: isAdminProfile(req.profileId) });
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    for (const key of ['enabled', 'hdhrDiscover', 'm3uUrl', 'epgUrl']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    res.json(await livetv.updateSettings(patch));
  } catch (err) {
    res.status(400).json({ error: err.message, fields: err.fields || {} });
  }
});

router.post('/test', requireAdmin, async (req, res) => {
  const { m3uUrl, epgUrl } = req.body || {};
  res.json(await livetv.testSources({ m3uUrl, epgUrl }));
});

router.post('/settings/adopt-guide', requireAdmin, async (req, res) => {
  try {
    res.json(await livetv.adoptPlaylistGuide({ m3uUrl: (req.body || {}).m3uUrl }));
  } catch (err) {
    res.status(400).json({ error: friendlyError(err), fields: err.fields || {} });
  }
});

module.exports = router;
