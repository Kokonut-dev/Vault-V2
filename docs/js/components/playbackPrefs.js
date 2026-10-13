/**
 * Playback preferences that apply across the audio and video players:
 *   - default playback speed (persisted, applied to every new item)
 *   - subtitle styling (size / colour / background) via `::cue`
 *   - subtitle delay for out-of-sync tracks (shifts cue times)
 *   - audio normalisation + skip-silence toggles (read by the audio player)
 *
 * Everything lives in localStorage under one key so the settings page, the
 * player menus and the keyboard layer all read the same object.
 */
import { toast } from './toast.js';

const KEY = 'vault_playback_prefs';

export const DEFAULT_PREFS = Object.freeze({
  speed: 1,
  normalize: false,
  skipSilence: false,
  subtitleSize: 100, // percent
  subtitleColor: '#ffffff',
  subtitleBackground: 'rgba(0, 0, 0, 0.6)',
  subtitleDelay: 0, // seconds, positive = later
});

export function getPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function setPrefs(patch, { silent = false } = {}) {
  const next = { ...getPrefs(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  applyAll(next);
  window.dispatchEvent(new CustomEvent('vault:playback-prefs-changed', { detail: next }));
  if (!silent) return next;
  return next;
}

export function resetPrefs() {
  localStorage.removeItem(KEY);
  applyAll({ ...DEFAULT_PREFS });
  return { ...DEFAULT_PREFS };
}

// ---------------------------------------------------------------------------
// Subtitle styling
// ---------------------------------------------------------------------------
function ensureStyleElement() {
  let style = document.getElementById('vault-subtitle-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'vault-subtitle-style';
    document.head.appendChild(style);
  }
  return style;
}

export function applySubtitleStyle(prefs = getPrefs()) {
  const style = ensureStyleElement();
  const delayNote = prefs.subtitleDelay ? `/* delay ${prefs.subtitleDelay}s applied to cues */\n` : '';
  style.textContent = `${delayNote}
    video::cue {
      font-size: ${Math.round(prefs.subtitleSize)}%;
      color: ${prefs.subtitleColor};
      background-color: ${prefs.subtitleBackground};
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
    }
    video::cue(b) { color: inherit; }
  `;
  document.querySelectorAll('#video-element').forEach(video => {
    video.style.setProperty('--subtitle-size', `${prefs.subtitleSize}%`);
  });
}

/**
 * Shift every cue in the video's text tracks by `prefs.subtitleDelay`.
 * Cue times are writable per the WebVTT spec; failures are non-fatal (the
 * style still applies, only the timing nudge is skipped).
 */
export function applySubtitleDelay(video = document.getElementById('video-element'), prefs = getPrefs()) {
  if (!video || !video.textTracks) return 0;
  let shifted = 0;
  for (const track of video.textTracks) {
    const cues = track.cues;
    if (!cues) continue;
    for (const cue of cues) {
      try {
        if (cue._vaultShown === undefined) {
          cue._vaultOriginalStart = cue.startTime;
          cue._vaultOriginalEnd = cue.endTime;
        }
        const delay = Number(prefs.subtitleDelay) || 0;
        cue.startTime = Math.max(0, cue._vaultOriginalStart + delay);
        cue.endTime = Math.max(0, cue._vaultOriginalEnd + delay);
        shifted += 1;
      } catch { /* read-only cues in this browser */ }
    }
  }
  return shifted;
}

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------
export function applySpeed(rate, { announce = false } = {}) {
  const value = Math.max(0.25, Math.min(3, Number(rate) || 1));
  const video = document.getElementById('video-element');
  if (video) {
    video.playbackRate = value;
    // Preserve pitch so podcasts/audiobooks stay intelligible.
    video.preservesPitch = true;
    video.mozPreservesPitch = true;
    video.webkitPreservesPitch = true;
  }
  const audio = document.querySelector('#audio-element') || document.querySelector('audio');
  if (audio) {
    audio.playbackRate = value;
    audio.preservesPitch = true;
  }
  if (announce) toast.info(`Playback speed ${value}×`);
  return value;
}

export function nudgeSpeed(delta) {
  const next = Math.round((getPrefs().speed + delta) * 100) / 100;
  const clamped = Math.max(0.25, Math.min(3, next));
  setPrefs({ speed: clamped }, { silent: true });
  applySpeed(clamped, { announce: true });
  return clamped;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function applyAll(prefs) {
  applySubtitleStyle(prefs);
  applySpeed(prefs.speed);
  window.dispatchEvent(new CustomEvent('vault:audio-prefs', { detail: prefs }));
}

export function initPlaybackPrefs() {
  const prefs = getPrefs();
  applyAll(prefs);

  // New video: re-apply style + delay once its tracks are attached.
  window.addEventListener('vault:video-opened', () => {
    const video = document.getElementById('video-element');
    if (!video) return;
    applySubtitleStyle();
    const run = () => {
      applySpeed(getPrefs().speed);
      applySubtitleDelay(video);
    };
    video.addEventListener('loadedmetadata', run, { once: true });
    video.textTracks?.addEventListener?.('addtrack', run);
  });

  window.addEventListener('vault:playback-prefs-changed', (event) => {
    const next = event.detail || getPrefs();
    applySubtitleStyle(next);
    applySpeed(next.speed);
    applySubtitleDelay(document.getElementById('video-element'), next);
  });

  return { getPrefs, setPrefs, resetPrefs, applySpeed, nudgeSpeed };
}

export default { initPlaybackPrefs, getPrefs, setPrefs, resetPrefs, applySpeed, nudgeSpeed, applySubtitleStyle, applySubtitleDelay };
