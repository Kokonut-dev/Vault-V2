/**
 * Extra Settings cards: playback quality, subtitle styling, devices & pairing,
 * sessions, two-factor auth and the remote-access helper.
 *
 * Rendered into the existing `.settings-grid` by views/settings.js so the
 * base view stays readable.
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../utils/icons.js';
import { toast } from '../components/toast.js';
import { getPrefs, setPrefs, resetPrefs } from '../components/playbackPrefs.js';
import { renderPairingPanel } from '../components/qrPair.js';
import { formatRelativeTime } from '../utils/format.js';

function card(title, iconName, body, id = '') {
  const node = document.createElement('div');
  node.className = 'settings-card';
  if (id) node.id = id;
  node.innerHTML = `<h3><span class="settings-card-icon" aria-hidden="true">${icon(iconName, { size: 17 })}</span>${title}</h3>${body}`;
  return node;
}

export function renderSettingsExtras(container) {
  const grid = container.querySelector('.settings-grid');
  if (!grid) return;

  grid.appendChild(playbackCard());
  grid.appendChild(subtitleCard());
  grid.appendChild(devicesCard());
  grid.appendChild(securityCard());
  grid.appendChild(remoteCard());
}

// ---------------------------------------------------------------------------
// Playback quality
// ---------------------------------------------------------------------------
function playbackCard() {
  const prefs = getPrefs();
  const node = card('Playback Quality', 'gauge', `
    <div class="form-group">
      <label class="form-label" for="pref-speed">Default speed: <span id="pref-speed-value">${prefs.speed}×</span></label>
      <input type="range" class="slider" id="pref-speed" min="0.5" max="2.5" step="0.05" value="${prefs.speed}">
    </div>
    <div class="form-group">
      <label style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="pref-normalize" ${prefs.normalize ? 'checked' : ''}>
        Normalise volume <span class="row-meta">(evens out quiet dialogue vs loud scenes)</span>
      </label>
    </div>
    <div class="form-group">
      <label style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" id="pref-skip-silence" ${prefs.skipSilence ? 'checked' : ''}>
        Skip silence <span class="row-meta">(audio only, approximate)</span>
      </label>
    </div>
    <button class="btn btn-ghost btn-sm" id="pref-reset">Reset playback preferences</button>
  `);

  node.querySelector('#pref-speed').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    node.querySelector('#pref-speed-value').textContent = `${value}×`;
    setPrefs({ speed: value }, { silent: true });
  });
  node.querySelector('#pref-normalize').addEventListener('change', (event) => {
    setPrefs({ normalize: event.target.checked });
    toast.success(event.target.checked ? 'Volume normalisation on' : 'Volume normalisation off');
  });
  node.querySelector('#pref-skip-silence').addEventListener('change', (event) => {
    setPrefs({ skipSilence: event.target.checked });
  });
  node.querySelector('#pref-reset').addEventListener('click', () => {
    const fresh = resetPrefs();
    node.querySelector('#pref-speed').value = fresh.speed;
    node.querySelector('#pref-speed-value').textContent = `${fresh.speed}×`;
    node.querySelector('#pref-normalize').checked = fresh.normalize;
    node.querySelector('#pref-skip-silence').checked = fresh.skipSilence;
    toast.success('Playback preferences reset');
  });
  return node;
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------
function subtitleCard() {
  const prefs = getPrefs();
  const node = card('Subtitles', 'captions', `
    <div class="form-group">
      <label class="form-label" for="sub-size">Text size: <span id="sub-size-value">${prefs.subtitleSize}%</span></label>
      <input type="range" class="slider" id="sub-size" min="80" max="200" step="5" value="${prefs.subtitleSize}">
    </div>
    <div class="form-group">
      <label class="form-label" for="sub-color">Text colour</label>
      <input type="color" class="form-input" id="sub-color" value="${prefs.subtitleColor}" style="height:38px; padding:4px;">
    </div>
    <div class="form-group">
      <label class="form-label" for="sub-bg">Background</label>
      <select class="form-input" id="sub-bg">
        <option value="rgba(0, 0, 0, 0.6)"${prefs.subtitleBackground === 'rgba(0, 0, 0, 0.6)' ? ' selected' : ''}>Dark box</option>
        <option value="transparent"${prefs.subtitleBackground === 'transparent' ? ' selected' : ''}>None</option>
        <option value="rgba(0, 0, 0, 0.85)"${prefs.subtitleBackground === 'rgba(0, 0, 0, 0.85)' ? ' selected' : ''}>Solid black</option>
        <option value="rgba(124, 108, 255, 0.35)"${prefs.subtitleBackground === 'rgba(124, 108, 255, 0.35)' ? ' selected' : ''}>Accent tint</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label" for="sub-delay">Timing offset: <span id="sub-delay-value">${prefs.subtitleDelay > 0 ? '+' : ''}${prefs.subtitleDelay}s</span></label>
      <input type="range" class="slider" id="sub-delay" min="-10" max="10" step="0.25" value="${prefs.subtitleDelay}">
      <div class="row-meta">Positive values show subtitles later (for tracks that run ahead).</div>
    </div>
    <p class="row-meta">Preview: <span style="font-size:${prefs.subtitleSize / 100}rem; color:${prefs.subtitleColor}; background:${prefs.subtitleBackground}; padding:2px 6px;">This is how subtitles look</span></p>
  `);

  node.querySelector('#sub-size').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    node.querySelector('#sub-size-value').textContent = `${value}%`;
    node.querySelector('p.row-meta span').style.fontSize = `${value / 100}rem`;
    setPrefs({ subtitleSize: value }, { silent: true });
  });
  node.querySelector('#sub-color').addEventListener('input', (event) => {
    node.querySelector('p.row-meta span').style.color = event.target.value;
    setPrefs({ subtitleColor: event.target.value }, { silent: true });
  });
  node.querySelector('#sub-bg').addEventListener('change', (event) => {
    node.querySelector('p.row-meta span').style.background = event.target.value;
    setPrefs({ subtitleBackground: event.target.value }, { silent: true });
  });
  node.querySelector('#sub-delay').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    node.querySelector('#sub-delay-value').textContent = `${value > 0 ? '+' : ''}${value}s`;
    setPrefs({ subtitleDelay: value });
  });
  return node;
}

// ---------------------------------------------------------------------------
// Devices & pairing
// ---------------------------------------------------------------------------
function devicesCard() {
  const node = card('Devices', 'qr', `
    <p class="row-meta">Pair another device by scanning a code, or check which sessions are signed in.</p>
    <div id="pair-panel" class="settings-subpanel"></div>
    <hr class="settings-divider">
    <div class="row-main">
      <div class="row-title">Active sessions</div>
      <button class="btn btn-ghost btn-sm" id="revoke-others">${icon('shield-off', { size: 14 })}<span>Sign out other devices</span></button>
    </div>
    <div id="sessions-list"></div>
  `);

  renderPairingPanel(node.querySelector('#pair-panel'));
  loadSessions(node.querySelector('#sessions-list'));

  node.querySelector('#revoke-others').addEventListener('click', async () => {
    try {
      await api.revokeOtherSessions();
      toast.success('Other sessions signed out');
      loadSessions(node.querySelector('#sessions-list'));
    } catch (err) {
      toast.error(err.message);
    }
  });
  return node;
}

async function loadSessions(host) {
  host.innerHTML = '<div class="skeleton skeleton-line"></div>';
  let sessions = [];
  try {
    const data = await api.getSessions();
    sessions = data.sessions || [];
  } catch (err) {
    host.innerHTML = `<div class="row-meta">${err.message}</div>`;
    return;
  }
  const currentSid = store.get('sessionId');
  host.innerHTML = sessions.length ? sessions.map(session => `
    <div class="session-row">
      <span class="row-icon">${icon(session.current ? 'monitor' : 'globe', { size: 16 })}</span>
      <div class="row-main">
        <div class="row-title">${session.device || session.userAgent || 'Unknown device'}${session.current ? ' · this device' : ''}</div>
        <div class="row-meta">${session.ip ? `${session.ip} · ` : ''}${session.createdAt ? formatRelativeTime(session.createdAt) : ''}${session.lastSeen ? ` · active ${formatRelativeTime(session.lastSeen)}` : ''}</div>
      </div>
      ${session.current || session.id === currentSid ? '' : `<button class="btn btn-ghost btn-sm" data-revoke="${session.id}">Revoke</button>`}
    </div>`).join('') : '<div class="row-meta">No sessions recorded.</div>';

  host.querySelectorAll('[data-revoke]').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await api.revokeSession(button.dataset.revoke);
        toast.success('Session revoked');
        loadSessions(host);
      } catch (err) {
        toast.error(err.message);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Two-factor (TOTP)
// ---------------------------------------------------------------------------
function securityCard() {
  const node = card('Two-factor authentication', 'key', `
    <p class="row-meta">Besides the 4×4 pattern, an authenticator app (TOTP) can be required at login.</p>
    <div id="totp-status" class="row-meta">Loading…</div>
    <div id="totp-setup" hidden>
      <div class="health-item"><div class="row-main">
        <div class="row-title">1. Add this secret to your authenticator</div>
        <code id="totp-secret" class="row-meta" style="font-size:14px; word-break:break-all;"></code>
      </div></div>
      <div class="form-group" style="margin-top:8px">
        <label class="form-label" for="totp-code">2. Enter the 6-digit code it generates</label>
        <input class="form-input" id="totp-code" inputmode="numeric" placeholder="123456" autocomplete="one-time-code">
      </div>
      <div class="page-actions" style="display:flex; gap:8px">
        <button class="btn btn-primary btn-sm" id="totp-enable">Enable TOTP</button>
        <button class="btn btn-ghost btn-sm" id="totp-cancel">Cancel</button>
      </div>
    </div>
    <div id="totp-actions" class="page-actions" style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px"></div>
    <div id="totp-recovery" hidden>
      <div class="row-title" style="margin-top:10px">Recovery codes</div>
      <div class="row-meta">Store these somewhere safe — each works once if you lose your phone.</div>
      <div id="recovery-list" class="row-meta" style="font-family:var(--font-mono); margin-top:6px; word-break:break-all;"></div>
    </div>
  `);

  const status = node.querySelector('#totp-status');
  const setup = node.querySelector('#totp-setup');
  const actions = node.querySelector('#totp-actions');

  function showRecoveryCodes(codes) {
    if (!codes?.length) return;
    node.querySelector('#totp-recovery').hidden = false;
    node.querySelector('#recovery-list').textContent = codes.join('   ');
  }

  function render(state) {
    status.innerHTML = state.enabled
      ? `${icon('shield-check', { size: 15 })} <strong>TOTP is enabled</strong> — ${state.recoveryCodesLeft ?? 0} recovery code(s) left.`
      : 'TOTP is not configured.';
    actions.replaceChildren();

    if (state.enabled) {
      const codes = document.createElement('button');
      codes.type = 'button';
      codes.className = 'btn btn-secondary btn-sm';
      codes.textContent = 'Regenerate recovery codes';
      codes.addEventListener('click', async () => {
        const code = window.prompt('Enter a current 6-digit code to regenerate recovery codes:');
        if (!code) return;
        try {
          const data = await api.totpRecoveryCodes(code);
          showRecoveryCodes(data.recoveryCodes);
          toast.success('New recovery codes generated');
          refresh();
        } catch (err) {
          toast.error(err.message);
        }
      });

      const disable = document.createElement('button');
      disable.type = 'button';
      disable.className = 'btn btn-ghost btn-sm';
      disable.textContent = 'Disable TOTP';
      disable.addEventListener('click', async () => {
        const password = window.prompt('Confirm your account password to disable two-factor authentication:');
        if (!password) return;
        try {
          await api.totpDisable(password);
          toast.success('TOTP disabled');
          refresh();
        } catch (err) {
          toast.error(err.message);
        }
      });

      actions.append(codes, disable);
    } else {
      const start = document.createElement('button');
      start.type = 'button';
      start.className = 'btn btn-secondary btn-sm';
      start.innerHTML = `${icon('key', { size: 14 })}<span>Set up TOTP</span>`;
      start.addEventListener('click', async () => {
        try {
          const data = await api.totpSetup();
          node.querySelector('#totp-secret').textContent = data.secret || '';
          const otpauth = data.otpauthUrl;
          if (otpauth) {
            // Offer the otpauth:// URI as a link for people whose authenticator
            // can be opened from the browser.
            setup.querySelector('#totp-otpauth')?.remove();
            const link = document.createElement('a');
            link.id = 'totp-otpauth';
            link.className = 'btn btn-ghost btn-sm';
            link.href = otpauth;
            link.textContent = 'Open in authenticator app';
            setup.querySelector('.page-actions').prepend(link);
          }
          setup.hidden = false;
        } catch (err) {
          toast.error(err.message);
        }
      });
      actions.append(start);
    }
  }

  async function refresh() {
    try {
      const data = await api.totpStatus();
      render({ enabled: !!data.enabled, recoveryCodesLeft: data.recoveryCodesLeft });
    } catch (err) {
      status.innerHTML = `<span class="row-meta">${err.message}</span>`;
    }
  }

  node.querySelector('#totp-enable').addEventListener('click', async () => {
    const code = node.querySelector('#totp-code').value.trim();
    if (!/^\d{6}$/.test(code)) return toast.error('Enter the 6-digit code from your app');
    try {
      const data = await api.totpEnable(code);
      toast.success('Two-factor authentication enabled');
      showRecoveryCodes(data.recoveryCodes);
      setup.hidden = true;
      refresh();
    } catch (err) {
      toast.error(err.message);
    }
  });
  node.querySelector('#totp-cancel').addEventListener('click', () => { setup.hidden = true; });

  refresh();
  return node;
}

// ---------------------------------------------------------------------------
// Remote access helper
// ---------------------------------------------------------------------------
function remoteCard() {
  const base = window.location.origin;
  const node = card('Remote access', 'globe', `
    <p class="row-meta">Watching away from home? Pick whichever fits your setup — Vault works with all three.</p>
    <div class="health-list">
      <div class="health-item">
        ${icon('wifi', { size: 16 })}
        <div class="row-main">
          <div class="row-title">Same network</div>
          <div class="row-meta">Use your machine's LAN address, e.g. <code>http://192.168.x.x:4000</code>. Point other devices at it and log in once.</div>
        </div>
      </div>
      <div class="health-item">
        ${icon('shield-check', { size: 16 })}
        <div class="row-main">
          <div class="row-title">HTTPS on your own domain</div>
          <div class="row-meta">Run <code>npm run generate-cert</code> in <code>server/</code>, enable <code>server.https</code>, or put Vault behind Caddy/nginx.</div>
        </div>
      </div>
      <div class="health-item">
        ${icon('zap', { size: 16 })}
        <div class="row-main">
          <div class="row-title">Tunnel (easiest)</div>
          <div class="row-meta"><code>cloudflared tunnel --url http://localhost:4000</code> — then set the API URL below to the tunnel address.</div>
        </div>
      </div>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Current address</label>
      <div style="display:flex; gap:8px;">
        <input class="form-input" id="remote-url" value="${base}" readonly style="flex:1">
        <button class="btn btn-secondary btn-sm" id="remote-copy">${icon('copy', { size: 14 })}<span>Copy</span></button>
      </div>
      <div class="row-meta" style="margin-top:6px">Browsers block plain HTTP when the page is HTTPS (only <code>localhost</code> is exempt) — that is why a tunnel or a certificate matters for remote access.</div>
    </div>
  `);

  node.querySelector('#remote-copy').addEventListener('click', async () => {
    const input = node.querySelector('#remote-url');
    input.select();
    try {
      await navigator.clipboard.writeText(input.value);
      toast.success('Address copied');
    } catch {
      document.execCommand('copy');
      toast.success('Address copied');
    }
  });
  return node;
}

export default { renderSettingsExtras };
