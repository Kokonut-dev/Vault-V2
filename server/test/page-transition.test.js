/**
 * Page transitions (SR-15). Regression: the exit animation uses
 * `fill: forwards`; it used to be dropped from the tracked list as soon as
 * it finished, so it was never cancelled and pinned the new view at
 * opacity 0 once the (fill-less) entrance ended — pages went blank.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><main id="view-container"><h1>Home</h1></main></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => fn();

const modUrl = pathToFileURL(path.join(__dirname, '../../docs/js/utils/pageTransition.js')).href;

/** Minimal WAAPI stand-in: finishes after `duration` ms, honours cancel(). */
function fakeAnimate(log) {
  return function animate(frames, timing) {
    let settle;
    const anim = {
      frames, timing, state: 'running',
      effect: { getTiming: () => ({ fill: timing.fill || 'none' }) },
      finished: new Promise((resolve, reject) => { settle = { resolve, reject }; }),
      cancel() {
        if (this.state === 'cancelled') return;
        const wasRunning = this.state === 'running';
        this.state = 'cancelled';
        if (wasRunning) settle.reject(new Error('AbortError'));
      },
    };
    anim.finished.catch(() => {});
    setTimeout(() => { if (anim.state === 'running') { anim.state = 'finished'; settle.resolve(anim); } }, timing.duration);
    log.push(anim);
    return anim;
  };
}

/** What a real element would still be showing: any finished fill animation that was never cancelled. */
const stuck = (log) => log.filter(a => a.state === 'finished' && a.timing.fill === 'forwards');

test('exit animation is cancelled after the swap; nothing pins the view invisible', async () => {
  const { swapView, transitionKind, _resetTransitions } = await import(modUrl);
  _resetTransitions();
  const container = document.getElementById('view-container');
  const log = [];
  container.animate = fakeAnimate(log);

  const paint = (title) => () => { container.innerHTML = `<h1>${title}</h1>`; };
  await swapView(container, paint('Home'), { path: '/' });               // first paint: no animation
  assert.equal(log.length, 0);

  await swapView(container, paint('Music'), { path: '/music' });
  await new Promise(r => setTimeout(r, 300));                           // let the entrance finish
  assert.equal(log.length, 2, 'exit + enter');
  assert.equal(log[0].timing.fill, 'forwards');
  assert.equal(log[0].state, 'cancelled', 'exit must be cancelled once the new view is in');
  assert.deepEqual(stuck(log), []);

  assert.equal(document.title, 'Music · Vault');
  assert.equal(document.getElementById('route-announcer').textContent, 'Music page');
  assert.equal(transitionKind({ from: '/music', to: '/music/album/1' }), 'forward');
  assert.equal(transitionKind({ from: '/music/album/1', to: '/music' }), 'back');
  assert.equal(transitionKind({ from: '/settings', to: '/settings' }), 'none');
});

test('rapid navigation leaves no animation behind and only the last view renders', async () => {
  const { swapView } = await import(modUrl);
  const container = document.getElementById('view-container');
  const log = [];
  container.animate = fakeAnimate(log);
  const rendered = [];
  const paint = (title) => () => { rendered.push(title); container.innerHTML = `<h1>${title}</h1>`; };

  const a = swapView(container, paint('Movies'), { path: '/movies' });
  await new Promise(r => setTimeout(r, 20));
  const b = swapView(container, paint('Playlists'), { path: '/playlists' });
  await new Promise(r => setTimeout(r, 20));
  const c = swapView(container, paint('Settings'), { path: '/settings' });
  await Promise.all([a, b, c]);
  await new Promise(r => setTimeout(r, 300));

  assert.deepEqual(rendered, ['Settings'], 'superseded swaps never render');
  assert.deepEqual(stuck(log), []);
  assert.equal(log.filter(x => x.state === 'running').length, 0);
  assert.equal(document.title, 'Settings · Vault');
});

test('motion "off" swaps without animating', async () => {
  const { swapView, setMotionPreference } = await import(modUrl);
  const container = document.getElementById('view-container');
  const log = [];
  container.animate = fakeAnimate(log);
  setMotionPreference('off');
  try {
    await swapView(container, () => { container.innerHTML = '<h1>Music</h1>'; }, { path: '/music' });
    assert.equal(log.length, 0);
    assert.equal(document.documentElement.dataset.motion, 'off');
  } finally {
    setMotionPreference('system');
  }
});
