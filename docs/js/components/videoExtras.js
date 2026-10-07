/**
 * Video player extras — the bits that needed the v3 API surface:
 *   - Skip Intro / Skip Recap / Skip Outro from markers (Plex pattern)
 *   - chapter chips on the timeline (Jellyfin pattern)
 *   - trickplay thumbnail preview while scrubbing (Plex/Emby pattern)
 *   - quality selector backed by /api/transcode/:id?quality=…
 *   - cast button (Remote Playback API)
 *
 * Loaded by app-extras; it piggybacks on the `vault:video-opened` and
 * `vault:timeupdate` events the player already emits.
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { formatTime } from '../utils/format.js';
import { toast } from './toast.js';
import { wireCastButton } from './playerExtras.js';

const QUALITIES = [
  ['original', 'Original (direct play)'],
  ['1080p', '1080p'],
  ['720p', '720p'],
  ['480p', '480p'],
  ['360p', '360p'],
];

let state = {
  item: null,
  markers: null,
  chapters: [],
  trickplay: null,
  plan: null,
};

function video() {
  return document.getElementById('video-element');
}

function skipButton() {
  return document.getElementById('skip-intro');
}

function activeRange(time) {
  const markers = state.markers;
  if (!markers) return null;
  const ranges = [];
  if (markers.intro?.start != null && markers.intro?.end != null) {
    ranges.push({ ...markers.intro, label: 'Skip Intro' });
  }
  if (markers.recap?.start != null && markers.recap?.end != null) {
    ranges.push({ ...markers.recap, label: 'Skip Recap' });
  }
  if (markers.outro?.start != null && markers.outro?.end != null) {
    ranges.push({ ...markers.outro, label: 'Next Episode' });
  }
  return ranges.find(range => time >= range.start && time < range.end) || null;
}

function updateSkipButton(time) {
  const button = skipButton();
  if (!button) return;
  const range = activeRange(time);
  if (!range) {
    button.hidden = true;
    button.dataset.range = '';
    return;
  }
  button.hidden = false;
  button.textContent = range.label;
  button.dataset.target = String(range.end);
}

function buildChapterChips() {
  const controls = document.getElementById('video-controls');
  if (!controls || !state.chapters.length) return;
  controls.querySelector('.chapters-list')?.remove();

  const list = document.createElement('div');
  list.className = 'chapters-list';
  list.setAttribute('role', 'list');
  list.innerHTML = state.chapters.map((chapter, index) => `
    <button type="button" role="listitem" class="btn btn-ghost btn-sm chapter-chip" data-chapter="${index}" data-start="${chapter.start}">
      ${chapter.title ? chapter.title : `Chapter ${index + 1}`}
      <span class="row-meta">${formatTime(chapter.start)}</span>
    </button>`).join('');
  list.querySelectorAll('[data-chapter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const el = video();
      if (el) el.currentTime = Number(chip.dataset.start);
    });
  });
  controls.insertBefore(list, controls.firstChild);
}

function highlightChapter(time) {
  const chips = document.querySelectorAll('#video-controls .chapter-chip');
  if (!chips.length) return;
  let active = -1;
  state.chapters.forEach((chapter, index) => {
    if (chapter.start <= time) active = index;
  });
  chips.forEach((chip, index) => chip.classList.toggle('active', index === active));
}

// ---------------------------------------------------------------------------
// Trickplay preview while hovering the progress bar
// ---------------------------------------------------------------------------
function buildTrickplayPreview() {
  let preview = document.getElementById('trickplay-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.className = 'trickplay-preview';
    preview.id = 'trickplay-preview';
    preview.innerHTML = '<img alt="" aria-hidden="true">';
    document.body.appendChild(preview);
  }
  return preview;
}

function wireTrickplay() {
  const progress = document.getElementById('video-progress');
  if (!progress || !state.trickplay) return;
  const preview = buildTrickplayPreview();
  const img = preview.querySelector('img');
  const meta = state.trickplay;
  const sheetWidth = (meta.tileWidth || 160) * (meta.columns || 10);
  const sheetHeight = (meta.tileHeight || 90) * (meta.rows || 10);

  const show = (event) => {
    const el = video();
    if (!el?.duration) return;
    const rect = progress.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const time = ratio * el.duration;
    const index = Math.floor(time / (meta.interval || 10));
    const sheet = Math.floor(index / ((meta.columns || 10) * (meta.rows || 10)));
    const within = index % ((meta.columns || 10) * (meta.rows || 10));
    const col = within % (meta.columns || 10);
    const row = Math.floor(within / (meta.columns || 10));
    if (!meta.sheets?.[sheet]) return;

    img.src = meta.sheets[sheet].startsWith('http') ? meta.sheets[sheet] : `${api.baseUrl}${meta.sheets[sheet]}`;
    img.style.width = `${sheetWidth}px`;
    img.style.height = `${sheetHeight}px`;
    img.style.objectFit = 'none';
    img.style.objectPosition = `-${col * (meta.tileWidth || 160)}px -${row * (meta.tileHeight || 90)}px`;
    img.style.transform = `scale(${176 / sheetWidth})`;
    img.style.transformOrigin = 'top left';
    preview.style.width = '176px';
    preview.style.height = `${Math.round(sheetHeight * (176 / sheetWidth))}px`;
    preview.style.left = `${Math.min(window.innerWidth - 190, Math.max(8, rect.left + ratio * rect.width - 88))}px`;
    preview.style.top = `${rect.top - preview.offsetHeight - 12}px`;
    preview.classList.add('active');
  };

  progress.addEventListener('mousemove', show);
  progress.addEventListener('mouseleave', () => preview.classList.remove('active'));
  progress.addEventListener('focus', () => preview.classList.remove('active'));
}

// ---------------------------------------------------------------------------
// Quality selector
// ---------------------------------------------------------------------------
function buildQualityButton() {
  const speed = document.getElementById('video-speed');
  if (!speed || document.getElementById('video-quality')) return;
  const button = document.createElement('button');
  button.className = 'video-control-btn';
  button.id = 'video-quality';
  button.setAttribute('aria-label', 'Quality');
  button.textContent = 'Auto';
  speed.parentNode.insertBefore(button, speed);

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'video-quality-menu';
  menu.innerHTML = QUALITIES.map(([value, label]) => `
    <button type="button" class="context-menu-item" data-quality="${value}">
      ${icon('gauge', { size: 15 })}<span>${label}</span>
    </button>`).join('');
  document.body.appendChild(menu);

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.right - 232)}px`;
    menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 8)}px`;
    menu.classList.add('active');
  });
  document.addEventListener('click', () => menu.classList.remove('active'));

  menu.querySelectorAll('[data-quality]').forEach(option => {
    option.addEventListener('click', async () => {
      menu.classList.remove('active');
      const quality = option.dataset.quality;
      const el = video();
      if (!el || !state.item) return;
      const resume = el.currentTime;
      const wasPlaying = !el.paused;
      button.textContent = quality === 'original' ? 'Auto' : quality;

      el.src = quality === 'original'
        ? api.getStreamUrl(state.item.id)
        : api.getTranscodeUrl(state.item.id, quality);
      const onMeta = () => {
        el.currentTime = resume;
        if (wasPlaying) el.play().catch(() => {});
        el.removeEventListener('loadedmetadata', onMeta);
      };
      el.addEventListener('loadedmetadata', onMeta);
      el.load();

      try {
        const plan = await api.getPlan(state.item.id, quality);
        if (plan?.transcode) toast.info(`Transcoding with ${plan.encoder?.label || 'CPU'} (${plan.reasons?.join(', ') || 'compatibility'})`);
      } catch { /* plan is informational only */ }
    });
  });
}

// ---------------------------------------------------------------------------
// Loading extras for the current item
// ---------------------------------------------------------------------------
async function loadItemExtras(item) {
  state = { item, markers: null, chapters: [], trickplay: null, plan: null };
  if (!item) return;

  const [markers, chapters, trickplay] = await Promise.all([
    api.getMarkers(item.id).catch(() => null),
    api.getChapters(item.id).catch(() => null),
    api.getTrickplay(item.id).catch(() => null),
  ]);

  // Fall back to the series-level intro the server remembers.
  if (markers && !markers.intro && item.seriesKey) {
    try {
      const series = await api.getMarkers(`series_${item.seriesKey}`);
      if (series?.intro) markers.intro = series.intro;
    } catch { /* no series markers */ }
  }

  state.markers = markers && (markers.intro || markers.outro || markers.recap) ? markers : null;
  state.chapters = chapters?.chapters || markers?.chapters || [];
  state.trickplay = trickplay?.sheets?.length ? trickplay : null;

  if (state.chapters.length) buildChapterChips();
  if (state.trickplay) wireTrickplay();
  updateSkipButton(0);
}

export function initVideoExtras() {
  window.addEventListener('vault:video-opened', (event) => loadItemExtras(event.detail?.item));
  window.addEventListener('vault:timeupdate', (event) => {
    const { currentTime } = event.detail || {};
    if (typeof currentTime !== 'number') return;
    updateSkipButton(currentTime);
    highlightChapter(currentTime);
  });
  window.addEventListener('vault:video-closed', () => {
    state = { item: null, markers: null, chapters: [], trickplay: null, plan: null };
  });

  const button = skipButton();
  if (button) {
    button.addEventListener('click', () => {
      const el = video();
      if (el && button.dataset.target) el.currentTime = Number(button.dataset.target);
    });
  }

  // Quality menu is created lazily but the cast button can be wired now.
  wireCastButton(document.getElementById('cast-button'));
  document.addEventListener('vault:player-ready', () => {
    buildQualityButton();
  });
  // The controls exist before the first open, so try immediately too.
  setTimeout(buildQualityButton, 800);
}

export default { initVideoExtras };
