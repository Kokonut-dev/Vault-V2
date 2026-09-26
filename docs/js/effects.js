/**
 * Visual effects — glass + grain sliders
 */
import { store } from './store.js';
import { themeManager } from './themes.js';

export function initEffects() {
  // Create grain overlay if not exists
  let grainEl = document.getElementById('grain-overlay');
  if (!grainEl) {
    grainEl = document.createElement('div');
    grainEl.id = 'grain-overlay';
    grainEl.className = 'grain-overlay';
    document.body.appendChild(grainEl);
  }

  // Apply initial values
  themeManager.setGlassIntensity(store.get('glassIntensity'));
  themeManager.setGrainIntensity(store.get('grainIntensity'));

  // Listen for settings changes
  window.addEventListener('vault:settings-updated', (e) => {
    const { glass, grain } = e.detail || {};
    if (glass !== undefined) themeManager.setGlassIntensity(glass);
    if (grain !== undefined) themeManager.setGrainIntensity(grain);
  });
}

export function createGlassSlider(container, initialValue = 20) {
  const wrapper = document.createElement('div');
  wrapper.className = 'form-group';
  wrapper.innerHTML = `
    <label class="form-label">Frosted Glass Intensity: <span class="glass-value">${initialValue}%</span></label>
    <input type="range" class="slider" min="0" max="100" value="${initialValue}" data-type="glass">
    <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-tertiary); margin-top:4px;">
      <span>Transparent</span><span>Heavy Frost</span>
    </div>
  `;
  const input = wrapper.querySelector('input');
  const valueEl = wrapper.querySelector('.glass-value');
  
  input.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    valueEl.textContent = `${val}%`;
    themeManager.setGlassIntensity(val);
  });

  container.appendChild(wrapper);
  return wrapper;
}

export function createGrainSlider(container, initialValue = 15) {
  const wrapper = document.createElement('div');
  wrapper.className = 'form-group';
  wrapper.innerHTML = `
    <label class="form-label">Film Grain Intensity: <span class="grain-value">${initialValue}%</span></label>
    <input type="range" class="slider" min="0" max="100" value="${initialValue}" data-type="grain">
    <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-tertiary); margin-top:4px;">
      <span>Off</span><span>Heavy</span>
    </div>
  `;
  const input = wrapper.querySelector('input');
  const valueEl = wrapper.querySelector('.grain-value');
  
  input.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    valueEl.textContent = `${val}%`;
    themeManager.setGrainIntensity(val);
  });

  container.appendChild(wrapper);
  return wrapper;
}
