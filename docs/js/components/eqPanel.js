/**
 * EQ Panel — 10-band parametric EQ with Web Audio API
 */
import { store } from '../store.js';
import { EQ_PRESETS, EQ_FREQUENCIES } from '../utils/constants.js';
import { toast } from './toast.js';
import { onUnmount } from '../utils/lifecycle.js';

let canvas = null;
let ctx = null;

/** Detaches the previous panel's vault:eq-updated handler. */
let detachEqListener = null;

export function renderEQPanel(container) {
  const gains = store.get('eqGains');
  const preset = store.get('eqPreset');
  const enabled = store.get('eqEnabled');
  
  container.innerHTML = `
    <div class="eq-panel">
      <div class="eq-header">
        <div>
          <div class="eq-title">Equalizer</div>
          <label style="display:flex; align-items:center; gap:8px; margin-top:8px; font-size:13px;">
            <input type="checkbox" id="eq-enabled" ${enabled ? 'checked' : ''}> Enable EQ
          </label>
        </div>
        <button class="btn btn-secondary btn-sm" id="eq-reset">Reset</button>
      </div>
      
      <div class="eq-visual">
        <canvas class="eq-canvas" id="eq-canvas" width="800" height="200"></canvas>
      </div>
      
      <div style="padding:12px 16px; border-bottom:1px solid var(--border);">
        <div style="font-size:12px; font-weight:600; margin-bottom:8px;">Presets</div>
        <div class="eq-presets" id="eq-presets">
          ${Object.entries(EQ_PRESETS).map(([key, p]) => `
            <button class="eq-preset ${preset === key ? 'active' : ''}" data-preset="${key}">${p.name}</button>
          `).join('')}
        </div>
      </div>
      
      <div class="eq-bands" id="eq-bands">
        ${EQ_FREQUENCIES.map((freq, idx) => `
          <div class="eq-band ${gains[idx] !== 0 ? 'active' : ''}" data-index="${idx}">
            <div class="eq-band-freq">${freq >= 1000 ? (freq/1000)+'k' : freq}Hz</div>
            <input type="range" class="eq-band-slider" min="-12" max="12" step="0.5" value="${gains[idx]}" data-index="${idx}" orient="vertical">
            <div class="eq-band-gain">${gains[idx] > 0 ? '+' : ''}${gains[idx]}dB</div>
          </div>
        `).join('')}
      </div>
      
      <div class="eq-footer">
        <div class="eq-save">
          <input type="text" id="eq-preset-name" placeholder="Custom preset name">
          <button class="btn btn-secondary btn-sm" id="eq-save-preset">Save Custom</button>
        </div>
        <button class="btn btn-primary btn-sm" id="eq-close">Done</button>
      </div>
    </div>
  `;
  
  canvas = container.querySelector('#eq-canvas');
  ctx = canvas.getContext('2d');
  
  // Draw initial curve
  drawEQCurve(gains);
  
  // Events
  container.querySelector('#eq-enabled').addEventListener('change', (e) => {
    store.set('eqEnabled', e.target.checked, true);
  });
  
  container.querySelector('#eq-close')?.addEventListener('click', () => {
    container.closest('.modal-backdrop')?.remove();
  });

  container.querySelector('#eq-reset').addEventListener('click', () => {
    const flat = [0,0,0,0,0,0,0,0,0,0];
    store.set('eqGains', flat, true);
    store.set('eqPreset', 'flat', true);
    updateBandUI(flat);
    drawEQCurve(flat);
  });
  
  container.querySelectorAll('.eq-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      const presetData = EQ_PRESETS[key];
      if (presetData) {
        store.set('eqGains', [...presetData.gains], true);
        store.set('eqPreset', key, true);
        updateBandUI(presetData.gains);
        drawEQCurve(presetData.gains);
        container.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    });
  });
  
  container.querySelectorAll('.eq-band-slider').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const gains = [...store.get('eqGains')];
      gains[idx] = parseFloat(e.target.value);
      store.set('eqGains', gains, true);
      store.set('eqPreset', 'custom', true);
      
      const band = e.target.closest('.eq-band');
      band.classList.toggle('active', gains[idx] !== 0);
      band.querySelector('.eq-band-gain').textContent = `${gains[idx] > 0 ? '+' : ''}${gains[idx]}dB`;
      
      drawEQCurve(gains);
      
      container.querySelectorAll('.eq-preset').forEach(b => b.classList.remove('active'));
    });
  });
  
  container.querySelector('#eq-save-preset').addEventListener('click', () => {
    const name = container.querySelector('#eq-preset-name').value.trim();
    if (!name) {
      toast.error('Enter a preset name');
      return;
    }
    const custom = store.get('eqCustomPresets') || {};
    custom[name] = [...store.get('eqGains')];
    store.set('eqCustomPresets', custom, true);
    localStorage.setItem('vault_eq_custom', JSON.stringify(custom));
    toast.success(`Saved preset "${name}"`);
    container.querySelector('#eq-preset-name').value = '';
  });
  
  // Listen for external updates. The panel is re-created every time the EQ
  // dialog opens, so detach the previous handler first (and on unmount).
  detachEqListener?.();
  const onEqUpdated = (e) => {
    if (!container.isConnected) return;
    const { gains } = e.detail;
    updateBandUI(gains);
    drawEQCurve(gains);
  };
  window.addEventListener('vault:eq-updated', onEqUpdated);
  detachEqListener = () => window.removeEventListener('vault:eq-updated', onEqUpdated);
  onUnmount(detachEqListener);
}

function updateBandUI(gains) {
  document.querySelectorAll('.eq-band-slider').forEach((slider, idx) => {
    slider.value = gains[idx];
    const band = slider.closest('.eq-band');
    if (band) {
      band.classList.toggle('active', gains[idx] !== 0);
      const gainEl = band.querySelector('.eq-band-gain');
      if (gainEl) gainEl.textContent = `${gains[idx] > 0 ? '+' : ''}${gains[idx]}dB`;
    }
  });
}

function drawEQCurve(gains) {
  if (!ctx || !canvas) return;
  
  const width = canvas.width;
  const height = canvas.height;
  const padding = 20;
  
  ctx.clearRect(0, 0, width, height);
  
  // Grid
  ctx.strokeStyle = 'rgba(128,128,128,0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = padding + (i / 10) * (width - padding * 2);
    ctx.beginPath();
    ctx.moveTo(x, padding);
    ctx.lineTo(x, height - padding);
    ctx.stroke();
  }
  for (let i = 0; i <= 6; i++) {
    const y = padding + (i / 6) * (height - padding * 2);
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }
  
  // 0dB line
  ctx.strokeStyle = 'rgba(128,128,128,0.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padding, height / 2);
  ctx.lineTo(width - padding, height / 2);
  ctx.stroke();
  ctx.setLineDash([]);
  
  // Curve
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#7C5CFF';
  ctx.lineWidth = 3;
  ctx.beginPath();
  
  const points = [];
  for (let i = 0; i < EQ_FREQUENCIES.length; i++) {
    const x = padding + (i / (EQ_FREQUENCIES.length - 1)) * (width - padding * 2);
    // Map -12 to +12 dB to height
    const gain = gains[i];
    const y = height / 2 - (gain / 12) * (height / 2 - padding);
    points.push({ x, y });
  }
  
  // Smooth curve via bezier
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpX = (prev.x + curr.x) / 2;
    ctx.bezierCurveTo(cpX, prev.y, cpX, curr.y, curr.x, curr.y);
  }
  ctx.stroke();
  
  // Fill under
  ctx.lineTo(width - padding, height - padding);
  ctx.lineTo(padding, height - padding);
  ctx.closePath();
  ctx.fillStyle = 'rgba(124,92,255,0.1)';
  ctx.fill();
  
  // Points
  points.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#7C5CFF';
    ctx.fill();
    ctx.strokeStyle = 'white';
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

export function showEQModal() {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active';
  backdrop.innerHTML = `<div id="eq-modal-container" style="max-width:800px; width:100%;"></div>`;
  document.body.appendChild(backdrop);
  
  renderEQPanel(backdrop.querySelector('#eq-modal-container'));
  
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  
  backdrop.querySelector('#eq-close')?.addEventListener('click', () => backdrop.remove());
  
  return backdrop;
}
