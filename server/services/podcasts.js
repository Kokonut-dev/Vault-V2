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

const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|flac|wav)(\?|$)/i;

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
  const res = await fetch(url, { headers: { 'User-Agent': 'Vault/3.0 (podcast fetcher)', Accept: 'application/rss+xml, application/xml, text/xml, */*' } });
  if (!res.ok) throw new Error(`Feed responded ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml);
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
  extras.updateFeed(entry.id, { items: parsed.items.slice(0, maxEpisodes) });
  events.broadcast('podcast:changed', { id: entry.id, action: 'subscribe', title: entry.title });
  return entry;
}

async function refreshFeed(id) {
  const feed = extras.getFeeds().find(f => f.id === id);
  if (!feed) return null;
  const parsed = await fetchFeed(feed.url);
  const updated = extras.updateFeed(id, {
    title: parsed.feed.title || feed.title,
    description: parsed.feed.description || feed.description,
    artwork: parsed.feed.artwork || feed.artwork,
    items: parsed.items,
    lastFetchedAt: new Date().toISOString(),
  });
  events.broadcast('podcast:changed', { id, action: 'refresh', episodes: parsed.items.length });
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

  const ext = (episode.url.match(AUDIO_EXT) || [, '.mp3'])[1].replace('?', '');
  const fileName = `${String(episode.published || '').slice(0, 10) || 'episode'} - ${safeName(episode.title)}${ext}`;
  const targetPath = path.join(targetDir, fileName);
  if (await fs.pathExists(targetPath)) {
    return { path: targetPath, skipped: true };
  }

  const jobId = `podcast_${feedId}_${Date.now()}`;
  events.jobStart(jobId, 'podcast-download', `Downloading ${episode.title}`, episode.size || 0);

  const res = await fetch(episode.url, { headers: { 'User-Agent': 'Vault/3.0 (podcast downloader)' } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const tmp = `${targetPath}.part`;
  const total = Number(res.headers.get('content-length')) || episode.size || 0;
  let received = 0;
  const stream = fs.createWriteStream(tmp);
  const reader = res.body.getReader();

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!stream.write(Buffer.from(value))) {
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
    await scanFile(targetPath).catch(() => {});
    return { path: targetPath };
  } catch (err) {
    stream.destroy();
    await fs.remove(tmp).catch(() => {});
    events.jobFinish(jobId, 'error', { error: err.message });
    throw err;
  }
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 120).trim();
}

module.exports = { parseFeed, fetchFeed, subscribe, refreshFeed, refreshAll, downloadEpisode, safeName };
