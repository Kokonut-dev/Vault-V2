/**
 * EQ Panel — 10-band parametric EQ with Web Audio API
 */
import { createFocusTrap } from '../utils/focusTrap.js';
import { store } from '../store.js';
import { EQ_PRESETS, EQ_FREQUENCIES } from '../utils/constants.js';
import { toast } from './toast.js';
import { icon } from '../utils/icons.js';
import { onUnmount } from '../utils/lifecycle.js';

let canvas = null;
let ctx = null;
let resizeObserver = null;

/** Detaches the previous panel's vault:eq-updated handler. */
let detachEqListener = null;

const BAND_MIN = -12;
const BAND_MAX = 12;

const freqLabel = (freq) => (freq >= 1000 ? `${freq / 1000}k` : String(freq));
const freqSpoken = (freq) => (freq >= 1000 ? `${freq / 1000} kilohertz` : `${freq} hertz`);
const formatGain = (g) => (g === 0 ? '0 dB' : `${g > 0 ? '+' : '−'}${Math.abs(g)} dB`);
const sameGains = (a, b) => a.length === b.length && a.every((v, i) => Number(v) === Number(b[i]));
const escapeAttr = (v) => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function customPresets() {
  const raw = store.get('eqCustomPresets');
  return raw && typeof raw === 'object' ? raw : {};
}

function presetName(key) {
  if (!key || key === 'custom') return 'Custom';
  if (key.startsWith('user:')) return key.slice(5);
  return EQ_PRESETS[key]?.name || 'Custom';
}

/** Fill the slider track from 0 dB to the value (EQ gain is centred, not bottom-up). */
function paintSlider(slider) {
  const value = Number(slider.value);
  const pos = ((value - BAND_MIN) / (BAND_MAX - BAND_MIN)) * 100;
  slider.style.setProperty('--lo', `${Math.min(50, pos)}%`);
  slider.style.setProperty('--hi', `${Math.max(50, pos)}%`);
}

export function renderEQPanel(container) {
  const gains = store.get('eqGains');
  const enabled = store.get('eqEnabled');

  container.innerHTML = `
    <div class="eq-panel${enabled ? '' : ' is-off'}">
      <header class="eq-header">
        <div class="eq-heading">
          <h2 class="eq-title" id="eq-title">Equaliser</h2>
          <p class="eq-status" id="eq-status" aria-live="polite"></p>
        </div>
        <label class="eq-power">
          <span class="eq-power-label">On</span>
          <input type="checkbox" class="switch" id="eq-enabled" ${enabled ? 'checked' : ''} aria-label="Equaliser on">
        </label>
        <button type="button" class="btn-icon eq-x" id="eq-x" aria-label="Close equaliser">${icon('x', { size: 18 })}</button>
      </header>

      <div class="eq-body">
        <div class="eq-visual" aria-hidden="true">
          <canvas class="eq-canvas" id="eq-canvas"></canvas>
          <span class="eq-axis eq-axis-top">+12</span>
          <span class="eq-axis eq-axis-mid">0</span>
          <span class="eq-axis eq-axis-bottom">−12</span>
        </div>

        <div class="eq-presets-wrap">
          <div class="eq-label" id="eq-presets-label">Presets</div>
          <div class="eq-presets" id="eq-presets" role="group" aria-labelledby="eq-presets-label"></div>
        </div>

        <div class="eq-bands" id="eq-bands" role="group" aria-label="Bands">
          ${EQ_FREQUENCIES.map((freq, idx) => `
            <div class="eq-band${gains[idx] !== 0 ? ' active' : ''}" data-index="${idx}">
              <span class="eq-band-gain" aria-hidden="true">${formatGain(gains[idx])}</span>
              <input type="range" class="eq-band-slider" min="${BAND_MIN}" max="${BAND_MAX}" step="0.5" value="${gains[idx]}" data-index="${idx}"
                aria-label="${freqSpoken(freq)}" aria-valuetext="${formatGain(gains[idx])}" title="Double-click to reset">
              <span class="eq-band-freq" aria-hidden="true">${freqLabel(freq)}<small>Hz</small></span>
            </div>
          `).join('')}
        </div>
      </div>

      <footer class="eq-footer">
        <form class="eq-save" id="eq-save-form">
          <input type="text" class="form-input" id="eq-preset-name" maxlength="32" placeholder="Name this sound" aria-label="Custom preset name" autocomplete="off">
          <button type="submit" class="btn btn-secondary btn-sm" id="eq-save-preset">${icon('plus', { size: 14 })}<span>Save preset</span></button>
        </form>
        <div class="eq-footer-actions">
          <button type="button" class="btn btn-ghost btn-sm" id="eq-reset">Reset</button>
          <button type="button" class="btn btn-primary btn-sm" id="eq-close">Done</button>
        </div>
      </footer>
    </div>
  `;

  const panel = container.querySelector('.eq-panel');
  const toggle = container.querySelector('#eq-enabled');
  const status = container.querySelector('#eq-status');
  const powerLabel = container.querySelector('.eq-power-label');
  const presetsEl = container.querySelector('#eq-presets');
  const sliders = [...container.querySelectorAll('.eq-band-slider')];

  canvas = container.querySelector('#eq-canvas');
  ctx = canvas.getContext('2d');
  sliders.forEach(paintSlider);

  function paintStatus() {
    const on = store.get('eqEnabled');
    panel.classList.toggle('is-off', !on);
    powerLabel.textContent = on ? 'On' : 'Off';
    status.textContent = on ? presetName(store.get('eqPreset')) : 'Off — pick a preset or move a band to turn it on';
  }

  function renderPresets() {
    const active = store.get('eqPreset');
    const builtIn = Object.entries(EQ_PRESETS).map(([key, p]) => `
      <button type="button" class="eq-preset${active === key ? ' active' : ''}" data-preset="${key}" aria-pressed="${active === key}">${p.name}</button>`);
    const mine = Object.keys(customPresets()).map((name) => {
      const key = `user:${name}`;
      return `
      <span class="eq-preset eq-preset-user${active === key ? ' active' : ''}">
        <button type="button" class="eq-preset-apply" data-preset="${escapeAttr(key)}" aria-pressed="${active === key}">${escapeAttr(name)}</button>
        <button type="button" class="eq-preset-remove" data-remove="${escapeAttr(name)}" aria-label="Delete preset ${escapeAttr(name)}">${icon('x', { size: 12 })}</button>
      </span>`;
    });
    presetsEl.innerHTML = builtIn.concat(mine).join('');
  }

  // Changing the sound while the EQ is off would silently do nothing — turn it on.
  function ensureOn() {
    if (store.get('eqEnabled')) return;
    toggle.checked = true;
    store.set('eqEnabled', true, true);
  }

  function apply(next, presetKey) {
    store.set('eqGains', next, true);
    store.set('eqPreset', presetKey, true);
    updateBandUI(next, container);
    drawEQCurve(next);
    renderPresets();
    paintStatus();
  }

  function setBand(idx, value) {
    const next = [...store.get('eqGains')];
    next[idx] = value;
    // Matching a preset again (e.g. dragging back to flat) re-selects it.
    const builtIn = Object.entries(EQ_PRESETS).find(([, p]) => sameGains(p.gains, next))?.[0];
    const mine = Object.entries(customPresets()).find(([, g]) => sameGains(g, next))?.[0];
    const match = builtIn || (mine ? `user:${mine}` : null);
    ensureOn();
    store.set('eqGains', next, true);
    const before = store.get('eqPreset');
    store.set('eqPreset', match || 'custom', true);
    const slider = sliders[idx];
    paintSlider(slider);
    slider.setAttribute('aria-valuetext', formatGain(value));
    const band = slider.closest('.eq-band');
    band.classList.toggle('active', value !== 0);
    band.querySelector('.eq-band-gain').textContent = formatGain(value);
    scheduleDraw(next);
    if (before !== store.get('eqPreset')) renderPresets();
    paintStatus();
  }

  // rAF-coalesced redraws: `input` fires far faster than the screen refreshes.
  let pending = null;
  function scheduleDraw(next) {
    const first = pending === null;
    pending = next;
    if (first) requestAnimationFrame(() => { const g = pending; pending = null; drawEQCurve(g); });
  }

  renderPresets();
  paintStatus();
  sizeCanvas();
  drawEQCurve(gains);

  resizeObserver?.disconnect();
  resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (!canvas?.isConnected) { resizeObserver?.disconnect(); return; }
    sizeCanvas();
    drawEQCurve(store.get('eqGains'));
  }) : null;
  resizeObserver?.observe(canvas);

  toggle.addEventListener('change', () => {
    store.set('eqEnabled', toggle.checked, true);
    paintStatus();
    drawEQCurve(store.get('eqGains'));
  });

  container.querySelector('#eq-reset').addEventListener('click', () => {
    apply([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'flat');
  });

  presetsEl.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const name = remove.dataset.remove;
      const custom = { ...customPresets() };
      delete custom[name];
      saveCustom(custom);
      if (store.get('eqPreset') === `user:${name}`) store.set('eqPreset', 'custom', true);
      renderPresets();
      paintStatus();
      toast.info(`Deleted “${name}”`);
      presetsEl.querySelector('button')?.focus();
      return;
    }
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const key = btn.dataset.preset;
    const gainsFor = key.startsWith('user:') ? customPresets()[key.slice(5)] : EQ_PRESETS[key]?.gains;
    if (!Array.isArray(gainsFor)) return;
    ensureOn();
    apply([...gainsFor], key);
    presetsEl.querySelector(`[data-preset="${CSS.escape(key)}"]`)?.focus();
  });

  sliders.forEach((slider) => {
    const idx = Number(slider.dataset.index);
    slider.addEventListener('input', () => setBand(idx, Number(slider.value)));
    slider.addEventListener('dblclick', () => { slider.value = 0; setBand(idx, 0); });
  });

  container.querySelector('#eq-save-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = container.querySelector('#eq-preset-name');
    const name = input.value.trim().replace(/\s+/g, ' ');
    if (!name) {
      toast.error('Give the preset a name first');
      input.focus();
      return;
    }
    const custom = { ...customPresets() };
    const existed = Object.prototype.hasOwnProperty.call(custom, name);
    custom[name] = [...store.get('eqGains')];
    saveCustom(custom);
    store.set('eqPreset', `user:${name}`, true);
    renderPresets();
    paintStatus();
    toast.success(existed ? `Updated “${name}”` : `Saved “${name}”`);
    input.value = '';
  });

  // Listen for external updates. The panel is re-created every time the EQ
  // dialog opens, so detach the previous handler first (and on unmount).
  detachEqListener?.();
  const onEqUpdated = (e) => {
    if (!container.isConnected) return;
    const { gains: next } = e.detail;
    updateBandUI(next, container);
    drawEQCurve(next);
  };
  window.addEventListener('vault:eq-updated', onEqUpdated);
  detachEqListener = () => window.removeEventListener('vault:eq-updated', onEqUpdated);
  onUnmount(detachEqListener);
}

function saveCustom(custom) {
  store.set('eqCustomPresets', custom, true);
  try { localStorage.setItem('vault_eq_custom', JSON.stringify(custom)); } catch { /* storage full/private mode */ }
}

function updateBandUI(gains, root = document) {
  root.querySelectorAll('.eq-band-slider').forEach((slider, idx) => {
    slider.value = gains[idx];
    paintSlider(slider);
    slider.setAttribute('aria-valuetext', formatGain(gains[idx]));
    const band = slider.closest('.eq-band');
    if (band) {
      band.classList.toggle('active', gains[idx] !== 0);
      const gainEl = band.querySelector('.eq-band-gain');
      if (gainEl) gainEl.textContent = formatGain(gains[idx]);
    }
  });
}

/** Match the canvas bitmap to its CSS size × devicePixelRatio (it was a fixed 800×200, stretched and blurry). */
function sizeCanvas() {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function drawEQCurve(gains) {
  if (!ctx || !canvas || !canvas.isConnected) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  if (width < 2 || height < 2) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // One style lookup per draw (it used to be one per point).
  const styles = getComputedStyle(canvas);
  const accent = styles.getPropertyValue('--accent').trim() || '#F2A877';
  const grid = styles.getPropertyValue('--border').trim() || 'rgba(128,128,128,0.2)';
  const surface = styles.getPropertyValue('--bg-elevated').trim() || '#fff';
  const on = Boolean(store.get('eqEnabled'));

  const padX = 30;
  const padY = 16;
  const mid = height / 2;
  const span = mid - padY;
  ctx.clearRect(0, 0, width, height);

  // Grid: one line per band + ±6/±12 dB rows.
  ctx.strokeStyle = grid;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < EQ_FREQUENCIES.length; i++) {
    const x = Math.round(padX + (i / (EQ_FREQUENCIES.length - 1)) * (width - padX * 2)) + 0.5;
    ctx.moveTo(x, padY);
    ctx.lineTo(x, height - padY);
  }
  for (const db of [-12, -6, 6, 12]) {
    const y = Math.round(mid - (db / 12) * span) + 0.5;
    ctx.moveTo(padX, y);
    ctx.lineTo(width - padX, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padX, Math.round(mid) + 0.5);
  ctx.lineTo(width - padX, Math.round(mid) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const points = EQ_FREQUENCIES.map((_, i) => ({
    x: padX + (i / (EQ_FREQUENCIES.length - 1)) * (width - padX * 2),
    y: mid - (Number(gains[i]) / 12) * span,
  }));
  const trace = () => {
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cpX = (prev.x + curr.x) / 2;
      ctx.bezierCurveTo(cpX, prev.y, cpX, curr.y, curr.x, curr.y);
    }
  };

  ctx.globalAlpha = on ? 1 : 0.45;
  // Fill between the curve and 0 dB, so boosts and cuts read at a glance.
  ctx.beginPath();
  trace();
  ctx.lineTo(points.at(-1).x, mid);
  ctx.lineTo(points[0].x, mid);
  ctx.closePath();
  ctx.fillStyle = accent;
  ctx.globalAlpha = on ? 0.16 : 0.08;
  ctx.fill();

  ctx.globalAlpha = on ? 1 : 0.45;
  ctx.beginPath();
  trace();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = surface;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = accent;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function showEQModal() {
  // One at a time — a second click used to stack another dialog on top.
  const existing = document.getElementById('eq-modal-container');
  if (existing) { existing.querySelector('#eq-enabled')?.focus(); return existing.closest('.modal-backdrop'); }

  const opener = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop active eq-backdrop';
  // A real dialog: labelled, focus-trapped, closes on Escape / backdrop /
  // Done, and hands focus back to whatever opened it (SR-11).
  backdrop.innerHTML = `<div id="eq-modal-container" class="eq-modal" role="dialog" aria-modal="true" aria-labelledby="eq-title"></div>`;
  document.body.appendChild(backdrop);

  renderEQPanel(backdrop.querySelector('#eq-modal-container'));

  const trap = createFocusTrap(backdrop, {
    initialFocus: () => backdrop.querySelector('#eq-enabled'),
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('vault:escape', close);
    document.removeEventListener('keydown', onKeydown);
    resizeObserver?.disconnect();
    resizeObserver = null;
    trap.release();
    backdrop.remove();
    if (opener && document.body.contains(opener)) opener.focus?.();
  };
  const onKeydown = (e) => { if (e.key === 'Escape') close(); };
  window.addEventListener('vault:escape', close);
  document.addEventListener('keydown', onKeydown);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('#eq-close')?.addEventListener('click', close);
  backdrop.querySelector('#eq-x')?.addEventListener('click', close);
  trap.activate();

  return backdrop;
}
