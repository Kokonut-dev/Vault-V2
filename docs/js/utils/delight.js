/**
 * Small, playful responses to the things people tap most: a heart that pops
 * (with a little burst) when a song is liked, play buttons that squish, skip
 * buttons that nudge the way they go, shuffle that wiggles, repeat that
 * turns, and "Surprise me" that rolls.
 *
 * Rules (css/animations.css): transform + opacity only, short (≤ 520 ms),
 * one-shot — nothing loops — and only on a person's own action, never on
 * render. Motion setting "full" only: "reduced" and "off" (and the system's
 * reduce-motion preference, through "system") get none of it.
 *
 * Web Animations, not classes: no reflow to restart a keyframe, nothing to
 * clean up, and `composite: 'add'` stacks the bounce on top of a button's
 * own hover/active transform instead of fighting it.
 */

const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/** True when playful motion may run right now. */
export function delightAllowed() {
  if (typeof document === 'undefined') return false;
  // utils/pageTransition.js keeps html[data-motion] current (setting + the
  // system preference). Read only the attribute: importing that module
  // here would run its side effects wherever likes.js is loaded.
  const attr = document.documentElement?.dataset?.motion;
  if (attr) return attr === 'full';
  try { return !matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function play(el, frames, options) {
  if (!el || typeof el.animate !== 'function' || !delightAllowed()) return null;
  try {
    return el.animate(frames, { composite: 'add', ...options });
  } catch {
    // composite: 'add' unsupported → plain (replace) animation.
    try { return el.animate(frames, options); } catch { return null; }
  }
}

/** The like heart: a springy pop and a burst of dots on like, a soft shrink on unlike. */
export function heartPop(btn, liked) {
  if (!btn || !delightAllowed()) return;
  const glyph = btn.querySelector('svg') || btn;
  if (!liked) {
    play(glyph, [{ transform: 'scale(1)' }, { transform: 'scale(0.78)' }, { transform: 'scale(1)' }],
      { duration: 260, easing: 'ease-out' });
    return;
  }
  play(glyph, [
    { transform: 'scale(1)' },
    { transform: 'scale(0.7)', offset: 0.18 },
    { transform: 'scale(1.32)', offset: 0.5 },
    { transform: 'scale(0.94)', offset: 0.76 },
    { transform: 'scale(1)' },
  ], { duration: 520, easing: 'ease-out' });
  // The burst: one dot whose box-shadow draws a ring of six, scaled out and
  // faded (transform + opacity, removed when done).
  const burst = document.createElement('span');
  burst.className = 'like-burst';
  burst.setAttribute('aria-hidden', 'true');
  btn.appendChild(burst);
  const anim = play(burst, [
    { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 1, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.5, easing: 'ease-in' },
    { transform: 'translate(-50%, -50%) scale(1.2)', opacity: 0 },
  ], { duration: 500, easing: 'linear', composite: 'replace' });
  if (anim) anim.finished.catch(() => {}).finally(() => burst.remove());
  else burst.remove();
}

/** Any play / pause button: squish down and spring back. */
export function squish(el) {
  play(el, [
    { transform: 'scale(1)' },
    { transform: 'scale(0.84)', offset: 0.3 },
    { transform: 'scale(1.06)', offset: 0.7 },
    { transform: 'scale(1)' },
  ], { duration: 340, easing: 'ease-out' });
}

/** Skip buttons: a quick nudge in the direction they go. */
export function nudge(el, direction = 1) {
  const glyph = el?.querySelector('svg') || el;
  play(glyph, [
    { transform: 'translateX(0)' },
    { transform: `translateX(${4 * direction}px)`, offset: 0.4 },
    { transform: 'translateX(0)' },
  ], { duration: 300, easing: SPRING });
}

/** Shuffle: a little wiggle. */
export function wiggle(el) {
  const glyph = el?.querySelector('svg') || el;
  play(glyph, [
    { transform: 'rotate(0deg)' },
    { transform: 'rotate(-14deg)', offset: 0.25 },
    { transform: 'rotate(10deg)', offset: 0.55 },
    { transform: 'rotate(-4deg)', offset: 0.8 },
    { transform: 'rotate(0deg)' },
  ], { duration: 420, easing: 'ease-out' });
}

/** Repeat / "Surprise me": one full turn with a springy landing. */
export function spin(el) {
  const glyph = el?.querySelector('svg') || el;
  play(glyph, [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    { duration: 520, easing: SPRING });
}

// Which control does what. Delegated, so views rendered later get it too.
const SQUISH = '.media-card-play, [data-hero-play], #mini-play, #np-play, [data-play-all], .btn-play';
const ACTIONS = [
  ['#mini-next, #np-next', el => nudge(el, 1)],
  ['#mini-prev, #np-prev', el => nudge(el, -1)],
  ['#np-shuffle, [data-shuffle-all]', wiggle],
  ['#np-repeat', spin],
  ['[data-surprise]', spin],
  [SQUISH, squish],
];

let started = false;
export function initDelight() {
  if (started || typeof document === 'undefined') return;
  started = true;
  document.addEventListener('click', (event) => {
    if (!delightAllowed() || !event.target?.closest) return;
    for (const [selector, run] of ACTIONS) {
      const el = event.target.closest(selector);
      if (el && !el.disabled) { run(el); return; }
    }
  }, { passive: true });
}

export default { initDelight, heartPop, squish, nudge, wiggle, spin, delightAllowed };
