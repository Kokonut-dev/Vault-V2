/**
 * Index-consistency tests for the library service.
 *
 * The indexes used to be rebuilt (O(n)) on every add/update/remove, and
 * `updateItem` did a `findIndex` over the whole library — which made a full
 * rescan O(n²). These tests pin the behaviour that the O(1) paths must keep:
 * dedupe by id *and* path, in-place updates, type moves, genre cache
 * invalidation and search-text freshness.
 *
 * Test items are removed again at the end, so a developer's real library
 * (server/data/library.json) is left untouched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const library = require('../services/library');

const TEST_IDS = ['test-id-1', 'test-id-2', 'test-id-3'];
const TEST_PATHS = ['/tmp/vault-test/one.mkv', '/tmp/vault-test/two.mkv', '/tmp/vault-test/three.mkv'];

function cleanup() {
  for (const id of TEST_IDS) library.removeItem(id);
}

test('add / read / type index / genre cache', () => {
  cleanup();
  library.init();
  const before = library.getAll().length;

  library.addItem({ id: TEST_IDS[0], title: 'One', type: 'movie', path: TEST_PATHS[0], genre: 'TestGenreAlpha' });
  library.addItem({ id: TEST_IDS[1], title: 'Two', type: 'music', path: TEST_PATHS[1], genre: 'TestGenreBeta', artist: 'Someone' });

  assert.equal(library.getAll().length, before + 2, 'both items were appended');
  assert.equal(library.getById(TEST_IDS[0]).title, 'One');
  assert.ok(library.getByType('movie').some(i => i.id === TEST_IDS[0]), 'type index has the movie');
  assert.ok(library.getByType('music').some(i => i.id === TEST_IDS[1]), 'type index has the music item');
  assert.ok(library.getGenres().includes('TestGenreAlpha'), 'genre cache knows the new genre');
  assert.ok(library.search('One').some(i => i.id === TEST_IDS[0]), 'search finds the new item');

  cleanup();
  assert.equal(library.getAll().length, before, 'cleanup restored the library size');
});

test('addItem de-dupes by id and by path (no O(n) scan needed)', () => {
  cleanup();
  const before = library.getAll().length;

  library.addItem({ id: TEST_IDS[0], title: 'Original', type: 'movie', path: TEST_PATHS[0] });
  library.addItem({ id: TEST_IDS[0], title: 'Updated by id', type: 'movie', path: TEST_PATHS[0] });
  assert.equal(library.getAll().length, before + 1, 'same id did not duplicate');
  assert.equal(library.getById(TEST_IDS[0]).title, 'Updated by id');

  // Same path under a different id must update the existing entry, exactly as
  // the previous `findIndex(i => i.id === id || i.path === path)` did.
  library.addItem({ id: TEST_IDS[1], title: 'Updated by path', type: 'movie', path: TEST_PATHS[0] });
  assert.equal(library.getAll().length, before + 1, 'same path did not duplicate');
  const survivor = library.getAll().find(i => i.path === TEST_PATHS[0]);
  assert.equal(survivor.title, 'Updated by path');

  cleanup();
  assert.equal(library.getAll().length, before);
});

test('updateItem mutates in place, refreshes search text and moves type buckets', () => {
  cleanup();
  library.addItem({ id: TEST_IDS[0], title: 'Before', type: 'movie', path: TEST_PATHS[0], genre: 'TestGenreGamma' });
  const reference = library.getById(TEST_IDS[0]);

  const updated = library.updateItem(TEST_IDS[0], { title: 'After', type: 'music' });
  assert.equal(updated, reference, 'the same object is mutated (no array slot swap)');
  assert.equal(library.getById(TEST_IDS[0]).title, 'After');

  // searchTextCache is a WeakMap keyed by object: in-place mutation must
  // invalidate it, otherwise search keeps matching the old title.
  assert.ok(library.search('After').some(i => i.id === TEST_IDS[0]), 'search sees the new title');
  assert.equal(library.search('Before').some(i => i.id === TEST_IDS[0]), false, 'stale title is gone');

  // Type moved from movie to music in the type index.
  assert.equal(library.getByType('movie').some(i => i.id === TEST_IDS[0]), false, 'left the movie bucket');
  assert.ok(library.getByType('music').some(i => i.id === TEST_IDS[0]), 'joined the music bucket');

  cleanup();
});

test('removeItem drops the item, its path and its genre from the caches', () => {
  cleanup();
  const before = library.getAll().length;
  library.addItem({ id: TEST_IDS[2], title: 'Doomed', type: 'movie', path: TEST_PATHS[2], genre: 'TestGenreDelta' });
  assert.ok(library.getGenres().includes('TestGenreDelta'));

  assert.equal(library.removeItem(TEST_IDS[2]), true);
  assert.equal(library.removeItem(TEST_IDS[2]), false, 'second removal is a no-op');
  assert.equal(library.getAll().length, before);
  assert.equal(library.getById(TEST_IDS[2]), null);
  assert.equal(library.getByType('movie').some(i => i.id === TEST_IDS[2]), false);
  assert.equal(library.getGenres().includes('TestGenreDelta'), false, 'genre cache was invalidated');
});
