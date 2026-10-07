/**
 * Library + listening statistics for the Stats page ("your year in Vault").
 * Everything is computed locally from history, listen records and the index.
 */
const libraryService = require('./library');
const extras = require('./extras');

function topN(map, n = 10) {
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

function build({ period = 'all' } = {}) {
  const items = libraryService.getAll();
  const history = libraryService.getHistory();
  const listens = extras.getListens();

  const since = (() => {
    const now = new Date();
    if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
    if (period === 'year') return new Date(now.getFullYear(), 0, 1);
    if (period === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d;
    }
    return new Date(0);
  })();

  const totalListenSeconds = Object.values(listens.total || {}).reduce((a, b) => a + b, 0);

  // Watch/listen time per day for the last 90 days
  const daily = [];
  const dailyMap = listens.daily || {};
  for (let i = 89; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    daily.push({ date: key, seconds: (dailyMap[key]?.seconds) || 0 });
  }

  const itemById = new Map(items.map(i => [i.id, i]));
  const byGenre = {};
  const byArtist = {};
  const byType = { movie: 0, music: 0, video: 0, audiobook: 0, podcast: 0, comic: 0 };
  const byPlayCount = {};

  for (const item of items) {
    byType[item.type] = (byType[item.type] || 0) + 1;
    object: {
      const genres = item.genres?.length ? item.genres : (item.genre ? [item.genre] : []);
      for (const genre of genres) byGenre[genre] = (byGenre[genre] || 0) + 1;
    }
    if (item.artist) byArtist[item.artist] = (byArtist[item.artist] || 0) + 1;
    if (item.playCount) byPlayCount[item.title] = item.playCount;
  }

  const recentHistory = history.filter(h => new Date(h.watchedAt) >= since);
  const completed = history.filter(h => h.completed || h.progress >= 95).length;
  const inProgress = history.filter(h => h.progress > 5 && h.progress < 95).length;

  const sessionSeconds = recentHistory.reduce((sum, h) => sum + (listens.total?.[h.itemId] || 0), 0);

  const mostWatched = history
    .map(h => ({ item: itemById.get(h.itemId), entry: h }))
    .filter(r => r.item)
    .sort((a, b) => (b.entry.playCount || 0) - (a.entry.playCount || 0) || b.entry.progress - a.entry.progress)
    .slice(0, 12)
    .map(r => ({
      id: r.item.id,
      title: r.item.title,
      type: r.item.type,
      artist: r.item.artist || null,
      poster: !!r.item.posterPath,
      playCount: r.entry.playCount || 0,
      progress: r.entry.progress,
      watchedAt: r.entry.watchedAt,
    }));

  const biggest = [...items]
    .filter(i => i.fileSize)
    .sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0))
    .slice(0, 5)
    .map(i => ({ id: i.id, title: i.title, fileSize: i.fileSize, resolution: i.resolution }));

  const storageSaved = {
    // Rough estimate of what a transcode/streaming pass costs vs. disk.
    libraryBytes: items.reduce((sum, i) => sum + (i.fileSize || 0), 0),
  };

  return {
    period,
    generatedAt: new Date().toISOString(),
    library: {
      items: items.length,
      byType,
      hours: formatDuration(items.reduce((sum, i) => sum + (i.duration || 0), 0)),
      storage: storageSaved.libraryBytes,
      topGenres: topN(byGenre, 12),
      topArtists: topN(byArtist, 12),
      topPlayed: topN(byPlayCount, 10),
      biggest,
      withArtwork: items.filter(i => i.posterPath || i.coverArtPath || i.thumbnailPath).length,
      hdr: items.filter(i => i.hdr).length,
      fourK: items.filter(i => i.fourK).length,
    },
    watching: {
      totalSeconds: totalListenSeconds,
      total: formatDuration(totalListenSeconds),
      watchedSessions: recentHistory.length,
      completed,
      inProgress,
      daily,
      mostWatched,
      sessionSeconds: formatDuration(sessionSeconds),
    },
  };
}

module.exports = { build, formatDuration };
