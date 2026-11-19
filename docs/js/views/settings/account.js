/**
 * Settings → Account: Sign-in & security, Devices (SR-10, SR-13).
 */
import { api } from '../../api.js';
import { store } from '../../store.js';
import { toast } from '../../components/toast.js';
import { promptModal } from '../../components/modal.js';
import { confirmDialog } from '../../components/confirmDialog.js';
import { renderPairingPanel } from '../../components/qrPair.js';
import { createGridPicker } from '../../components/gridPicker.js';
import { copyText } from '../../utils/clipboard.js';
import { escapeHtml, formatRelativeTime } from '../../utils/format.js';
import { icon } from '../../utils/icons.js';
import { onUnmount } from '../../utils/lifecycle.js';
import {
  section, group, row, el, flashStatus, fieldError, clearFieldError, applyFieldErrors, busy,
} from './ui.js';

// ---------------------------------------------------------------------------
// Sign-in & security
// ---------------------------------------------------------------------------
export function securitySection() {
  const s = section({
    id: 'security',
    title: 'Sign-in & security',
    iconName: 'shield',
    scope: 'account',
    intro: 'Your username, password, grid pattern and two-factor sign-in.',
  });

  const creds = group('Sign-in details', { description: 'Fill in only what you want to change, then confirm with your current password.' });
  const form = el(`<form class="settings-form" id="creds-form" novalidate autocomplete="on">
    </form>`);
  form.append(
    row({ id: 'new-user', label: 'New username', help: 'At least 3 characters. Leave empty to keep the current one.', keywords: 'username login name',
      control: '<input class="form-input" id="new-user" name="new-username" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="50">' }),
    row({ id: 'new-pass', label: 'New password', help: 'Leave empty to keep the current one.', keywords: 'password change',
      control: '<input class="form-input" id="new-pass" name="new-password" type="password" autocomplete="new-password" minlength="6">' }),
    row({ id: 'new-pass-2', label: 'Repeat new password', keywords: 'password confirm',
      control: '<input class="form-input" id="new-pass-2" name="new-password-confirm" type="password" autocomplete="new-password">' }),
  );

  const gridRow = el(`<div class="setting-row is-stacked" data-keywords="grid pattern squares 4x4 second step sign in">
      <div class="setting-text">
        <span class="setting-label" id="grid-label">New grid pattern</span>
        <p class="setting-help" id="grid-help">The 8 squares you tap after your password. Leave untouched to keep your current pattern.</p>
      </div>
      <div class="setting-control">
        <button type="button" class="btn btn-secondary btn-sm" id="grid-toggle" aria-expanded="false" aria-controls="grid-host">${icon('layout-grid', { size: 15 })}<span>Choose a new pattern</span></button>
        <div id="grid-host" hidden></div>
      </div>
    </div>`);
  form.append(gridRow);
  let picker = null;
  const gridToggle = gridRow.querySelector('#grid-toggle');
  const gridHost = gridRow.querySelector('#grid-host');
  gridToggle.addEventListener('click', () => {
    const open = gridHost.hidden;
    gridHost.hidden = !open;
    gridToggle.setAttribute('aria-expanded', String(open));
    gridToggle.querySelector('span').textContent = open ? 'Keep my current pattern' : 'Choose a new pattern';
    if (open && !picker) {
      picker = createGridPicker({ length: 8, labelledBy: 'grid-label', describedBy: 'grid-help' });
      gridHost.append(picker.el);
    }
    if (open) picker.focus();
    else picker?.clear();
  });

  form.append(
    row({ id: 'current-pass', label: 'Current password', help: 'Required to save any change.', keywords: 'current password confirm',
      control: '<input class="form-input" id="current-pass" name="current-password" type="password" autocomplete="current-password" required aria-required="true">' }),
    el(`<div class="settings-actions"><button type="submit" class="btn btn-primary" id="save-creds">Update sign-in details</button></div>`),
  );
  creds.append(form);

  const twofa = group('Two-factor sign-in', { description: 'Besides the grid, an authenticator app (TOTP) can be required at sign-in.' });
  twofa.dataset.keywords = 'two factor 2fa totp authenticator recovery codes otp';
  const totp = el(`<div class="totp">
      <p class="totp-status" id="totp-status" role="status">Loading…</p>
      <div class="totp-setup" id="totp-setup" hidden>
        <ol class="totp-steps">
          <li><p>Add this key to your authenticator app:</p>
            <div class="input-with-actions"><code class="totp-secret" id="totp-secret"></code>
            <button type="button" class="btn btn-secondary btn-sm" id="totp-copy">${icon('copy', { size: 14 })}<span>Copy</span></button></div>
            <p class="setting-help"><a id="totp-otpauth" class="link-button" hidden>Or open it in your authenticator app</a></p></li>
          <li><label class="form-label" for="totp-code">Enter the 6-digit code it shows</label>
            <input class="form-input totp-code" id="totp-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="one-time-code" placeholder="123456"></li>
        </ol>
        <div class="settings-actions">
          <button type="button" class="btn btn-primary btn-sm" id="totp-enable">Turn on two-factor</button>
          <button type="button" class="btn btn-ghost btn-sm" id="totp-cancel">Cancel</button>
        </div>
      </div>
      <div class="settings-actions" id="totp-actions"></div>
      <div class="totp-recovery" id="totp-recovery" hidden>
        <p class="setting-label">Recovery codes</p>
        <p class="setting-help">Keep these somewhere safe — each works once if you lose your phone.</p>
        <ul class="recovery-list" id="recovery-list"></ul>
        <button type="button" class="btn btn-secondary btn-sm" id="recovery-copy">${icon('copy', { size: 14 })}<span>Copy codes</span></button>
      </div>
    </div>`);
  twofa.append(totp);
  s.body.append(creds, twofa);

  // --- credentials wiring
  const inputs = {
    currentPassword: form.querySelector('#current-pass'),
    newUsername: form.querySelector('#new-user'),
    newPassword: form.querySelector('#new-pass'),
    confirm: form.querySelector('#new-pass-2'),
  };
  Object.values(inputs).forEach(input => input.addEventListener('input', () => clearFieldError(input)));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    Object.values(inputs).forEach(clearFieldError);
    const payload = { currentPassword: inputs.currentPassword.value };
    const username = inputs.newUsername.value.trim();
    const password = inputs.newPassword.value;
    const errors = {};
    if (username) {
      if (username.length < 3) errors.newUsername = 'Usernames need at least 3 characters';
      else payload.newUsername = username;
    }
    if (password) {
      if (password.length < 6) errors.newPassword = 'Use at least 6 characters';
      else if (password !== inputs.confirm.value) errors.confirm = 'The two passwords don’t match';
      else payload.newPassword = password;
    }
    if (picker && !picker.isEmpty()) {
      if (!picker.isComplete()) errors.grid = `Pick all 8 squares (${picker.value().length} so far), or choose “Keep my current pattern”.`;
      else payload.newGridPattern = picker.value();
    }
    if (!payload.currentPassword) errors.currentPassword = 'Enter your current password to make changes';
    if (!errors.currentPassword && !payload.newUsername && !payload.newPassword && !payload.newGridPattern && !Object.keys(errors).length) {
      flashStatus(s, 'Nothing to change yet', 'error');
      inputs.newUsername.focus();
      return;
    }
    if (errors.grid) {
      gridRow.querySelector('.grid-picker-status').textContent = errors.grid;
      flashStatus(s, errors.grid, 'error');
    }
    if (applyFieldErrors(inputs, errors) || errors.grid) return;

    const btn = form.querySelector('#save-creds');
    busy(btn, true, 'Updating…');
    try {
      const result = await api.updateCredentials(payload);
      // A new password or grid rotates the server's signing key and signs
      // out other devices; this one gets a fresh token to stay signed in.
      if (result?.token) {
        store.setAuth(result.token, store.get('user'));
        api.clearTokenCache();
      }
      form.reset();
      if (picker) { picker.clear(); gridToggle.click(); }
      const others = result?.signedOut ? ` Other devices (${result.signedOut}) were signed out.` : '';
      flashStatus(s, `Sign-in details updated.${others}`);
      toast.success('Sign-in details updated');
    } catch (err) {
      if (!applyFieldErrors(inputs, err.fields || (err.code === 'WRONG_PASSWORD' ? { currentPassword: err.message } : {}))) {
        flashStatus(s, err.message, 'error');
      }
    } finally {
      busy(btn, false);
    }
  });

  // --- TOTP wiring
  const status = totp.querySelector('#totp-status');
  const setup = totp.querySelector('#totp-setup');
  const actions = totp.querySelector('#totp-actions');
  const recovery = totp.querySelector('#totp-recovery');
  let lastCodes = [];

  const showRecovery = (codes) => {
    if (!codes?.length) return;
    lastCodes = codes;
    recovery.hidden = false;
    totp.querySelector('#recovery-list').innerHTML = codes.map(c => `<li><code>${escapeHtml(c)}</code></li>`).join('');
  };
  totp.querySelector('#recovery-copy').addEventListener('click', async () => {
    if (await copyText(lastCodes.join('\n'))) flashStatus(s, 'Recovery codes copied');
  });
  totp.querySelector('#totp-copy').addEventListener('click', async () => {
    if (await copyText(totp.querySelector('#totp-secret').textContent)) flashStatus(s, 'Key copied');
  });

  const button = (label, cls, onClick, iconName) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls} btn-sm`;
    b.innerHTML = `${iconName ? icon(iconName, { size: 14 }) : ''}<span>${label}</span>`;
    b.addEventListener('click', onClick);
    return b;
  };

  function render(state) {
    status.innerHTML = state.enabled
      ? `${icon('shield-check', { size: 16 })}<span><strong>Two-factor is on.</strong> ${state.recoveryCodesLeft ?? 0} recovery code${state.recoveryCodesLeft === 1 ? '' : 's'} left.</span>`
      : `${icon('shield-off', { size: 16 })}<span>Two-factor is off.</span>`;
    status.dataset.state = state.enabled ? 'on' : 'off';
    actions.replaceChildren();
    if (state.enabled) {
      actions.append(
        button('New recovery codes', 'btn-secondary', async () => {
          const code = await promptModal({
            title: 'New recovery codes',
            message: 'Your old codes stop working. Enter the current code from your authenticator app to continue.',
            label: '6-digit code',
            confirmLabel: 'Generate',
            inputMode: 'numeric',
            autocomplete: 'one-time-code',
            validate: v => (/^\d{6}$/.test(v) ? '' : 'Enter the 6 digits shown in your app'),
          });
          if (!code) return;
          try {
            const data = await api.totpRecoveryCodes(code);
            showRecovery(data.recoveryCodes);
            flashStatus(s, 'New recovery codes generated');
            refresh();
          } catch (err) { flashStatus(s, err.message, 'error'); }
        }, 'refresh'),
        button('Turn off two-factor', 'btn-ghost', async () => {
          const password = await promptModal({
            title: 'Turn off two-factor sign-in',
            message: 'Confirm with your account password.',
            label: 'Password',
            inputType: 'password',
            autocomplete: 'current-password',
            confirmLabel: 'Turn off',
          });
          if (!password) return;
          try {
            await api.totpDisable(password);
            recovery.hidden = true;
            flashStatus(s, 'Two-factor turned off');
            refresh();
          } catch (err) { flashStatus(s, err.message, 'error'); }
        }),
      );
    } else {
      actions.append(button('Set up two-factor', 'btn-secondary', async () => {
        try {
          const data = await api.totpSetup();
          totp.querySelector('#totp-secret').textContent = data.secret || '';
          const link = totp.querySelector('#totp-otpauth');
          if (data.otpauthUrl) { link.href = data.otpauthUrl; link.hidden = false; } else link.hidden = true;
          setup.hidden = false;
          actions.hidden = true;
          totp.querySelector('#totp-code').focus();
        } catch (err) { flashStatus(s, err.message, 'error'); }
      }, 'key'));
    }
  }

  async function refresh() {
    try {
      const data = await api.totpStatus();
      render({ enabled: Boolean(data.enabled), recoveryCodesLeft: data.recoveryCodesLeft });
    } catch (err) {
      status.textContent = `Couldn’t load two-factor status: ${err.message}`;
    }
  }

  const codeInput = totp.querySelector('#totp-code');
  totp.querySelector('#totp-enable').addEventListener('click', async (e) => {
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) { fieldError(codeInput, 'Enter the 6 digits shown in your app'); codeInput.focus(); return; }
    clearFieldError(codeInput);
    busy(e.currentTarget, true, 'Checking…');
    try {
      const data = await api.totpEnable(code);
      setup.hidden = true;
      actions.hidden = false;
      codeInput.value = '';
      showRecovery(data.recoveryCodes);
      flashStatus(s, 'Two-factor turned on');
      refresh();
    } catch (err) {
      fieldError(codeInput, err.message);
      codeInput.focus();
    } finally {
      busy(e.currentTarget, false);
    }
  });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); totp.querySelector('#totp-enable').click(); } });
  totp.querySelector('#totp-cancel').addEventListener('click', () => { setup.hidden = true; actions.hidden = false; actions.querySelector('button')?.focus(); });

  refresh();
  return s;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
export function devicesSection() {
  const s = section({
    id: 'devices',
    title: 'Devices',
    iconName: 'monitor',
    scope: 'account',
    intro: 'Pair a phone or TV, see where you’re signed in, install Vault as an app.',
  });

  const pair = group('Pair a device');
  pair.dataset.keywords = 'pair qr code phone tv device connect';
  pair.append(el(`<div class="pair-ondemand">
      <p class="setting-help">Shows a QR code and a 6-digit code that sign another device in. Codes last 5 minutes and work once.</p>
      <button type="button" class="btn btn-secondary btn-sm" id="pair-show" aria-expanded="false" aria-controls="pair-panel">${icon('qr', { size: 15 })}<span>Show pairing code</span></button>
      <div id="pair-panel" class="pair-panel" hidden></div>
    </div>`));

  const sessions = group('Where you’re signed in');
  sessions.dataset.keywords = 'sessions sign out logout revoke devices browsers';
  sessions.append(el(`<div class="sessions">
      <div id="sessions-list" class="sessions-list"></div>
      <div class="settings-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="logout-btn">${icon('log-out', { size: 14 })}<span>Sign out of this device</span></button>
        <button type="button" class="btn btn-ghost btn-sm" id="revoke-others">${icon('shield-off', { size: 14 })}<span>Sign out everywhere else</span></button>
      </div>
    </div>`));

  const install = group('Install as an app');
  install.append(row({
    label: 'Vault on your home screen',
    help: '<span id="install-hint">Use your browser’s “Install” or “Add to Home Screen” option for full-screen playback.</span>',
    keywords: 'install pwa app home screen',
    control: `<button class="btn btn-secondary btn-sm" id="install-app" type="button" hidden>${icon('download', { size: 14 })}<span>Install</span></button>`,
  }));
  s.body.append(pair, sessions, install);

  // --- pairing on demand (no token is minted until asked)
  const pairBtn = s.querySelector('#pair-show');
  const pairPanel = s.querySelector('#pair-panel');
  pairBtn.addEventListener('click', () => {
    const open = pairPanel.hidden;
    pairPanel.hidden = !open;
    pairBtn.setAttribute('aria-expanded', String(open));
    pairBtn.querySelector('span').textContent = open ? 'Hide pairing code' : 'Show pairing code';
    if (open) renderPairingPanel(pairPanel);
    // Closing removes the panel's DOM, which also stops qrPair's polling.
    else pairPanel.replaceChildren();
  });

  // --- install
  const installBtn = s.querySelector('#install-app');
  const hint = s.querySelector('#install-hint');
  const syncInstall = () => {
    const available = Boolean(window.vaultInstall?.available?.());
    installBtn.hidden = !available;
    if (hint) hint.textContent = available ? 'Opens full screen, with its own icon.' : 'Use your browser’s “Install” or “Add to Home Screen” option for full-screen playback.';
  };
  syncInstall();
  window.addEventListener('vault:install-state', syncInstall);
  onUnmount(() => window.removeEventListener('vault:install-state', syncInstall));
  installBtn.addEventListener('click', async () => {
    const accepted = await window.vaultInstall?.prompt?.();
    if (accepted) flashStatus(s, 'Installing Vault…');
    syncInstall();
  });

  // --- sessions
  const list = s.querySelector('#sessions-list');
  s.querySelector('#logout-btn').addEventListener('click', async () => {
    const { confirmed: ok } = await confirmDialog({ title: 'Sign out of this device?', message: 'You’ll need your password and grid to sign back in.', confirmText: 'Sign out' });
    if (ok) window.dispatchEvent(new CustomEvent('vault:logout'));
  });
  s.querySelector('#revoke-others').addEventListener('click', async (e) => {
    const { confirmed: ok } = await confirmDialog({ title: 'Sign out everywhere else?', message: 'Every other browser and device signed in to Vault will have to sign in again.', confirmText: 'Sign out others', danger: true });
    if (!ok) return;
    busy(e.currentTarget, true, 'Signing out…');
    try {
      await api.revokeOtherSessions();
      flashStatus(s, 'Other devices signed out');
      loadSessions(list, s);
    } catch (err) { flashStatus(s, err.message, 'error'); } finally { busy(e.currentTarget, false); }
  });
  loadSessions(list, s);
  return s;
}

function describeAgent(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ') || '';
}

async function loadSessions(host, s) {
  host.innerHTML = '<div class="skeleton skeleton-line"></div>';
  let sessions = [];
  try {
    sessions = (await api.getSessions()).sessions || [];
  } catch (err) {
    host.innerHTML = `<p class="setting-help">${escapeHtml(err.message)}</p>`;
    return;
  }
  const currentSid = store.get('sessionId');
  if (!sessions.length) { host.innerHTML = '<p class="setting-help">No sessions recorded.</p>'; return; }
  host.innerHTML = `<ul class="session-items">${sessions.map(session => {
    const current = session.current || session.id === currentSid;
    const name = session.device || describeAgent(session.userAgent) || 'Unknown device';
    const meta = [session.ip, session.lastSeen ? `active ${formatRelativeTime(session.lastSeen)}` : session.createdAt ? `signed in ${formatRelativeTime(session.createdAt)}` : ''].filter(Boolean).join(' · ');
    return `<li class="session-item${current ? ' is-current' : ''}">
      <span class="session-icon" aria-hidden="true">${icon(current ? 'monitor' : 'globe', { size: 18 })}</span>
      <div class="session-text"><p class="session-name">${escapeHtml(name)}${current ? ' <span class="chip">This device</span>' : ''}</p>
        ${meta ? `<p class="setting-help">${escapeHtml(meta)}</p>` : ''}</div>
      ${current ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-revoke="${escapeHtml(session.id)}" aria-label="Sign out ${escapeHtml(name)}">Sign out</button>`}
    </li>`;
  }).join('')}</ul>`;
  host.querySelectorAll('[data-revoke]').forEach(btn => btn.addEventListener('click', async () => {
    busy(btn, true, '…');
    try {
      await api.revokeSession(btn.dataset.revoke);
      flashStatus(s, 'Device signed out');
      loadSessions(host, s);
    } catch (err) { busy(btn, false); flashStatus(s, err.message, 'error'); }
  }));
}
