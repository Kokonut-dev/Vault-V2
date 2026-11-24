/**
 * Tests for Stats / Recap aggregation service.
 * Run: npm test   (node --test test/*.test.js)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const stats = require('../services/stats');
const extras = require('../services/extras');
const libraryService = require('../services/library');

test('formatDuration formats zero and various runtimes correctly', () => {
  assert.equal(stats.formatDuration(0).human, '0m');
  assert.equal(stats.formatDuration(50).human, '0m');
  assert.equal(stats.formatDuration(96).human, '1m');
  assert.equal(stats.formatDuration(3660).human, '1h 1m');
  assert.equal(stats.formatDuration(7200).human, '2h 0m');
  assert.equal(stats.formatDuration(90000).human, '1d 1h');
});

test('periodStart calculates valid start dates', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const week = stats.periodStart('week', now);
  assert.ok(week instanceof Date);
  assert.equal(week.toISOString().slice(0, 10), '2026-11-10');

  const month = stats.periodStart('month', now);
  assert.equal(month.getFullYear(), 2026);
  assert.equal(month.getMonth(), 10); // November (0-indexed)
  assert.equal(month.getDate(), 1);

  const year = stats.periodStart('year', now);
  assert.equal(year.getFullYear(), 2026);
  assert.equal(year.getMonth(), 0);
  assert.equal(year.getDate(), 1);

  assert.equal(stats.periodStart('all', now), null);
});

test('stats.build handles empty library and default periods', () => {
  const recapWeek = stats.build({ period: 'week' });
  assert.equal(recapWeek.period, 'week');
  assert.equal(recapWeek.watching.daily.length, 7);
  assert.equal(recapWeek.watching.days90.length, 90);
  assert.ok(Array.isArray(recapWeek.listening.topArtists));
  assert.ok(Array.isArray(recapWeek.listening.topTracks));
  assert.ok(Array.isArray(recapWeek.listening.topAlbums));
  assert.ok(Array.isArray(recapWeek.watching.mostWatched));
  assert.equal(recapWeek.summary.totalSeconds, 0);

  const recapMonth = stats.build({ period: 'month' });
  assert.equal(recapMonth.watching.daily.length, 30);

  const recapAll = stats.build({ period: 'all' });
  assert.equal(recapAll.watching.daily.length, 90);
});

test('stats.build aggregates listening activity and ranks tracks/artists', () => {
  // Mock an item in library
  const item1 = { id: 'track-1', title: 'Song One', artist: 'Artist A', album: 'Album Alpha', type: 'music', fileSize: 1000 };
  const item2 = { id: 'track-2', title: 'Song Two', artist: 'Artist A', album: 'Album Alpha', type: 'music', fileSize: 2000 };
  const item3 = { id: 'track-3', title: 'Song Three', artist: 'Artist B', album: 'Album Beta', type: 'music', fileSize: 3000 };

  const origGetAll = libraryService.getAll;
  const origGetListens = extras.getListens;

  try {
    libraryService.getAll = () => [item1, item2, item3];
    extras.getListens = () => ({
      total: {
        'track-1': 100,
        'track-2': 50,
        'track-3': 200,
      },
      daily: {
        // Today (UTC, like stats.js): a fixed date fell out of the 'week'
        // window a few days after the test was written.
        [new Date().toISOString().slice(0, 10)]: {
          seconds: 350,
          items: {
            'track-1': 100,
            'track-2': 50,
            'track-3': 200,
          },
        },
      },
    });

    const recap = stats.build({ period: 'week' });
    assert.equal(recap.listening.seconds, 350);
    assert.equal(recap.listening.tracks, 3);
    assert.equal(recap.summary.totalSeconds, 350);
    assert.equal(recap.summary.activeDays, 1);

    // Top artists: Artist B (200), Artist A (150)
    assert.equal(recap.listening.topArtists.length, 2);
    assert.equal(recap.listening.topArtists[0].name, 'Artist B');
    assert.equal(recap.listening.topArtists[0].seconds, 200);
    assert.equal(recap.listening.topArtists[1].name, 'Artist A');
    assert.equal(recap.listening.topArtists[1].seconds, 150);

    // Top tracks: Song Three (200), Song One (100), Song Two (50)
    assert.equal(recap.listening.topTracks.length, 3);
    assert.equal(recap.listening.topTracks[0].title, 'Song Three');
    assert.equal(recap.listening.topTracks[0].seconds, 200);

    // Top albums: Album Beta (200), Album Alpha (150)
    assert.equal(recap.listening.topAlbums.length, 2);
    assert.equal(recap.listening.topAlbums[0].name, 'Album Beta');
  } finally {
    libraryService.getAll = origGetAll;
    extras.getListens = origGetListens;
  }
});
