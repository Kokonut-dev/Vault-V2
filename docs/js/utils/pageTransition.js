/**
 * Page transitions (SETTINGS_REVAMP_PLAN.md SR-15).
 *
 * WAAPI on #view-container rather than the View Transitions API: our views
 * render asynchronously, and a VT snapshot freezes input while data loads.
 *
 *   sibling → sibling   fade-through: old out 90 ms, new in 210 ms
 *                       (opacity + scale .985 → 1)
 *   list → detail       shared X axis: new view enters from +24 px (240 ms)
 *   detail → list/Back  retraces from −24 px
 *   reduced motion      opacity only, 120 ms, no exit phase
 *
 * The enter animation starts as soon as the view's synchronous render has
 * painted its skeleton — it never waits on data. A new navigation cancels
 * whatever is running (interruptible), and nothing lingers afterwards (no
 * fill, so no leftover transform creating a containing block).
 */

export const MOTION_KEY = 'vault_motion';
export const MOTION_MODES = ['system', 'full', 'reduced', 'off'];

const EASE_ENTER = 'cubic-bezier(0.16, 1, 0.3, 1)';
const EASE_EXIT = 'cubic-bezier(0.4, 0, 1, 1)';

let lastPath = null;
let running = [];
let swapToken = 0;

export function getMotionPreference() {
  try {
    const saved = localStorage.getItem(MOTION_KEY);
    return MOTION_MODES.includes(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function setMotionPreference(mode) {
  const next = MOTION_MODES.includes(mode) ? mode : 'system';
  try { localStorage.setItem(MOTION_KEY, next); } catch { /* private mode */ }
  applyMotionAttribute();
  return next;
}

/** Resolve "system" against prefers-reduced-motion → 'full' | 'reduced' | 'off'. */
export function resolveMotion(pref = getMotionPreference()) {
  if (pref === 'off' || pref === 'reduced' || pref === 'full') return pref;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'reduced' : 'full';
}

export function applyMotionAttribute() {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.motion = resolveMotion();
}

const depthOf = (path = '/') => String(path).split(/[?#]/)[0].split('/').filter(Boolean).length;

/**
 * Work out what kind of transition a navigation should get.
 * @returns {'none'|'fade'|'forward'|'back'}
 */
export function transitionKind({ from, to, type = 'push' } = {}) {
  if (from == null || to == null) return 'none';
  const a = String(from).split(/[?#]/)[0];
  const b = String(to).split(/[?#]/)[0];
  if (a === b) return 'none';
  const da = depthOf(a);
  const db = depthOf(b);
  if (db > da) return type === 'pop' ? 'back' : 'forward';
  if (db < da) return 'back';
  return 'fade';
}

function cancelRunning() {
  for (const anim of running) {
    try { anim.cancel(); } catch { /* already gone */ }
  }
  running = [];
}

function track(anim) {
  running.push(anim);
  const drop = () => { running = running.filter(a => a !== anim); };
  // A finished animation with `fill: forwards` (the exit) still holds its
  // end state — opacity 0 — until cancelled, so it must stay tracked until
  // cancelRunning() removes it. Only fill-less animations drop on finish.
  const fill = anim.effect?.getTiming?.().fill;
  if (fill === 'forwards' || fill === 'both') anim.finished.catch(drop);
  else anim.finished.then(drop, drop);
  return anim;
}

const ENTER = {
  full: {
    fade: { frames: [{ opacity: 0, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], duration: 210 },
    forward: { frames: [{ opacity: 0, transform: 'translateX(24px)' }, { opacity: 1, transform: 'none' }], duration: 240 },
    back: { frames: [{ opacity: 0, transform: 'translateX(-24px)' }, { opacity: 1, transform: 'none' }], duration: 240 },
  },
  reduced: { frames: [{ opacity: 0 }, { opacity: 1 }], duration: 120 },
};

/**
 * Swap the contents of `container` using `render` with a transition.
 *
 * @param {HTMLElement} container
 * @param {() => (void|Promise<void>)} render  wipes and re-renders the view
 * @param {object} [opts]
 * @param {string} [opts.path]       the destination path
 * @param {object} [opts.nav]        router nav ({ isCurrent(), type, from })
 */
export async function swapView(container, render, { path = '', nav = null } = {}) {
  const from = nav?.from ?? lastPath;
  const type = nav?.type || 'push';
  const token = ++swapToken;
  const isCurrent = () => token === swapToken && (!nav?.isCurrent || nav.isCurrent());
  lastPath = path || lastPath;

  cancelRunning();

  const motion = resolveMotion();
  const canAnimate = container
    && typeof container.animate === 'function'
    && motion !== 'off'
    && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const kind = canAnimate ? transitionKind({ from, to: path, type }) : 'none';

  if (kind === 'none') {
    await render();
    if (isCurrent()) settlePage(container, { announce: from != null && from !== path });
    return;
  }

  // From the first animated swap on, the CSS `.page` entrance must not
  // double up with ours (animations.css).
  document.documentElement.classList.add('has-page-transitions');

  // Exit: short and only in full motion (exits are ~70–85 % of entrances or
  // shorter; reduced motion swaps straight to a gentle fade-in).
  if (motion === 'full' && container.childElementCount) {
    const exit = track(container.animate(
      kind === 'fade'
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${kind === 'forward' ? -12 : 12}px)` }],
      { duration: 90, easing: EASE_EXIT, fill: 'forwards' },
    ));
    try { await exit.finished; } catch { /* interrupted by a newer navigation */ }
    if (!isCurrent()) return;
  }

  // Render synchronously up to the view's first await so its skeleton is in
  // the DOM, then start the entrance without waiting for data.
  const pending = render();
  cancelRunning();
  if (isCurrent()) {
    const spec = motion === 'reduced' ? ENTER.reduced : ENTER.full[kind];
    track(container.animate(spec.frames, { duration: spec.duration, easing: EASE_ENTER }));
  }
  await pending;
  if (isCurrent()) settlePage(container, { announce: true });
}

const APP_NAME = 'Vault';

/**
 * After a swap: give the document a per-page title (WCAG 2.4.2) and tell
 * screen-reader users the page changed. SPAs don't get the browser's own
 * "page loaded" cue, so a polite status message stands in for it; focus
 * stays where the user left it (on the nav link they activated).
 */
function settlePage(container, { announce = false } = {}) {
  if (typeof document === 'undefined' || !container?.querySelector) return;
  const heading = container.querySelector('h1');
  const name = heading?.textContent.replace(/\s+/g, ' ').trim();
  document.title = name ? `${name} · ${APP_NAME}` : APP_NAME;
  if (!announce || !name) return;
  let live = document.getElementById('route-announcer');
  if (!live) {
    live = document.createElement('p');
    live.id = 'route-announcer';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
  }
  // Clear then set on the next frame so repeat visits are re-announced.
  live.textContent = '';
  const say = () => { live.textContent = `${name} page`; };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(say); else say();
}

/** Test hook. */
export function _resetTransitions() {
  cancelRunning();
  lastPath = null;
  swapToken = 0;
}

applyMotionAttribute();
if (typeof matchMedia === 'function') {
  try {
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyMotionAttribute);
  } catch { /* old Safari */ }
}
