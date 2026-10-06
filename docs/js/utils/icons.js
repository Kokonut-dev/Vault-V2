/**
 * Icons — one inline, stroke-based SVG set for the whole UI.
 *
 * Why inline SVG instead of the emoji / dingbat glyphs this replaced:
 *   - emoji (🎬 ♫ 🔒 …) render differently on every OS, can't inherit
 *     `color`, ignore stroke width and sit on inconsistent baselines;
 *   - dingbats (⌕ ≡ ◷ ∅ …) exist only in some fonts and fall back to tofu;
 *   - one inline `<svg>` copies nothing, needs no sprite/webfont request,
 *     scales crisply and is recoloured by the theme via `currentColor`.
 *
 * Geometry follows the 24×24 Lucide grid (MIT) — 2px-safe strokes, round caps.
 * Icons are decorative by default (`aria-hidden`), so the accessible name must
 * live on the control itself (`aria-label` / visible text) — which every
 * call-site in Vault already provides.
 *
 * Usage:
 *   import { icon, iconEl, setIcon, setIconLabel, hydrateIcons } from '../utils/icons.js';
 *
 *   // inside a template string
 *   `<button class="btn btn-icon" aria-label="Close">${icon('x')}</button>`
 *
 *   // runtime swaps (play/pause, mute, favourites…)
 *   setIcon(playBtn, isPlaying ? 'pause' : 'play');
 *   setIconLabel(backBtn, 'arrow-left', 'Back');
 */

/** name → inner markup of a 24×24 viewBox. */
export const ICONS = Object.freeze({
  /* ---------- chrome / navigation ---------- */
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  'search-x':
    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="m13.5 8.5-5 5"/><path d="m8.5 8.5 5 5"/>',
  // theme toggle — a half-filled disc (contrast), legible at 16px where the
  // busier sun+moon mark smears into a blob
  contrast:
    '<circle cx="12" cy="12" r="10"/><path d="M12 18a6 6 0 0 0 0-12v12z" fill="currentColor" stroke="none"/>',
  keyboard:
    '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
  home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  film: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>',
  music: '<circle cx="8" cy="18" r="4"/><path d="M12 18V2l7 4"/>',
  video:
    '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  'layout-grid':
    '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  heart:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  'heart-filled':
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  'star-filled': '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01z"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  'upload-cloud':
    '<path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor" stroke="none"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  database:
    '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  'file-question':
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a2 2 0 0 1 4 0c0 .6-.4 1-.9 1.4-.5.4-1.1.8-1.1 1.6"/><path d="M12 18h.01"/>',

  /* ---------- direction / affordances ---------- */
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  'arrow-up': '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'check-circle': '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
  'alert-triangle':
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'alert-circle':
    '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  'wifi-off':
    '<path d="M12 20h.01"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/><path d="M5 12.859a10 10 0 0 1 5.17-2.69"/><path d="M19 12.859a10 10 0 0 0-2.007-1.523"/><path d="M2 8.82a15 15 0 0 1 4.177-2.643"/><path d="M22 8.82a15 15 0 0 0-11.288-3.764"/><path d="m2 2 20 20"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  'external-link':
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',

  /* ---------- playback ---------- */
  play: '<path d="M6 4.5a1 1 0 0 1 1.5-.87l11 7.5a1 1 0 0 1 0 1.74l-11 7.5A1 1 0 0 1 6 19.5z"/>',
  pause:
    '<rect width="4" height="16" x="6" y="4" rx="1"/><rect width="4" height="16" x="14" y="4" rx="1"/>',
  'skip-back': '<path d="M19 20 9 12l10-8z"/><path d="M5 19V5"/>',
  'skip-forward': '<path d="m5 4 10 8-10 8z"/><path d="M19 5v14"/>',
  'volume-2':
    '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  'volume-x': '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  maximize:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  minimize:
    '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  shuffle:
    '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/>',
  repeat:
    '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  'repeat-1':
    '<path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/><path d="M11 10.5h1.5V15"/>',
  captions:
    '<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4"/><path d="M15 15h2"/><path d="M7 11h2"/><path d="M13 11h4"/>',
  sliders:
    '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',
  'picture-in-picture':
    '<path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>',
  theatre:
    '<rect width="20" height="14" x="2" y="4" rx="2"/><path d="M8 21h8"/><path d="M12 18v3"/>',

  /* ---------- fallback ---------- */
  circle: '<circle cx="12" cy="12" r="9"/>',
});

/** Names that render as a solid shape (fill) rather than an outline. */
const FILLED = new Set(['heart-filled', 'star-filled']);

const escapeAttr = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Build an inline SVG string for `name`.
 *
 * @param {string} name          key of ICONS (unknown names fall back to a dot)
 * @param {object} [options]
 * @param {number} [options.size=20]      width + height in px
 * @param {string} [options.className='icon']  extra classes (e.g. 'icon icon-inline')
 * @param {number} [options.strokeWidth=1.75]
 * @param {string} [options.title]        when set the icon is announced (role="img")
 */
export function icon(name, options = {}) {
  const { size = 20, className = 'icon', strokeWidth = 1.75, title = '' } = options;
  const body = ICONS[name] || ICONS.circle;
  const filled = FILLED.has(name);
  const a11y = title
    ? ` role="img" aria-label="${escapeAttr(title)}"`
    : ' aria-hidden="true"';
  return (
    `<svg class="${escapeAttr(className)}" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${strokeWidth}" ` +
    `stroke-linecap="round" stroke-linejoin="round" focusable="false"${a11y}>${body}</svg>`
  );
}

/** Same as {@link icon} but returns a live SVGElement (for DOM-based updates). */
export function iconEl(name, options = {}) {
  const { size = 20, className = 'icon', strokeWidth = 1.75, title = '' } = options;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const filled = FILLED.has(name);
  const attrs = {
    class: className,
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: filled ? 'currentColor' : 'none',
    stroke: 'currentColor',
    'stroke-width': String(strokeWidth),
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  };
  for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
  if (title) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.innerHTML = ICONS[name] || ICONS.circle;
  return svg;
}

/**
 * Replace an element's contents with a single icon — the "swap the glyph"
 * helper used for play/pause, mute and favourite toggles.
 */
export function setIcon(el, name, options = {}) {
  if (!el) return null;
  const svg = iconEl(name, options);
  el.replaceChildren(svg);
  return svg;
}

/**
 * Replace an element's contents with `icon + label` (or `label + icon` when
 * `position: 'end'`). The label is inserted as a real text node, so callers
 * never hand-concatenate HTML for user-facing strings.
 */
export function setIconLabel(el, name, label, options = {}) {
  if (!el) return null;
  const { position = 'start', ...iconOptions } = options;
  const svg = iconEl(name, iconOptions);
  const text = document.createElement('span');
  text.textContent = label;
  el.replaceChildren(...(position === 'end' ? [text, svg] : [svg, text]));
  return svg;
}

/**
 * Fill every `[data-icon]` placeholder in `root` with its SVG.
 *
 * Static markup (index.html) declares the icon it wants — `data-icon="menu"`,
 * optional `data-icon-size`, `data-icon-class`, `data-icon-stroke` — and this
 * runs once at boot. Keeps one source of truth for the artwork (ICONS) while
 * the HTML stays readable, and the app shell is still hidden behind the auth
 * gate while it hydrates, so nothing flashes.
 */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconHydrated === 'true') return;
    const size = Number.parseInt(el.dataset.iconSize || '', 10);
    const strokeWidth = Number.parseFloat(el.dataset.iconStroke || '');
    el.replaceChildren(
      iconEl(el.dataset.icon, {
        size: Number.isFinite(size) ? size : 20,
        strokeWidth: Number.isFinite(strokeWidth) ? strokeWidth : 1.75,
        className: el.dataset.iconClass || 'icon',
      })
    );
    el.dataset.iconHydrated = 'true';
  });
}

export default icon;
