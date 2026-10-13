/**
 * Library + listening statistics for the Stats page ("your year in Vault").
 * Everything is computed locally from history, listen records and the index.
 *
 * Listen records (extras.recordListen) are bucketed per UTC day and per item,
 * so each period (week / month / year) is summed from the matching day buckets.
 * "all" uses the lifetime per-item totals.
 */
const libraryService = require('./library');
const extras = require('./extras');

const PERIODS = ['week', 'month', 'year', 'all'];
const DAILY_DAYS = 90;
const TOP_N = 10;

function topN(map, n = TOP_N) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, value]) => ({ key, value }));
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return { seconds: s, days, hours, minutes, human: days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m` };
}

/** Start of the period as a Date (or null for all-time). */
function periodStart(period, now = new Date()) {
  if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === 'year') return new Date(now.getFullYear(), 0, 1);
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    return d;
  }
  return null;
}

/** Seconds listened per item within the period. */
function secondsByItem(period, listens, since) {
  if (!since) return { ...(listens.total || {}) };
  const sinceKey = since.toISOString().slice(0, 10);
  const totals = {};
  for (const [day, bucket] of Object.entries(listens.daily || {})) {
    if (day < sinceKey) continue;
    for (const [itemId, secs] of Object.entries(bucket.items || {})) {
      totals[itemId] = (totals[itemId] || 0) + secs;
    }
  }
  return totals;
}

function build({ period = 'all' } = {}) {
  if (!PERIODS.includes(period)) period = 'all';

  const items = libraryService.getAll();
  const history = libraryService.getHistory();
  const listens = extras.getListens();
  const since = periodStart(period);
  const byId = secondsByItem(period, listens, since);

  const itemById = new Map(items.map(i => [i.id, i]));
  const byGenre = {};
  const byArtist = {};
  const byType = { movie: 0, music: 0, video: 0, audiobook: 0, podcast: 0, comic: 0 };

  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    const genres = item.genres?.length ? item.genres : (item.genre ? [item.genre] : []);
    for (const genre of genres) byGenre[genre] = (byGenre[genre] || 0) + 1;
    if (item.artist) byArtist[item.artist] = (byArtist[item.artist] || 0) + 1;
  }

  // Split period listen time into music vs everything else.
  let musicSeconds = 0;
  let videoSeconds = 0;
  const musicTracks = new Set();
  const videoTitles = new Set();
  const artistSeconds = {};
  const titleSeconds = [];
  for (const [itemId, secs] of Object.entries(byId)) {
    const item = itemById.get(itemId);
    if (!item || !secs) continue;
    if (item.type === 'music') {
      musicSeconds += secs;
      musicTracks.add(itemId);
      const artist = item.artist || 'Unknown artist';
      artistSeconds[artist] = (artistSeconds[artist] || 0) + secs;
    } else {
      videoSeconds += secs;
      videoTitles.add(itemId);
      titleSeconds.push({ id: item.id, title: item.title, type: item.type, poster: !!item.posterPath, seconds: secs });
    }
  }

  // Daily activity for the last 90 days (all media types).
  const daily = [];
  const dailyMap = listens.daily || {};
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    daily.push({ date: key, seconds: dailyMap[key]?.seconds || 0 });
  }

  const sinceForHistory = since || new Date(0);
  const recentHistory = history.filter(h => new Date(h.watchedAt) >= sinceForHistory);
  const completed = history.filter(h => h.completed || h.progress >= 95).length;
  const inProgress = history.filter(h => h.progress > 5 && h.progress < 95).length;

  const mostWatched = titleSeconds.sort((a, b) => b.seconds - a.seconds).slice(0, TOP_N);

  const topArtists = Object.entries(artistSeconds)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([name, seconds]) => ({ name, seconds }));

  const biggest = [...items]
    .filter(i => i.fileSize)
    .sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0))
    .slice(0, 5)
    .map(i => ({ id: i.id, title: i.title, fileSize: i.fileSize, resolution: i.resolution }));

  const lifetimeVideoSeconds = Object.entries(listens.total || {})
    .reduce((sum, [id, secs]) => (itemById.get(id)?.type !== 'music' ? sum + secs : sum), 0);

  return {
    period,
    generatedAt: new Date().toISOString(),
    library: {
      items: items.length,
      byType,
      hours: formatDuration(items.reduce((sum, i) => sum + (i.duration || 0), 0)),
      storage: items.reduce((sum, i) => sum + (i.fileSize || 0), 0),
      artists: Object.keys(byArtist).length,
      topGenres: topN(byGenre, 12),
      topArtists: topN(byArtist, 12),
      topPlayed: items
        .filter(i => i.playCount)
        .sort((a, b) => (b.playCount || 0) - (a.playCount || 0))
        .slice(0, TOP_N)
        .map(i => ({ key: i.title, value: i.playCount })),
      biggest,
      withArtwork: items.filter(i => i.posterPath || i.coverArtPath || i.thumbnailPath).length,
      hdr: items.filter(i => i.hdr).length,
      fourK: items.filter(i => i.fourK).length,
    },
    watching: {
      // Non-music playback time within the period.
      seconds: Math.round(videoSeconds),
      total: formatDuration(lifetimeVideoSeconds),
      items: videoTitles.size,
      sessions: recentHistory.length,
      completed,
      inProgress,
      daily,
      mostWatched,
    },
    listening: {
      // Music playback time within the period.
      seconds: Math.round(musicSeconds),
      tracks: musicTracks.size,
      topArtists,
    },
  };
}

module.exports = { build, formatDuration, periodStart };
