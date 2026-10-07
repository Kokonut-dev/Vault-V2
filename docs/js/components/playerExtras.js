/**
 * Player extras that apply to both audio and video:
 *   - sleep timer / "stop after N items" with a gentle fade-out (Plexamp)
 *   - casting (Remote Playback API → AirPlay, and Vault-to-Vault rooms)
 *   - bookmarks (timestamped notes per item)
 *   - playback stats panel ("stats for nerds")
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { formatTime } from '../utils/format.js';
import { toast } from './toast.js';
import { modal } from './modal.js';

// ---------------------------------------------------------------------------
// Sleep timer
// ---------------------------------------------------------------------------
const sleep = {
  timeoutId: null,
  endsAt: null,
  stopAfter: null,
  played: 0,
  fadeSeconds: 20,
};

function fadeOutAndPause() {
  const media = document.querySelector('#video-element') || document.querySelector('#audio-element') || document.querySelector('audio');
  if (!media) return;

  const originalVolume = media.volume;
  const steps = 40;
  const stepMs = (sleep.fadeSeconds * 1000) / steps;
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    media.volume = Math.max(0, originalVolume * (1 - step / steps));
    if (step >= steps) {
      clearInterval(timer);
      media.pause();
      media.volume = originalVolume;
      window.dispatchEvent(new CustomEvent('vault:sleep-triggered'));
      toast.info('Sleep timer finished — playback paused');
    }
  }, stepMs);
}

export function setSleepTimer(minutes, { fade = true } = {}) {
  clearSleepTimer({ silent: true });
  if (!minutes) return null;
  sleep.endsAt = Date.now() + minutes * 60000;
  sleep.fadeSeconds = fade ? 20 : 0;
  const delay = Math.max(0, minutes * 60000 - (fade ? sleep.fadeSeconds * 1000 : 0));
  sleep.timeoutId = setTimeout(() => {
    if (fade) fadeOutAndPause();
    else {
      const media = document.querySelector('#video-element') || document.querySelector('audio');
      media?.pause();
      toast.info('Sleep timer finished — playback paused');
    }
    clearSleepTimer({ silent: true });
  }, delay);
  toast.success(`Sleeping in ${minutes} min${fade ? ' (fades out)' : ''}`);
  updateSleepIndicator();
  return sleep.endsAt;
}

export function stopAfterItems(count) {
  sleep.stopAfter = count;
  sleep.played = 0;
  toast.success(count ? `Stopping after ${count} more item${count === 1 ? '' : 's'}` : 'Stop-after cleared');
  updateSleepIndicator();
}

export function clearSleepTimer({ silent = false } = {}) {
  if (sleep.timeoutId) clearTimeout(sleep.timeoutId);
  sleep.timeoutId = null;
  sleep.endsAt = null;
  sleep.stopAfter = null;
  sleep.played = 0;
  updateSleepIndicator();
  if (!silent) toast.info('Sleep timer cleared');
}

export function onItemFinished() {
  if (!sleep.stopAfter) return;
  sleep.played += 1;
  if (sleep.played >= sleep.stopAfter) {
    const media = document.querySelector('#video-element') || document.querySelector('audio');
    media?.pause();
    toast.info('Stop-after limit reached — playback paused');
    clearSleepTimer({ silent: true });
  }
}

function updateSleepIndicator() {
  const badge = document.getElementById('sleep-indicator');
  if (!badge) return;
  const active = !!sleep.endsAt || !!sleep.stopAfter;
  badge.classList.toggle('active', active);
  if (sleep.endsAt) {
    const left = Math.max(0, Math.round((sleep.endsAt - Date.now()) / 60000));
    badge.textContent = `${icon('moon', { size: 13 })} ${left}m`;
  } else if (sleep.stopAfter) {
    badge.textContent = `${icon('moon', { size: 13 })} ×${sleep.stopAfter}`;
  }
}

/** Settings row used by both player menus. */
export function renderSleepMenu() {
  return `
    <div class="player-menu-section">
      <div class="player-menu-label">Sleep timer</div>
      <div class="player-menu-actions">
        ${[15, 30, 45, 60, 90].map(m => `<button type="button" class="btn btn-ghost btn-sm" data-sleep="${m}">${m}m</button>`).join('')}
        <button type="button" class="btn btn-ghost btn-sm" data-sleep="0">Off</button>
      </div>
    </div>
    <div class="player-menu-section">
      <div class="player-menu-label">Stop after</div>
      <div class="player-menu-actions">
        ${[1, 2, 3, 5].map(n => `<button type="button" class="btn btn-ghost btn-sm" data-stop-after="${n}">${n} item${n === 1 ? '' : 's'}</button>`).join('')}
        <button type="button" class="btn btn-ghost btn-sm" data-stop-after="0">Off</button>
      </div>
    </div>
  `;
}

export function wireSleepMenu(root) {
  root.querySelectorAll('[data-sleep]').forEach(button => {
    button.addEventListener('click', () => {
      const minutes = Number(button.dataset.sleep);
      if (!minutes) clearSleepTimer();
      else setSleepTimer(minutes);
    });
  });
  root.querySelectorAll('[data-stop-after]').forEach(button => {
    button.addEventListener('click', () => stopAfterItems(Number(button.dataset.stopAfter)));
  });
}

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------
export function castSupported() {
  const video = document.getElementById('video-element');
  return !!(video && video.remote && typeof video.remote.prompt === 'function');
}

export async function startCast() {
  const video = document.getElementById('video-element');
  if (!video?.remote) {
    toast.info('This browser has no cast target. Use Picture-in-Picture or open Vault on the other device.');
    return false;
  }
  try {
    await video.remote.prompt();
    toast.success('Sent to the remote player');
    return true;
  } catch (err) {
    // AbortError simply means the user dismissed the picker.
    if (err?.name !== 'AbortError') toast.error(`Cast failed: ${err.message}`);
    return false;
  }
}

export function wireCastButton(button) {
  if (!button) return;
  const supported = castSupported();
  button.hidden = !supported;
  button.addEventListener('click', startCast);
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------
export async function addBookmarkFor(item, time, label = null) {
  if (!item) return null;
  try {
    const bookmark = await api.addBookmark({ itemId: item.id, time, label: label || `At ${formatTime(time)}` });
    toast.success('Bookmark saved');
    window.dispatchEvent(new CustomEvent('vault:bookmarks-changed', { detail: { item } }));
    return bookmark;
  } catch (err) {
    toast.error(`Could not save bookmark: ${err.message}`);
    return null;
  }
}

export async function openBookmarks(item, onSeek) {
  let bookmarks = [];
  try {
    const data = await api.getBookmarks(item.id);
    bookmarks = data.bookmarks || [];
  } catch {
    bookmarks = [];
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Bookmarks">
      <div class="modal-header">
        <div class="modal-title">${icon('bookmark', { size: 16 })}<span>Bookmarks — ${item.title}</span></div>
        <button class="modal-close" aria-label="Close">${icon('x', { size: 16 })}</button>
      </div>
      <div class="modal-body">
        <button type="button" class="btn btn-primary btn-sm" id="bookmark-add">${icon('plus', { size: 14 })}<span>Bookmark current position</span></button>
        <div class="bookmark-list" id="bookmark-list"></div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const list = backdrop.querySelector('#bookmark-list');
  const close = () => backdrop.remove();

  const renderList = () => {
    list.innerHTML = bookmarks.length
      ? bookmarks.map(b => `<div class="bookmark-row">
          <button type="button" class="bookmark-jump" data-time="${b.time}">${icon('play', { size: 13 })} ${formatTime(b.time)}</button>
          <span class="bookmark-label">${b.label}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-remove="${b.id}" aria-label="Delete bookmark">${icon('trash', { size: 13 })}</button>
        </div>`).join('')
      : `<div class="empty-state compact"><div class="empty-state-text">No bookmarks yet.</div></div>`;

    list.querySelectorAll('.bookmark-jump').forEach(button => {
      button.addEventListener('click', () => {
        onSeek?.(Number(button.dataset.time));
        close();
      });
    });
    list.querySelectorAll('[data-remove]').forEach(button => {
      button.addEventListener('click', async () => {
        await api.removeBookmark(button.dataset.remove);
        bookmarks = bookmarks.filter(b => b.id !== button.dataset.remove);
        renderList();
      });
    });
  };
  renderList();

  backdrop.querySelector('#bookmark-add').addEventListener('click', async () => {
    const time = window.vaultPlayback?.currentTime?.() ?? 0;
    const bookmark = await addBookmarkFor(item, time);
    if (bookmark) {
      bookmarks.unshift(bookmark);
      renderList();
    }
  });
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  window.addEventListener('vault:escape', close, { once: true });
  return backdrop;
}

// ---------------------------------------------------------------------------
// Stats for nerds
// ---------------------------------------------------------------------------
export function renderStatsPanel(plan, extra = {}) {
  if (!plan) return '';
  const rows = [
    ['Quality', plan.quality],
    ['Playback', plan.directPlay ? 'Direct play' : `Transcode (${plan.encoder?.label || 'CPU'})`],
    ['Reason', plan.reasons?.join(', ')],
    ['Source', `${plan.source.width}×${plan.source.height} · ${plan.source.videoCodec}/${plan.source.audioCodec} · ${Math.round((plan.source.bitrate || 0) / 1000)} kbps`],
    ['Container', plan.source.container],
    extra.video && ['Resolution out', `${extra.video.videoWidth}×${extra.video.videoHeight}`],
    extra.video && ['Dropped frames', extra.video.dropped ?? '—'],
    extra.buffered !== undefined && ['Buffered ahead', `${extra.buffered.toFixed(1)}s`],
    extra.latency !== undefined && ['Decoder latency', `${Math.round(extra.latency)}ms`],
    ['Hardware', (plan.capabilities?.hardwareAcceleration || []).join(', ') || 'software only'],
  ].filter(Boolean);

  return `
    <table class="stats-table">
      ${rows.map(([label, value]) => `<tr><th>${label}</th><td>${String(value ?? '—')}</td></tr>`).join('')}
    </table>
  `;
}

export { sleep as _sleep, updateSleepIndicator, api, modal };
