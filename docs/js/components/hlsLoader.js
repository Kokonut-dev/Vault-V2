/**
 * Lazy HLS loader — pulls in the vendored hls.js only when an HLS stream is
 * actually about to be played.
 *
 * Why lazy: hls.js is ~250 KB and the vast majority of sessions play a plain
 * MP4/MKV stream or a progressive transcode, so it is only fetched when an
 * HLS stream (Live TV, adaptive streaming) is actually opened.
 *
 * hls.js is used wherever MediaSource exists — Chrome, Edge, Firefox, desktop
 * Safari and iOS 17.1+ (ManagedMediaSource). The browser's own HLS player is
 * only a fallback for devices without MediaSource, because canPlayType() is
 * not a reliable signal (Chrome answers "maybe" and then can't play).
 *
 * Usage from the player:
 *   const ok = await attachHls(videoEl, api.hlsMasterUrl(item.id));
 *   if (!ok) fall back to the progressive transcode URL.
 */
let hlsModule = null;

/** MediaSource in any form hls.js can drive (ManagedMediaSource = iOS 17.1+). */
function mseAvailable() {
  return Boolean(window.MediaSource || window.ManagedMediaSource || window.WebKitMediaSource);
}

function nativeHls(videoEl) {
  return Boolean(videoEl?.canPlayType?.('application/vnd.apple.mpegurl'));
}

export function hlsSupported() {
  return mseAvailable() || nativeHls(document.createElement('video'));
}

async function loadHls() {
  if (window.Hls) return window.Hls;
  if (!hlsModule) {
    const mod = await import('../../vendor/hls.light.min.js');
    hlsModule = mod.default || mod.Hls || window.Hls;
  }
  return hlsModule;
}

/**
 * Attach an HLS source to a <video>. Returns true when playback was handed to
 * hls.js or the browser's native HLS support.
 */
export async function attachHls(videoEl, url, { startPosition = 0, live = false, itemId = null, onFatal = null } = {}) {
  if (!videoEl || !url) return false;
  detachHls(videoEl);

  // hls.js first, native HLS only where MediaSource doesn't exist (iPhones
  // before iOS 17.1, some TV browsers). The old order — native whenever
  // canPlayType() answered — broke when Chrome shipped a built-in HLS
  // player in late 2025: it answers "maybe" yet fails many streams with
  // MEDIA_ERR_SRC_NOT_SUPPORTED, and hls.js was never loaded. This is the
  // order hls.js itself recommends (check Hls.isSupported() first).
  if (mseAvailable()) {
    const started = await attachWithLibrary(videoEl, url, { startPosition, live, itemId, onFatal });
    if (started) return true;
  }
  if (nativeHls(videoEl)) {
    videoEl.src = url;
    if (startPosition) {
      videoEl.addEventListener('loadedmetadata', () => {
        try { videoEl.currentTime = startPosition; } catch { /* not seekable yet */ }
      }, { once: true });
    }
    return true;
  }
  return false;
}

async function attachWithLibrary(videoEl, url, { startPosition, live, itemId, onFatal }) {
  try {
    const Hls = await loadHls();
    if (!Hls?.isSupported?.()) return false;

    const hls = new Hls({
      maxBufferLength: 30,
      enableWorker: true,
      lowLatencyMode: false,
      // Server-side restreams need a few seconds to produce the next
      // segment; be patient before declaring the stream dead.
      ...(live ? { liveSyncDurationCount: 3, manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 6, fragLoadingMaxRetry: 6 } : {}),
    });
    hls.loadSource(url);
    hls.attachMedia(videoEl);
    if (startPosition) {
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        try { videoEl.currentTime = startPosition; } catch { /* not seekable yet */ }
      });
    }
    let recoveredMedia = false;
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) return;
      // A decode hiccup is often recoverable once (hls.js' documented pattern).
      if (data.type === Hls.ErrorTypes?.MEDIA_ERROR && !recoveredMedia) {
        recoveredMedia = true;
        try { hls.recoverMediaError(); return; } catch { /* fall through */ }
      }
      console.warn('[HLS] fatal error', data.type, data.details);
      hls.destroy();
      if (videoEl._vaultHls === hls) delete videoEl._vaultHls;
      if (typeof onFatal === 'function') onFatal(data);
      else window.dispatchEvent(new CustomEvent('vault:hls-failed', { detail: { url, itemId, data } }));
    });
    // Keep a handle so the player can destroy it on close.
    videoEl._vaultHls = hls;
    return true;
  } catch (err) {
    console.warn('[HLS] unavailable, falling back to progressive', err);
    return false;
  }
}

export function detachHls(videoEl) {
  if (videoEl?._vaultHls) {
    try { videoEl._vaultHls.destroy(); } catch { /* already gone */ }
    delete videoEl._vaultHls;
  }
}

export default { attachHls, detachHls, hlsSupported };
