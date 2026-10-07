/**
 * Settings view
 */
import { store } from '../store.js';
import { themeManager } from '../themes.js';
import { api } from '../api.js';
import { toast } from '../components/toast.js';
import { getApiBaseUrl, setApiBaseUrl } from '../config.js';
import { renderEQPanel } from '../components/eqPanel.js';
import { renderSettingsExtras } from './settingsExtras.js';
import { copyText } from '../utils/clipboard.js';
import { icon } from '../utils/icons.js';

export function renderSettings(container) {
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Settings</h1>
      <p class="page-subtitle">Customize your Vault experience</p>
    </div>
    
    <div class="settings-grid">
      <!-- Appearance -->
      <div class="settings-card">
        <h3><span class="settings-card-icon" aria-hidden="true">${icon('palette', { size: 17 })}</span>Appearance</h3>
        
        <div class="form-group">
          <label class="form-label">Theme</label>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${['dark', 'light', 'warm', 'cold'].map(theme => `
              <button class="btn ${store.get('theme') === theme ? 'btn-primary' : 'btn-secondary'} btn-sm" data-theme="${theme}">${theme.charAt(0).toUpperCase() + theme.slice(1)}</button>
            `).join('')}
          </div>
        </div>
        
        <div id="glass-slider-container"></div>
        <div id="grain-slider-container"></div>
      </div>
      
      <!-- Playback -->
      <div class="settings-card">
        <h3><span class="settings-card-icon" aria-hidden="true">${icon('play', { size: 17 })}</span>Playback</h3>
        
        <div class="form-group">
          <label class="form-label">Default Volume: <span id="vol-value">${Math.round(store.get('volume') * 100)}%</span></label>
          <input type="range" class="slider" id="vol-slider" min="0" max="100" value="${store.get('volume') * 100}">
        </div>
        
        <div class="form-group">
          <label class="form-label">Crossfade Duration: <span id="crossfade-value">${store.get('crossfade')}s</span></label>
          <input type="range" class="slider" id="crossfade-slider" min="0" max="12" value="${store.get('crossfade')}">
        </div>
        
        <div class="form-group">
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" id="gapless-toggle" ${localStorage.getItem('vault_gapless') !== 'false' ? 'checked' : ''}> Gapless Playback
          </label>
        </div>
        
        <div class="form-group">
          <button class="btn btn-secondary" id="open-eq">Open Equalizer</button>
        </div>
      </div>
      
      <!-- Server -->
      <div class="settings-card">
        <h3><span class="settings-card-icon" aria-hidden="true">${icon('database', { size: 17 })}</span>Server</h3>
        
        <div class="form-group">
          <label class="form-label">API Base URL</label>
          <div style="display:flex; gap:8px;">
            <input type="text" class="form-input" id="api-url" value="${getApiBaseUrl()}" style="flex:1;">
            <button class="btn btn-secondary" id="copy-api-url" type="button">${icon('copy', { size: 16 })}<span>Copy</span></button>
            <button class="btn btn-secondary" id="save-api-url">Save</button>
          </div>
          <div style="font-size:11px; color:var(--text-tertiary); margin-top:4px;">Change if your server is on a different URL (e.g., Cloudflare Tunnel)</div>
        </div>
        
        <div class="form-group">
          <button class="btn btn-secondary btn-sm" id="test-connection">Test Connection</button>
          <button class="btn btn-secondary btn-sm" id="trigger-scan">Trigger Library Scan</button>
        </div>
        
        <div id="server-info" style="font-size:12px; color:var(--text-secondary); background:rgba(var(--glass-tint),0.09); padding:12px; border-radius:8px; margin-top:12px; font-family:var(--font-mono);"></div>
      </div>
      
      <!-- Security -->
      <div class="settings-card">
        <h3><span class="settings-card-icon" aria-hidden="true">${icon('shield', { size: 17 })}</span>Security</h3>
        
        <div class="form-group">
          <label class="form-label">Change Credentials</label>
          <input type="password" class="form-input" id="current-pass" placeholder="Current password" style="margin-bottom:8px;">
          <input type="text" class="form-input" id="new-user" placeholder="New username (optional)" style="margin-bottom:8px;">
          <input type="password" class="form-input" id="new-pass" placeholder="New password (optional)" style="margin-bottom:8px;">
          <input type="text" class="form-input" id="new-grid" placeholder="New grid pattern (8 numbers 0-15 comma-separated, optional)">
          <button class="btn btn-primary btn-sm" id="save-creds" style="margin-top:12px;">Update Credentials</button>
        </div>
        
        <div class="form-group" style="margin-top:16px;">
          <button class="btn btn-secondary btn-sm" id="logout-btn">Logout</button>
        </div>
      </div>
      
      <!-- About -->
      <div class="settings-card">
        <h3><span class="settings-card-icon" aria-hidden="true">${icon('info', { size: 17 })}</span>About Vault</h3>
        <div style="font-size:13px; color:var(--text-secondary); line-height:1.6;">
          <p style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><strong>Vault v2.0.0</strong><span class="badge badge-accent">self-hosted</span></p>
          <p style="margin-top:8px;">A premium self-hosted personal media server — built with vanilla JS, Web Audio API, and Node.js. Supports all major audio/video codecs with on-the-fly transcoding.</p>
          <p style="margin-top:8px;">Themes: Dark, Light, Warm, Cold • Glassmorphism • Film Grain • 10-band EQ • Global Search</p>
          <p style="margin-top:12px;"><a href="https://github.com/Kokonut-dev/Vault-V2" target="_blank" rel="noopener" style="color:var(--accent-text); font-weight:600; text-decoration:none;">GitHub Repository ${icon('external-link', { size: 14, className: 'icon icon-inline' })}</a></p>
        </div>
      </div>
    </div>
    
    <div id="eq-modal-host"></div>
  `;
  
  // v3 cards: playback quality, subtitles, devices/pairing, TOTP, remote access.
  renderSettingsExtras(container);

  // Theme buttons
  container.querySelectorAll('[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => {
      themeManager.setTheme(btn.dataset.theme);
      container.querySelectorAll('[data-theme]').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.theme === btn.dataset.theme);
        b.classList.toggle('btn-secondary', b.dataset.theme !== btn.dataset.theme);
      });
    });
  });
  
  // Glass & Grain sliders
  const { createGlassSlider, createGrainSlider } = (() => {
    // Inline simple versions
    const glassContainer = container.querySelector('#glass-slider-container');
    const grainContainer = container.querySelector('#grain-slider-container');
    
    glassContainer.innerHTML = `
      <div class="form-group">
        <label class="form-label">Glass Intensity: <span id="glass-val">${store.get('glassIntensity')}%</span></label>
        <input type="range" class="slider" id="glass-slider" min="0" max="100" value="${store.get('glassIntensity')}">
      </div>
    `;
    grainContainer.innerHTML = `
      <div class="form-group">
        <label class="form-label">Grain Intensity: <span id="grain-val">${store.get('grainIntensity')}%</span></label>
        <input type="range" class="slider" id="grain-slider" min="0" max="100" value="${store.get('grainIntensity')}">
      </div>
    `;
    
    return {};
  })();
  
  container.querySelector('#glass-slider')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    container.querySelector('#glass-val').textContent = `${val}%`;
    themeManager.setGlassIntensity(val);
  });
  
  container.querySelector('#grain-slider')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    container.querySelector('#grain-val').textContent = `${val}%`;
    themeManager.setGrainIntensity(val);
  });
  
  // Volume
  container.querySelector('#vol-slider').addEventListener('input', (e) => {
    const vol = parseInt(e.target.value, 10) / 100;
    store.set('volume', vol, true);
    container.querySelector('#vol-value').textContent = `${e.target.value}%`;
  });
  
  // Crossfade
  container.querySelector('#crossfade-slider').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    store.set('crossfade', val, true);
    container.querySelector('#crossfade-value').textContent = `${val}s`;
  });
  
  // EQ
  container.querySelector('#open-eq').addEventListener('click', () => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop active';
    backdrop.innerHTML = `<div id="eq-container" style="max-width:800px; width:100%; margin:20px;"></div>`;
    document.body.appendChild(backdrop);
    renderEQPanel(backdrop.querySelector('#eq-container'));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    backdrop.querySelector('#eq-close')?.addEventListener('click', () => backdrop.remove());
  });
  
  // API URL
  container.querySelector('#copy-api-url').addEventListener('click', async () => {
    const url = container.querySelector('#api-url').value.trim();
    if (await copyText(url)) toast.success('Server URL copied to clipboard');
    else toast.error('Could not copy — select the URL and copy manually');
  });

  container.querySelector('#save-api-url').addEventListener('click', () => {
    const url = container.querySelector('#api-url').value.trim().replace(/\/+$/, '');
    if (url) {
      setApiBaseUrl(url);
      container.querySelector('#api-url').value = url;
      toast.success(`API URL saved: ${url}`);
    }
  });
  
  container.querySelector('#test-connection').addEventListener('click', async () => {
    try {
      const health = await api.health();
      toast.success(`Connected: ${health.library?.total || 0} items`);
      container.querySelector('#server-info').textContent = JSON.stringify(health, null, 2);
    } catch (err) {
      toast.error(`Connection failed: ${err.message}`);
      container.querySelector('#server-info').textContent = `Error: ${err.message}`;
    }
  });
  
  container.querySelector('#trigger-scan').addEventListener('click', async () => {
    try {
      toast.info('Starting library scan...');
      const res = await api.triggerScan();
      toast.success(`Scan complete: ${res.scanned} items`);
      const data = await api.getLibrary({ limit: 1000 });
      store.setLibrary(data.items || []);
    } catch (err) {
      toast.error(err.message);
    }
  });
  
  // Security
  container.querySelector('#save-creds').addEventListener('click', async () => {
    const currentPassword = container.querySelector('#current-pass').value;
    const newUsername = container.querySelector('#new-user').value.trim();
    const newPassword = container.querySelector('#new-pass').value;
    const newGridStr = container.querySelector('#new-grid').value.trim();
    
    if (!currentPassword) {
      toast.error('Current password required');
      return;
    }
    
    const payload = { currentPassword };
    if (newUsername) payload.newUsername = newUsername;
    if (newPassword) payload.newPassword = newPassword;
    if (newGridStr) {
      try {
        const pattern = newGridStr.split(',').map(s => parseInt(s.trim(), 10));
        if (pattern.length !== 8 || pattern.some(n => isNaN(n) || n < 0 || n > 15)) throw new Error();
        payload.newGridPattern = pattern;
      } catch {
        toast.error('Invalid grid pattern — must be 8 numbers 0-15 comma-separated');
        return;
      }
    }
    
    try {
      await api.updateCredentials(payload);
      toast.success('Credentials updated');
      container.querySelector('#current-pass').value = '';
      container.querySelector('#new-user').value = '';
      container.querySelector('#new-pass').value = '';
      container.querySelector('#new-grid').value = '';
    } catch (err) {
      toast.error(err.message);
    }
  });
  
  container.querySelector('#logout-btn').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('vault:logout'));
  });
  
  // Load server info. The write must survive the user navigating away before
  // the request resolves (the element is gone once the view unmounts).
  const showServerInfo = (text) => {
    const el = container.querySelector('#server-info');
    if (el) el.textContent = text;
  };
  api.health()
    .then(health => showServerInfo(JSON.stringify(health, null, 2)))
    .catch(err => showServerInfo(`Cannot connect: ${err.message}`));
}
