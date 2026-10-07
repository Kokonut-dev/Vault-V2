/**
 * Lyrics view (Spotify/Apple Music pattern).
 *
 * Reads sidecar `.lrc` (synced) or embedded lyrics through the API, highlights
 * the current line, click-to-seek, and offers an offset nudge for files whose
 * timings drift.
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { toast } from './toast.js';

const OFFSET_KEY = 'vault_lyrics_offset';

let container = null;
let lines = [];
let synced = false;
let offset = Number(localStorage.getItem(OFFSET_KEY) || 0);
let activeIndex = -1;
let currentItemId = null;

function formatOffset(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}s`;
}

function render() {
  if (!container) return;

  if (!lines.length && !container.dataset.plain) {
    container.innerHTML = `<div class="lyrics-empty">${icon('music', { size: 26 })}
      <div class="empty-state-title">No lyrics for this track</div>
      <div class="empty-state-text">Add a <code>.lrc</code> file next to the audio file, or embed lyrics in the tags.</div>
    </div>`;
    return;
  }

  if (!synced) {
    container.innerHTML = `<div class="lyrics-plain">${(container.dataset.plain || '').split('\n').map(l => `<p>${l}</p>`).join('')}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="lyrics-toolbar">
      <button type="button" class="btn btn-ghost btn-sm" data-offset="-0.5" aria-label="Lyrics 0.5 seconds earlier">${icon('minus', { size: 13 })}0.5s</button>
      <span class="lyrics-offset" title="Lyrics timing offset">${formatOffset(offset)}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-offset="0.5" aria-label="Lyrics 0.5 seconds later">+0.5s</button>
    </div>
    <div class="lyrics-lines" role="list">
      ${lines.map((line, index) => `<button type="button" role="listitem" class="lyrics-line" data-index="${index}" data-time="${line.time}">${line.text}</button>`).join('')}
    </div>
  `;

  container.querySelectorAll('[data-offset]').forEach(button => {
    button.addEventListener('click', () => {
      offset = Math.round((offset + Number(button.dataset.offset)) * 10) / 10;
      localStorage.setItem(OFFSET_KEY, String(offset));
      render();
      if (activeIndex >= 0) highlight(activeIndex);
    });
  });

  container.querySelectorAll('.lyrics-line').forEach(node => {
    node.addEventListener('click', () => {
      const time = Number(node.dataset.time) - offset;
      window.dispatchEvent(new CustomEvent('vault:seek', { detail: { time: Math.max(0, time) } }));
    });
  });
}

function highlight(index) {
  if (!container || !synced) return;
  const nodes = container.querySelectorAll('.lyrics-line');
  nodes.forEach((node, i) => node.classList.toggle('active', i === index));
  const node = nodes[index];
  if (node && container.scrollHeight > container.clientHeight) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

export function setLyricTime(currentTime) {
  if (!synced || !lines.length) return;
  const time = currentTime + offset;
  let index = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= time) index = i;
    else break;
  }
  if (index !== activeIndex) {
    activeIndex = index;
    highlight(index);
  }
}

export async function loadLyrics(item, target = container) {
  container = target || container;
  if (!container || !item) return;
  currentItemId = item.id;
  lines = [];
  synced = false;
  activeIndex = -1;
  container.dataset.plain = '';
  container.innerHTML = `<div class="lyrics-loading"><span class="loading-dots"><span></span><span></span><span></span></span></div>`;

  try {
    const data = await api.getLyrics(item.id);
    if (currentItemId !== item.id) return; // switched tracks mid-flight
    if (data?.lines?.length) {
      lines = data.lines;
      synced = !!data.synced;
    } else if (data?.lyrics) {
      container.dataset.plain = data.lyrics;
    }
    render();
  } catch {
    render();
  }
}

export function initLyrics() {
  const host = document.getElementById('lyrics-container');
  if (host) container = host;

  window.addEventListener('vault:timeupdate', (event) => {
    const time = event.detail?.currentTime;
    if (typeof time === 'number') setLyricTime(time);
  });

  window.addEventListener('vault:track-changed', (event) => {
    const item = event.detail?.item;
    if (container && document.getElementById('now-playing')?.classList.contains('active')) {
      loadLyrics(item);
    }
  });

  return { loadLyrics, setLyricTime };
}

export function openLyricsModal(item) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal modal-lyrics" role="dialog" aria-modal="true" aria-label="Lyrics">
      <div class="modal-header">
        <div class="modal-title">${icon('music', { size: 16 })}<span>Lyrics</span></div>
        <button class="modal-close" aria-label="Close lyrics">${icon('x', { size: 16 })}</button>
      </div>
      <div class="modal-body"><div id="lyrics-modal-body" class="lyrics-container"></div></div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  window.addEventListener('vault:escape', close, { once: true });
  loadLyrics(item, backdrop.querySelector('#lyrics-modal-body'));
  return backdrop;
}
