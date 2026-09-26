/**
 * Audio Player — with Web Audio API EQ, crossfade, gapless, queue
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { toast } from './toast.js';
import { formatTime } from '../utils/format.js';

let audioContext = null;
let sourceNode = null;
let gainNode = null;
let eqNodes = [];
let compressorNode = null;
let analyserNode = null;
let currentAudio = null;
let nextAudio = null;
let crossfadeTimeout = null;
let isCrossfading = false;

const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function initAudioContext() {
  if (audioContext) return audioContext;
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioContext.createGainNode ? audioContext.createGainNode() : audioContext.createGain();
    compressorNode = audioContext.createDynamicsCompressor();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;
    
    // Create 10 EQ bands
    eqNodes = EQ_FREQUENCIES.map(freq => {
      const filter = audioContext.createBiquadFilter();
      filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1;
      filter.gain.value = 0;
      return filter;
    });
    
    // Connect chain: source -> EQ -> compressor -> gain -> analyser -> destination
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
    
    return audioContext;
  } catch (err) {
    console.warn('Web Audio API not supported:', err);
    return null;
  }
}

function applyEQ() {
  const gains = store.get('eqGains') || [0,0,0,0,0,0,0,0,0,0];
  const enabled = store.get('eqEnabled');
  
  eqNodes.forEach((node, idx) => {
    node.gain.value = enabled ? gains[idx] : 0;
  });
  
  // Update visual if EQ panel open
  window.dispatchEvent(new CustomEvent('vault:eq-updated', { detail: { gains } }));
}

function createAudioElement() {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'metadata';
  return audio;
}

function connectAudioToGraph(audio) {
  if (!audioContext) initAudioContext();
  if (!audioContext) return;
  
  try {
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch {}
    }
    sourceNode = audioContext.createMediaElementSource(audio);
    sourceNode.connect(eqNodes[0] || gainNode);
  } catch (err) {
    console.warn('Failed to connect audio to Web Audio:', err.message);
  }
}

export function initAudioPlayer() {
  initAudioContext();
  
  // Create audio elements
  currentAudio = createAudioElement();
  nextAudio = createAudioElement();
  
  // Volume
  currentAudio.volume = store.get('volume');
  gainNode && (gainNode.gain.value = store.get('volume'));
  
  // Events
  currentAudio.addEventListener('timeupdate', onTimeUpdate);
  currentAudio.addEventListener('ended', onEnded);
  currentAudio.addEventListener('play', () => store.set('isPlaying', true));
  currentAudio.addEventListener('pause', () => store.set('isPlaying', false));
  currentAudio.addEventListener('loadedmetadata', onLoadedMetadata);
  currentAudio.addEventListener('error', (e) => {
    console.error('Audio error', e);
    toast.error('Failed to play track');
  });
  
  // Store subscriptions
  store.subscribe('volume', (vol) => {
    if (currentAudio) currentAudio.volume = vol;
    if (gainNode) gainNode.gain.value = vol;
  });
  
  store.subscribe('eqGains', applyEQ);
  store.subscribe('eqEnabled', applyEQ);
  
  // Player actions
  window.addEventListener('vault:play', (e) => {
    const { item, queue, index } = e.detail;
    if (queue) {
      store.set('queue', queue, true);
      store.set('queueIndex', index ?? 0, true);
      playItem(queue[index ?? 0]);
    } else if (item) {
      // Add to queue and play
      const currentQueue = store.get('queue');
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
    const { action, percent } = e.detail;
    handleAction(action, percent);
  });
  
  // Expose for visualizer
  window.VAULT_AUDIO = {
    getAnalyser: () => analyserNode,
    getContext: () => audioContext,
  };
  
  console.log('[AudioPlayer] Initialized');
}

function handleAction(action, percent) {
  switch (action) {
    case 'playPause':
      if (currentAudio.paused) currentAudio.play().catch(() => {});
      else currentAudio.pause();
      break;
    case 'seekBack':
      currentAudio.currentTime = Math.max(0, currentAudio.currentTime - 10);
      break;
    case 'seekForward':
      currentAudio.currentTime = Math.min(currentAudio.duration, currentAudio.currentTime + 10);
      break;
    case 'volumeUp':
      store.set('volume', Math.min(1, store.get('volume') + 0.05), true);
      break;
    case 'volumeDown':
      store.set('volume', Math.max(0, store.get('volume') - 0.05), true);
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
    case 'repeat':
      const modes = ['off', 'all', 'one'];
      const idx = modes.indexOf(store.get('repeat'));
      store.set('repeat', modes[(idx + 1) % modes.length], true);
      break;
    case 'seekPercent':
      if (percent !== undefined && currentAudio.duration) {
        currentAudio.currentTime = (percent / 100) * currentAudio.duration;
      }
      break;
  }
}

export async function playItem(item) {
  if (!item) return;
  
  try {
    store.set('currentTrack', item);
    store.set('isPlaying', true);
    
    // Update Media Session
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: item.title,
        artist: item.artist || 'Unknown',
        album: item.album || '',
        artwork: [
          { src: api.getCoverUrl(item.id), sizes: '512x512', type: 'image/jpeg' }
        ]
      });
      navigator.mediaSession.setActionHandler('play', () => currentAudio.play());
      navigator.mediaSession.setActionHandler('pause', () => currentAudio.pause());
      navigator.mediaSession.setActionHandler('nexttrack', playNext);
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    }
    
    // Set source
    const streamUrl = api.getStreamUrl(item.id);
    currentAudio.src = streamUrl;
    currentAudio.load();
    
    // Connect to Web Audio
    connectAudioToGraph(currentAudio);
    
    await currentAudio.play();
    
    // Update history
    store.addToHistory(item.id, 0);
    api.addHistory({ itemId: item.id, progress: 0, duration: item.duration }).catch(() => {});
    
    // Preload next for gapless
    preloadNext();
    
    window.dispatchEvent(new CustomEvent('vault:track-changed', { detail: { item } }));
    
  } catch (err) {
    console.error('Play failed', err);
    toast.error(`Failed to play ${item.title}`);
  }
}

function preloadNext() {
  const queue = store.get('queue');
  const idx = store.get('queueIndex');
  const nextIdx = idx + 1;
  
  if (nextIdx < queue.length) {
    const nextItem = queue[nextIdx];
    nextAudio.src = api.getStreamUrl(nextItem.id);
    nextAudio.load();
  }
}

function onTimeUpdate() {
  if (!currentAudio.duration) return;
  
  const progress = (currentAudio.currentTime / currentAudio.duration) * 100;
  const currentTrack = store.get('currentTrack');
  
  if (currentTrack) {
    store.addToHistory(currentTrack.id, progress);
  }
  
  // Crossfade
  const crossfade = store.get('crossfade');
  if (crossfade > 0 && currentAudio.duration - currentAudio.currentTime <= crossfade && !isCrossfading) {
    const queue = store.get('queue');
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
}

function crossfadeToNext() {
  const queue = store.get('queue');
  const idx = store.get('queueIndex');
  const nextItem = queue[idx + 1];
  
  if (!nextItem) {
    isCrossfading = false;
    return;
  }
  
  nextAudio.volume = 0;
  nextAudio.play().catch(() => {});
  
  const duration = store.get('crossfade') * 1000;
  const start = Date.now();
  
  const fade = () => {
    const elapsed = Date.now() - start;
    const progress = Math.min(elapsed / duration, 1);
    
    currentAudio.volume = (1 - progress) * store.get('volume');
    nextAudio.volume = progress * store.get('volume');
    
    if (progress < 1) {
      requestAnimationFrame(fade);
    } else {
      // Swap
      const temp = currentAudio;
      currentAudio = nextAudio;
      nextAudio = temp;
      nextAudio.pause();
      nextAudio.src = '';
      
      currentAudio.addEventListener('timeupdate', onTimeUpdate);
      currentAudio.addEventListener('ended', onEnded);
      
      store.set('queueIndex', idx + 1, true);
      store.set('currentTrack', nextItem);
      isCrossfading = false;
      
      preloadNext();
    }
  };
  
  fade();
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
  const queue = store.get('queue');
  let idx = store.get('queueIndex');
  const shuffle = store.get('shuffle');
  const repeat = store.get('repeat');
  
  if (shuffle) {
    idx = Math.floor(Math.random() * queue.length);
  } else {
    idx++;
  }
  
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
  const queue = store.get('queue');
  let idx = store.get('queueIndex');
  
  if (currentAudio.currentTime > 3) {
    currentAudio.currentTime = 0;
    return;
  }
  
  idx--;
  if (idx < 0) idx = queue.length - 1;
  
  store.set('queueIndex', idx, true);
  playItem(queue[idx]);
}

function onLoadedMetadata() {
  window.dispatchEvent(new CustomEvent('vault:durationchange', {
    detail: { duration: currentAudio.duration }
  }));
}

export function getAudioElement() {
  return currentAudio;
}

export function getAnalyser() {
  return analyserNode;
}
