/**
 * Mini Player — persistent bottom bar
 */
import { store } from '../store.js';
import { api } from '../api.js';
import { formatTime } from '../utils/format.js';

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
    miniPlayBtn.textContent = isPlaying ? '⏸' : '▶';
    npPlayBtn.textContent = isPlaying ? '⏸' : '▶';
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
      if (miniMuteBtn) miniMuteBtn.textContent = vol === 0 ? '🔇' : '🔊';
    });
  }
  if (miniMuteBtn) {
    miniMuteBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'mute' } }));
      const muted = store.get('isMuted');
      miniMuteBtn.textContent = muted ? '🔇' : '🔊';
    });
  }
  store.subscribe('volume', (vol) => {
    if (miniVolume && document.activeElement !== miniVolume) miniVolume.value = vol;
    if (miniMuteBtn) miniMuteBtn.textContent = vol === 0 || store.get('isMuted') ? '🔇' : '🔊';
  });
  
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
    const shuffle = !store.get('shuffle');
    store.set('shuffle', shuffle, true);
    npShuffleBtn.style.color = shuffle ? 'var(--accent)' : '';
  });
  
  npRepeatBtn.addEventListener('click', () => {
    const modes = ['off', 'all', 'one'];
    const current = store.get('repeat');
    const idx = modes.indexOf(current);
    const next = modes[(idx + 1) % modes.length];
    store.set('repeat', next, true);
    npRepeatBtn.textContent = next === 'one' ? '🔂' : next === 'all' ? '🔁' : '🔁';
    npRepeatBtn.style.color = next !== 'off' ? 'var(--accent)' : '';
    npRepeatBtn.style.opacity = next === 'off' ? '0.5' : '1';
  });
  
  nowPlayingSlider.addEventListener('input', (e) => {
    const percent = parseFloat(e.target.value);
    window.dispatchEvent(new CustomEvent('vault:player-action', { detail: { action: 'seekPercent', percent } }));
  });
  
  // Initial state
  const currentTrack = store.get('currentTrack');
  if (currentTrack) updateTrackInfo(currentTrack);
  updatePlayState(store.get('isPlaying'));
  
  // Shuffle/repeat UI
  if (store.get('shuffle')) npShuffleBtn.style.color = 'var(--accent)';
  if (store.get('repeat') !== 'off') {
    npRepeatBtn.style.color = 'var(--accent)';
  } else {
    npRepeatBtn.style.opacity = '0.5';
  }
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
