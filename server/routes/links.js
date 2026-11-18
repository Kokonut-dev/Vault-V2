/**
 * /api/links — "Paste a link" (SETTINGS_REVAMP_PLAN.md SR-6).
 *
 *   POST /inspect          { url }        → what the link is + what Vault can do with it
 *   POST /import-playlist  { url, name }  → fetch an .m3u/.m3u8 and match it against the library
 *
 * Both make the server fetch a user-supplied URL, so they are admin-only and
 * go through utils/safeFetch (SSRF guards, size + time caps).
 */
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/requireAdmin');
const { safeFetchText, friendlyError } = require('../utils/safeFetch');
const links = require('../services/links');
const libraryService = require('../services/library');
const events = require('../services/events');
const { sanitizeString } = require('../utils/validators');

const INSPECT_BYTES = 768 * 1024;
const PLAYLIST_BYTES = 8 * 1024 * 1024;

router.use(requireAdmin);

router.post('/inspect', async (req, res) => {
  const url = String((req.body || {}).url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a link first', field: 'url' });
  try {
    const fetched = await safeFetchText(url, { maxBytes: INSPECT_BYTES, truncate: true, timeoutMs: 15000 });
    const result = links.classify(fetched.text, { contentType: fetched.contentType, truncated: fetched.truncated });
    if (result.summary && result.summary.epgUrl) {
      // Never reflect embedded credentials back to the browser.
      result.summary.epgUrl = links.redactUrl(result.summary.epgUrl);
      result.summary.hasEpgUrl = true;
    }
    res.json({ ...result, displayUrl: links.redactUrl(url), redirected: fetched.finalUrl !== new URL(url).toString() });
  } catch (err) {
    res.status(400).json({ error: friendlyError(err), field: 'url', code: err.code || 'FETCH_FAILED' });
  }
});

router.post('/import-playlist', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Paste a playlist link first', field: 'url' });
  let fetched;
  try {
    fetched = await safeFetchText(String(url).trim(), { maxBytes: PLAYLIST_BYTES, timeoutMs: 20000 });
  } catch (err) {
    return res.status(400).json({ error: friendlyError(err), field: 'url', code: err.code || 'FETCH_FAILED' });
  }
  const kind = links.classify(fetched.text, { contentType: fetched.contentType });
  if (kind.kind !== 'm3u-audio' && kind.kind !== 'm3u-live') {
    return res.status(400).json({ error: kind.hint || `That link is a ${kind.label.toLowerCase()}, not a playlist`, field: 'url', kind: kind.kind });
  }
  try {
    const { matched, considered, missed, remote } = links.matchEntries(fetched.text.split(/\r?\n/), libraryService.getAll());
    const fallbackName = (() => {
      try {
        const base = decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/\.(m3u8?)$/i, '');
        return base || 'Imported playlist';
      } catch { return 'Imported playlist'; }
    })();
    const cleanName = sanitizeString(String(name || '').trim() || fallbackName, 100) || 'Imported playlist';
    const playlist = libraryService.forProfile(req.profileId || 'default').createPlaylist({ name: cleanName, items: matched });
    events.broadcast('playlist:changed', { id: playlist.id, action: 'create' });
    res.json({ playlist: { id: playlist.id, name: playlist.name }, matched: matched.length, considered, missed, remote });
  } catch (err) {
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
