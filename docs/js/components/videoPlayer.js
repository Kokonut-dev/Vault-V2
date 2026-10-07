/**
 * Video Player — custom overlay with transcode fallback.
 * Fixes: modal used .modal-backdrop (opacity:0 so video was invisible),
 * play() errors swallowed, no transcode fallback, no error UI.
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { formatTime, escapeHtml } from '../utils/format.js';
import { toast } from './toast.js';
import { showEQModal } from './eqPanel.js';
import { setIcon } from '../utils/icons.js';

let videoEl = null;
let isTheatre = false;
let isFullscreen = false;
let controlsTimeout = null;
let currentItem = null;
let rafId = null;
let lastProgressSave = 0;
let nextEpisodeListener = null;
let nextEpisodeInterval = null;
let usingTranscode = false;

function showModal(modal) {
  if (!modal) return;
  modal.hidden = false;
  modal.classList.add('active');
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
}

function hideModal(modal) {
  if (!modal) return;
  modal.hidden = true;
  modal.classList.remove('active');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
}

function setError(message, showTranscode = false) {
  const el = document.getElementById('video-error');
  if (!el) return;
  const msg = el.querySelector('.video-error-msg');
  if (msg) msg.textContent = message || 'Playback failed';
  const retry = el.querySelector('#video-retry-transcode');
  if (retry) retry.style.display = showTranscode ? 'inline-flex' : 'none';
  el.style.display = 'flex';
}

function clearError() {
  const el = document.getElementById('video-error');
  if (el) el.style.display = 'none';
}

export function initVideoPlayer() {
  videoEl = document.getElementById('video-element');
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('video-player');
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
  const retryBtn = document.getElementById('video-retry-transcode');

  if (!videoEl || !modal) return;

  playBtn?.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play().catch(err => toast.error(err.message || 'Play failed'));
    else videoEl.pause();
  });

  videoEl.addEventListener('click', () => {
    if (videoEl.paused) videoEl.play().catch(() => {});
    else videoEl.pause();
  });

  videoEl.addEventListener('play', () => {
    if (playBtn) setIcon(playBtn, 'pause', { size: 20 });
    player?.classList.remove('paused');
    clearError();
  });

  videoEl.addEventListener('pause', () => {
    if (playBtn) setIcon(playBtn, 'play', { size: 20 });
    player?.classList.add('paused');
  });

  videoEl.addEventListener('error', () => {
    const err = videoEl.error;
    console.error('[VideoPlayer] error', err);

    // Attempt ladder: direct play → progressive transcode → HLS (if the
    // browser supports MSE and the vendored hls.js loads). Each step is only
    // taken once per item so a broken file cannot loop forever.
    if (currentItem && !usingTranscode) {
      toast.info('Direct play failed — trying transcode…');
      openPlayer(currentItem, { forceTranscode: true });
      return;
    }
    if (currentItem && usingTranscode && !currentItem._triedHls) {
      currentItem._triedHls = true;
      import('./hlsLoader.js').then(async ({ attachHls }) => {
        const started = await attachHls(videoEl, api.hlsMasterUrl(currentItem.id), {
          startPosition: videoEl.currentTime || 0,
        });
        if (!started) {
          setError('This file could not be played. The codec may be unsupported or the server is unreachable.', false);
          return;
        }
        clearError();
        toast.info('Switched to adaptive streaming (HLS)');
        videoEl.play().catch(() => player?.classList.add('paused', 'show-controls'));
      });
      return;
    }
    setError('This file could not be played. The codec may be unsupported or the server is unreachable.', false);
  });

  videoEl.addEventListener('timeupdate', () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!videoEl.duration) return;
      const percent = (videoEl.currentTime / videoEl.duration) * 100;
      if (played) played.style.width = `${percent}%`;
      if (thumb) thumb.style.left = `${percent}%`;
      if (currentTimeEl) currentTimeEl.textContent = formatTime(videoEl.currentTime);
      if (progress) {
        progress.setAttribute('aria-valuenow', String(Math.round(percent)));
        progress.setAttribute('aria-valuetext', `${formatTime(videoEl.currentTime)} of ${formatTime(videoEl.duration || 0)}`);
      }
      const now = Date.now();
      if (currentItem && now - lastProgressSave > 5000) {
        lastProgressSave = now;
        store.addToHistory(currentItem.id, percent);
      }
      // v3: one shared tick for lyrics highlighting, skip-intro prompts,
      // chapter highlighting and the trickplay preview.
      window.dispatchEvent(new CustomEvent('vault:timeupdate', {
        detail: { currentTime: videoEl.currentTime, duration: videoEl.duration, item: currentItem },
      }));
    });
  });

  videoEl.addEventListener('loadedmetadata', () => {
    if (durationEl) durationEl.textContent = formatTime(videoEl.duration);
  });

  videoEl.addEventListener('ended', () => {
    // Two things used to be missing here (audit note): nothing told the
    // server the item finished, and no event fired for the "stop after N"
    // sleep timer / next-episode logic to hook into.
    if (currentItem) {
      api.markCompleted?.(currentItem.id).catch(() => {});
      store.addToHistory?.(currentItem.id, 100);
    }
    window.dispatchEvent(new CustomEvent('vault:item-finished', { detail: { item: currentItem } }));
  });

  videoEl.addEventListener('progress', () => {
    if (videoEl.buffered.length > 0 && videoEl.duration) {
      const bufferedEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
      const percent = (bufferedEnd / videoEl.duration) * 100;
      if (buffered) buffered.style.width = `${percent}%`;
    }
  });

  progress?.addEventListener('click', (e) => {
    const rect = progress.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    if (videoEl.duration) videoEl.currentTime = percent * videoEl.duration;
  });

  let isDragging = false;
  thumb?.addEventListener('mousedown', () => { isDragging = true; });
  document.addEventListener('mouseup', () => { isDragging = false; });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging || !progress) return;
    const rect = progress.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (videoEl.duration) videoEl.currentTime = percent * videoEl.duration;
  });

  const syncMuteIcon = () => {
    if (!muteBtn) return;
    setIcon(muteBtn, videoEl.muted || videoEl.volume === 0 ? 'volume-x' : 'volume-2', { size: 18 });
  };

  muteBtn?.addEventListener('click', () => {
    videoEl.muted = !videoEl.muted;
    syncMuteIcon();
  });

  volumeSlider?.addEventListener('input', (e) => {
    videoEl.volume = parseFloat(e.target.value);
    videoEl.muted = false;
    syncMuteIcon();
  });

  fullscreenBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      (player || modal).requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });

  document.addEventListener('fullscreenchange', () => {
    isFullscreen = !!document.fullscreenElement;
    player?.classList.toggle('fullscreen', isFullscreen);
    if (fullscreenBtn) setIcon(fullscreenBtn, isFullscreen ? 'minimize' : 'maximize', { size: 18 });
  });

  theatreBtn?.addEventListener('click', () => {
    isTheatre = !isTheatre;
    player?.classList.toggle('theatre', isTheatre);
    store.set('theatreMode', isTheatre);
  });

  pipBtn?.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoEl.requestPictureInPicture();
    } catch (err) {
      toast.info('Picture-in-Picture is not available');
    }
  });

  closeBtn?.addEventListener('click', closePlayer);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePlayer();
  });

  captionsBtn?.addEventListener('click', () => {
    const tracks = videoEl.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].mode = tracks[i].mode === 'showing' ? 'hidden' : 'showing';
    }
  });

  eqBtn?.addEventListener('click', () => {
    try { showEQModal(); } catch {}
  });

  let speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
  let speedIdx = 3;
  speedBtn?.addEventListener('click', () => {
    speedIdx = (speedIdx + 1) % speeds.length;
    videoEl.playbackRate = speeds[speedIdx];
    speedBtn.textContent = `${speeds[speedIdx]}x`;
  });

  nextBtn?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:play-next-episode'));
  });

  retryBtn?.addEventListener('click', () => {
    if (currentItem) openPlayer(currentItem, { forceTranscode: true });
  });

  window.addEventListener('vault:player-action', (e) => {
    if (!modal.classList.contains('active')) return;
    const { action, percent } = e.detail || {};
    switch (action) {
      case 'playPause':
        if (videoEl.paused) videoEl.play().catch(() => {});
        else videoEl.pause();
        break;
      case 'seekBack':
        videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
        break;
      case 'seekForward':
        videoEl.currentTime = Math.min(videoEl.duration || 0, videoEl.currentTime + 10);
        break;
      case 'mute':
        videoEl.muted = !videoEl.muted;
        syncMuteIcon();
        break;
      case 'fullscreen':
        fullscreenBtn?.click();
        break;
      case 'theatre':
        theatreBtn?.click();
        break;
      case 'pip':
        pipBtn?.click();
        break;
      case 'captions':
        captionsBtn?.click();
        break;
      case 'seekPercent':
        if (percent !== undefined && videoEl.duration) videoEl.currentTime = (percent / 100) * videoEl.duration;
        break;
    }
  });

  player?.addEventListener('mousemove', () => {
    player.classList.add('show-controls');
    clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
      if (!videoEl.paused) player.classList.remove('show-controls');
    }, 3000);
  });

  window.addEventListener('vault:open-video', (e) => {
    if (e.detail?.item) openPlayer(e.detail.item);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closePlayer();
  });

  syncMuteIcon();

}

export function openPlayer(item, { forceTranscode = false } = {}) {
  currentItem = item;
  usingTranscode = !!forceTranscode;
  const modal = document.getElementById('video-modal');
  videoEl = document.getElementById('video-element') || videoEl;
  if (!videoEl || !modal) return;

  clearError();

  while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild);

  const url = api.getPlaybackUrl(item, { forceTranscode });
  if (api.isMixedContent(url)) {
    // Only genuinely-blocked URLs reach this point (loopback/localhost URLs are
    // allowed by browsers and play fine from GitHub Pages).
    showModal(modal);
    setError(api.mixedContentHelp(url), false);
    return;
  }

  videoEl.src = url;
  usingTranscode = forceTranscode || api.needsTranscode(item);

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

  const history = (store.get('history') || []).find(h => h.itemId === item.id);
  if (history && history.progress > 5 && history.progress < 95) {
    const onMeta = () => {
      videoEl.currentTime = (history.progress / 100) * videoEl.duration;
      videoEl.removeEventListener('loadedmetadata', onMeta);
    };
    videoEl.addEventListener('loadedmetadata', onMeta);
  }

  showModal(modal);
  const player = document.getElementById('video-player');
  player?.classList.add('paused', 'show-controls');

  videoEl.load();
  videoEl.play().catch((err) => {
    console.warn('[VideoPlayer] play() rejected', err);
    // Autoplay policies: show controls so user can press play
    player?.classList.add('paused', 'show-controls');
    if (!usingTranscode) {
      // Keep the overlay visible; user can retry
    }
  });

  if (item.season && item.episode) checkNextEpisode(item);

  // Let the v3 extras layer load markers (skip intro/outro), chapters,
  // trickplay metadata and the transcode plan for this item.
  window.dispatchEvent(new CustomEvent('vault:video-opened', { detail: { item } }));
}

export function closePlayer() {
  const modal = document.getElementById('video-modal');
  const vEl = document.getElementById('video-element');
  window.dispatchEvent(new CustomEvent('vault:video-closed'));
  if (vEl) {
    import('./hlsLoader.js').then(({ detachHls }) => detachHls(vEl)).catch(() => {});
  }

  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (controlsTimeout) { clearTimeout(controlsTimeout); controlsTimeout = null; }
  if (nextEpisodeListener && vEl) { vEl.removeEventListener('timeupdate', nextEpisodeListener); nextEpisodeListener = null; }
  if (nextEpisodeInterval) { clearInterval(nextEpisodeInterval); nextEpisodeInterval = null; }

  if (vEl) {
    vEl.pause();
    vEl.removeAttribute('src');
    vEl.load();
  }
  hideModal(modal);

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }

  currentItem = null;
  lastProgressSave = 0;
  usingTranscode = false;
  clearError();
}

function checkNextEpisode(item) {
  const library = store.get('library') || [];
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

  document.getElementById('video-element')?.addEventListener('click', () => {
    if (nextEpisodeInterval) { clearInterval(nextEpisodeInterval); nextEpisodeInterval = null; }
  }, { once: true });
}
