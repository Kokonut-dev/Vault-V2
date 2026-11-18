/**
 * Which player is in charge right now — the video modal while it's open,
 * otherwise the audio player.
 *
 * Several features (sleep timer, stop-after, lyrics/chapter/bookmark seeks,
 * playback speed, SyncPlay) used to grab
 *   document.querySelector('#video-element') || document.querySelector('audio')
 * but #video-element is always in the page (the modal is just hidden) and the
 * audio player's element is never in the DOM. So they all acted on the hidden
 * video: the sleep timer never paused music or audiobooks, and clicking a
 * lyric line or chapter didn't move the audio.
 */
export function videoPlayerOpen() {
  return Boolean(document.getElementById('video-modal')?.classList.contains('active'));
}

function audioApi() {
  return window.VAULT_AUDIO || null;
}

/** The media element the user is hearing, or null when nothing is loaded. */
export function activeMedia() {
  if (videoPlayerOpen()) return document.getElementById('video-element');
  return audioApi()?.getElement?.() || null;
}

/** Position in seconds (audio: includes the offset of a restarted conversion). */
export function activeTime() {
  if (!videoPlayerOpen() && audioApi()?.currentTime) return audioApi().currentTime();
  const media = activeMedia();
  return media && Number.isFinite(media.currentTime) ? media.currentTime : 0;
}

export function activeDuration() {
  if (!videoPlayerOpen() && audioApi()?.duration) return audioApi().duration();
  const media = activeMedia();
  return media && Number.isFinite(media.duration) ? media.duration : 0;
}

/** Seek whichever player is active; resumes playback. Returns false if none. */
export function seekActive(time) {
  const t = Math.max(0, Number(time) || 0);
  if (!videoPlayerOpen() && audioApi()?.seek) return audioApi().seek(t);
  const media = activeMedia();
  if (!media) return false;
  try { media.currentTime = t; } catch { return false; }
  if (media.paused) media.play().catch(() => {});
  return true;
}

export function pauseActive() {
  activeMedia()?.pause?.();
}
