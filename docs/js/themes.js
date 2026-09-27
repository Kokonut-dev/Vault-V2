/**
 * Theme manager — handles dark/light/warm/cold + glass + grain
 */
import { store } from './store.js';

export class ThemeManager {
  constructor() {
    this.themes = ['dark', 'light', 'warm', 'cold'];
  }

  init() {
    const saved = store.get('theme') || 'dark';
    this.setTheme(saved);
    
    const glass = store.get('glassIntensity');
    this.setGlassIntensity(glass);
    
    const grain = store.get('grainIntensity');
    this.setGrainIntensity(grain);

    store.subscribe('theme', (theme) => this.setTheme(theme));
    store.subscribe('glassIntensity', (val) => this.setGlassIntensity(val));
    store.subscribe('grainIntensity', (val) => this.setGrainIntensity(val));
  }

  setTheme(theme) {
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
    root.setAttribute('data-theme', theme);
    root.classList.add('theme-transition');
    clearTimeout(this._themeTransitionTimer);
    this._themeTransitionTimer = setTimeout(() => {
      root.classList.remove('theme-transition');
    }, 500);

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
    store.set('glassIntensity', v, true);
    localStorage.setItem('vault_glass', String(v));
  }

  setGrainIntensity(value) {
    const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
    const opacity = v === 0 ? 0 : (v / 100) * 0.15;
    document.documentElement.style.setProperty('--grain-opacity', String(opacity));
    store.set('grainIntensity', v, true);
    localStorage.setItem('vault_grain', String(v));
    
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
