/**
 * Audio Player — Web Audio API EQ, queue, gapless-ish preload.
 * Fixes: AudioContext never resumed (silent playback), MediaElementSource
 * double-connect, missing transcode fallback, swallowed play errors.
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from './toast.js';

let audioContext = null;
let sourceNodes = new WeakMap();
let gainNode = null;
let eqNodes = [];
let compressorNode = null;
let analyserNode = null;
let currentAudio = null;
let nextAudio = null;
let isCrossfading = false;
let graphReady = false;
let unlockBound = false;
let silenceMonitor = null;

const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function initAudioContext() {
  if (audioContext) return audioContext;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioContext.createGain();
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

    let lastNode = null;
    eqNodes.forEach((node, idx) => {
      if (idx === 0) lastNode = node;
      else {
        lastNode.connect(node);
        lastNode = node;
      }
    });

    if (lastNode) {
      lastNode.connect(compressorNode);
      compressorNode.connect(gainNode);
      gainNode.connect(analyserNode);
      analyserNode.connect(audioContext.destination);
    } else {
      gainNode.connect(analyserNode);
      analyserNode.connect(audioContext.destination);
    }

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
  initAudioContext();
  if (!audioContext) return false;
  if (audioContext.state === 'suspended') {
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

function createAudioElement() {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.playsInline = true;
  // Only set CORS when the API is cross-origin — same-origin + anonymous can
  // fail if the stream response is missing ACAO on Range 206.
  try {
    const apiOrigin = new URL(api.baseUrl || window.VAULT_CONFIG?.apiBaseUrl || '', window.location.href).origin;
    if (apiOrigin !== window.location.origin) {
      audio.crossOrigin = 'anonymous';
    }
  } catch {}
  return audio;
}

function connectAudioToGraph(audio) {
  if (!audio || !graphReady || !audioContext) return;
  if (audioContext.state !== 'running') return;
  if (sourceNodes.has(audio)) return;
  try {
    const sourceNode = audioContext.createMediaElementSource(audio);
    sourceNodes.set(audio, sourceNode);
    sourceNode.connect(eqNodes[0] || gainNode);
  } catch (err) {
    console.warn('Failed to connect audio to Web Audio:', err.message);
  }
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
  if (silenceMonitor || !analyserNode) return;
  const buffer = new Uint8Array(analyserNode.fftSize);
  let silentFor = 0;
  let lastJump = 0;
  silenceMonitor = setInterval(() => {
    if (!currentAudio || currentAudio.paused) { silentFor = 0; return; }
    const prefs = readAudioPrefs();
    if (!prefs.skipSilence) { silentFor = 0; return; }
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

export function initAudioPlayer() {
  initAudioContext();

  currentAudio = createAudioElement();
  nextAudio = createAudioElement();

  currentAudio.volume = store.get('volume') ?? 0.8;
  if (gainNode) gainNode.gain.value = store.get('volume') ?? 0.8;

  attachAudioListeners(currentAudio);

  if (!unlockBound) {
    unlockBound = true;
    const unlock = () => { unlockAudio(); };
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock, { passive: true });
    document.addEventListener('click', unlock, { passive: true });
  }

  store.subscribe('volume', (vol) => {
    if (currentAudio) currentAudio.volume = vol;
    if (gainNode) gainNode.gain.value = vol;
  });

  store.subscribe('eqGains', applyEQ);
  store.subscribe('eqEnabled', applyEQ);

  window.addEventListener('vault:play', (e) => {
    const { item, queue, index } = e.detail || {};
    if (queue) {
      store.set('queue', queue, true);
      store.set('queueIndex', index ?? 0, true);
      playItem(queue[index ?? 0]);
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
    const { action, percent } = e.detail || {};
    handleAction(action, percent);
  });

  window.addEventListener('vault:audio-prefs', (event) => {
    const prefs = event.detail || readAudioPrefs();
    applyNormalization(prefs.normalize);
    if (prefs.skipSilence) startSilenceMonitor();
    else stopSilenceMonitor();
  });
  const initialPrefs = readAudioPrefs();
  applyNormalization(initialPrefs.normalize);
  if (initialPrefs.skipSilence) startSilenceMonitor();

  window.VAULT_AUDIO = {
    getAnalyser: () => analyserNode,
    getContext: () => audioContext,
    unlock: unlockAudio,
    applyNormalization,
  };

}

function handleAction(action, percent) {
  if (!currentAudio) return;
  switch (action) {
    case 'playPause':
      unlockAudio().then(() => {
        if (currentAudio.paused) currentAudio.play().catch((err) => toast.error(err.message || 'Playback failed'));
        else currentAudio.pause();
      });
      break;
    case 'seekBack':
      currentAudio.currentTime = Math.max(0, (currentAudio.currentTime || 0) - 10);
      break;
    case 'seekForward':
      currentAudio.currentTime = Math.min(currentAudio.duration || 0, (currentAudio.currentTime || 0) + 10);
      break;
    case 'volumeUp':
      store.set('volume', Math.min(1, (store.get('volume') || 0) + 0.05), true);
      break;
    case 'volumeDown':
      store.set('volume', Math.max(0, (store.get('volume') || 0) - 0.05), true);
      break;
    case 'mute':
      store.set('isMuted', !store.get('isMuted'));
      currentAudio.muted = store.get('isMuted');
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
    case 'seekPercent':
      if (percent !== undefined && currentAudio.duration) {
        currentAudio.currentTime = (percent / 100) * currentAudio.duration;
      }
      break;
  }
}

export async function playItem(item, { forceTranscode = false } = {}) {
  if (!item) return;

  try {
    await unlockAudio();
    store.set('currentTrack', item);
    store.set('isPlaying', true);

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: item.title,
          artist: item.artist || 'Unknown',
          album: item.album || '',
          artwork: [{ src: api.getCoverUrl(item.id), sizes: '512x512', type: 'image/jpeg' }]
        });
        navigator.mediaSession.setActionHandler('play', () => currentAudio.play());
        navigator.mediaSession.setActionHandler('pause', () => currentAudio.pause());
        navigator.mediaSession.setActionHandler('nexttrack', playNext);
        navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      } catch {}
    }

    const streamUrl = api.getPlaybackUrl(item, { forceTranscode });
    if (warnMixedContent(streamUrl)) {
      store.set('isPlaying', false);
      return;
    }

    currentAudio.pause();
    currentAudio.src = streamUrl;
    currentAudio.load();
    connectAudioToGraph(currentAudio);

    await currentAudio.play();

    store.addToHistory(item.id, 0);
    api.addHistory({ itemId: item.id, progress: 0, duration: item.duration }).catch(() => {});

    preloadNext();
    window.dispatchEvent(new CustomEvent('vault:track-changed', { detail: { item } }));
  } catch (err) {
    console.error('Play failed', err);
    // If direct play failed, try transcode once
    if (!forceTranscode && item.type === 'music') {
      try {
        await playItem(item, { forceTranscode: true });
        return;
      } catch {}
    }
    store.set('isPlaying', false);
    toast.error(`Failed to play ${item.title}`);
  }
}

function preloadNext() {
  const queue = store.get('queue') || [];
  const idx = store.get('queueIndex');
  const nextIdx = idx + 1;
  if (nextIdx < queue.length && nextAudio) {
    const nextItem = queue[nextIdx];
    nextAudio.src = api.getPlaybackUrl(nextItem);
    nextAudio.load();
  }
}

let audioRaf = null;
let lastHistorySave = 0;
function onTimeUpdate() {
  if (audioRaf) return;
  audioRaf = requestAnimationFrame(() => {
    audioRaf = null;
    if (!currentAudio?.duration) return;

    const progress = (currentAudio.currentTime / currentAudio.duration) * 100;
    const currentTrack = store.get('currentTrack');

    const now = Date.now();
    if (currentTrack && now - lastHistorySave > 10000) {
      lastHistorySave = now;
      store.addToHistory(currentTrack.id, progress);
    }

    const crossfade = store.get('crossfade');
    if (crossfade > 0 && currentAudio.duration - currentAudio.currentTime <= crossfade && !isCrossfading) {
      const queue = store.get('queue') || [];
      const idx = store.get('queueIndex');
      if (idx + 1 < queue.length) {
        isCrossfading = true;
        crossfadeToNext();
      }
    }

    window.dispatchEvent(new CustomEvent('vault:timeupdate', {
      detail: {
        currentTime: currentAudio.currentTime,
        duration: currentAudio.duration,
        progress
      }
    }));
  });
}

function cleanupAudioListeners(audio) {
  if (!audio) return;
  audio.removeEventListener('timeupdate', onTimeUpdate);
  audio.removeEventListener('ended', onEnded);
  audio.removeEventListener('play', onPlay);
  audio.removeEventListener('pause', onPause);
  audio.removeEventListener('loadedmetadata', onLoadedMetadata);
  audio.removeEventListener('error', onAudioError);
}

function onPlay() { store.set('isPlaying', true); }
function onPause() { store.set('isPlaying', false); }

function onAudioError() {
  const item = store.get('currentTrack');
  const mediaError = currentAudio?.error;
  console.error('Audio error', mediaError);
  if (item && currentAudio?.src && !currentAudio.src.includes('/transcode/')) {
    playItem(item, { forceTranscode: true });
    return;
  }
  toast.error('Failed to play track');
  store.set('isPlaying', false);
}

function attachAudioListeners(audio) {
  if (!audio) return;
  cleanupAudioListeners(audio);
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('play', onPlay);
  audio.addEventListener('pause', onPause);
  audio.addEventListener('loadedmetadata', onLoadedMetadata);
  audio.addEventListener('error', onAudioError);
}

function crossfadeToNext() {
  const queue = store.get('queue') || [];
  const idx = store.get('queueIndex');
  const nextItem = queue[idx + 1];

  if (!nextItem || !nextAudio) {
    isCrossfading = false;
    return;
  }

  unlockAudio().then(() => {
    nextAudio.volume = 0;
    connectAudioToGraph(nextAudio);
    nextAudio.play().catch(() => {});

    const duration = (store.get('crossfade') || 0) * 1000;
    const start = Date.now();

    const fade = () => {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      if (currentAudio) currentAudio.volume = (1 - progress) * (store.get('volume') || 0.8);
      if (nextAudio) nextAudio.volume = progress * (store.get('volume') || 0.8);

      if (progress < 1) {
        requestAnimationFrame(fade);
      } else {
        if (currentAudio) {
          cleanupAudioListeners(currentAudio);
          try { currentAudio.pause(); } catch {}
        }
        const temp = currentAudio;
        currentAudio = nextAudio;
        nextAudio = temp;
        if (nextAudio) {
          try { nextAudio.pause(); nextAudio.removeAttribute('src'); nextAudio.load(); } catch {}
          cleanupAudioListeners(nextAudio);
        }
        attachAudioListeners(currentAudio);
        if (currentAudio) currentAudio.volume = store.get('volume') || 0.8;
        store.set('queueIndex', idx + 1, true);
        store.set('currentTrack', nextItem);
        isCrossfading = false;
        preloadNext();
      }
    };
    fade();
  });
}

function onEnded() {
  const repeat = store.get('repeat');
  if (repeat === 'one') {
    currentAudio.currentTime = 0;
    currentAudio.play().catch(() => {});
    return;
  }
  playNext();
}

function playNext() {
  const queue = store.get('queue') || [];
  let idx = store.get('queueIndex');
  const shuffle = store.get('shuffle');
  const repeat = store.get('repeat');

  if (!queue.length) {
    store.set('isPlaying', false);
    return;
  }

  if (shuffle) idx = Math.floor(Math.random() * queue.length);
  else idx++;

  if (idx >= queue.length) {
    if (repeat === 'all') idx = 0;
    else {
      store.set('isPlaying', false);
      return;
    }
  }

  store.set('queueIndex', idx, true);
  playItem(queue[idx]);
}

function playPrev() {
  const queue = store.get('queue') || [];
  let idx = store.get('queueIndex');
  if (currentAudio && currentAudio.currentTime > 3) {
    currentAudio.currentTime = 0;
    return;
  }
  idx--;
  if (idx < 0) idx = Math.max(0, queue.length - 1);
  store.set('queueIndex', idx, true);
  playItem(queue[idx]);
}

function onLoadedMetadata() {
  window.dispatchEvent(new CustomEvent('vault:durationchange', {
    detail: { duration: currentAudio?.duration || 0 }
  }));
}

export function getAudioElement() {
  return currentAudio;
}

export function getAnalyser() {
  return analyserNode;
}
