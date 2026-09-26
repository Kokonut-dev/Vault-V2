/**
 * Video Player — optimized: rAF throttled progress, cleanup listeners, debounced history
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { formatTime, escapeHtml } from '../utils/format.js';

let videoEl = null;
let isTheatre = false;
let isFullscreen = false;
let controlsTimeout = null;
let currentItem = null;
let rafId = null;
let lastProgressSave = 0;
let nextEpisodeListener = null;
let nextEpisodeInterval = null;

export function initVideoPlayer() {
  videoEl = document.getElementById('video-element');
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('video-player');
  const controls = document.getElementById('video-controls');
  const progress = document.getElementById('video-progress');
  const played = document.getElementById('video-played');
  const buffered = document.getElementById('video-buffered');
  const thumb = document.getElementById('video-thumb');
  const playBtn = document.getElementById('video-play');
  const muteBtn = document.getElementById('video-mute');
  const volumeSlider = document.getElementById('video-volume');
  const currentTimeEl = document.getElementById('video-current');
  const durationEl = document.getElementById('video-duration');
  const fullscreenBtn = document.getElementById('video-fullscreen');
  const theatreBtn = document.getElementById('video-theatre');
  const pipBtn = document.getElementById('video-pip');
  const closeBtn = document.getElementById('video-close');
  const captionsBtn = document.getElementById('video-captions');
  const eqBtn = document.getElementById('video-eq');
  const speedBtn = document.getElementById('video-speed');
  const nextBtn = document.getElementById('video-next');
  
  if (!videoEl) return;
  
  // Play/pause
  playBtn.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
  });
  
  videoEl.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play();
    else videoEl.pause();
  });
  
  videoEl.addEventListener('play', () => {
    playBtn.textContent = '⏸';
    player.classList.remove('paused');
  });
  
  videoEl.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    player.classList.add('paused');
  });
  
  // Progress — throttled via rAF to avoid layout thrash on every timeupdate
  videoEl.addEventListener('timeupdate', () => {
    if (rafId) return; // already scheduled
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!videoEl.duration) return;
      const percent = (videoEl.currentTime / videoEl.duration) * 100;
      played.style.width = `${percent}%`;
      thumb.style.left = `${percent}%`;
      currentTimeEl.textContent = formatTime(videoEl.currentTime);
      
      // Debounced history save: only every 5s
      const now = Date.now();
      if (currentItem && now - lastProgressSave > 5000) {
        lastProgressSave = now;
        store.addToHistory(currentItem.id, percent);
      }
    });
  });
  
  videoEl.addEventListener('loadedmetadata', () => {
    durationEl.textContent = formatTime(videoEl.duration);
  });
  
  videoEl.addEventListener('progress', () => {
    if (videoEl.buffered.length > 0) {
      const bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
      const percent = (bufferedEnd / videoEl.duration) * 100;
      buffered.style.width = `${percent}%`;
    }
  });
  
  // Seek
  progress.addEventListener('click', (e) => {
    const rect = progress.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    videoEl.currentTime = percent * videoEl.duration;
  });
  
  // Drag seek
  let isDragging = false;
  thumb.addEventListener('mousedown', () => isDragging = true);
  document.addEventListener('mouseup', () => isDragging = false);
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = progress.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    videoEl.currentTime = percent * videoEl.duration;
  });
  
  // Volume
  muteBtn.addEventListener('click', () => {
    videoEl.muted = !videoEl.muted;
    muteBtn.textContent = videoEl.muted ? '🔇' : '🔊';
  });
  
  volumeSlider.addEventListener('input', (e) => {
    videoEl.volume = parseFloat(e.target.value);
    videoEl.muted = false;
    muteBtn.textContent = videoEl.volume === 0 ? '🔇' : '🔊';
  });
  
  // Fullscreen
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      player.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
  
  document.addEventListener('fullscreenchange', () => {
    isFullscreen = !!document.fullscreenElement;
    player.classList.toggle('fullscreen', isFullscreen);
    fullscreenBtn.textContent = isFullscreen ? '⛶' : '⛶';
  });
  
  // Theatre
  theatreBtn.addEventListener('click', () => {
    isTheatre = !isTheatre;
    player.classList.toggle('theatre', isTheatre);
    store.set('theatreMode', isTheatre);
  });
  
  // PiP
  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await videoEl.requestPictureInPicture();
      }
    } catch (err) {
      console.warn('PiP failed', err);
    }
  });
  
  // Close
  closeBtn.addEventListener('click', closePlayer);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePlayer();
  });
  
  // Captions
  captionsBtn.addEventListener('click', () => {
    const tracks = videoEl.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = tracks[i].mode === 'showing' ? 'hidden' : 'showing';
    }
  });
  
  // Speed
  let speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
  let speedIdx = 3;
  speedBtn.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    videoEl.playbackRate = speeds[speedIdx];
    speedBtn.textContent = `${speeds[speedIdx]}x`;
  });
  
  // Next episode
  nextBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:play-next-episode'));
  });
  
  // Keyboard
  window.addEventListener('vault:player-action', (e) => {
    if (!modal.style.display || modal.style.display === 'none') return;
    const { action, percent } = e.detail;
    switch (action) {
      case 'playPause':
        if (videoEl.paused) videoEl.play(); else videoEl.pause();
        break;
      case 'seekBack':
        videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
        break;
      case 'seekForward':
        videoEl.currentTime = Math.min(videoEl.duration, videoEl.currentTime + 10);
        break;
      case 'mute':
        videoEl.muted = !videoEl.muted;
        break;
      case 'fullscreen':
        fullscreenBtn.click();
        break;
      case 'theatre':
        theatreBtn.click();
        break;
      case 'pip':
        pipBtn.click();
        break;
      case 'captions':
        captionsBtn.click();
        break;
      case 'seekPercent':
        if (percent !== undefined) videoEl.currentTime = (percent / 100) * videoEl.duration;
        break;
    }
  });
  
  // Show/hide controls on mousemove
  player.addEventListener('mousemove', () => {
    player.classList.add('show-controls');
    clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
      if (!videoEl.paused) player.classList.remove('show-controls');
    }, 3000);
  });
  
  // Open video event
  window.addEventListener('vault:open-video', (e) => {
    openPlayer(e.detail.item);
  });
  
  console.log('[VideoPlayer] Initialized');
}

export function openPlayer(item) {
  currentItem = item;
  const modal = document.getElementById('video-modal');
  const videoEl = document.getElementById('video-element');
  
  // Clear old tracks
  while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild);
  
  // Set source
  videoEl.src = api.getStreamUrl(item.id);
  
  // Subtitles
  if (item.subtitles && item.subtitles.length > 0) {
    item.subtitles.forEach(sub => {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = sub.language || 'Unknown';
      track.srclang = sub.language || 'en';
      track.src = api.getSubtitleUrl(item.id, sub.id);
      track.default = false;
      videoEl.appendChild(track);
    });
  }
  
  // Resume position if exists
  const history = store.get('history').find(h => h.itemId === item.id);
  if (history && history.progress > 5 && history.progress < 95) {
    videoEl.addEventListener('loadedmetadata', function onMeta() {
      videoEl.currentTime = (history.progress / 100) * videoEl.duration;
      videoEl.removeEventListener('loadedmetadata', onMeta);
    });
  }
  
  modal.style.display = 'flex';
  videoEl.load();
  videoEl.play().catch(() => {});
  
  // Check for next episode if series
  if (item.season && item.episode) {
    checkNextEpisode(item);
  }
}

export function closePlayer() {
  const modal = document.getElementById('video-modal');
  const vEl = document.getElementById('video-element');
  
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (controlsTimeout) { clearTimeout(controlsTimeout); controlsTimeout = null; }
  if (nextEpisodeListener) { vEl.removeEventListener('timeupdate', nextEpisodeListener); nextEpisodeListener = null; }
  if (nextEpisodeInterval) { clearInterval(nextEpisodeInterval); nextEpisodeInterval = null; }
  
  vEl.pause();
  vEl.src = '';
  modal.style.display = 'none';
  
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  
  currentItem = null;
  lastProgressSave = 0;
}

function checkNextEpisode(item) {
  const library = store.get('library');
  const next = library.find(i => 
    i.title === item.title && 
    i.season === item.season && 
    i.episode === item.episode + 1
  );
  
  if (next) {
    const overlay = document.getElementById('next-episode-overlay');
    const titleEl = document.getElementById('next-episode-title');
    if (titleEl) titleEl.textContent = `S${next.season}E${next.episode} — ${escapeHtml(next.title)}`;
    const imgEl = document.getElementById('next-episode-img');
    if (imgEl) imgEl.src = api.getThumbnailUrl(next.id);
    
    // Cleanup previous listener if any
    if (nextEpisodeListener && videoEl) {
      videoEl.removeEventListener('timeupdate', nextEpisodeListener);
    }
    nextEpisodeListener = function showNext() {
      if (videoEl.duration - videoEl.currentTime < 30) {
        overlay?.classList.add('active');
        startCountdown(next);
        videoEl.removeEventListener('timeupdate', nextEpisodeListener);
        nextEpisodeListener = null;
      }
    };
    videoEl.addEventListener('timeupdate', nextEpisodeListener);
  }
}

function startCountdown(nextItem) {
  if (nextEpisodeInterval) clearInterval(nextEpisodeInterval);
  let count = 10;
  const el = document.getElementById('next-episode-countdown');
  nextEpisodeInterval = setInterval(() => {
    count--;
    if (el) el.textContent = String(count);
    if (count <= 0) {
      clearInterval(nextEpisodeInterval);
      nextEpisodeInterval = null;
      openPlayer(nextItem);
    }
  }, 1000);
  
  // Cancel if user interacts
  document.getElementById('video-element')?.addEventListener('click', () => {
    if (nextEpisodeInterval) { clearInterval(nextEpisodeInterval); nextEpisodeInterval = null; }
  }, { once: true });
}
