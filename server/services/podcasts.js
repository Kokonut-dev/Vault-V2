/**
 * Podcast support: RSS/Atom feed parsing (no dependencies) and episode
 * downloads into the podcast library folder, where the scanner picks them up.
 */
const fs = require('fs-extra');
const path = require('path');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const extras = require('./extras');
const events = require('./events');
// Feed and enclosure URLs come from users and from third-party XML, so they
// go through the SSRF guard (no cloud-metadata / link-local targets, every
// redirect re-checked) instead of a bare fetch().
const { safeFetchText, safeFetchStream, friendlyError } = require('../utils/safeFetch');

const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)(\?|$)/i;

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function pickTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : null;
}

function pickAttr(xml, tag, attr) {
  const match = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']+)["']`, 'i'));
  return match ? decodeEntities(match[1]) : null;
}

/** Parse an RSS 2.0 or Atom feed into a normalised shape. */
function parseFeed(xml) {
  const channelMatch = xml.match(/<channel[^>]*>([\s\S]*?)<\/channel>/i);
  const channel = channelMatch ? channelMatch[1] : xml;
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 800));

  const feed = {
    title: pickTag(channel, 'title') || pickTag(xml, 'title') || 'Untitled feed',
    description: decodeEntities(pickTag(channel, 'description') || pickTag(xml, 'subtitle') || ''),
    link: pickTag(channel, 'link') || pickAttr(xml, 'link', 'href'),
    artwork: pickAttr(channel, 'itunes:image', 'href') ||
      pickAttr(channel, 'image', 'href') ||
      pickTag(channel, 'url') || null,
  };

  const itemTag = isAtom ? 'entry' : 'item';
  const items = [];
  const re = new RegExp(`<${itemTag}[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, 'gi');
  let match;
  while ((match = re.exec(xml))) {
    const body = match[1];
    const enclosureUrl = pickAttr(body, 'enclosure', 'url') ||
      pickAttr(body, 'media:content', 'url') ||
      (isAtom ? pickAttr(body, 'link', 'href') : null) ||
      pickTag(body, 'guid');
    if (!enclosureUrl || !/^https?:/i.test(enclosureUrl)) continue;
    if (!AUDIO_EXT.test(enclosureUrl) && !pickAttr(body, 'enclosure', 'type')?.includes('audio')) continue;

    items.push({
      guid: pickTag(body, 'guid') || pickTag(body, 'id') || enclosureUrl,
      title: pickTag(body, 'title') || 'Episode',
      description: decodeEntities(pickTag(body, 'description') || pickTag(body, 'summary') || '').slice(0, 2000),
      published: pickTag(body, 'pubDate') || pickTag(body, 'published') || pickTag(body, 'updated') || null,
      duration: pickTag(body, 'itunes:duration') || null,
      url: enclosureUrl,
      size: Number(pickAttr(body, 'enclosure', 'length')) || 0,
      type: pickAttr(body, 'enclosure', 'type') || 'audio/mpeg',
      artwork: pickAttr(body, 'itunes:image', 'href') || null,
    });
  }
  return { feed, items };
}

async function fetchFeed(url) {
  let xml;
  try {
    ({ text: xml } = await safeFetchText(url, {
      maxBytes: 15 * 1024 * 1024,
      timeoutMs: 20000,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    }));
  } catch (err) {
    throw new Error(friendlyError(err));
  }
  return parseFeed(xml);
}

/** Keep per-episode state (download, played) across feed refreshes. */
function mergeEpisodes(previous = [], fresh = []) {
  const byGuid = new Map(previous.map(item => [item.guid, item]));
  return fresh.map(item => {
    const old = byGuid.get(item.guid);
    if (!old) return item;
    const kept = {};
    for (const key of ['localPath', 'downloadedAt', 'played', 'position']) {
      if (old[key] !== undefined) kept[key] = old[key];
    }
    return { ...item, ...kept };
  });
}

/** Add (or refresh) a feed and cache its episode list. */
async function subscribe(url, options = {}) {
  const parsed = await fetchFeed(url);
  const maxEpisodes = getConfig().podcasts?.maxEpisodesPerFeed || 200;
  const entry = extras.addFeed({
    url,
    title: parsed.feed.title,
    description: parsed.feed.description,
    artwork: parsed.feed.artwork,
    autoDownload: options.autoDownload || getConfig().podcasts?.autoDownload || false,
    items: parsed.items.slice(0, maxEpisodes),
  });
  // Re-subscribing to a known feed must keep its downloaded episodes.
  extras.updateFeed(entry.id, { items: mergeEpisodes(entry.items, parsed.items).slice(0, maxEpisodes), lastFetchedAt: new Date().toISOString() });
  events.broadcast('podcast:changed', { id: entry.id, action: 'subscribe', title: entry.title });
  return entry;
}

async function refreshFeed(id) {
  const feed = extras.getFeeds().find(f => f.id === id);
  if (!feed) return null;
  const parsed = await fetchFeed(feed.url);
  const maxEpisodes = getConfig().podcasts?.maxEpisodesPerFeed || 200;
  const updated = extras.updateFeed(id, {
    title: parsed.feed.title || feed.title,
    description: parsed.feed.description || feed.description,
    artwork: parsed.feed.artwork || feed.artwork,
    // A refresh used to replace the list and forget which episodes were
    // downloaded (localPath) — they showed as not saved afterwards.
    items: mergeEpisodes(feed.items, parsed.items).slice(0, maxEpisodes),
    lastFetchedAt: new Date().toISOString(),
  });
  events.broadcast('podcast:changed', { id, action: 'refresh', episodes: parsed.items.length });

  // Auto-download (the toggle was saved but never acted on): fetch episodes
  // that are new since the last refresh, newest first, at most 3 per run so
  // switching it on doesn't pull a whole back-catalogue.
  if (feed.autoDownload) {
    const known = new Set((feed.items || []).map(item => item.guid));
    const fresh = parsed.items.filter(item => !known.has(item.guid)).slice(0, 3);
    (async () => {
      for (const episode of fresh) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await downloadEpisode(id, episode.guid);
        } catch (err) {
          logger.warn(`[Podcast] auto-download failed for ${episode.title}: ${err.message}`);
        }
      }
    })();
  }
  return updated;
}

async function refreshAll() {
  const results = [];
  for (const feed of extras.getFeeds()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push({ id: feed.id, ok: true, ...(await refreshFeed(feed.id) ? {} : {}) });
    } catch (err) {
      logger.warn(`[Podcast] refresh failed for ${feed.title}: ${err.message}`);
      results.push({ id: feed.id, ok: false, error: err.message });
    }
  }
  return results;
}

/** Download one episode into the podcast library folder. */
async function downloadEpisode(feedId, guid) {
  const feed = extras.getFeeds().find(f => f.id === feedId);
  if (!feed) throw new Error('Feed not found');
  const episode = (feed.items || []).find(i => i.guid === guid);
  if (!episode) throw new Error('Episode not found');

  const targetDir = path.join(getConfig().media.paths.podcasts || path.join(__dirname, '../media/podcasts'), safeName(feed.title));
  await fs.ensureDir(targetDir);

  const fileName = episodeFileName(episode);
  const targetPath = path.join(targetDir, fileName);
  if (await fs.pathExists(targetPath)) {
    return { path: targetPath, skipped: true };
  }

  const jobId = `podcast_${feedId}_${Date.now()}`;
  events.jobStart(jobId, 'podcast-download', `Downloading ${episode.title}`, episode.size || 0);

  const tmp = `${targetPath}.part`;
  const maxBytes = (getConfig().media?.maxUploadSizeMB || 10240) * 1024 * 1024;
  let stream = null;
  let res = null;

  try {
    try {
      ({ res } = await safeFetchStream(episode.url, { accept: 'audio/*, */*' }));
    } catch (err) {
      throw new Error(`Download failed: ${friendlyError(err)}`);
    }
    const total = Number(res.headers['content-length']) || episode.size || 0;
    if (total > maxBytes) throw new Error('Download failed: the episode is larger than the upload size limit');
    let received = 0;
    stream = fs.createWriteStream(tmp);
    for await (const chunk of res) {
      received += chunk.length;
      if (received > maxBytes) throw new Error('Download failed: the episode is larger than the upload size limit');
      if (!stream.write(chunk)) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => stream.once('drain', resolve));
      }
      events.jobProgress(jobId, received, total);
    }
    await new Promise(resolve => stream.end(resolve));
    await fs.move(tmp, targetPath, { overwrite: true });

    const items = feed.items.map(i => (i.guid === guid ? { ...i, downloadedAt: new Date().toISOString(), localPath: targetPath } : i));
    extras.updateFeed(feedId, { items });

    events.jobFinish(jobId, 'done', { path: targetPath });
    const { scanFile } = require('./scanner');
    const scanned = await scanFile(targetPath).catch(() => null);
    if (scanned?.id) applyFeedMetadata(scanned, feed, episode);
    return { path: targetPath };
  } catch (err) {
    res?.destroy?.();
    stream?.destroy();
    await fs.remove(tmp).catch(() => {});
    events.jobFinish(jobId, 'error', { error: err.message });
    throw err;
  }
}

// Many enclosures carry no ID3 tags, which left downloaded episodes in the
// library as "2026-11-09 - Episode One_ Boats" by "Unknown Artist". The feed
// knows better, so fill in whatever the tags did not provide.
function applyFeedMetadata(item, feed, episode) {
  const libraryService = require('./library');
  const base = path.basename(item.path || '', path.extname(item.path || ''));
  const blank = v => !v || /^unknown( artist| album)?$/i.test(String(v)) || v === base;
  const updates = { podcastFeedId: feed.id, episodeGuid: episode.guid };
  if (blank(item.title) && episode.title) updates.title = episode.title;
  if (blank(item.album) && feed.title) updates.album = feed.title;
  if (blank(item.artist) && feed.title) updates.artist = feed.author || feed.title;
  if (episode.published && !item.published) updates.published = episode.published;
  if (episode.description && !item.description) updates.description = episode.description;
  try { libraryService.updateItem(item.id, updates); } catch (err) { logger.warn(`[Podcast] metadata update failed: ${err.message}`); }
}

// "2026-11-09 - Episode One_ Boats.mp3". The extension must keep its dot or
// the scanner ignores the file, and RSS pubDates ("Mon, 09 Nov 2026 ...")
// are turned into a sortable ISO date instead of being cut at 10 characters.
function episodeFileName(episode) {
  let pathname = '';
  try { pathname = new URL(episode.url).pathname; } catch { pathname = String(episode.url || ''); }
  const m = pathname.match(/\.(mp3|m4a|m4b|aac|ogg|oga|opus|flac|wav)$/i);
  const ext = m ? `.${m[1].toLowerCase()}` : '.mp3';
  const ts = Date.parse(episode.published || '');
  const date = Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : 'episode';
  return `${date} - ${safeName(episode.title || episode.guid || 'Untitled')}${ext}`;
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 120).trim();
}

module.exports = { parseFeed, fetchFeed, mergeEpisodes, subscribe, refreshFeed, refreshAll, downloadEpisode, safeName, episodeFileName };
