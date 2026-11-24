/**
 * Podcasts — subscriptions, episodes, download-for-offline, resume.
 * Server: /api/podcasts (RSS/Atom parse, per-episode download + scan).
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime, formatRelativeTime } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { promptModal } from '../components/modal.js';

/** itunes:duration is "1:02:03", "62:03" or plain seconds. */
export function parseEpisodeDuration(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parts = String(value).trim().split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * Player item for a feed episode. Downloaded episodes play the library copy
 * (seekable, convertible); others stream from the podcast host. The old
 * payload had no stream URL and no id, so playback went to
 * /api/transcode/undefined and always failed.
 */
export function episodeToPlayable(episode, feed = {}) {
  const base = {
    type: 'podcast',
    title: episode.title || 'Episode',
    artist: feed.title || '',
    album: feed.title || '',
    artwork: episode.artwork || feed.artwork || null,
    duration: parseEpisodeDuration(episode.duration),
    guid: episode.guid,
  };
  if (episode.downloaded && episode.localItemId) return { ...base, id: episode.localItemId };
  return { ...base, id: `podcast:${episode.guid}`, streamUrl: episode.url };
}

export async function renderPodcasts(container, params = {}) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('rss', { size: 26 })}<span>Podcasts</span></h1>
      <p class="page-subtitle">Subscribe by URL; new episodes can download automatically</p>
      <div class="page-actions" style="margin-top:10px;display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="feed-add">${icon('plus', { size: 14 })}<span>Add feed</span></button>
        <button class="btn btn-secondary btn-sm" id="feeds-refresh">${icon('refresh', { size: 14 })}<span>Refresh all</span></button>
      </div>
    </div>
    <div id="podcasts-body"></div>
  `;

  const body = container.querySelector('#podcasts-body');
  let feeds = [];
  let activeFeed = params.id || null;

  async function load() {
    try {
      const data = await api.getFeeds();
      feeds = data.feeds || [];
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }
    paint();
  }

  function paint() {
    if (!feeds.length) {
      body.innerHTML = `<div class="empty-state">${icon('rss', { size: 30 })}
        <div class="empty-state-title">No subscriptions yet</div>
        <div class="empty-state-message">Paste an RSS feed URL — Vault keeps the episodes, artwork and playback position.</div></div>`;
      return;
    }

    if (!activeFeed) activeFeed = feeds[0].id;

    body.innerHTML = `
      <div class="feed-list" style="display:flex;gap:8px;overflow-x:auto;margin-bottom:16px">
        ${feeds.map(feed => `<button type="button" class="btn ${feed.id === activeFeed ? 'btn-primary' : 'btn-secondary'} btn-sm" data-feed="${feed.id}">
          ${escapeHtml(feed.title || feed.url)}
        </button>`).join('')}
      </div>
      <div id="feed-detail"></div>
    `;

    body.querySelectorAll('[data-feed]').forEach(button => {
      button.addEventListener('click', () => {
        activeFeed = button.dataset.feed;
        paint();
      });
    });

    const feed = feeds.find(entry => entry.id === activeFeed);
    const detail = body.querySelector('#feed-detail');
    const episodes = feed?.items || [];

    detail.innerHTML = `
      <div class="feed-header" style="display:flex;gap:16px;align-items:flex-start;margin-bottom:16px">
        ${feed.artwork ? `<img src="${escapeHtml(feed.artwork)}" alt="" style="width:96px;border-radius:12px">` : ''}
        <div class="row-main">
          <h2 class="section-title" style="margin:0">${escapeHtml(feed.title || feed.url)}</h2>
          <div class="row-meta">${escapeHtml(feed.description || '')}</div>
          <div class="row-meta">${episodes.length} episode(s)${feed.lastFetchedAt ? ` · updated ${formatRelativeTime(feed.lastFetchedAt)}` : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <button class="btn btn-secondary btn-sm" data-feed-refresh>${icon('refresh', { size: 13 })} Refresh</button>
          <button class="btn btn-ghost btn-sm" data-feed-autodl>${feed.autoDownload ? 'Auto-download: on' : 'Auto-download: off'}</button>
          <button class="btn btn-ghost btn-sm danger" data-feed-remove>Unsubscribe</button>
        </div>
      </div>
      <div class="episode-list">
        ${episodes.map(episode => `
          <div class="podcast-episode${episode.played ? ' played' : ''}" data-episode="${escapeHtml(episode.guid)}" data-np-id="${escapeHtml(String(episodeToPlayable(episode, feed).id))}">
            <button class="btn btn-icon" data-ep-play aria-label="Play ${escapeHtml(episode.title)}">${icon('play', { size: 16 })}</button>
            <div class="row-main">
              <div class="row-title" data-np-slot="start">${escapeHtml(episode.title)}</div>
              <div class="row-meta">${episode.published && !Number.isNaN(Date.parse(episode.published)) ? formatRelativeTime(new Date(episode.published).toISOString()) : ''}${parseEpisodeDuration(episode.duration) ? ` · ${formatTime(parseEpisodeDuration(episode.duration))}` : ''}${episode.downloaded ? ' · downloaded' : ''}</div>
            </div>
            <button class="btn btn-ghost btn-sm" data-ep-download ${episode.downloaded ? 'disabled title="Already in your library"' : ''}>${icon(episode.downloaded ? 'check' : 'download', { size: 14 })}<span>${episode.downloaded ? 'Saved' : 'Download'}</span></button>
          </div>`).join('') || '<div class="row-meta">No episodes parsed from this feed yet.</div>'}
      </div>
    `;

    detail.querySelector('[data-feed-refresh]').addEventListener('click', async () => {
      try {
        await api.refreshFeed(feed.id);
        toast.success('Feed refreshed');
        load();
      } catch (err) {
        toast.error(err.message);
      }
    });
    detail.querySelector('[data-feed-autodl]').addEventListener('click', async () => {
      await api.updateFeed(feed.id, { autoDownload: !feed.autoDownload });
      feed.autoDownload = !feed.autoDownload;
      paint();
    });
    detail.querySelector('[data-feed-remove]').addEventListener('click', async () => {
      await api.deleteFeed(feed.id);
      toast.success('Unsubscribed');
      activeFeed = null;
      load();
    });

    detail.querySelectorAll('[data-ep-play]').forEach(button => {
      button.addEventListener('click', () => {
        const episode = episodes.find(e => e.guid === button.closest('[data-episode]').dataset.episode);
        if (!episode) return;
        const queue = episodes.map(entry => episodeToPlayable(entry, feed));
        const index = episodes.indexOf(episode);
        window.dispatchEvent(new CustomEvent('vault:play', { detail: { item: queue[index], queue, index } }));
      });
    });
    detail.querySelectorAll('[data-ep-download]').forEach(button => {
      button.addEventListener('click', async () => {
        const row = button.closest('[data-episode]');
        const progress = toast.progress('Downloading episode…');
        try {
          button.disabled = true;
          await api.downloadEpisode(feed.id, row.dataset.episode);
          progress.finish('Episode downloaded');
          load(); // show it as saved; it now plays from the library copy
        } catch (err) {
          button.disabled = false;
          progress.fail(/^download failed/i.test(err.message) ? err.message : `Download failed: ${err.message}`);
        }
      });
    });
  }

  container.querySelector('#feed-add').addEventListener('click', async () => {
    const url = await promptModal({
      title: 'Add podcast feed',
      label: 'Feed URL',
      placeholder: 'https://example.com/feed.xml',
      confirmLabel: 'Subscribe',
      validate: value => (/^https?:\/\//.test(value) ? null : 'Enter a full http(s) URL'),
    });
    if (!url) return;
    try {
      await api.subscribeFeed(url);
      toast.success('Subscribed');
      load();
    } catch (err) {
      toast.error(`Could not subscribe: ${err.message}`);
    }
  });

  container.querySelector('#feeds-refresh').addEventListener('click', async () => {
    const progress = toast.progress('Refreshing feeds…');
    try {
      const result = await api.refreshAllFeeds();
      progress.finish(`Checked ${result.feeds ?? feeds.length} feed(s), ${result.added ?? 0} new episode(s)`);
      load();
    } catch (err) {
      progress.fail(err.message);
    }
  });

  await load();
}

export default { renderPodcasts };
