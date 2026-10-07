/**
 * TV shows: grouping episodes into shows and seasons, Next Up, and play-through
 * helpers. The library index gives us `seriesKey` + season/episode at scan time.
 */
const express = require('express');
const router = express.Router();
const libraryService = require('../services/library');
const extras = require('../services/extras');

function showKey(item) {
  return item.seriesKey || (item.title || '').toLowerCase();
}

function isEpisode(item) {
  return item.type === 'movie' && (item.season !== null && item.season !== undefined || item.episode !== null && item.episode !== undefined);
}

function episodeSort(a, b) {
  const season = (Number(a.season) || 0) - (Number(b.season) || 0);
  if (season !== 0) return season;
  const episode = (Number(a.episode) || 0) - (Number(b.episode) || 0);
  if (episode !== 0) return episode;
  return String(a.title || '').localeCompare(String(b.title || ''));
}

/** All shows with episode counts + progress, newest first. */
function buildShows(profileId) {
  const items = libraryService.getAll().filter(i => isEpisode(i));
  const watchedMap = libraryService.getWatchedMap(profileId);
  const history = libraryService.forProfile(profileId).getHistory();
  const historyMap = new Map(history.map(h => [h.itemId, h]));

  const groups = new Map();
  for (const item of items) {
    const key = showKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const shows = [];
  for (const [key, episodes] of groups) {
    episodes.sort(episodeSort);
    const seasons = [...new Set(episodes.map(e => Number(e.season) || 1))].sort((a, b) => a - b);
    const watched = episodes.filter(e => watchedMap[e.id]?.watched).length;
    const inProgress = episodes.filter(e => {
      const entry = historyMap.get(e.id);
      return entry && entry.progress > 5 && entry.progress < 95;
    });
    const lastPlayed = episodes
      .map(e => historyMap.get(e.id)?.watchedAt)
      .filter(Boolean)
      .sort()
      .pop() || null;

    shows.push({
      key,
      id: `show:${Buffer.from(key).toString('base64url').slice(0, 16)}`,
      title: episodes[0].title?.replace(/\s*[sS]\d+[eE]\d+.*$/, '') || key,
      posterPath: episodes.find(e => e.posterPath)?.posterPath || null,
      backdropPath: episodes.find(e => e.backdropPath)?.backdropPath || null,
      episodeCount: episodes.length,
      seasonCount: seasons.length,
      seasons,
      watchedCount: watched,
      progress: episodes.length ? Math.round((watched / episodes.length) * 100) : 0,
      inProgressCount: inProgress.length,
      lastPlayedAt: lastPlayed,
      addedAt: episodes.reduce((min, e) => (e.addedAt && e.addedAt < min ? e.addedAt : min), episodes[0].addedAt),
      genres: [...new Set(episodes.flatMap(e => (e.genres?.length ? e.genres : e.genre ? [e.genre] : [])))].slice(0, 4),
      episodeIds: episodes.map(e => e.id),
    });
  }

  return shows.sort((a, b) => {
    const aDate = new Date(a.lastPlayedAt || a.addedAt || 0);
    const bDate = new Date(b.lastPlayedAt || b.addedAt || 0);
    return bDate - aDate;
  });
}

router.get('/shows', (req, res) => {
  const shows = buildShows(req.profileId || 'default');
  res.json({ shows, total: shows.length });
});

router.get('/shows/:key', (req, res) => {
  const profileId = req.profileId || 'default';
  const key = decodeURIComponent(req.params.key);
  const watchedMap = libraryService.getWatchedMap(profileId);
  const history = libraryService.forProfile(profileId).getHistory();
  const historyMap = new Map(history.map(h => [h.itemId, h]));

  const episodes = libraryService.getAll()
    .filter(i => isEpisode(i) && showKey(i) === key)
    .sort(episodeSort);

  if (!episodes.length) return res.status(404).json({ error: 'Show not found' });

  const seasonsMap = new Map();
  for (const episode of episodes) {
    const seasonNumber = Number(episode.season) || 1;
    if (!seasonsMap.has(seasonNumber)) seasonsMap.set(seasonNumber, []);
    seasonsMap.get(seasonNumber).push({
      ...episode,
      watched: !!watchedMap[episode.id]?.watched,
      progress: historyMap.get(episode.id)?.progress || 0,
      watchedAt: historyMap.get(episode.id)?.watchedAt || null,
    });
  }

  const markers = extras.getSeriesMarkers(key);
  res.json({
    key,
    title: key,
    episodes: episodes.length,
    seasons: [...seasonsMap.entries()].map(([number, list]) => ({
      number,
      episodes: list,
      watchedCount: list.filter(e => e.watched).length,
    })),
    intro: markers?.intro || null,
  });
});

/** Next unwatched episode, per show or for the whole library. */
router.get('/next-up', (req, res) => {
  const profileId = req.profileId || 'default';
  const limit = Math.min(50, parseInt(req.query.limit, 10) || 12);
  const watchedMap = libraryService.getWatchedMap(profileId);
  const history = libraryService.forProfile(profileId).getHistory();
  const historyMap = new Map(history.map(h => [h.itemId, h]));

  const shows = buildShows(profileId);
  const nextUp = [];

  for (const show of shows) {
    if (show.key && req.query.show && req.query.show !== show.key) continue;
    const episodes = libraryService.getAll()
      .filter(i => isEpisode(i) && showKey(i) === show.key)
      .sort(episodeSort);

    // Prefer the episode after the most recently watched one, else the first
    // in-progress episode, else the first unwatched episode.
    const withHistory = episodes
      .map(e => ({ episode: e, entry: historyMap.get(e.id) }))
      .filter(r => r.entry)
      .sort((a, b) => new Date(b.entry.watchedAt) - new Date(a.entry.watchedAt));

    let candidate = null;
    if (withHistory.length) {
      const lastWatched = withHistory[0];
      const index = episodes.findIndex(e => e.id === lastWatched.episode.id);
      candidate = episodes.slice(index + 1).find(e => !watchedMap[e.id]?.watched) || null;
      if (!candidate && lastWatched.entry.progress < 95) candidate = lastWatched.episode;
    }
    if (!candidate) candidate = episodes.find(e => !watchedMap[e.id]?.watched) || null;
    if (!candidate) continue;

    nextUp.push({
      ...candidate,
      showKey: show.key,
      showTitle: show.title,
      progress: historyMap.get(candidate.id)?.progress || 0,
      lastWatchedAt: withHistory[0]?.entry?.watchedAt || null,
    });
  }

  nextUp.sort((a, b) => new Date(b.lastWatchedAt || 0) - new Date(a.lastWatchedAt || 0));
  res.json({ items: nextUp.slice(0, limit), total: nextUp.length });
});

/** Mark a whole season/show watched or unwatched. */
router.post('/watched', (req, res) => {
  const profileId = req.profileId || 'default';
  const { key, season = null, watched = true } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });

  const episodes = libraryService.getAll().filter(i => isEpisode(i) && showKey(i) === key &&
    (season === null || Number(i.season) === Number(season)));

  for (const episode of episodes) {
    libraryService.setWatched(episode.id, !!watched, profileId);
    if (watched) {
      libraryService.forProfile(profileId).addHistoryEntry({
        itemId: episode.id,
        progress: 100,
        duration: episode.duration || 0,
        completed: true,
      });
    }
  }
  res.json({ message: `${episodes.length} episode(s) updated`, count: episodes.length });
});

module.exports = router;
module.exports.showKey = showKey;
module.exports.isEpisode = isEpisode;
module.exports.buildShows = buildShows;
