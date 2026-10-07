/**
 * Lazy HLS loader — pulls in the vendored hls.js only when an HLS stream is
 * actually about to be played.
 *
 * Why lazy: hls.js is ~250 KB and the vast majority of sessions play a plain
 * MP4/MKV stream or a progressive transcode. Safari plays HLS natively, so the
 * library is not fetched at all there.
 *
 * Usage from the player:
 *   const ok = await attachHls(videoEl, api.hlsMasterUrl(item.id));
 *   if (!ok) fall back to the progressive transcode URL.
 */
let hlsModule = null;

export function hlsSupported() {
  if (window.Hls) return true;
  const video = document.createElement('video');
  return !!video.canPlayType('application/vnd.apple.mpegurl');
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
export async function attachHls(videoEl, url, { startPosition = 0 } = {}) {
  if (!videoEl || !url) return false;

  // Native HLS (Safari, iOS, some smart-TV browsers) — no library needed.
  if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    videoEl.src = url;
    if (startPosition) videoEl.currentTime = startPosition;
    return true;
  }

  if (!window.MediaSource) return false;

  try {
    const Hls = await loadHls();
    if (!Hls?.isSupported?.()) return false;

    const hls = new Hls({
      maxBufferLength: 30,
      enableWorker: true,
      lowLatencyMode: false,
    });
    hls.loadSource(url);
    hls.attachMedia(videoEl);
    if (startPosition) {
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        try { videoEl.currentTime = startPosition; } catch { /* not seekable yet */ }
      });
    }
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) {
        console.warn('[HLS] fatal error, falling back', data.type, data.details);
        hls.destroy();
        window.dispatchEvent(new CustomEvent('vault:hls-failed', { detail: { url, data } }));
      }
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
