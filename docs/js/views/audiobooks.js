/**
 * Audiobooks — resume, chapter navigation, speed and sleep timer in one
 * place (Audiobookshelf/Plexamp pattern). Audiobooks are just library items
 * of type `audiobook`; chapters come from the media API.
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { renderMediaGrid, renderSkeletonGrid } from '../components/mediaGrid.js';
import { subscribeView } from '../utils/lifecycle.js';
import { icon } from '../utils/icons.js';
import { escapeHtml, formatTime } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { getPrefs, setPrefs, applySpeed } from '../components/playbackPrefs.js';
import { setSleepTimer } from '../components/playerExtras.js';

function audiobookItems() {
  const library = store.get('library') || [];
  const explicit = library.filter(item => item.type === 'audiobook');
  // Fall back to the audiobooks path when the scanner classified files as
  // plain audio (older scans / loose MP3 collections).
  if (explicit.length) return explicit;
  return library.filter(item => item.type === 'music' && /audiobook/i.test(item.path || ''));
}

export function renderAudiobooks(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('headphones', { size: 26 })}<span>Audiobooks</span></h1>
      <p class="page-subtitle">Resume where you stopped — chapters, speed and a sleep timer are built in</p>
    </div>
    <div id="audiobooks-content"></div>
  `;
  const content = container.querySelector('#audiobooks-content');
  renderSkeletonGrid(content, 6);

  function paint() {
    const items = audiobookItems();
    if (!items.length) {
      content.innerHTML = `<div class="empty-state">${icon('headphones', { size: 30 })}
        <div class="empty-state-title">No audiobooks yet</div>
        <div class="empty-state-message">Point <code>media.paths.audiobooks</code> at a folder of MP3/M4B files and run a scan.</div></div>`;
      return;
    }
    renderMediaGrid(content, items, {
      onClick: item => openAudiobook(item),
      onPlay: item => playAudiobook(item, items),
      emptyMessage: 'No audiobooks found.',
    });
  }

  paint();
  subscribeView(store, 'library', paint);
}

function playAudiobook(item, queue = []) {
  window.dispatchEvent(new CustomEvent('vault:play', { detail: { item, queue, index: 0 } }));
}

async function openAudiobook(item) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.title)}">
      <div class="modal-header">
        <div class="modal-title">${icon('headphones', { size: 16 })}<span>${escapeHtml(item.title)}</span></div>
        <button class="modal-close" aria-label="Close">${icon('x', { size: 16 })}</button>
      </div>
      <div class="modal-body">
        <div class="row-meta">${escapeHtml(item.author || item.artist || '')} ${item.year ? `· ${item.year}` : ''} ${item.duration ? `· ${formatTime(item.duration)}` : ''}</div>
        <div class="page-actions" style="display:flex; gap:8px; flex-wrap:wrap; margin:12px 0">
          <button class="btn btn-primary btn-sm" id="ab-play">${icon('play', { size: 14 })}<span>Play</span></button>
          <button class="btn btn-secondary btn-sm" id="ab-marks">${icon('bookmark', { size: 14 })}<span>Bookmarks</span></button>
          <button class="btn btn-secondary btn-sm" id="ab-sleep">${icon('moon', { size: 14 })}<span>Sleep 30m</span></button>
          <button class="btn btn-secondary btn-sm" id="ab-skip">${icon('refresh', { size: 14 })}<span>Resume from start</span></button>
        </div>
        <div class="player-menu-section">
          <div class="player-menu-label">Speed</div>
          <div class="player-menu-actions">
            ${[0.75, 1, 1.25, 1.5, 1.75, 2].map(rate => `<button type="button" class="btn btn-ghost btn-sm" data-rate="${rate}">${rate}×</button>`).join('')}
          </div>
        </div>
        <div id="ab-chapters">
          <div class="player-menu-label">Chapters</div>
          <div class="row-meta">Loading…</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const onEscape = () => close();
  const close = () => {
    window.removeEventListener('vault:escape', onEscape);
    backdrop.remove();
  };
  backdrop.querySelector('.modal-close').addEventListener('click', close);
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
  window.addEventListener('vault:escape', onEscape);

  backdrop.querySelector('#ab-play').addEventListener('click', () => {
    playAudiobook(item);
    close();
  });
  backdrop.querySelector('#ab-sleep').addEventListener('click', () => setSleepTimer(30));
  backdrop.querySelector('#ab-skip').addEventListener('click', () => {
    store.addToHistory(item.id, 0);
    toast.success('Progress reset — play to start from the beginning');
  });
  backdrop.querySelector('#ab-marks').addEventListener('click', async () => {
    const { openBookmarks } = await import('../components/playerExtras.js');
    openBookmarks(item, time => window.dispatchEvent(new CustomEvent('vault:seek', { detail: { time } })));
  });

  const current = getPrefs().speed;
  backdrop.querySelectorAll('[data-rate]').forEach(button => {
    if (Number(button.dataset.rate) === current) button.classList.add('btn-primary');
    button.addEventListener('click', () => {
      const rate = Number(button.dataset.rate);
      setPrefs({ speed: rate }, { silent: true });
      applySpeed(rate, { announce: true });
      backdrop.querySelectorAll('[data-rate]').forEach(b => b.classList.toggle('btn-primary', b === button));
    });
  });

  try {
    const data = await api.getChapters(item.id);
    const chapters = data.chapters || [];
    const host = backdrop.querySelector('#ab-chapters');
    host.innerHTML = `<div class="player-menu-label">Chapters</div>` + (chapters.length
      ? `<div class="chapters-list">${chapters.map((chapter, index) => `
          <button type="button" class="btn btn-ghost btn-sm chapter-chip" data-start="${chapter.start}">
            ${escapeHtml(chapter.title || `Chapter ${index + 1}`)} <span class="row-meta">${formatTime(chapter.start)}</span>
          </button>`).join('')}</div>`
      : '<div class="row-meta">No chapter metadata in this file.</div>');
    host.querySelectorAll('[data-start]').forEach(button => {
      button.addEventListener('click', () => {
        playAudiobook(item);
        const time = Number(button.dataset.start);
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('vault:seek', { detail: { time } })), 600);
        close();
      });
    });
  } catch {
    backdrop.querySelector('#ab-chapters').innerHTML = '<div class="player-menu-label">Chapters</div><div class="row-meta">Chapter list unavailable.</div>';
  }
}

export default { renderAudiobooks };
