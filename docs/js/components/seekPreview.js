/**
 * Seek preview for the music timelines: while hovering or dragging, a bubble
 * shows the time you'd jump to and a marker sits on the bar. Dragging no
 * longer seeks on every pixel (a converted stream restarted each time) — it
 * previews, then seeks once on release.
 *
 *   attachSeekPreview(host, { input })          — Now Playing <input type=range>
 *   attachSeekPreview(host, { ghost, onSeek })  — the mini player's thin bar
 *
 * `host.classList.contains('is-dragging')` tells progress updates to leave the
 * bar alone mid-drag (it used to snap back under the pointer).
 */
import { formatTime } from '../utils/format.js';

const duration = () => Number(window.VAULT_AUDIO?.duration?.()) || 0;
const THUMB = 14; // px — matches .slider's thumb (components.css); keeps the bubble over it

export function attachSeekPreview(host, { input = null, ghost = null, onSeek, onScrub } = {}) {
  if (!host || host.dataset.seekPreview) return;
  host.dataset.seekPreview = '1';
  host.classList.add('seek-host');

  const tip = document.createElement('div');
  tip.className = 'seek-tip';
  tip.setAttribute('aria-hidden', 'true');
  const marker = document.createElement('div');
  marker.className = 'seek-marker';
  marker.setAttribute('aria-hidden', 'true');
  host.append(marker, tip);

  const bar = input || host;
  let dragging = false;

  /** Fraction 0..1 for a pointer x over the bar. */
  const fractionAt = (clientX) => {
    const r = bar.getBoundingClientRect();
    if (!r.width) return 0;
    if (input) {
      // A range's usable track is inset by half a thumb on each side.
      return Math.min(1, Math.max(0, (clientX - r.left - THUMB / 2) / (r.width - THUMB)));
    }
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  /** Place the bubble + marker at `fraction` and label it. */
  const show = (fraction) => {
    const total = duration();
    if (!total) { hide(); return; }
    const barRect = bar.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const usable = input ? barRect.width - THUMB : barRect.width;
    const x = (barRect.left - hostRect.left) + (input ? THUMB / 2 : 0) + fraction * usable;
    tip.textContent = formatTime(fraction * total);
    // Keep the bubble inside the host so it never pokes off-screen.
    const half = tip.offsetWidth / 2 || 20;
    tip.style.left = `${Math.min(hostRect.width - half, Math.max(half, x))}px`;
    marker.style.left = `${x}px`;
    if (ghost) ghost.style.width = `${fraction * 100}%`;
    host.classList.add('is-seeking');
  };
  const hide = () => { if (!dragging) host.classList.remove('is-seeking'); };

  // Hover (mouse/pen only — touch has no hover; it previews while dragging).
  bar.addEventListener('pointermove', (e) => {
    if (dragging || e.pointerType === 'touch') return;
    show(fractionAt(e.clientX));
  });
  bar.addEventListener('pointerleave', () => hide());

  if (input) {
    // The range handles its own drag; follow its value.
    const start = () => { dragging = true; host.classList.add('is-dragging'); };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      host.classList.remove('is-dragging');
      hide();
    };
    input.addEventListener('pointerdown', start);
    input.addEventListener('input', () => {
      const fraction = Number(input.value) / Number(input.max || 100);
      show(fraction);
      onScrub?.(fraction);
    });
    input.addEventListener('change', () => {
      onSeek?.(Number(input.value) / Number(input.max || 100));
      end();
      if (!input.matches(':hover')) host.classList.remove('is-seeking');
    });
    input.addEventListener('pointerup', () => setTimeout(end, 0));
    input.addEventListener('pointercancel', end);
    input.addEventListener('blur', () => { end(); host.classList.remove('is-seeking'); });
    return;
  }

  // Custom bar: click or drag anywhere on it.
  host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !duration()) return;
    e.preventDefault();
    dragging = true;
    host.classList.add('is-dragging');
    try { host.setPointerCapture(e.pointerId); } catch { /* old browsers */ }
    show(fractionAt(e.clientX));
  });
  host.addEventListener('pointermove', (e) => {
    if (dragging) show(fractionAt(e.clientX));
  });
  const finish = (e, commit) => {
    if (!dragging) return;
    dragging = false;
    host.classList.remove('is-dragging');
    if (commit) onSeek?.(fractionAt(e.clientX));
    if (e.pointerType === 'touch' || !host.matches(':hover')) host.classList.remove('is-seeking');
  };
  host.addEventListener('pointerup', (e) => finish(e, true));
  host.addEventListener('pointercancel', (e) => finish(e, false));
}
