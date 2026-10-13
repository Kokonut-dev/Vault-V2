/**
 * Spotify-style shuffle planner.
 *
 * With shuffle on, every track in the queue plays once, in random order,
 * before any track repeats. When the pass is exhausted, repeat "all" starts a
 * new pass (the track that just finished is kept out of its first slot where
 * possible); otherwise playback ends.
 *
 * The player can ask for the next track ahead of time (preload / crossfade).
 * That pick is remembered so the track we preloaded is the one that plays.
 *
 * Tracks are tracked by item id, so a queue that is rebuilt (for example when
 * a track is appended) keeps the current pass instead of replaying songs.
 */
export class ShufflePlanner {
  constructor(random = Math.random) {
    this.random = random;
    this.played = new Set();
    this.history = [];
    this.pending = null; // { queue, from, to }
  }

  /** Start a fresh pass for a new queue, counting the starting track as played. */
  start(queue, startIndex = 0) {
    this.played = new Set();
    this.history = [];
    this.pending = null;
    if (queue[startIndex]) this.played.add(queue[startIndex].id);
  }

  /** Forget any pick made ahead of time (e.g. shuffle was toggled). */
  invalidate() {
    this.pending = null;
  }

  /**
   * Index of the track to play after `idx`, or -1 when the pass has ended and
   * `repeat` is not "all". Repeated calls for the same position return the same
   * pick until it is committed.
   */
  nextIndex(queue, idx, repeat) {
    if (this.pending && this.pending.queue === queue && this.pending.from === idx) {
      return this.pending.to;
    }
    const current = queue[idx];
    if (current) this.played.add(current.id);

    let candidates = this.unplayedIndices(queue);
    if (!candidates.length) {
      // The pass is complete: every track has played once.
      if (repeat !== 'all') return -1;
      // Start a clean pass. The track that just finished must not open it,
      // otherwise it would be back-to-back with itself.
      this.played = new Set();
      candidates = queue.map((_, i) => i).filter(i => !current || queue[i].id !== current.id);
      if (!candidates.length) candidates = queue.map((_, i) => i); // single-track queue
    }
    const to = candidates[Math.floor(this.random() * candidates.length)];
    this.played.add(queue[to].id);
    this.pending = { queue, from: idx, to };
    return to;
  }

  /** Record that playback moved from `fromIdx` to `toIdx`. */
  commit(queue, fromIdx) {
    const from = queue[fromIdx];
    if (from) {
      this.history.push(from.id);
      if (this.history.length > 500) this.history.shift();
    }
    this.pending = null;
  }

  /**
   * Index of the previously played track (most recent first), or -1 when there
   * is no history. Previous never re-counts a track as played.
   */
  previousIndex(queue) {
    this.pending = null;
    while (this.history.length) {
      const id = this.history.pop();
      const i = queue.findIndex(t => t.id === id);
      if (i >= 0) return i;
    }
    return -1;
  }

  unplayedIndices(queue) {
    const out = [];
    queue.forEach((t, i) => { if (!this.played.has(t.id)) out.push(i); });
    return out;
  }
}
