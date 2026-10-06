/**
 * Keyboard shortcuts manager
 *
 * One global keydown handler. Decision order, and why:
 *
 *   1. Alt/Cmd+Space opens search — the one chord allowed while typing, because
 *      it never produces a character.
 *   2. Escape always broadcasts on `vault:escape` (modals, palette, panels).
 *   3. Text entry wins. Inside a text field every other keystroke belongs to
 *      that field; we don't preventDefault and we don't dispatch anything.
 *      (Fixed: the Space = play/pause shortcut used to run with an input
 *      focused, so spaces could not be typed into the upload metadata fields —
 *      title / artist / genre / description — or any other input. Only
 *      `#search-input` was special-cased.)
 *   4. A focused control owns its keys: Space/Enter activate a focused button
 *      or link, arrows drive a focused slider/select.
 *   5. Ctrl/Cmd/Alt chords belong to the browser/OS: Cmd+P print, Cmd+S save,
 *      Cmd+R reload, Ctrl+N new window, etc.
 *   6. Player shortcuts fire only while a player is genuinely on screen.
 *      (Fixed: the check matched the always-present `.video-player` node inside
 *      the hidden video modal, so `s`, `n`, `c`, `f`, `m`… hijacked keystrokes
 *      on every page even with nothing playing.)
 */

const TEXT_ENTRY_TYPES = new Set([
  'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'week', 'time',
]);

// Space/Enter "click" these — the browser has to see the keystroke.
const ACTIVATABLE_TAGS = new Set(['button', 'summary']);
const ACTIVATABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'option', 'tab',
]);
const ACTIVATABLE_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'color', 'file',
]);

// Arrows/Home/End drive these natively — steering a volume slider or a
// <select> must not double-fire the app's media shortcuts.
// Deliberately NOT role="slider": #video-progress is one, it has no key
// handler of its own, and the arrows/digits here are what seek it.
const NAV_KEYS = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);
const NAV_TAGS = new Set(['select']);

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const tagName = (el) => (el && el.tagName ? el.tagName.toLowerCase() : '');
const attr = (el, name) => (el && typeof el.getAttribute === 'function' ? el.getAttribute(name) : null);

export class KeyboardManager {
  constructor() {
    this.shortcuts = new Map();
    this.sequence = [];
    this.sequenceTimer = null;
    this.enabled = true;
  }

  init() {
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
  }

  register(keys, callback, options = {}) {
    const id = Math.random().toString(36).substr(2, 9);
    this.shortcuts.set(id, { keys: this.normalizeKeys(keys), callback, options });
    return id;
  }

  unregister(id) {
    this.shortcuts.delete(id);
  }

  normalizeKeys(keys) {
    if (typeof keys === 'string') return keys.toLowerCase();
    return keys;
  }

  /** True when the element consumes plain characters (alt text fields). */
  isTyping(el = document.activeElement) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = tagName(el);
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const type = (attr(el, 'type') || 'text').toLowerCase();
      return TEXT_ENTRY_TYPES.has(type);
    }
    return TEXT_ROLES.has(attr(el, 'role'));
  }

  /**
   * True when the focused element is the one that should react to this key.
   * Space/Enter on a button (and arrow keys on a slider/select) are the
   * control's own interaction — the global layer steps aside.
   */
  controlOwns(e) {
    const el = e.target;
    if (!el || typeof el.getAttribute !== 'function') return false;
    const tag = tagName(el);
    if (tag === 'body' || tag === 'html' || !tag) return false;

    if (e.key === ' ' || e.key === 'Enter') {
      if (ACTIVATABLE_TAGS.has(tag)) return true;
      if (tag === 'a' && el.hasAttribute && el.hasAttribute('href')) return true;
      if (tag === 'input') {
        const type = (attr(el, 'type') || 'text').toLowerCase();
        if (ACTIVATABLE_INPUT_TYPES.has(type)) return true;
      }
      if (ACTIVATABLE_ROLES.has(attr(el, 'role'))) return true;
    }

    if (NAV_KEYS.has(e.key)) {
      if (NAV_TAGS.has(tag)) return true;
      if (tag === 'input' && (attr(el, 'type') || '').toLowerCase() === 'range') return true;
    }

    return false;
  }

  /** A player that should react to media keys is actually on screen. */
  hasActivePlayer() {
    return !!document.querySelector('#video-modal.active, #mini-player.active, #now-playing.active');
  }

  handleKeyDown(e) {
    if (!this.enabled) return;
    if (e.defaultPrevented) return; // a handler closer to the target used it

    // 1. Global search — works from inside text fields (types no character)
    if ((e.altKey || e.metaKey) && e.code === 'Space') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('vault:open-search'));
      return;
    }

    // 2. Escape always bubbles out to modals / panes
    if (e.key === 'Escape') {
      window.dispatchEvent(new CustomEvent('vault:escape'));
      return;
    }

    // 3. Typing wins — hand the keystroke back to the field untouched
    if (this.isTyping()) return;

    // 4. A focused control keeps its own keys
    if (this.controlOwns(e)) return;

    // 5. Browser/OS chords are not ours
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // 6. `?` opens the shortcuts panel
    if (e.key === '?') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('vault:show-shortcuts'));
      return;
    }

    // 7. "G then H/M/U/V/P/F/S" navigation
    if (e.key.toLowerCase() === 'g') {
      this.sequence = ['g'];
      clearTimeout(this.sequenceTimer);
      this.sequenceTimer = setTimeout(() => { this.sequence = []; }, 1000);
      return;
    }

    if (this.sequence.length === 1 && this.sequence[0] === 'g') {
      const key = e.key.toLowerCase();
      const navMap = {
        h: 'home',
        m: 'movies',
        u: 'music',
        v: 'videos',
        p: 'playlists',
        f: 'favourites',
        s: 'settings',
      };
      if (navMap[key]) {
        e.preventDefault();
        this.sequence = [];
        const page = navMap[key] === 'home' ? '/' : `/${navMap[key]}`;
        window.dispatchEvent(new CustomEvent('vault:navigate', { detail: { page } }));
        return;
      }
      this.sequence = [];
    }

    // 8. Player shortcuts — only when a player is open
    if (!this.hasActivePlayer()) return;

    // 0-9 seek to 0%-90% (this branch used to be unreachable: digits were
    // never in the player key map below)
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('vault:player-action', {
        detail: { action: 'seekPercent', percent: parseInt(e.key, 10) * 10 },
      }));
      return;
    }

    const playerKeys = {
      ' ': 'playPause',
      k: 'playPause',
      j: 'seekBack',
      l: 'seekForward',
      arrowleft: 'seekBack',
      arrowright: 'seekForward',
      arrowup: 'volumeUp',
      arrowdown: 'volumeDown',
      m: 'mute',
      f: 'fullscreen',
      t: 'theatre',
      p: 'pip',
      c: 'captions',
      n: 'next',
      s: 'shuffle',
      r: 'repeat',
    };

    const lowerKey = e.key.toLowerCase();
    const code = e.code.toLowerCase();
    const action = playerKeys[lowerKey] || playerKeys[code];
    if (!action) return;

    // Shift+N = previous
    if (lowerKey === 'n' && e.shiftKey) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'prev' } }));
      return;
    }

    e.preventDefault();
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action } }));
  }

  disable() {
    this.enabled = false;
  }

  enable() {
    this.enabled = true;
  }
}

export const keyboardManager = new KeyboardManager();
export default keyboardManager;
