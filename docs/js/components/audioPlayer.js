/**
 * Audio Player — queue, gapless hand-off, crossfade, Web Audio EQ.
 *
 * Routing rules (why playback used to fail or go quiet):
 *  - The <audio> element is only routed through Web Audio while something
 *    needs it (EQ on, normalisation, skip-silence, the Now Playing
 *    visualizer). Routing is permanent per element, and a routed element
 *    plays *silence* for sources without CORS (podcast hosts, radio
 *    streams), so foreign-origin sources always get a plain element.
 *  - Volume lives on the element only. It used to be applied to the element
 *    *and* a gain node, so the slider behaved like volume² (50% → 25%).
 *  - Mute follows `store.isMuted` wherever it is changed (the mini-player
 *    slider un-muted the icon but left the element muted).
 *  - Every playback start has a sequence number: a superseded start (user
 *    clicked another track) never falls back to transcoding the *old* track,
 *    and a failure is handled once (the play() rejection and the element's
 *    error event used to both retry and both toast).
 *  - Timing uses timers, not requestAnimationFrame, which stops in
 *    background tabs (crossfade, history and progress used to stall there).
 *  - Converted streams (WMA, ALAC, AIFF…) aren't byte-seekable, so seeking
 *    restarts the server conversion at the new position.
 */
import { store } from '../store.js';
import { ShufflePlanner } from '../utils/shuffle.js';
import { api } from '../api.js';
import { toast } from './toast.js';

let audioContext = null;
const sourceNodes = new WeakMap();
let gainNode = null;
let eqNodes = [];
let compressorNode = null;
let analyserNode = null;
let currentAudio = null;
let nextAudio = null;
let isCrossfading = false;
let crossfadeTimer = null;
let crossfadeFinish = null;
let graphReady = false;
let unlockBound = false;
let silenceMonitor = null;
let analyserRequested = false;
let explicitRate = null; // speed chosen from the player for the current item

// The track that is playing (or starting): which start it belongs to, which
// attempt (direct → converted), and the offset of a restarted conversion.
let playSeq = 0;
let currentPlay = null;

const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const AUDIO_TYPES = new Set(['music', 'podcast', 'audiobook']);

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function initAudioContext() {
  if (audioContext) return audioContext;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioContext = new Ctx();
    gainNode = audioContext.createGain();
    gainNode.gain.value = 1; // volume is applied on the element, see header
    compressorNode = audioContext.createDynamicsCompressor();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    applyNormalization(readAudioPrefs().normalize);

    eqNodes = EQ_FREQUENCIES.map(freq => {
      const filter = audioContext.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1;
      filter.gain.value = 0;
      return filter;
    });
    for (let i = 1; i < eqNodes.length; i++) eqNodes[i - 1].connect(eqNodes[i]);
    eqNodes[eqNodes.length - 1].connect(compressorNode);
    compressorNode.connect(gainNode);
    gainNode.connect(analyserNode);
    analyserNode.connect(audioContext.destination);

    // A routed element is silent while the context is suspended (iOS
    // interruptions, Chrome after a device change). Resume while playing.
    audioContext.addEventListener?.('statechange', () => {
      if (audioContext.state !== 'running' && currentAudio && !currentAudio.paused && sourceNodes.has(currentAudio)) {
        audioContext.resume().catch(() => {});
      }
    });

    applyEQ();
    graphReady = true;
    return audioContext;
  } catch (err) {
    console.warn('Web Audio API not supported:', err);
    graphReady = false;
    return null;
  }
}

async function unlockAudio() {
  if (!graphWanted() && !audioContext) return false;
  initAudioContext();
  if (!audioContext) return false;
  if (audioContext.state !== 'running') {
    try { await audioContext.resume(); } catch (err) {
      console.warn('[AudioPlayer] resume failed', err);
    }
  }
  return audioContext.state === 'running';
}

function applyEQ() {
  const gains = store.get('eqGains') || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const enabled = store.get('eqEnabled');
  eqNodes.forEach((node, idx) => {
    try { node.gain.value = enabled ? (gains[idx] || 0) : 0; } catch {}
  });
  window.dispatchEvent(new CustomEvent('vault:eq-updated', { detail: { gains } }));
}

function apiOrigin() {
  try {
    return new URL(api.baseUrl || window.VAULT_CONFIG?.apiBaseUrl || '', window.location.href).origin;
  } catch {
    return window.location.origin;
  }
}

/** Sources Web Audio can read: this page or the Vault server (which sends
 *  CORS headers). Anything else would be silenced by a routed element. */
function graphSafe(url) {
  if (!url) return false;
  try {
    const origin = new URL(url, window.location.href).origin;
    return origin === window.location.origin || origin === apiOrigin();
  } catch {
    return false;
  }
}

/** Something currently needs the Web Audio graph. */
function graphWanted() {
  const prefs = readAudioPrefs();
  return Boolean(store.get('eqEnabled') || prefs.normalize || prefs.skipSilence || analyserRequested);
}

function createAudioElement() {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.playsInline = true;
  audio.volume = store.get('volume') ?? 0.8;
  audio.muted = Boolean(store.get('isMuted'));
  return audio;
}

/**
 * Set crossOrigin for the next source, before src is assigned. The Vault
 * server answers CORS, so a cross-origin API gets 'anonymous' (needed for
 * Web Audio); foreign hosts get no CORS mode so they play without it.
 */
function setCorsMode(audio, url) {
  const apiCross = apiOrigin() !== window.location.origin;
  if (graphSafe(url) && apiCross) audio.crossOrigin = 'anonymous';
  else audio.removeAttribute('crossorigin');
}

/** Element suitable for `url`: a routed element can't play foreign sources. */
function elementFor(audio, url) {
  if (audio && sourceNodes.has(audio) && !graphSafe(url)) {
    try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
    const fresh = createAudioElement();
    return fresh;
  }
  return audio || createAudioElement();
}

function routeThroughGraph(audio) {
  if (!audio || sourceNodes.has(audio)) return;
  if (!graphWanted() || !graphSafe(audio.currentSrc || audio.src)) return;
  initAudioContext();
  if (!graphReady || !audioContext || audioContext.state !== 'running') return;
  try {
    const sourceNode = audioContext.createMediaElementSource(audio);
    sourceNodes.set(audio, sourceNode);
    sourceNode.connect(eqNodes[0] || gainNode);
  } catch (err) {
    console.warn('Failed to connect audio to Web Audio:', err.message);
  }
}

/** Something started needing the graph: unlock and route what's playing. */
function graphNeedChanged() {
  if (!graphWanted()) return;
  unlockAudio().then(() => routeThroughGraph(currentAudio));
}

function warnMixedContent(url) {
  if (api.isMixedContent(url)) {
    // Only fires for URLs browsers actually block (non-loopback HTTP).
    toast.error('Browser blocked HTTP audio on this HTTPS page. Use http://localhost:4000 (allowed by browsers), or serve Vault over HTTPS (npm run generate-cert, or a Cloudflare tunnel).', 'Playback blocked');
    return true;
  }
  return false;
}

/** Read the shared playback prefs (single localStorage key, see
 * components/playbackPrefs.js). Kept defensive: the audio player must work
 * even if the settings module has not been loaded yet. */
function readAudioPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem('vault_playback_prefs')) || {};
    return { normalize: !!prefs.normalize, skipSilence: !!prefs.skipSilence, speed: Number(prefs.speed) || 1 };
  } catch {
    return { normalize: false, skipSilence: false, speed: 1 };
  }
}

/**
 * Loudness normalisation through the existing DynamicsCompressor node —
 * quiet dialogue and loud action end up at a similar level, the way Plex and
 * Jellyfin's "normalize volume" option behaves.
 */
export function applyNormalization(enabled) {
  if (!compressorNode || !audioContext) return false;
  try {
    if (enabled) {
      compressorNode.threshold.value = -26;
      compressorNode.knee.value = 28;
      compressorNode.ratio.value = 6;
      compressorNode.attack.value = 0.005;
      compressorNode.release.value = 0.25;
    } else {
      // Transparent: ratio 1 makes the compressor a pass-through.
      compressorNode.threshold.value = 0;
      compressorNode.knee.value = 0;
      compressorNode.ratio.value = 1;
      compressorNode.attack.value = 0.003;
      compressorNode.release.value = 0.25;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Skip-silence approximation: watch the analyser's RMS while playing and, if
 * the track stays below the noise floor for longer than ~2 s, nudge forward.
 * Default off (settings toggle) because it changes the timeline.
 */
function startSilenceMonitor() {
  if (silenceMonitor) return;
  let silentFor = 0;
  let lastJump = 0;
  silenceMonitor = setInterval(() => {
    if (!currentAudio || currentAudio.paused || !analyserNode || !sourceNodes.has(currentAudio)) { silentFor = 0; return; }
    if (currentPlay?.transcoded) { silentFor = 0; return; } // not seekable
    const prefs = readAudioPrefs();
    if (!prefs.skipSilence) { silentFor = 0; return; }
    const buffer = new Uint8Array(analyserNode.fftSize);
    analyserNode.getByteTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const centred = (buffer[i] - 128) / 128;
      sum += centred * centred;
    }
    const rms = Math.sqrt(sum / buffer.length);
    if (rms < 0.01) {
      silentFor += 0.25;
      const now = Date.now();
      if (silentFor > 2 && now - lastJump > 1200) {
        // Step forward a second at a time; stop near the end of the track.
        if (currentAudio.duration && currentAudio.currentTime < currentAudio.duration - 3) {
          currentAudio.currentTime += 1;
          lastJump = now;
        }
      }
    } else {
      silentFor = 0;
    }
  }, 250);
}

export function stopSilenceMonitor() {
  if (silenceMonitor) clearInterval(silenceMonitor);
  silenceMonitor = null;
}

function videoPlayerOpen() {
  return Boolean(document.getElementById('video-modal')?.classList.contains('active'));
}

export function initAudioPlayer() {
  window.addEventListener('pagehide', () => saveProgress());
  currentAudio = createAudioElement();
  nextAudio = createAudioElement();
  attachAudioListeners(currentAudio);

  if (!unlockBound) {
    unlockBound = true;
    const unlock = () => { if (graphWanted()) unlockAudio().then(() => routeThroughGraph(currentAudio)); };
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock, { passive: true });
  }

  store.subscribe('volume', (vol) => {
    const v = Math.min(1, Math.max(0, Number(vol) || 0));
    if (currentAudio && !isCrossfading) currentAudio.volume = v;
  });
  store.subscribe('isMuted', (muted) => {
    if (currentAudio) currentAudio.muted = Boolean(muted);
    if (nextAudio) nextAudio.muted = Boolean(muted);
  });

  store.subscribe('shuffle', () => planner.invalidate());
  store.subscribe('eqGains', applyEQ);
  store.subscribe('eqEnabled', () => { applyEQ(); graphNeedChanged(); });

  window.addEventListener('vault:play', (e) => {
    const { item, queue, index } = e.detail || {};
    if (queue && queue.length) {
      const start = Math.min(Math.max(0, index ?? 0), queue.length - 1);
      store.set('queue', queue, true);
      store.set('queueIndex', start, true);
      planner.start(queue, start);
      playItem(queue[start]);
    } else if (item) {
      const currentQueue = store.get('queue') || [];
      const existingIdx = currentQueue.findIndex(t => t.id === item.id);
      if (existingIdx >= 0) {
        store.set('queueIndex', existingIdx, true);
        playItem(currentQueue[existingIdx]);
      } else {
        const newQueue = [...currentQueue, item];
        store.set('queue', newQueue, true);
        store.set('queueIndex', newQueue.length - 1, true);
        playItem(item);
      }
    }
  });

  window.addEventListener('vault:player-action', (e) => {
    // The video player handles shortcuts while it's open; acting here too
    // started/seeked/muted the music underneath the film.
    if (videoPlayerOpen()) return;
    const { action, percent } = e.detail || {};
    handleAction(action, percent);
  });

  // Opening a film pauses the music instead of playing both at once.
  window.addEventListener('vault:video-opened', () => {
    if (currentAudio && !currentAudio.paused) currentAudio.pause();
  });

  window.addEventListener('vault:audio-prefs', (event) => {
    const prefs = event.detail || readAudioPrefs();
    applyNormalization(prefs.normalize);
    if (prefs.skipSilence) startSilenceMonitor();
    else stopSilenceMonitor();
    graphNeedChanged();
    applyRate();
  });
  const initialPrefs = readAudioPrefs();
  if (initialPrefs.skipSilence) startSilenceMonitor();

  window.VAULT_AUDIO = {
    getAnalyser: () => analyserNode,
    getContext: () => audioContext,
    unlock: unlockAudio,
    applyNormalization,
    getElement: () => (currentPlay ? currentAudio : null),
    currentTime: () => mediaTime(),
    duration: () => mediaDuration(),
    seek(seconds) {
      if (!currentPlay) return false;
      seekTo(seconds);
      if (currentAudio.paused && !currentPlay.transcoded) currentAudio.play().catch(() => {});
      return true;
    },
    /** Speed: the saved default applies to spoken word (podcasts,
     *  audiobooks); an explicit change from the player applies to whatever
     *  is playing. Music otherwise stays at 1×. */
    setSpeed(rate, { explicit = false } = {}) {
      if (explicit) explicitRate = rate;
      applyRate();
    },
    /** The visualizer asks for the analyser while Now Playing is open.
     *  Skipped on iOS, where routed audio can stop when the screen locks. */
    useAnalyser() {
      if (analyserRequested || isIOS()) return;
      analyserRequested = true;
      graphNeedChanged();
    },
  };
}

function isSpoken(item) {
  return item?.type === 'podcast' || item?.type === 'audiobook';
}

function applyRate() {
  if (!currentAudio) return;
  const rate = explicitRate || (isSpoken(currentPlay?.item) ? readAudioPrefs().speed : 1);
  const value = Math.max(0.25, Math.min(3, Number(rate) || 1));
  try {
    currentAudio.defaultPlaybackRate = value; // survives load()
    currentAudio.playbackRate = value;
    currentAudio.preservesPitch = true;
  } catch {}
}

/** Where a podcast/audiobook was left off (library history, in seconds). */
function resumePosition(item) {
  if (!isSpoken(item) || !isLibraryItem(item)) return 0;
  const entry = (store.get('history') || []).find(h => h.itemId === item.id);
  const pct = Number(entry?.progress) || 0;
  const duration = Number(item.duration) || 0;
  if (!duration || pct < 1 || pct > 97) return 0;
  return Math.max(0, (pct / 100) * duration - 5); // a few seconds of context
}

/** Position in the track, including the start offset of a converted stream. */
function mediaTime() {
  return (currentPlay?.offset || 0) + (currentAudio?.currentTime || 0);
}

/** Track length; converted streams don't know it, the library does. */
function mediaDuration() {
  const d = currentAudio?.duration;
  if (!currentPlay?.transcoded && Number.isFinite(d) && d > 0) return d;
  const known = Number(currentPlay?.item?.duration);
  if (Number.isFinite(known) && known > 0) return known;
  return Number.isFinite(d) && d > 0 ? (currentPlay?.offset || 0) + d : 0;
}

function seekTo(seconds) {
  if (!currentAudio || !currentPlay) return;
  const duration = mediaDuration();
  let target = Math.max(0, Number(seconds) || 0);
  if (duration) target = Math.min(target, Math.max(0, duration - 0.25));
  if (currentPlay.transcoded) {
    // A converted stream can't seek by bytes: restart it at the new spot.
    startSource(currentPlay, { transcode: true, startAt: target });
    return;
  }
  try { currentAudio.currentTime = target; } catch {}
}

function handleAction(action, percent) {
  if (!currentAudio) return;
  switch (action) {
    case 'playPause':
      if (!currentPlay) {
        // Nothing loaded yet (fresh page): start the queue if there is one.
        const queue = store.get('queue') || [];
        const idx = store.get('queueIndex') ?? 0;
        if (queue[idx]) playItem(queue[idx]);
        break;
      }
      if (currentAudio.paused) {
        unlockAudio().finally(() => {
          currentAudio.play().catch((err) => {
            if (err?.name !== 'AbortError') toast.error(err.message || 'Playback failed');
          });
        });
      } else currentAudio.pause();
      break;
    case 'seekBack':
      seekTo(mediaTime() - 10);
      break;
    case 'seekForward':
      seekTo(mediaTime() + 10);
      break;
    case 'volumeUp':
      store.set('volume', Math.min(1, (store.get('volume') || 0) + 0.05), true);
      if (store.get('isMuted')) store.set('isMuted', false);
      break;
    case 'volumeDown':
      store.set('volume', Math.max(0, (store.get('volume') || 0) - 0.05), true);
      break;
    case 'mute':
      store.set('isMuted', !store.get('isMuted'));
      break;
    case 'next':
      playNext();
      break;
    case 'prev':
      playPrev();
      break;
    case 'shuffle':
      store.set('shuffle', !store.get('shuffle'), true);
      break;
    case 'repeat': {
      const modes = ['off', 'all', 'one'];
      const idx = modes.indexOf(store.get('repeat'));
      store.set('repeat', modes[(idx + 1) % modes.length], true);
      break;
    }
    case 'seekPercent': {
      const duration = mediaDuration();
      if (percent !== undefined && duration) seekTo((percent / 100) * duration);
      break;
    }
  }
}

/** Library items have a cover route; feed episodes carry their own artwork. */
function artworkFor(item) {
  if (item.artwork) return item.artwork;
  if (isLibraryItem(item)) return api.getCoverUrl(item.id);
  return null;
}

function isLibraryItem(item) {
  return Boolean(item?.id) && !item.streamUrl && !String(item.id).includes(':');
}

function setMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  try {
    const art = artworkFor(item);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: item.artist || item.author || 'Unknown',
      album: item.album || '',
      artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
    const handlers = {
      play: () => currentAudio.play().catch(() => {}),
      pause: () => currentAudio.pause(),
      stop: () => currentAudio.pause(),
      nexttrack: playNext,
      previoustrack: playPrev,
      seekbackward: (d) => seekTo(mediaTime() - (d?.seekOffset || 10)),
      seekforward: (d) => seekTo(mediaTime() + (d?.seekOffset || 10)),
      seekto: (d) => { if (d && Number.isFinite(d.seekTime)) seekTo(d.seekTime); },
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported action */ }
    }
  } catch {}
}

let lastPositionState = 0;
function updatePositionState(force = false) {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = Date.now();
  if (!force && now - lastPositionState < 5000) return;
  lastPositionState = now;
  const duration = mediaDuration();
  if (!duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(duration, Math.max(0, mediaTime())),
      playbackRate: currentAudio?.playbackRate || 1,
    });
  } catch {}
}

/** Settings → Playback → Gapless (default on). */
const gaplessEnabled = () => localStorage.getItem('vault_gapless') !== 'false';

function isAudioItem(item) {
  return AUDIO_TYPES.has(item?.type) || !item?.type;
}

function stopCrossfade() {
  if (crossfadeTimer) clearInterval(crossfadeTimer);
  crossfadeTimer = null;
  crossfadeFinish = null;
  isCrossfading = false;
}

/**
 * Start a track: resets the timeline, records history, announces the track.
 * `startAt` resumes part-way (used for audiobooks / restarted conversions).
 */
export async function playItem(item, { forceTranscode = false, startAt = null } = {}) {
  if (!item) return;
  saveProgress(); // the track being left
  const seq = ++playSeq;
  explicitRate = null;
  // "Resume where you stopped" for podcasts and audiobooks.
  if (startAt == null) startAt = resumePosition(item);
  stopCrossfade();
  if (nextAudio) { try { nextAudio.pause(); } catch {} }
  currentPlay = { seq, item, attempt: 0, handled: 0, transcoded: false, offset: 0 };

  store.set('currentTrack', item);
  setMediaSession(item);
  const started = await startSource(currentPlay, { transcode: forceTranscode, startAt });
  if (!started || seq !== playSeq) return;

  if (isLibraryItem(item)) {
    const progress = startAt && item.duration ? (startAt / item.duration) * 100 : 0;
    store.addToHistory(item.id, progress);
    api.addHistory({ itemId: item.id, progress, duration: item.duration }).catch(() => {});
  }
  preloadNext();
  updatePositionState(true);
  window.dispatchEvent(new CustomEvent('vault:track-changed', { detail: { item } }));
}

/**
 * Load and play one source for `play` (direct file, or the server's
 * conversion). Returns true once playback started. Failures go through
 * handleFailure exactly once per attempt.
 */
async function startSource(play, { transcode = false, startAt = 0 } = {}) {
  const attempt = ++play.attempt;
  const stale = () => play.seq !== playSeq || attempt !== play.attempt;
  const item = play.item;
  const url = transcode
    ? api.getPlaybackUrl(item, { forceTranscode: true, startAt })
    : api.getPlaybackUrl(item);
  if (!url) {
    handleFailure(play, attempt, new Error('No stream URL'));
    return false;
  }
  if (warnMixedContent(url)) {
    store.set('isPlaying', false);
    return false;
  }

  play.transcoded = url.includes('/api/transcode/');
  // A converted stream that starts part-way reports time from 0.
  play.offset = play.transcoded ? startAt : 0;

  const el = elementFor(currentAudio, url);
  if (el !== currentAudio) {
    cleanupAudioListeners(currentAudio);
    currentAudio = el;
    attachAudioListeners(currentAudio);
  }
  currentAudio.pause();
  setCorsMode(currentAudio, url);
  currentAudio.volume = store.get('volume') ?? 0.8;
  currentAudio.muted = Boolean(store.get('isMuted'));
  currentAudio.src = url;
  currentAudio.load();
  applyRate();
  if (!play.transcoded && startAt > 0) {
    currentAudio.addEventListener('loadedmetadata', () => {
      try { currentAudio.currentTime = startAt; } catch {}
    }, { once: true });
  }

  if (graphWanted()) {
    await unlockAudio();
    if (stale()) return false;
    routeThroughGraph(currentAudio);
  }

  try {
    await currentAudio.play();
    if (stale()) return false;
    return true;
  } catch (err) {
    if (stale()) return false;
    handleFailure(play, attempt, err);
    return false;
  }
}

/** Can the server convert this item? Only library files, not feed URLs. */
function canTranscode(item) {
  return isLibraryItem(item) && isAudioItem(item);
}

function failureMessage(item) {
  if (!isLibraryItem(item)) {
    return `Couldn't play "${item.title}". The host refused the stream or is unreachable — try downloading the episode instead.`;
  }
  return `Couldn't play "${item.title}". The file may be damaged, or the server couldn't convert it (is ffmpeg installed?).`;
}

/** One failure per attempt: direct → converted stream → explained error. */
function handleFailure(play, attempt, err) {
  if (!play || play.seq !== playSeq || attempt !== play.attempt) return; // superseded
  if (play.handled >= attempt) return; // already dealt with (play() + error event)
  play.handled = attempt;
  if (err?.name === 'AbortError') return; // interrupted by a newer load
  if (err?.name === 'NotAllowedError') {
    // Autoplay blocked (e.g. restored queue, no user gesture yet).
    store.set('isPlaying', false);
    toast.info('Press play to start audio.');
    return;
  }
  console.warn('[AudioPlayer] playback failed', play.item?.title, err?.message || err);
  if (!play.transcoded && canTranscode(play.item)) {
    startSource(play, { transcode: true, startAt: mediaTime() });
    return;
  }
  store.set('isPlaying', false);
  toast.error(failureMessage(play.item));
}

function preloadNext() {
  const queue = store.get('queue') || [];
  const idx = store.get('queueIndex');
  const nextIdx = nextIndex(queue, idx);
  // Only buffer the next track when something uses it: gapless hand-off or
  // crossfade. With both off this saves a stream per track.
  if (!gaplessEnabled() && !((store.get('crossfade') || 0) > 0)) {
    preloadedIdx = -1;
    return;
  }
  preloadedIdx = nextIdx;
  if (nextIdx >= 0) {
    const nextItem = queue[nextIdx];
    const url = api.getPlaybackUrl(nextItem);
    if (!url) { preloadedIdx = -1; return; }
    nextAudio = elementFor(nextAudio, url);
    setCorsMode(nextAudio, url);
    nextAudio.muted = Boolean(store.get('isMuted'));
    nextAudio.src = url;
    nextAudio.load();
  }
}

// Shuffle (Spotify-style) lives in utils/shuffle.js; the player only asks it
// for the next index and commits what actually plays.
const planner = new ShufflePlanner();
let preloadedIdx = -1;

/** Index of the track that follows `idx`, or -1 when playback should end. */
function nextIndex(queue, idx) {
  if (store.get('shuffle')) return planner.nextIndex(queue, idx, store.get('repeat'));
  return idx + 1 < queue.length ? idx + 1 : -1;
}

/** Commit an advance from `fromIdx` to `toIdx` (history is used by Previous). */
function commitAdvance(queue, fromIdx, toIdx) {
  if (store.get('shuffle')) planner.commit(queue, fromIdx);
  store.set('queueIndex', toIdx, true);
}

let lastHistorySave = 0;
let lastRemoteSave = 0;
/**
 * Record how far into the current track we are. Called every 10 s while
 * playing and — so "resume where you stopped" survives a quick switch —
 * whenever playback pauses, the track changes or the page goes away. The
 * server copy (other devices) is updated at most once a minute plus on those
 * events.
 */
function saveProgress({ remote = true } = {}) {
  const item = currentPlay?.item;
  if (!item || !isLibraryItem(item) || !currentAudio || isCrossfading) return;
  const duration = mediaDuration();
  const time = mediaTime();
  if (!duration || !(time > 0)) return;
  const progress = Math.min(100, (time / duration) * 100);
  store.addToHistory(item.id, progress);
  if (remote) {
    lastRemoteSave = Date.now();
    api.addHistory({ itemId: item.id, progress, duration: item.duration || duration }).catch(() => {});
  }
}

function onTimeUpdate() {
  // `timeupdate` fires ~4×/s, also in background tabs (requestAnimationFrame
  // doesn't, which used to freeze crossfade and history there).
  if (!currentAudio || !currentPlay) return;
  const duration = mediaDuration();
  const time = mediaTime();
  const progress = duration ? Math.min(100, (time / duration) * 100) : 0;
  const currentTrack = store.get('currentTrack');

  const now = Date.now();
  if (currentTrack && isLibraryItem(currentTrack) && now - lastHistorySave > 10000) {
    lastHistorySave = now;
    saveProgress({ remote: now - lastRemoteSave > 60000 });
  }

  const crossfade = store.get('crossfade');
  if (crossfade > 0 && duration && duration - time <= crossfade && !isCrossfading && !currentAudio.paused) {
    const queue = store.get('queue') || [];
    if (nextIndex(queue, store.get('queueIndex')) >= 0) crossfadeToNext();
  }

  updatePositionState();
  window.dispatchEvent(new CustomEvent('vault:timeupdate', {
    detail: { currentTime: time, duration, progress }
  }));
}

function cleanupAudioListeners(audio) {
  if (!audio) return;
  audio.removeEventListener('timeupdate', onTimeUpdate);
  audio.removeEventListener('ended', onEnded);
  audio.removeEventListener('play', onPlay);
  audio.removeEventListener('pause', onPause);
  audio.removeEventListener('loadedmetadata', onLoadedMetadata);
  audio.removeEventListener('durationchange', onLoadedMetadata);
  audio.removeEventListener('error', onAudioError);
}

function onPlay() {
  store.set('isPlaying', true);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  if (sourceNodes.has(currentAudio) && audioContext && audioContext.state !== 'running') {
    audioContext.resume().catch(() => {});
  }
}

function onPause() {
  if (isCrossfading) return;
  if (!currentAudio?.ended) saveProgress();
  store.set('isPlaying', false);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
}

function onAudioError() {
  // Errors after an emptied src (track switch) are not failures.
  if (!currentPlay || !currentAudio?.getAttribute('src')) return;
  const mediaError = currentAudio.error;
  const err = new Error(mediaError?.message || `Media error ${mediaError?.code || ''}`.trim());
  err.name = mediaError?.code === 4 ? 'NotSupportedError' : 'MediaError';
  handleFailure(currentPlay, currentPlay.attempt, err);
}

function attachAudioListeners(audio) {
  if (!audio) return;
  cleanupAudioListeners(audio);
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('play', onPlay);
  audio.addEventListener('pause', onPause);
  audio.addEventListener('loadedmetadata', onLoadedMetadata);
  audio.addEventListener('durationchange', onLoadedMetadata);
  audio.addEventListener('error', onAudioError);
}

function crossfadeToNext() {
  const queue = store.get('queue') || [];
  const idx = store.get('queueIndex');
  const nextIdx = nextIndex(queue, idx);
  const nextItem = nextIdx >= 0 ? queue[nextIdx] : null;
  if (!nextItem || !nextAudio || preloadedIdx !== nextIdx) return;

  isCrossfading = true;
  const target = store.get('volume') ?? 0.8;
  const incoming = nextAudio;
  const outgoing = currentAudio;
  incoming.volume = 0;
  incoming.muted = Boolean(store.get('isMuted'));
  routeThroughGraph(incoming);
  incoming.play().catch(() => {});

  const duration = Math.max(0.5, store.get('crossfade') || 0) * 1000;
  const start = Date.now();

  crossfadeFinish = () => {
    if (crossfadeTimer) clearInterval(crossfadeTimer);
    crossfadeTimer = null;
    crossfadeFinish = null;
    cleanupAudioListeners(outgoing);
    try { outgoing.pause(); outgoing.removeAttribute('src'); outgoing.load(); } catch {}
    currentAudio = incoming;
    nextAudio = outgoing;
    attachAudioListeners(currentAudio);
    currentAudio.volume = store.get('volume') ?? 0.8;
    isCrossfading = false;
    commitAdvance(queue, idx, nextIdx);
    currentPlay = { seq: ++playSeq, item: nextItem, attempt: 1, handled: 0, transcoded: currentAudio.src.includes('/api/transcode/'), offset: 0 };
    explicitRate = null;
    applyRate();
    store.set('currentTrack', nextItem);
    store.set('isPlaying', !currentAudio.paused);
    setMediaSession(nextItem);
    if (isLibraryItem(nextItem)) {
      store.addToHistory(nextItem.id, 0);
      api.addHistory({ itemId: nextItem.id, progress: 0, duration: nextItem.duration }).catch(() => {});
    }
    preloadNext();
    window.dispatchEvent(new CustomEvent('vault:track-changed', { detail: { item: nextItem } }));
  };

  // Timers keep running (throttled) in background tabs; rAF does not.
  crossfadeTimer = setInterval(() => {
    const progress = Math.min((Date.now() - start) / duration, 1);
    outgoing.volume = (1 - progress) * target;
    incoming.volume = progress * target;
    if (progress >= 1) crossfadeFinish?.();
  }, 50);
}

function onEnded() {
  if (isCrossfading) { crossfadeFinish?.(); return; }
  saveProgress(); // ≈100%, so a finished chapter doesn't "resume" at 90%
  // Sleep timer "stop after N items" cancels the advance (preventDefault).
  const finished = new CustomEvent('vault:item-finished', { detail: { item: currentPlay?.item }, cancelable: true });
  if (!window.dispatchEvent(finished)) {
    store.set('isPlaying', false);
    return;
  }
  const repeat = store.get('repeat');
  if (repeat === 'one') {
    if (currentPlay?.transcoded && currentPlay.offset) {
      startSource(currentPlay, { transcode: true, startAt: 0 });
      return;
    }
    currentAudio.currentTime = 0;
    currentAudio.play().catch(() => {});
    return;
  }
  if (gaplessEnabled() && handOffToPreloaded()) return;
  playNext();
}

/**
 * Gapless playback: the next track is already buffered in `nextAudio`
 * (preloadNext), so swap the elements and start it immediately instead of
 * re-requesting the stream. Returns false when the hand-off isn't possible
 * (not buffered yet, queue changed…) so the caller falls back to playNext().
 */
function handOffToPreloaded() {
  const queue = store.get('queue') || [];
  const idx = store.get('queueIndex');
  const nextIdx = nextIndex(queue, idx);
  const nextItem = nextIdx >= 0 ? queue[nextIdx] : null;
  if (!nextItem || !nextAudio || preloadedIdx !== nextIdx) return false;
  if (nextAudio.readyState < 2 || !nextAudio.currentSrc) return false; // HAVE_CURRENT_DATA

  const finished = currentAudio;
  cleanupAudioListeners(finished);
  currentAudio = nextAudio;
  nextAudio = finished;
  try { nextAudio.pause(); nextAudio.removeAttribute('src'); nextAudio.load(); } catch {}

  routeThroughGraph(currentAudio);
  attachAudioListeners(currentAudio);
  currentAudio.volume = store.get('volume') ?? 0.8;
  currentAudio.muted = Boolean(store.get('isMuted'));
  try { currentAudio.currentTime = 0; } catch {}

  commitAdvance(queue, idx, nextIdx);
  currentPlay = { seq: ++playSeq, item: nextItem, attempt: 1, handled: 0, transcoded: currentAudio.src.includes('/api/transcode/'), offset: 0 };
    explicitRate = null;
    applyRate();
  store.set('currentTrack', nextItem);
  setMediaSession(nextItem);
  const play = currentPlay;
  currentAudio.play().catch((err) => handleFailure(play, 1, err));

  if (isLibraryItem(nextItem)) {
    store.addToHistory(nextItem.id, 0);
    api.addHistory({ itemId: nextItem.id, progress: 0, duration: nextItem.duration }).catch(() => {});
  }
  preloadNext();
  window.dispatchEvent(new CustomEvent('vault:track-changed', { detail: { item: nextItem } }));
  return true;
}

function playNext() {
  const queue = store.get('queue') || [];
  const idx = store.get('queueIndex');

  if (!queue.length) {
    store.set('isPlaying', false);
    return;
  }

  let nextIdx = nextIndex(queue, idx);
  if (nextIdx < 0) {
    if (store.get('repeat') === 'all') nextIdx = 0;
    else {
      store.set('isPlaying', false);
      return;
    }
  }

  commitAdvance(queue, idx, nextIdx);
  playItem(queue[nextIdx]);
}

function playPrev() {
  const queue = store.get('queue') || [];
  let idx = store.get('queueIndex');
  if (currentAudio && mediaTime() > 3) {
    seekTo(0);
    return;
  }
  if (store.get('shuffle')) {
    // Walk back through what actually played, most recent first.
    const prev = planner.previousIndex(queue);
    if (prev >= 0) {
      store.set('queueIndex', prev, true);
      playItem(queue[prev]);
    } else {
      seekTo(0);
    }
    return;
  }
  if (!queue.length) return;
  idx--;
  if (idx < 0) idx = Math.max(0, queue.length - 1);
  store.set('queueIndex', idx, true);
  playItem(queue[idx]);
}

function onLoadedMetadata() {
  window.dispatchEvent(new CustomEvent('vault:durationchange', {
    detail: { duration: mediaDuration() }
  }));
}

export function getAnalyser() {
  return analyserNode;
}
