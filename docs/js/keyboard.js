/**
 * Keyboard shortcuts manager
 */
import { store } from './store.js';

export class KeyboardManager {
  constructor() {
    this.shortcuts = new Map();
    this.sequence = [];
    this.sequenceTimer = null;
    this.enabled = true;
  }

  init() {
    document.addEventListener('keydown', this.handleKeyDown.bind(this));
    
    // Detect if user is typing in input
    this.isTyping = () => {
      const active = document.activeElement;
      if (!active) return false;
      const tag = active.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable;
    };
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

  handleKeyDown(e) {
    if (!this.enabled) return;

    // Global search: Alt+Space / Option+Space
    if ((e.altKey || e.metaKey) && e.code === 'Space') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('vault:open-search'));
      return;
    }

    // ? to show shortcuts (when not typing)
    if (e.key === '?' && !this.isTyping()) {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('vault:show-shortcuts'));
      return;
    }

    // Escape
    if (e.key === 'Escape') {
      window.dispatchEvent(new CustomEvent('vault:escape'));
      return;
    }

    // Don't handle other shortcuts when typing, except space for player
    if (this.isTyping()) {
      // Allow space for player when not in text input? Check if input is search
      if (e.code === 'Space' && document.activeElement.id !== 'search-input') {
        // Let player handle it
      } else {
        return;
      }
    }

    // Sequence handling for G then H etc.
    if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.sequence = ['g'];
      clearTimeout(this.sequenceTimer);
      this.sequenceTimer = setTimeout(() => this.sequence = [], 1000);
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
        window.dispatchEvent(new CustomEvent('vault:navigate', { detail: { page: navMap[key] } }));
        return;
      }
      this.sequence = [];
    }

    // Player shortcuts
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

    if (playerKeys[lowerKey] || playerKeys[code]) {
      // Only if player is active or video is focused
      const hasPlayer = document.querySelector('.video-player, .mini-player.active, .now-playing.active');
      if (hasPlayer) {
        const action = playerKeys[lowerKey] || playerKeys[code];
        
        // Handle Shift+N for previous
        if (lowerKey === 'n' && e.shiftKey) {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'prev' } }));
          return;
        }

        // Number keys 0-9 for seek percentage
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const percent = parseInt(e.key, 10) * 10;
          window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'seekPercent', percent } }));
          return;
        }

        e.preventDefault();
        window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action } }));
      }
    }
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
