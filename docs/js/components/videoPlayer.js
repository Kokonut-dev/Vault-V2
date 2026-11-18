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
let streamSession = null; // server restream (Live TV / IPTV) currently attached
let openToken = 0; // bumps on every open/close so stale async opens bail out
let retryOptions = { forceTranscode: true };

/**
 * Live TV / IPTV entries are not library items: they have no /api/media
 * stream, no transcode-by-id, no history, markers or thumbnails. Treating
 * them like library items is what made every fallback 404.
 */
export function isExternalItem(item) {
  return Boolean(item && (item.channelId || item.external || String(item.id || '').startsWith('live:')));
}

// Server error codes that a retry can't fix (wrong credentials, dead link…).
const FINAL_CODES = new Set(['NO_FFMPEG', 'AUTH', 'NOT_FOUND', 'BLOCKED', 'UNSUPPORTED_SCHEME', 'NOT_MEDIA', 'NO_STREAMS', 'CHANNEL_NOT_FOUND', 'ADMIN_REQUIRED']);

function mediaErrorMessage(err) {
  switch (err?.code) {
    case 1: return 'Playback was stopped.';
    case 2: return 'The stream stopped arriving — the connection to the Vault server dropped.';
    case 3: return 'Your browser couldn\'t decode this stream.';
    case 4: return 'Your browser can\'t play this stream\'s format.';
    default: return 'This stream could not be played.';
  }
}

function hlsFailureMessage(data) {
  const status = data?.response?.code || data?.networkDetails?.status;
  if (status === 404) return 'This stream ended on the server (it may have been idle too long).';
  if (status === 401) return 'Your session expired. Sign in again to keep watching.';
  if (data?.type === 'mediaError') return 'Your browser couldn\'t decode this stream, even after conversion.';
  return 'The connection to the Vault server dropped while playing this stream.';
}

function setStatus(message) {
  const el = document.getElementById('video-status');
  if (!el) return;
  const msg = el.querySelector('.video-status-msg');
  if (msg) msg.textContent = message || '';
  el.hidden = !message;
}

function releaseStream() {
  if (streamSession) {
    api.stopChannelStream(streamSession.sessionId);
    streamSession = null;
  }
}

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

function setError(message, showTranscode = false, { label = 'Try transcoding', forceTranscode = true } = {}) {
  const el = document.getElementById('video-error');
  if (!el) return;
  setStatus(null);
  const msg = el.querySelector('.video-error-msg');
  if (msg) msg.textContent = message || 'Playback failed';
  const retry = el.querySelector('#video-retry-transcode');
  retryOptions = { forceTranscode };
  if (retry) {
    retry.textContent = label;
    retry.style.display = showTranscode ? 'inline-flex' : 'none';
  }
  el.style.display = 'flex';
  (showTranscode ? retry : el.querySelector('#video-error-close'))?.focus?.({ preventScroll: true });
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
  const downloadBtn = document.getElementById('video-download');
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
    if (playBtn) {
      setIcon(playBtn, 'pause', { size: 20 });
      playBtn.setAttribute('aria-label', 'Pause');
    }
    player?.classList.remove('paused');
    clearError();
  });

  videoEl.addEventListener('pause', () => {
    if (playBtn) {
      setIcon(playBtn, 'play', { size: 20 });
      playBtn.setAttribute('aria-label', 'Play');
    }
    player?.classList.add('paused');
  });

  videoEl.addEventListener('error', () => {
    const err = videoEl.error;
    console.error('[VideoPlayer] error', err);
    if (!currentItem) return;

    // Live TV / IPTV: never fall back to library routes (they 404 for these).
    if (currentItem.channelId) {
      // No attached restream means this error belongs to a stream we
      // already tore down (hls.js reported it first) — ignore it.
      if (!streamSession) return;
      channelFailed(currentItem, mediaErrorMessage(err));
      return;
    }
    if (isExternalItem(currentItem)) {
      setError(`${mediaErrorMessage(err)} The source may use a format browsers can't play, or it may be offline.`, false);
      return;
    }

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
          itemId: currentItem.id,
          onFatal: () => setError('This file could not be played, even after converting it on the server. Check that ffmpeg is installed on the server, or try downloading the file instead.', false),
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
      if (currentItem && !isExternalItem(currentItem) && now - lastProgressSave > 5000) {
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
    if (durationEl) durationEl.textContent = currentItem?.live || !Number.isFinite(videoEl.duration) ? 'Live' : formatTime(videoEl.duration);
  });
  videoEl.addEventListener('playing', () => setStatus(null));
  videoEl.addEventListener('waiting', () => {
    if (streamSession && !videoEl.currentTime) setStatus('Buffering…');
  });

  // OS-level media controls (lock screen, Windows/macOS media keys, Android
  // notification). Audio had this; video did not (Tier 3 item).
  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !currentItem) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentItem.title || 'Vault',
        artist: currentItem.artist || currentItem.genre || '',
        album: currentItem.season ? `S${String(currentItem.season).padStart(2, '0')}E${String(currentItem.episode || 0).padStart(2, '0')}` : (currentItem.album || 'Vault'),
        artwork: currentItem.poster || currentItem.cover
          ? [{ src: currentItem.poster || currentItem.cover, sizes: '512x512', type: 'image/jpeg' }]
          : (isExternalItem(currentItem) ? [] : [{ src: api.getThumbnailUrl(currentItem.id), sizes: '320x180', type: 'image/jpeg' }]),
      });
    } catch { /* MediaMetadata unsupported */ }

    const video = videoEl;
    navigator.mediaSession.setActionHandler?.('play', () => video?.play().catch(() => {}));
    navigator.mediaSession.setActionHandler?.('pause', () => video?.pause());
    navigator.mediaSession.setActionHandler?.('seekbackward', () => {
      if (video) video.currentTime = Math.max(0, video.currentTime - 10);
    });
    navigator.mediaSession.setActionHandler?.('seekforward', () => {
      if (video) video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
    });
    navigator.mediaSession.setActionHandler?.('seekto', (details) => {
      if (video && details.seekTime != null) video.currentTime = details.seekTime;
    });
    try {
      navigator.mediaSession.setActionHandler?.('nexttrack', nextBtn && !nextBtn.disabled ? () => nextBtn.click() : null);
    } catch { /* handler unsupported */ }
  }

  window.addEventListener('vault:video-opened', () => {
    updateMediaSession();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  videoEl.addEventListener('pause', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
  videoEl.addEventListener('play', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  videoEl.addEventListener('ended', () => {
    // Two things used to be missing here (audit note): nothing told the
    // server the item finished, and no event fired for the "stop after N"
    // sleep timer / next-episode logic to hook into.
    if (currentItem && !isExternalItem(currentItem)) {
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
  downloadBtn?.addEventListener('click', () => {
    if (!currentItem || isExternalItem(currentItem)) return;
    if (api.downloadItemFile(currentItem)) toast.success(`Downloading "${currentItem.title}"`);
  });


  retryBtn?.addEventListener('click', () => {
    if (currentItem) openPlayer(currentItem, { ...retryOptions });
  });
  document.getElementById('video-error-close')?.addEventListener('click', closePlayer);

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

  // Closing the tab mid-stream: tell the server so ffmpeg stops now rather
  // than when the idle reaper notices.
  window.addEventListener('pagehide', releaseStream);

  window.addEventListener('vault:open-video', (e) => {
    if (e.detail?.item) openPlayer(e.detail.item);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closePlayer();
  });

  syncMuteIcon();

}

export function openPlayer(item, { forceTranscode = false } = {}) {
  const token = ++openToken;
  if (item && isExternalItem(item)) item.external = true;
  // Switching items (or retrying) must not leave the previous restream
  // running on the server or the previous hls.js instance attached.
  releaseStream();
  currentItem = item;
  usingTranscode = !!forceTranscode;
  const modal = document.getElementById('video-modal');
  videoEl = document.getElementById('video-element') || videoEl;
  if (!videoEl || !modal) return;

  clearError();
  setStatus(null);
  if (videoEl._vaultHls) {
    try { videoEl._vaultHls.destroy(); } catch { /* already gone */ }
    delete videoEl._vaultHls;
  }
  const durationLabel = document.getElementById('video-duration');
  const currentLabel = document.getElementById('video-current');
  if (durationLabel) durationLabel.textContent = item?.live ? 'Live' : '0:00';
  if (currentLabel) currentLabel.textContent = '0:00';
  const playerEl = document.getElementById('video-player');
  playerEl?.classList.toggle('is-external', isExternalItem(item));
  playerEl?.classList.toggle('is-live', Boolean(item?.live));

  while (videoEl.firstChild) videoEl.removeChild(videoEl.firstChild);

  if (item?.channelId) {
    openChannel(item, { forceTranscode, token, modal });
    return;
  }
  if (isExternalItem(item)) {
    openExternal(item, { token, modal });
    return;
  }

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

/**
 * Live TV / IPTV entry: ask the server to restream it as HLS (copying
 * browser-friendly codecs, converting the rest), then attach hls.js.
 * Ladder: auto (copy where possible) → forced conversion → explained error.
 */
async function openChannel(item, { forceTranscode, token, modal }) {
  const player = document.getElementById('video-player');
  showModal(modal);
  player?.classList.add('paused', 'show-controls');
  setStatus(forceTranscode ? 'Converting the stream on the server…' : `Tuning in to ${item.title || 'the channel'}…`);
  window.dispatchEvent(new CustomEvent('vault:video-opened', { detail: { item } }));

  let session;
  try {
    session = await api.playChannel(item.channelId, { transcode: forceTranscode });
  } catch (err) {
    if (token !== openToken) return;
    const retryable = !FINAL_CODES.has(err.code);
    setError(err.message || 'This channel could not be started.', retryable, { label: 'Try again', forceTranscode });
    return;
  }
  if (token !== openToken) {
    api.stopChannelStream(session.sessionId);
    return;
  }
  streamSession = session;
  const url = api.liveStreamUrl(session.playlist);
  if (api.isMixedContent(url)) {
    setError(api.mixedContentHelp(url), false);
    return;
  }

  const { attachHls } = await import('./hlsLoader.js');
  if (token !== openToken) return;
  const started = await attachHls(videoEl, url, {
    live: session.live,
    onFatal: (data) => {
      if (token === openToken) channelFailed(item, hlsFailureMessage(data));
    },
  });
  if (token !== openToken) return;
  if (!started) {
    setError('This browser can\'t play streamed (HLS) video. Try a current version of Chrome, Edge, Firefox or Safari.', false);
    return;
  }
  setStatus(session.plan?.directPlayable === false && !forceTranscode ? 'Converting the stream on the server…' : 'Starting playback…');
  startWhenReady(token);
}

/**
 * play() called while hls.js is still wiring up its MediaSource rejects with
 * an AbortError ("interrupted by a new load request") and the video then
 * sits paused on a black frame. Try now, and again once media can play;
 * only a real autoplay block (NotAllowedError) leaves it to the user.
 */
function startWhenReady(token) {
  const player = document.getElementById('video-player');
  const attempt = () => {
    if (token !== openToken || !videoEl.paused) return;
    videoEl.play().catch((err) => {
      if (token !== openToken) return;
      if (err?.name === 'NotAllowedError') {
        setStatus(null);
        player?.classList.add('paused', 'show-controls');
      }
    });
  };
  videoEl.addEventListener('canplay', attempt, { once: true });
  attempt();
}

/** First failure → retry with full conversion; second → explain and stop. */
function channelFailed(item, message) {
  if (!item || currentItem !== item) return;
  if (!usingTranscode) {
    toast.info('Playback failed — converting the stream on the server…');
    openPlayer(item, { forceTranscode: true });
    return;
  }
  releaseStream();
  setError(message, true, { label: 'Try again', forceTranscode: true });
}

/** An item that carries its own URL but isn't a Live TV channel. */
async function openExternal(item, { token, modal }) {
  const url = item.streamUrl;
  showModal(modal);
  document.getElementById('video-player')?.classList.add('paused', 'show-controls');
  if (!url) {
    setError('This item has no playable source.', false);
    return;
  }
  if (api.isMixedContent(url)) {
    setError(api.mixedContentHelp(url), false);
    return;
  }
  window.dispatchEvent(new CustomEvent('vault:video-opened', { detail: { item } }));
  if (/\.m3u8(\?|$)/i.test(url)) {
    const { attachHls } = await import('./hlsLoader.js');
    if (token !== openToken) return;
    const started = await attachHls(videoEl, url, {
      live: Boolean(item.live),
      onFatal: (data) => {
        if (token === openToken) setError(`${hlsFailureMessage(data)} The source may block playback from other sites (CORS) or be offline.`, false);
      },
    });
    if (!started) {
      setError('This browser can\'t play streamed (HLS) video.', false);
      return;
    }
  } else {
    videoEl.src = url;
    videoEl.load();
  }
  startWhenReady(token);
}

export function closePlayer() {
  openToken++;
  releaseStream();
  setStatus(null);
  const modal = document.getElementById('video-modal');
  const vEl = document.getElementById('video-element');
  document.getElementById('video-player')?.classList.remove('is-live', 'is-external');
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
