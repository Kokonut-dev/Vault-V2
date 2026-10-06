/**
 * Mini Player — persistent bottom bar
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { formatTime } from '../utils/format.js';
import { setIcon } from '../utils/icons.js';

export function initMiniPlayer() {
  const miniPlayer = document.getElementById('mini-player');
  const miniCoverImg = document.getElementById('mini-cover-img');
  const miniTitle = document.getElementById('mini-title');
  const miniArtist = document.getElementById('mini-artist');
  const miniProgressBar = document.getElementById('mini-progress-bar');
  const miniPlayBtn = document.getElementById('mini-play');
  const miniPrevBtn = document.getElementById('mini-prev');
  const miniNextBtn = document.getElementById('mini-next');
  const miniExpandBtn = document.getElementById('mini-expand');
  const miniMuteBtn = document.getElementById('mini-mute');
  const miniVolume = document.getElementById('mini-volume');
  
  const nowPlaying = document.getElementById('now-playing');
  const nowPlayingClose = document.getElementById('now-playing-close');
  const nowPlayingImg = document.getElementById('now-playing-img');
  const nowPlayingTitle = document.getElementById('now-playing-title');
  const nowPlayingArtist = document.getElementById('now-playing-artist');
  const nowPlayingSlider = document.getElementById('now-playing-slider');
  const nowPlayingCurrent = document.getElementById('now-playing-current');
  const nowPlayingDuration = document.getElementById('now-playing-duration');
  const npPlayBtn = document.getElementById('np-play');
  const npPrevBtn = document.getElementById('np-prev');
  const npNextBtn = document.getElementById('np-next');
  const npShuffleBtn = document.getElementById('np-shuffle');
  const npRepeatBtn = document.getElementById('np-repeat');
  
  function updateTrackInfo(item) {
    if (!item) {
      miniPlayer.style.display = 'none';
      miniPlayer.classList.remove('active');
      document.body.classList.remove('has-mini-player');
      return;
    }
    
    miniPlayer.style.display = 'flex';
    requestAnimationFrame(() => miniPlayer.classList.add('active'));
    document.body.classList.add('has-mini-player');
    
    miniTitle.textContent = item.title;
    miniArtist.textContent = item.artist || item.album || '';
    
    const coverUrl = api.getCoverUrl(item.id);
    miniCoverImg.src = coverUrl;
    miniCoverImg.style.display = 'block';
    miniCoverImg.onerror = () => miniCoverImg.style.display = 'none';
    
    // Now playing
    nowPlayingTitle.textContent = item.title;
    nowPlayingArtist.textContent = item.artist || '';
    nowPlayingImg.src = coverUrl;
    nowPlayingImg.onerror = () => nowPlayingImg.style.display = 'none';
    
    // Visualizer
    initVisualizer();
  }
  
  function updatePlayState(isPlaying) {
    // Icons are inline SVGs (utils/icons.js) — swap the glyph, keep the label.
    setIcon(miniPlayBtn, isPlaying ? 'pause' : 'play', { size: 16 });
    setIcon(npPlayBtn, isPlaying ? 'pause' : 'play', { size: 22 });
  }

  function syncMuteIcon() {
    const muted = store.get('isMuted') || store.get('volume') === 0;
    setIcon(miniMuteBtn, muted ? 'volume-x' : 'volume-2', { size: 16 });
  }
  
  function updateProgress(currentTime, duration, progress) {
    miniProgressBar.style.width = `${progress}%`;
    nowPlayingSlider.value = progress;
    nowPlayingCurrent.textContent = formatTime(currentTime);
    nowPlayingDuration.textContent = formatTime(duration);
  }
  
  // Events
  store.subscribe('currentTrack', updateTrackInfo);
  store.subscribe('isPlaying', updatePlayState);
  
  window.addEventListener('vault:timeupdate', (e) => {
    const { currentTime, duration, progress } = e.detail;
    updateProgress(currentTime, duration, progress);
  });
  
  window.addEventListener('vault:track-changed', (e) => {
    updateTrackInfo(e.detail.item);
  });
  
  miniPlayBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'playPause' } }));
  });
  
  miniPrevBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'prev' } }));
  });
  
  miniNextBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'next' } }));
  });
  
  miniExpandBtn.addEventListener('click', () => {
    nowPlaying.classList.add('active');
  });

  if (miniVolume) {
    miniVolume.value = store.get('volume') ?? 0.8;
    miniVolume.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      store.set('volume', vol, true);
      store.set('isMuted', vol === 0);
      syncMuteIcon();
    });
  }
  if (miniMuteBtn) {
    miniMuteBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'mute' } }));
      syncMuteIcon();
    });
  }
  store.subscribe('volume', (vol) => {
    if (miniVolume && document.activeElement !== miniVolume) miniVolume.value = vol;
    syncMuteIcon();
  });
  store.subscribe('isMuted', syncMuteIcon);
  
  nowPlayingClose.addEventListener('click', () => {
    nowPlaying.classList.remove('active');
  });
  
  npPlayBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'playPause' } }));
  });
  
  npPrevBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'prev' } }));
  });
  
  npNextBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'next' } }));
  });
  
  npShuffleBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'shuffle' } }));
  });
  
  npRepeatBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'repeat' } }));
  });
  
  nowPlayingSlider.addEventListener('input', (e) => {
    const percent = parseFloat(e.target.value);
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'seekPercent', percent } }));
  });
  
  // Shuffle / repeat glyphs come from the shared icon set (utils/icons.js) —
  // the accent-coloured "on" state is the only player-specific part.
  function updateShuffleUI(shuffle) {
    if (!npShuffleBtn) return;
    setIcon(npShuffleBtn, 'shuffle', { size: 18 });
    npShuffleBtn.style.color = shuffle ? 'var(--accent)' : '';
  }

  function updateRepeatUI(repeat) {
    if (!npRepeatBtn) return;
    setIcon(npRepeatBtn, repeat === 'one' ? 'repeat-1' : 'repeat', { size: 18 });
    npRepeatBtn.style.color = repeat !== 'off' ? 'var(--accent)' : '';
    npRepeatBtn.style.opacity = repeat === 'off' ? '0.5' : '1';
  }

  // Subscribe to store changes so UI stays in sync from any source (click, keyboard, etc.)
  store.subscribe('shuffle', updateShuffleUI);
  store.subscribe('repeat', updateRepeatUI);

  // Initial state
  const currentTrack = store.get('currentTrack');
  if (currentTrack) updateTrackInfo(currentTrack);
  updatePlayState(store.get('isPlaying'));
  updateShuffleUI(store.get('shuffle'));
  updateRepeatUI(store.get('repeat'));
  syncMuteIcon();
}

let visualizerRaf = null;
let visualizerStarted = false;

function initVisualizer() {
  const visualizerEl = document.getElementById('visualizer');
  if (!visualizerEl) return;

  if (!visualizerEl.childElementCount) {
    for (let i = 0; i < 32; i++) {
      const bar = document.createElement('div');
      bar.className = 'visualizer-bar';
      bar.style.height = '4px';
      visualizerEl.appendChild(bar);
    }
  }

  if (visualizerStarted) return;
  visualizerStarted = true;

  const bars = visualizerEl.querySelectorAll('.visualizer-bar');
  const dataArray = new Uint8Array(256);

  function animate() {
    visualizerRaf = requestAnimationFrame(animate);
    const nowPlaying = document.getElementById('now-playing');
    if (!nowPlaying || !nowPlaying.classList.contains('active')) return;
    const analyser = window.VAULT_AUDIO?.getAnalyser();
    if (!analyser) return;
    if (dataArray.length !== analyser.frequencyBinCount) {
      // recreate locally
    }
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);
    bars.forEach((bar, idx) => {
      const value = buf[idx * 2] || 0;
      const height = Math.max(4, (value / 255) * 60);
      bar.style.height = `${height}px`;
      bar.style.opacity = String(0.5 + (value / 255) * 0.5);
    });
  }

  animate();
}
