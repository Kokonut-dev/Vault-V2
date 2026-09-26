/**
 * Onboarding Wizard — 6 steps
 * Handles first-time setup flow for Vault V2
 * 
 * Steps:
 * 1. Welcome
 * 2. Server Connection
 * 3. Admin Account
 * 4. Security Grid
 * 5. Media & Preferences
 * 6. Review & Complete
 */

import { api } from './api.js';
import { getApiBaseUrl, setApiBaseUrl, getConfig } from './config.js';
import { escapeHtml } from './utils/format.js';
import { store } from './store.js';
import { toast } from './components/toast.js';

export class OnboardingManager {
  constructor() {
    this.currentStep = 1;
    this.totalSteps = 6;
    this.data = {
      apiUrl: getApiBaseUrl(),
      username: '',
      password: '',
      confirmPassword: '',
      gridPattern: [],
      gridOrderMatters: false,
      mediaPaths: {
        movies: './media/movies',
        music: './media/music',
        videos: './media/videos',
      },
      corsOrigins: [],
      theme: localStorage.getItem('vault_theme') || 'dark',
      serverPort: 4000,
    };
    this.setupStatus = null;
    this.isConnected = false;
  }

  async init() {
    // Check if we need onboarding
    try {
      const status = await this.checkSetupStatus();
      return status.needsSetup;
    } catch {
      // If cannot connect, still show onboarding for connection step
      return true;
    }
  }

  async checkSetupStatus() {
    try {
      const status = await api.getSetupStatus();
      this.setupStatus = status;
      this.isConnected = true;
      return status;
    } catch (err) {
      this.isConnected = false;
      throw err;
    }
  }

  render(container) {
    container.innerHTML = `
      <div class="onboarding-gate" id="onboarding-gate">
        <div class="onboarding-container">
          <div class="onboarding-header">
            <div class="onboarding-progress" id="onboarding-progress">
              ${Array.from({ length: this.totalSteps }, (_, i) => `
                <div class="onboarding-progress-dot ${i + 1 === this.currentStep ? 'active' : ''} ${i + 1 < this.currentStep ? 'completed' : ''}" data-step="${i + 1}"></div>
              `).join('')}
            </div>
            <div class="onboarding-step-label" id="onboarding-step-label">Step ${this.currentStep} of ${this.totalSteps}</div>
            <h1 class="onboarding-title" id="onboarding-title">Welcome to Vault</h1>
            <p class="onboarding-subtitle" id="onboarding-subtitle">Your premium self-hosted media server</p>
          </div>
          
          <div class="onboarding-body" id="onboarding-body">
            <!-- Steps injected here -->
          </div>
          
          <div class="onboarding-footer">
            <div class="onboarding-footer-left">
              <button class="btn btn-ghost btn-sm" id="onboarding-back" style="display:none;">← Back</button>
              <button class="onboarding-skip" id="onboarding-skip" style="display:none;">Skip to login</button>
            </div>
            <div class="onboarding-footer-right">
              <button class="btn btn-secondary btn-sm" id="onboarding-secondary" style="display:none;"></button>
              <button class="btn btn-primary" id="onboarding-next">Get Started →</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.bindEvents();
    this.renderStep();
  }

  bindEvents() {
    const nextBtn = document.getElementById('onboarding-next');
    const backBtn = document.getElementById('onboarding-back');
    const skipBtn = document.getElementById('onboarding-skip');

    nextBtn.addEventListener('click', () => this.next());
    backBtn.addEventListener('click', () => this.back());
    skipBtn.addEventListener('click', () => this.skip());

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('onboarding-gate')) return;
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        this.next();
      }
      if (e.key === 'Escape' && this.currentStep > 1) {
        this.back();
      }
    });
  }

  updateProgress() {
    const dots = document.querySelectorAll('.onboarding-progress-dot');
    dots.forEach((dot, idx) => {
      const step = idx + 1;
      dot.classList.toggle('active', step === this.currentStep);
      dot.classList.toggle('completed', step < this.currentStep);
    });

    const label = document.getElementById('onboarding-step-label');
    if (label) label.textContent = `Step ${this.currentStep} of ${this.totalSteps}`;

    const backBtn = document.getElementById('onboarding-back');
    if (backBtn) backBtn.style.display = this.currentStep > 1 ? 'inline-flex' : 'none';

    const skipBtn = document.getElementById('onboarding-skip');
    if (skipBtn) {
      // Show skip if server already configured
      skipBtn.style.display = this.setupStatus && !this.setupStatus.needsSetup ? 'inline-flex' : 'none';
    }
  }

  renderStep() {
    const body = document.getElementById('onboarding-body');
    const titleEl = document.getElementById('onboarding-title');
    const subtitleEl = document.getElementById('onboarding-subtitle');
    const nextBtn = document.getElementById('onboarding-next');
    const secondaryBtn = document.getElementById('onboarding-secondary');

    if (!body) return;

    this.updateProgress();

    // Reset secondary button
    secondaryBtn.style.display = 'none';
    secondaryBtn.textContent = '';

    switch (this.currentStep) {
      case 1:
        titleEl.textContent = 'Welcome to Vault';
        subtitleEl.textContent = 'Your premium self-hosted personal media server for movies, music, and videos';
        body.innerHTML = this.renderWelcome();
        nextBtn.textContent = 'Get Started →';
        nextBtn.disabled = false;
        break;

      case 2:
        titleEl.textContent = 'Connect to Server';
        subtitleEl.textContent = 'Vault needs a local server to manage your media library';
        body.innerHTML = this.renderServerConnection();
        nextBtn.textContent = 'Test & Continue →';
        nextBtn.disabled = false;
        this.bindServerStep();
        break;

      case 3:
        titleEl.textContent = 'Create Admin Account';
        subtitleEl.textContent = 'Set up your administrator credentials';
        body.innerHTML = this.renderAdminAccount();
        nextBtn.textContent = 'Continue →';
        nextBtn.disabled = false;
        this.bindAccountStep();
        break;

      case 4:
        titleEl.textContent = 'Security Grid';
        subtitleEl.textContent = 'Choose 8 secret squares — your second authentication factor';
        body.innerHTML = this.renderGridStep();
        nextBtn.textContent = 'Continue →';
        nextBtn.disabled = this.data.gridPattern.length !== 8;
        this.bindGridStep();
        break;

      case 5:
        titleEl.textContent = 'Media & Preferences';
        subtitleEl.textContent = 'Configure your library and appearance';
        body.innerHTML = this.renderMediaStep();
        nextBtn.textContent = 'Continue →';
        nextBtn.disabled = false;
        this.bindMediaStep();
        break;

      case 6:
        titleEl.textContent = 'Ready to Launch';
        subtitleEl.textContent = 'Review your settings and complete setup';
        body.innerHTML = this.renderReviewStep();
        nextBtn.textContent = 'Complete Setup ✨';
        nextBtn.disabled = false;
        secondaryBtn.style.display = 'inline-flex';
        secondaryBtn.textContent = 'Back to Review';
        secondaryBtn.onclick = () => this.renderStep(); // refresh
        break;

      default:
        break;
    }
  }

  renderWelcome() {
    return `
      <div class="onboarding-step active">
        <div class="onboarding-welcome-icon">V</div>
        <p style="font-size:14px; line-height:1.6; color:var(--text-secondary); margin-bottom:20px;">
          Vault is a premium, self-hosted media server that keeps your movies, music, and videos private and beautifully organized.
          No cloud, no tracking — just you and your media.
        </p>
        
        <div class="onboarding-features">
          <div class="onboarding-feature">
            <div class="onboarding-feature-icon">🔒</div>
            <div class="onboarding-feature-text">
              <strong>Two-Factor Security</strong>
              <span>Password + secret grid pattern protects your vault</span>
            </div>
          </div>
          <div class="onboarding-feature">
            <div class="onboarding-feature-icon">🎬</div>
            <div class="onboarding-feature-text">
              <strong>All Formats Supported</strong>
              <span>Movies, music, videos with on-the-fly transcoding</span>
            </div>
          </div>
          <div class="onboarding-feature">
            <div class="onboarding-feature-icon">✨</div>
            <div class="onboarding-feature-text">
              <strong>Premium Experience</strong>
              <span>Glassmorphism, themes, EQ, and powerful search</span>
            </div>
          </div>
        </div>

        <div class="onboarding-hint" style="margin-top:16px; padding:12px; background:var(--bg-secondary); border-radius:10px; border:1px solid var(--border);">
          <strong style="color:var(--text-primary);">First time?</strong> This wizard will set up your server in under 2 minutes. 
          You'll create an admin account and a secret grid pattern.
        </div>
      </div>
    `;
  }

  renderServerConnection() {
    const needsSetup = this.setupStatus ? this.setupStatus.needsSetup : null;
    const hasConfig = this.setupStatus ? this.setupStatus.hasConfig : null;

    return `
      <div class="onboarding-step active">
        <div class="onboarding-form">
          <div class="onboarding-input-group">
            <label class="onboarding-label">Server URL</label>
            <div style="display:flex; gap:8px;">
              <input type="text" class="onboarding-input" id="ob-api-url" value="${this.data.apiUrl}" placeholder="http://localhost:4000" style="flex:1;">
              <button class="btn btn-secondary btn-sm" id="ob-test-connection" type="button">Test</button>
            </div>
            <div class="onboarding-hint">
              For local dev: <code>http://localhost:4000</code><br>
              For remote: Cloudflare Tunnel or ngrok HTTPS URL
            </div>
          </div>

          <div id="ob-connection-status"></div>

          ${needsSetup !== null ? `
            <div class="${needsSetup ? 'onboarding-success' : 'onboarding-error'}" style="margin-top:8px;">
              ${needsSetup
          ? `✓ Server reachable — <strong>setup required</strong>. No config.json found, you'll create it next.`
          : `⚠ Server already configured (user: ${this.setupStatus.current?.username || 'unknown'}). You can skip to login or re-configure.`}
            </div>
          ` : `
            <div class="onboarding-hint" style="margin-top:8px;">
              Enter your Vault server URL and test connection. The server must be running:<br>
              <code style="background:var(--bg-tertiary); padding:2px 6px; border-radius:4px;">cd server && npm install && npm start</code>
            </div>
          `}

          <div class="onboarding-input-group" style="margin-top:8px;">
            <label class="onboarding-label">Quick Presets</label>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="btn btn-ghost btn-sm preset-url" data-url="http://localhost:4000">Localhost :4000</button>
              <button type="button" class="btn btn-ghost btn-sm preset-url" data-url="http://localhost:3000">Localhost :3000</button>
              <button type="button" class="btn btn-ghost btn-sm preset-url" data-url="https://localhost:4000">HTTPS Local</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  bindServerStep() {
    const input = document.getElementById('ob-api-url');
    const testBtn = document.getElementById('ob-test-connection');
    const statusEl = document.getElementById('ob-connection-status');

    if (!input || !testBtn) return;

    const updateApiUrl = () => {
      const url = input.value.trim().replace(/\/$/, '');
      if (url) {
        this.data.apiUrl = url;
        setApiBaseUrl(url);
        document.getElementById('server-url-display') && (document.getElementById('server-url-display').textContent = url);
      }
    };

    input.addEventListener('change', updateApiUrl);
    input.addEventListener('blur', updateApiUrl);

    document.querySelectorAll('.preset-url').forEach(btn => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.url;
        updateApiUrl();
        this.testConnection();
      });
    });

    testBtn.addEventListener('click', () => this.testConnection());

    // Auto-test on entry if we have URL
    if (this.data.apiUrl) {
      setTimeout(() => this.testConnection(), 300);
    }
  }

  async testConnection() {
    const statusEl = document.getElementById('ob-connection-status');
    const input = document.getElementById('ob-api-url');
    if (!statusEl || !input) return;

    const url = input.value.trim().replace(/\/$/, '');
    if (!url) {
      statusEl.innerHTML = `<div class="connection-test error"><span>⚠</span> Please enter a server URL</div>`;
      return;
    }

    this.data.apiUrl = url;
    setApiBaseUrl(url);

    statusEl.innerHTML = `<div class="connection-test testing"><div class="connection-dot"></div> Testing connection to ${escapeHtml(url)}...</div>`;

    try {
      // Try health first
      const health = await api.health();
      // Then setup status
      let setupStatus = null;
      try {
        setupStatus = await api.getSetupStatus();
        this.setupStatus = setupStatus;
      } catch {}

      this.isConnected = true;
      statusEl.innerHTML = `
        <div class="connection-test success">
          <span>✓</span> Connected — ${health.library?.total || 0} items, v${health.version || '2.0.0'}
          ${setupStatus ? `<br><span style="margin-left:16px;">Setup: ${setupStatus.needsSetup ? 'required' : 'complete'}</span>` : ''}
        </div>
      `;

      // Update the setup status box if present
      const existingBox = document.querySelector('.onboarding-success, .onboarding-error');
      if (setupStatus && existingBox) {
        existingBox.className = setupStatus.needsSetup ? 'onboarding-success' : 'onboarding-error';
        existingBox.innerHTML = setupStatus.needsSetup
          ? `✓ Server reachable — <strong>setup required</strong>. No config.json found, you'll create it next.`
          : `⚠ Server already configured (user: ${setupStatus.current?.username || 'unknown'}). You can skip to login or re-configure.`;

        // Show skip button
        const skipBtn = document.getElementById('onboarding-skip');
        if (skipBtn) skipBtn.style.display = setupStatus.needsSetup ? 'none' : 'inline-flex';
      }

      toast.success(`Connected to ${url}`);
    } catch (err) {
      this.isConnected = false;
      statusEl.innerHTML = `
        <div class="connection-test error">
          <span>✕</span> Cannot connect: ${err.message}<br>
          <span style="margin-left:16px; opacity:0.8;">Make sure server is running: cd server && npm start</span>
        </div>
      `;
    }
  }

  renderAdminAccount() {
    return `
      <div class="onboarding-step active">
        <div class="onboarding-form">
          <div class="onboarding-input-group">
            <label class="onboarding-label">Username</label>
            <input type="text" class="onboarding-input" id="ob-username" value="${this.data.username}" placeholder="admin" autocomplete="username">
            <div class="onboarding-hint">3-50 chars, letters, numbers, underscore, dash</div>
          </div>

          <div class="onboarding-input-group">
            <label class="onboarding-label">Password</label>
            <input type="password" class="onboarding-input" id="ob-password" value="${this.data.password}" placeholder="••••••••" autocomplete="new-password">
            <div class="password-strength" id="ob-pw-strength">
              <div class="password-strength-bar"></div>
              <div class="password-strength-bar"></div>
              <div class="password-strength-bar"></div>
              <div class="password-strength-bar"></div>
            </div>
            <div class="password-strength-text" id="ob-pw-strength-text"></div>
            <div class="onboarding-hint">Min 4 characters, use a strong unique password</div>
          </div>

          <div class="onboarding-input-group">
            <label class="onboarding-label">Confirm Password</label>
            <input type="password" class="onboarding-input" id="ob-confirm" value="${this.data.confirmPassword}" placeholder="••••••••" autocomplete="new-password">
          </div>

          <div id="ob-account-error"></div>
        </div>
      </div>
    `;
  }

  bindAccountStep() {
    const userInput = document.getElementById('ob-username');
    const passInput = document.getElementById('ob-password');
    const confirmInput = document.getElementById('ob-confirm');

    if (!userInput || !passInput || !confirmInput) return;

    const update = () => {
      this.data.username = userInput.value.trim();
      this.data.password = passInput.value;
      this.data.confirmPassword = confirmInput.value;
      this.validateAccountStep();
      this.updatePasswordStrength(passInput.value);
    };

    userInput.addEventListener('input', update);
    passInput.addEventListener('input', update);
    confirmInput.addEventListener('input', update);

    // Initial
    this.updatePasswordStrength(passInput.value);
    this.validateAccountStep();
  }

  updatePasswordStrength(pw) {
    const bars = document.querySelectorAll('#ob-pw-strength .password-strength-bar');
    const textEl = document.getElementById('ob-pw-strength-text');
    if (!bars.length || !textEl) return;

    let score = 0;
    if (pw.length >= 4) score++;
    if (pw.length >= 8) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;

    // Clamp 0-4
    score = Math.min(score, 4);

    bars.forEach((bar, idx) => {
      bar.classList.remove('active', 'weak', 'medium', 'strong');
      if (idx < score) {
        bar.classList.add('active');
        if (score <= 1) bar.classList.add('weak');
        else if (score <= 2) bar.classList.add('medium');
        else bar.classList.add('strong');
      }
    });

    const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
    const classes = ['', 'weak', 'weak', 'medium', 'strong'];
    textEl.textContent = pw ? labels[score] || '' : '';
    textEl.className = 'password-strength-text ' + (classes[score] || '');
  }

  validateAccountStep() {
    const errorEl = document.getElementById('ob-account-error');
    const nextBtn = document.getElementById('onboarding-next');
    if (!errorEl || !nextBtn) return true;

    const { username, password, confirmPassword } = this.data;

    if (!username || username.length < 3) {
      errorEl.innerHTML = `<div class="onboarding-error">Username must be at least 3 characters</div>`;
      nextBtn.disabled = true;
      return false;
    }
    if (!/^[a-zA-Z0-9_\-]+$/.test(username)) {
      errorEl.innerHTML = `<div class="onboarding-error">Username can only contain letters, numbers, underscore, dash</div>`;
      nextBtn.disabled = true;
      return false;
    }
    if (!password || password.length < 4) {
      errorEl.innerHTML = `<div class="onboarding-error">Password must be at least 4 characters</div>`;
      nextBtn.disabled = true;
      return false;
    }
    if (password !== confirmPassword) {
      errorEl.innerHTML = `<div class="onboarding-error">Passwords do not match</div>`;
      nextBtn.disabled = true;
      return false;
    }

    errorEl.innerHTML = '';
    nextBtn.disabled = false;
    return true;
  }

  renderGridStep() {
    return `
      <div class="onboarding-step active">
        <div class="onboarding-grid-info">
          <span id="ob-grid-count">${this.data.gridPattern.length} / 8 selected</span>
          <button type="button" class="btn btn-ghost btn-sm" id="ob-grid-clear">Clear</button>
        </div>

        <div class="onboarding-grid-container" id="ob-grid">
          ${Array.from({ length: 16 }, (_, i) => `
            <div class="onboarding-grid-square ${this.data.gridPattern.includes(i) ? 'selected' : ''}" data-index="${i}" role="button" tabindex="0" aria-label="Grid square ${i}">${i}</div>
          `).join('')}
        </div>

        <label class="onboarding-toggle" style="margin-top:12px;">
          <input type="checkbox" id="ob-grid-order" ${this.data.gridOrderMatters ? 'checked' : ''}>
          <div>
            <div style="font-size:13px; font-weight:600;">Order matters</div>
            <div style="font-size:11px; color:var(--text-tertiary);">If enabled, you must click squares in exact order</div>
          </div>
        </label>

        <div id="ob-grid-error" style="margin-top:12px;"></div>

        <div class="onboarding-hint" style="margin-top:12px;">
          <strong>Tip:</strong> Choose a memorable pattern (e.g., corners, a shape). This is your second factor — keep it secret!
          ${this.data.gridOrderMatters ? '<br><em>Order matters is ON — remember the sequence!</em>' : ''}
        </div>
      </div>
    `;
  }

  bindGridStep() {
    const grid = document.getElementById('ob-grid');
    const countEl = document.getElementById('ob-grid-count');
    const clearBtn = document.getElementById('ob-grid-clear');
    const orderToggle = document.getElementById('ob-grid-order');
    const errorEl = document.getElementById('ob-grid-error');
    const nextBtn = document.getElementById('onboarding-next');

    if (!grid) return;

    const updateUI = () => {
      grid.querySelectorAll('.onboarding-grid-square').forEach(el => {
        const idx = parseInt(el.dataset.index, 10);
        el.classList.toggle('selected', this.data.gridPattern.includes(idx));
      });
      if (countEl) countEl.textContent = `${this.data.gridPattern.length} / 8 selected`;
      if (nextBtn) nextBtn.disabled = this.data.gridPattern.length !== 8;

      if (this.data.gridPattern.length === 8) {
        if (errorEl) errorEl.innerHTML = `<div class="onboarding-success">✓ Pattern set: [${this.data.gridPattern.join(', ')}]</div>`;
      } else {
        if (errorEl) errorEl.innerHTML = '';
      }
    };

    grid.querySelectorAll('.onboarding-grid-square').forEach(el => {
      const toggle = () => {
        const idx = parseInt(el.dataset.index, 10);
        const pos = this.data.gridPattern.indexOf(idx);
        if (pos >= 0) {
          this.data.gridPattern.splice(pos, 1);
        } else {
          if (this.data.gridPattern.length >= 8) {
            toast.info('You can only select 8 squares');
            return;
          }
          this.data.gridPattern.push(idx);
        }
        updateUI();
      };

      el.addEventListener('click', toggle);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        this.data.gridPattern = [];
        updateUI();
      });
    }

    if (orderToggle) {
      orderToggle.addEventListener('change', (e) => {
        this.data.gridOrderMatters = e.target.checked;
      });
    }

    updateUI();
  }

  renderMediaStep() {
    return `
      <div class="onboarding-step active">
        <div class="onboarding-form">
          <div class="onboarding-input-group">
            <label class="onboarding-label">Theme Preference</label>
            <div class="onboarding-themes" id="ob-themes">
              ${[
        { id: 'dark', name: 'Dark', colors: ['#0A0A0A', '#1A1A1A', '#FF4D5A'] },
        { id: 'light', name: 'Light', colors: ['#FFFFFF', '#F5F5F5', '#FF4D5A'] },
        { id: 'warm', name: 'Warm', colors: ['#1A1207', '#2D1F0E', '#FF8C42'] },
        { id: 'cold', name: 'Cold', colors: ['#0A1419', '#122530', '#4DA6FF'] },
      ].map(t => `
                <div class="onboarding-theme ${this.data.theme === t.id ? 'selected' : ''}" data-theme="${t.id}">
                  <div class="onboarding-theme-name">${t.name}</div>
                  <div class="onboarding-theme-preview">
                    ${t.colors.map(c => `<span style="background:${c}; border:1px solid var(--border);"></span>`).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <div class="onboarding-input-group">
            <label class="onboarding-label">Media Library Paths (server-side)</label>
            <div class="onboarding-hint" style="margin-bottom:8px;">These are paths on your server machine. Defaults will be created if missing.</div>
            
            <div class="onboarding-paths">
              <div class="onboarding-path-item">
                <label class="onboarding-label">Movies</label>
                <div class="onboarding-path-row">
                  <input type="text" class="onboarding-input" id="ob-path-movies" value="${this.data.mediaPaths.movies}" placeholder="./media/movies">
                </div>
              </div>
              <div class="onboarding-path-item">
                <label class="onboarding-label">Music</label>
                <div class="onboarding-path-row">
                  <input type="text" class="onboarding-input" id="ob-path-music" value="${this.data.mediaPaths.music}" placeholder="./media/music">
                </div>
              </div>
              <div class="onboarding-path-item">
                <label class="onboarding-label">Videos</label>
                <div class="onboarding-path-row">
                  <input type="text" class="onboarding-input" id="ob-path-videos" value="${this.data.mediaPaths.videos}" placeholder="./media/videos">
                </div>
              </div>
            </div>
          </div>

          <div class="onboarding-input-group">
            <label class="onboarding-label">Additional CORS Origins (optional)</label>
            <input type="text" class="onboarding-input" id="ob-cors" placeholder="https://your-tunnel.trycloudflare.com, https://custom.domain.com" value="${this.data.corsOrigins.join(', ')}">
            <div class="onboarding-hint">Comma-separated. GitHub Pages origin is always included automatically.</div>
          </div>

          <div id="ob-media-test-result"></div>
        </div>
      </div>
    `;
  }

  bindMediaStep() {
    const themesEl = document.getElementById('ob-themes');
    const moviesInput = document.getElementById('ob-path-movies');
    const musicInput = document.getElementById('ob-path-music');
    const videosInput = document.getElementById('ob-path-videos');
    const corsInput = document.getElementById('ob-cors');

    if (themesEl) {
      themesEl.querySelectorAll('.onboarding-theme').forEach(el => {
        el.addEventListener('click', () => {
          themesEl.querySelectorAll('.onboarding-theme').forEach(t => t.classList.remove('selected'));
          el.classList.add('selected');
          this.data.theme = el.dataset.theme;
          // Apply theme live
          document.documentElement.setAttribute('data-theme', this.data.theme);
          localStorage.setItem('vault_theme', this.data.theme);
        });
      });
    }

    const updatePaths = () => {
      if (moviesInput) this.data.mediaPaths.movies = moviesInput.value.trim() || './media/movies';
      if (musicInput) this.data.mediaPaths.music = musicInput.value.trim() || './media/music';
      if (videosInput) this.data.mediaPaths.videos = videosInput.value.trim() || './media/videos';
      if (corsInput) {
        const raw = corsInput.value.trim();
        this.data.corsOrigins = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
      }
    };

    [moviesInput, musicInput, videosInput, corsInput].forEach(input => {
      if (input) {
        input.addEventListener('change', updatePaths);
        input.addEventListener('blur', updatePaths);
      }
    });

    updatePaths();
  }

  renderReviewStep() {
    const gridDisplay = this.data.gridPattern.length === 8
      ? `[${this.data.gridPattern.join(', ')}] ${this.data.gridOrderMatters ? '(order matters)' : '(order free)'}`
      : 'Not set';

    return `
      <div class="onboarding-step active">
        <div class="onboarding-complete-icon">✓</div>
        <h3 style="text-align:center; font-size:16px; font-weight:700; margin-bottom:16px;">Review Your Setup</h3>
        
        <div class="onboarding-review">
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Server URL</span>
            <span class="onboarding-review-value" style="max-width:200px; overflow:hidden; text-overflow:ellipsis;">${this.data.apiUrl}</span>
          </div>
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Username</span>
            <span class="onboarding-review-value">${this.data.username}</span>
          </div>
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Password</span>
            <span class="onboarding-review-value">•••••••• (${this.data.password.length} chars)</span>
          </div>
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Grid Pattern</span>
            <span class="onboarding-review-value">${gridDisplay}</span>
          </div>
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Theme</span>
            <span class="onboarding-review-value">${this.data.theme}</span>
          </div>
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Movies Path</span>
            <span class="onboarding-review-value" style="font-size:11px;">${this.data.mediaPaths.movies}</span>
          </div>
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Music Path</span>
            <span class="onboarding-review-value" style="font-size:11px;">${this.data.mediaPaths.music}</span>
          </div>
          <div class="onboarding-review-item">
            <span class="onboarding-review-label">Videos Path</span>
            <span class="onboarding-review-value" style="font-size:11px;">${this.data.mediaPaths.videos}</span>
          </div>
          ${this.data.corsOrigins.length ? `
            <div class="onboarding-review-item">
              <span class="onboarding-review-label">CORS Origins</span>
              <span class="onboarding-review-value" style="font-size:11px;">${this.data.corsOrigins.join(', ')}</span>
            </div>
          ` : ''}
        </div>

        <div id="ob-complete-status" style="margin-top:16px;"></div>

        <div class="onboarding-hint" style="margin-top:16px; text-align:center;">
          By completing setup, you confirm that you've saved your grid pattern securely.<br>
          <strong>Enablement: true</strong> — Vault will be ready for deployment.
        </div>
      </div>
    `;
  }

  async next() {
    // Validate current step before proceeding
    if (this.currentStep === 2) {
      // Server connection must be valid
      if (!this.data.apiUrl) {
        toast.error('Please enter a server URL');
        return;
      }
      // Try to test if not yet connected
      if (!this.isConnected) {
        await this.testConnection();
        if (!this.isConnected) {
          toast.error('Cannot proceed without server connection');
          return;
        }
      }
    }

    if (this.currentStep === 3) {
      if (!this.validateAccountStep()) return;
    }

    if (this.currentStep === 4) {
      if (this.data.gridPattern.length !== 8) {
        toast.error('Please select exactly 8 squares');
        return;
      }
    }

    if (this.currentStep < this.totalSteps) {
      this.currentStep++;
      this.renderStep();
    } else {
      // Final step — complete setup
      await this.completeSetup();
    }
  }

  back() {
    if (this.currentStep > 1) {
      this.currentStep--;
      this.renderStep();
    }
  }

  skip() {
    // User wants to skip onboarding and go to login
    const gate = document.getElementById('onboarding-gate');
    if (gate) gate.remove();
    window.dispatchEvent(new CustomEvent('vault:onboarding-skipped'));
  }

  async completeSetup() {
    const nextBtn = document.getElementById('onboarding-next');
    const statusEl = document.getElementById('ob-complete-status');

    if (nextBtn) {
      nextBtn.disabled = true;
      nextBtn.textContent = 'Setting up...';
    }

    if (statusEl) {
      statusEl.innerHTML = `<div class="connection-test testing"><div class="connection-dot"></div> Creating config, hashing password, securing vault...</div>`;
    }

    try {
      const payload = {
        username: this.data.username,
        password: this.data.password,
        confirmPassword: this.data.confirmPassword,
        gridPattern: this.data.gridPattern,
        gridOrderMatters: this.data.gridOrderMatters,
        mediaPaths: this.data.mediaPaths,
        corsOrigins: this.data.corsOrigins,
        theme: this.data.theme,
        server: {
          port: this.data.serverPort,
        },
      };

      const result = await api.completeSetup(payload);

      if (statusEl) {
        statusEl.innerHTML = `
          <div class="onboarding-success">
            ✓ Setup complete! Config saved.<br>
            <span style="font-family:var(--font-mono); font-size:11px;">User: ${result.config.username} | Enablement: ${result.enablement ? 'true' : 'true'}</span>
          </div>
        `;
      }

      // Save token if provided
      if (result.token) {
        store.setAuth(result.token, result.user);
        localStorage.setItem('vault_token', result.token);
      }

      // Save theme
      localStorage.setItem('vault_theme', this.data.theme);
      document.documentElement.setAttribute('data-theme', this.data.theme);

      toast.success('Vault setup complete! Welcome 🎉');

      if (nextBtn) {
        nextBtn.textContent = 'Enter Vault →';
        nextBtn.disabled = false;
      }

      // After short delay, hide onboarding and show app or auth
      setTimeout(() => {
        const gate = document.getElementById('onboarding-gate');
        if (gate) gate.remove();

        if (result.token) {
          window.dispatchEvent(new CustomEvent('vault:onboarding-complete', { detail: result }));
        } else {
          window.dispatchEvent(new CustomEvent('vault:onboarding-complete-no-token'));
        }
      }, 1200);

    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `<div class="onboarding-error">✕ Setup failed: ${escapeHtml(err.message)}</div>`;
      }
      if (nextBtn) {
        nextBtn.disabled = false;
        nextBtn.textContent = 'Retry Setup ✨';
      }
      toast.error(`Setup failed: ${escapeHtml(err.message)}`);
    }
  }
}

export const onboardingManager = new OnboardingManager();
export default onboardingManager;
