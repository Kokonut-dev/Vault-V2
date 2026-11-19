/**
 * Theme manager — handles dark/light/warm/cold/midnight/white + glass + grain
 */
import { store } from './store.js';

/**
 * Display metadata for the six themes. IDs are stable (they are persisted in
 * localStorage as `vault_theme`), so the 3.0 palette refresh renamed only the
 * display names. Swatches = [background, raised surface, accent] and must
 * match docs/css/variables.css.
 */
export const THEME_META = [
  { id: 'dark', name: 'Graphite', mode: 'Dark', colors: ['#161719', '#26282A', '#93BFF0'] },
  { id: 'light', name: 'Stone', mode: 'Light', colors: ['#F4F2EF', '#FDFBF9', '#005360'] },
  { id: 'warm', name: 'Sepia', mode: 'Light', colors: ['#F6EBDA', '#FCF3E4', '#294875'] },
  { id: 'cold', name: 'Dusk', mode: 'Dark', colors: ['#11181F', '#222A31', '#8ECED1'] },
  { id: 'midnight', name: 'Ember', mode: 'OLED', colors: ['#000000', '#1B1917', '#EAC07F'] },
  { id: 'white', name: 'Daylight', mode: 'Light', colors: ['#FFFFFF', '#F1F3F5', '#175098'] },
];

/** Markup for one theme swatch strip (decorative — the button carries the name). */
export function themeSwatch(meta) {
  return `<span class="theme-swatch" aria-hidden="true">${meta.colors
    .map(c => `<span style="background:${c}"></span>`).join('')}</span>`;
}

export class ThemeManager {
  constructor() {
    this.themes = THEME_META.map(t => t.id);
  }

  init() {
    // localStorage first: it can be newer than the store's copy, which was
    // read when the page loaded (e.g. a theme picked in the setup wizard).
    let stored = null;
    try { stored = localStorage.getItem('vault_theme'); } catch { /* storage blocked */ }
    const saved = [stored, store.get('theme')].find(t => this.themes.includes(t)) || 'dark';
    // No fade on load — it's not a switch the user made.
    this.setTheme(saved, { animate: false });
    
    const glass = store.get('glassIntensity');
    this.setGlassIntensity(glass);
    
    const grain = store.get('grainIntensity');
    this.setGrainIntensity(grain);

    store.subscribe('theme', (theme) => this.setTheme(theme));
    store.subscribe('glassIntensity', (val) => this.setGlassIntensity(val));
    store.subscribe('grainIntensity', (val) => this.setGrainIntensity(val));
  }

  setTheme(theme, { animate = true } = {}) {
    if (!this.themes.includes(theme)) theme = 'dark';
    // Idempotence guard: store.set('theme') re-emits into the 'theme'
    // subscriber above, which called back into setTheme — previously that
    // recursed until the stack overflowed (the store's try/catch swallowed
    // the RangeError) and re-dispatched vault:theme-changed thousands of
    // times per switch. Return early when everything already matches.
    const root = document.documentElement;
    if (root.getAttribute('data-theme') === theme && store.get('theme') === theme) return;

    // F-2: scope universal transitions to the switch itself (themes.css) —
    // the class is removed shortly after the fade settles.
    const changed = root.getAttribute('data-theme') !== theme;
    root.setAttribute('data-theme', theme);
    if (animate && changed) {
      root.classList.add('theme-transition');
      clearTimeout(this._themeTransitionTimer);
      this._themeTransitionTimer = setTimeout(() => {
        root.classList.remove('theme-transition');
      }, 500);
    }

    store.set('theme', theme, true);
    localStorage.setItem('vault_theme', theme);
    // Dispatch event
    window.dispatchEvent(new CustomEvent('vault:theme-changed', { detail: { theme } }));
  }

  getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  setGlassIntensity(value) {
    const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
    // Single source of truth: glass.css derives blur radius, fill opacity and
    // hairline strength from --glass-intensity.
    document.documentElement.style.setProperty('--glass-intensity', v);
    localStorage.setItem('vault_glass', String(v));
    // Same idempotence guard as setTheme: store.set re-emits into the
    // 'glassIntensity' subscriber, which called straight back in here until
    // the stack overflowed ("Store listener error" on every load, C-18).
    if (store.get('glassIntensity') !== v) store.set('glassIntensity', v, true);
  }

  setGrainIntensity(value) {
    const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
    const opacity = v === 0 ? 0 : (v / 100) * 0.15;
    document.documentElement.style.setProperty('--grain-opacity', String(opacity));
    localStorage.setItem('vault_grain', String(v));
    if (store.get('grainIntensity') !== v) store.set('grainIntensity', v, true);
    
    const grainEl = document.getElementById('grain-overlay');
    if (grainEl) {
      grainEl.style.opacity = String(opacity);
      grainEl.style.display = v === 0 ? 'none' : 'block';
    }
  }

  toggleTheme() {
    const current = this.getTheme();
    const idx = this.themes.indexOf(current);
    const next = this.themes[(idx + 1) % this.themes.length];
    this.setTheme(next);
    return next;
  }
}

export const themeManager = new ThemeManager();
export default themeManager;
