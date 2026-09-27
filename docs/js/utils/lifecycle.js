/**
 * Per-view lifecycle — fixes the store subscription leak (F-4).
 *
 * Views were calling store.subscribe() on every route mount and never
 * unsubscribing, so each navigation left permanent listeners re-rendering
 * detached containers. Now the router's mount() calls runViewCleanups()
 * before swapping the DOM, and views register through subscribeView().
 *
 * A generation counter guards the race where an async render registers
 * subscriptions AFTER its view has already been replaced — those callbacks
 * are silently skipped instead of resurrecting dead views.
 */

const cleanups = new Set();
let generation = 0;

/** Register a callback to run when the current view unmounts. */
export function onUnmount(fn) {
  if (typeof fn === 'function') cleanups.add(fn);
}

/**
 * store.subscribe() bound to the current view's lifetime.
 * The callback only fires while its generation is still current.
 */
export function subscribeView(store, key, callback) {
  const gen = generation;
  const unsub = store.subscribe(key, (...args) => {
    if (gen !== generation) return;
    callback(...args);
  });
  onUnmount(unsub);
  return unsub;
}

/** Called by the router before tearing down the current view's DOM. */
export function runViewCleanups() {
  generation++;
  for (const fn of cleanups) {
    try {
      fn();
    } catch (e) {
      console.error('View cleanup error', e);
    }
  }
  cleanups.clear();
}
