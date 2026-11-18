const express = require('express');
const router = express.Router();
const { requireAdmin, isAdminProfile } = require('../middleware/requireAdmin');
const { friendlyError } = require('../utils/safeFetch');
const livetv = require('../services/livetv');
const restream = require('../services/restream');
const { sendFileWithRange } = require('../utils/fileUtils');

/**
 * Channel list for the browser. Stream URLs are deliberately left out: IPTV
 * links embed the account's username and password, and browsers can't play
 * most of them directly anyway. Playback goes through POST /channels/:id/play.
 */
function publicChannel(c) {
  const { url, referrer, userAgent, ...rest } = c;
  return { ...rest, playable: /^https?:\/\//i.test(url || '') };
}

router.get('/channels', async (req, res) => {
  const channels = await livetv.loadChannels({ fresh: req.query.refresh === 'true' });
  const withEpg = req.query.epg === 'true' && channels.length ? await livetv.getNowNext(channels.map(c => c.tvgId || c.id)) : {};
  res.json({
    channels: channels.map(c => ({
      ...publicChannel(c),
      now: withEpg[c.tvgId || c.id]?.now || null,
      next: withEpg[c.tvgId || c.id]?.next || null,
    })),
    total: channels.length,
  });
});

// --- Playback through the server (services/restream.js) --------------------
function streamError(res, err) {
  if (err instanceof restream.StreamError) {
    return res.status(err.status || 502).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: restream.messageFor('FAILED'), code: 'FAILED' });
}

router.post('/channels/:id/play', async (req, res) => {
  const channel = await livetv.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'This channel is no longer in the channel list. Reload Live TV.', code: 'CHANNEL_NOT_FOUND' });
  try {
    const session = await restream.start(channel, { transcode: Boolean((req.body || {}).transcode) });
    res.json({ ...session, channel: { id: channel.id, name: channel.name, kind: channel.kind } });
  } catch (err) {
    streamError(res, err);
  }
});

router.get('/channels/:id/probe', async (req, res) => {
  const channel = await livetv.getChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found', code: 'CHANNEL_NOT_FOUND' });
  try {
    const url = await restream.assertPlayableUrl(channel.url);
    const source = await restream.probe(url, channel);
    res.json({ ok: true, kind: channel.kind, source: { ...source, summary: restream.describeSource(source) }, plan: restream.planFor(source) });
  } catch (err) {
    streamError(res, err);
  }
});

router.get('/stream/status', (req, res) => res.json(restream.status()));

router.get('/stream/:session/index.m3u8', async (req, res) => {
  const text = await restream.playlistFor(req.params.session, req.query.token);
  if (text == null) return res.status(404).json({ error: 'This stream has ended. Press play again.', code: 'SESSION_GONE' });
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.send(text);
});

router.get('/stream/:session/:file', (req, res) => {
  const file = restream.segmentFile(req.params.session, req.params.file);
  if (!file) return res.status(404).json({ error: 'Segment not found', code: 'SEGMENT_GONE' });
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  return sendFileWithRange(req, res, file);
});

router.delete('/stream/:session', (req, res) => {
  restream.release(req.params.session);
  res.json({ ok: true });
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
    if (!channelUrl && !channelId) return res.status(400).json({ error: 'channelId required' });
    // Recording an arbitrary URL makes the server fetch it: admins only.
    // Everyone else records channels from the configured list by id.
    if (channelUrl && !isAdminProfile(req.profileId)) {
      return res.status(403).json({ error: 'Only an admin can record a custom link', code: 'ADMIN_REQUIRED' });
    }
    const recording = await livetv.record({ channelUrl, title, durationSeconds, channelId, startAt });
    res.json({ ...recording, channelUrl: undefined });
  } catch (err) {
    if (err instanceof restream.StreamError) return res.status(400).json({ error: err.message, code: err.code });
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
  const { detectCapabilities } = require('../services/transcodePlan');
  res.json({
    ...livetv.publicSettings(),
    // Most IPTV streams need ffmpeg on the server to play in a browser;
    // Settings warns up front instead of every channel failing later.
    playback: { ffmpeg: Boolean(detectCapabilities().ffmpeg) },
    canEdit: isAdminProfile(req.profileId),
  });
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
