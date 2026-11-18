/**
 * "Use Vault on another device" — one button instead of terminal commands.
 *
 *  Same Wi-Fi  the LAN addresses the server listens on, as a QR code that
 *              also signs the other device in (single-use, 5 minutes).
 *  Anywhere    a Cloudflare quick tunnel the server runs itself, installing
 *              cloudflared on first use; shows the https:// address + QR.
 *
 * Server side: /api/remote (status, tunnel) and /api/server/network.
 */
import { api } from '../api.js';
import { createModal } from './modal.js';
import { renderQr } from './qrPair.js';
import { toast } from './toast.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { copyText } from '../utils/clipboard.js';
import { waitForServerDown, waitForServer } from '../utils/serverLauncher.js';

const SIGN_IN_PREF = 'vault_share_signin';

function formatMb(bytes) {
  return `${Math.round((bytes || 0) / 1048576)} MB`;
}

export function openShareDevice({ tab = 'lan' } = {}) {
  const { backdrop, close } = createModal({
    title: 'Use Vault on another device',
    content: `
      <div class="share-device">
        <div class="segmented share-tabs" role="tablist" aria-label="How the other device connects">
          <button type="button" role="tab" class="segmented-btn" id="share-tab-lan" aria-controls="share-panel" data-tab="lan">${icon('wifi', { size: 15 })}<span>Same Wi-Fi</span></button>
          <button type="button" role="tab" class="segmented-btn" id="share-tab-remote" aria-controls="share-panel" data-tab="remote">${icon('globe', { size: 15 })}<span>Anywhere</span></button>
        </div>
        <div id="share-panel" role="tabpanel" class="share-panel" aria-live="polite">
          <div class="share-loading">${icon('loader', { size: 18 })}<span>Checking your network…</span></div>
        </div>
      </div>`,
    onClose: () => { closed = true; clearInterval(poll); clearInterval(countdown); window.removeEventListener('vault:remote-changed', onRemote); },
  });
  backdrop.querySelector('.modal').classList.add('share-modal');

  const panel = backdrop.querySelector('#share-panel');
  let closed = false;
  let active = tab;
  let status = null;
  let poll = null;
  let countdown = null;
  let selectedUrl = null;

  const onRemote = (e) => {
    if (!status) return;
    status.tunnel = e.detail || status.tunnel;
    if (active === 'remote') paintRemote();
  };
  window.addEventListener('vault:remote-changed', onRemote);

  backdrop.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => select(btn.dataset.tab)));

  function select(name) {
    active = name;
    backdrop.querySelectorAll('[data-tab]').forEach(btn => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `share-tab-${name}`);
    clearInterval(countdown);
    if (!status) return;
    if (name === 'lan') paintLan(); else paintRemote();
  }

  async function load() {
    try {
      status = await api.remoteStatus();
    } catch (err) {
      panel.innerHTML = err.code === 'ADMIN_REQUIRED'
        ? `<p class="settings-callout">${icon('lock', { size: 15 })}<span>Only an admin profile can share this server. Ask the owner, or switch profile.</span></p>`
        : `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(err.status === 404 ? 'Your Vault server is older than this page — update and restart it to use this.' : err.message)}</span></p>`;
      return;
    }
    if (closed) return;
    select(active);
    if (['installing', 'starting'].includes(status.tunnel?.status)) startPolling();
  }

  // ---------------------------------------------------------------- QR
  async function showQr(baseUrl) {
    const qrHost = panel.querySelector('.share-qr');
    const linkInput = panel.querySelector('#share-link');
    const timer = panel.querySelector('.share-expiry');
    if (!qrHost) return;
    const signIn = panel.querySelector('#share-signin')?.checked;
    clearInterval(countdown);
    let link = baseUrl;
    qrHost.classList.add('is-loading');
    if (signIn) {
      try {
        const data = await api.createSignInLink(baseUrl, 'Signed in with a QR code');
        if (data?.approved && data.url) {
          link = data.url;
          let left = data.expiresIn || 300;
          const tick = () => {
            if (!timer) return;
            if (left <= 0) {
              clearInterval(countdown);
              timer.innerHTML = `Code expired — <button type="button" class="btn-link" data-action="renew">make a new one</button>`;
              qrHost.classList.add('is-expired');
              return;
            }
            timer.textContent = `Single-use sign-in code · expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
            left -= 1;
          };
          tick();
          countdown = setInterval(tick, 1000);
        } else if (timer) {
          timer.textContent = 'The other device will sign in with your password and grid.';
        }
      } catch {
        if (timer) timer.textContent = 'Couldn’t create a sign-in code — the other device will sign in normally.';
      }
    } else if (timer) {
      timer.textContent = 'The other device will sign in with your password and grid.';
    }
    qrHost.classList.remove('is-loading', 'is-expired');
    if (linkInput) linkInput.value = link;
    const ok = await renderQr(qrHost, link, { size: 200 });
    if (!ok) qrHost.innerHTML = `<code>${escapeHtml(link)}</code>`;
  }

  function qrBlock() {
    const signIn = localStorage.getItem(SIGN_IN_PREF) !== '0';
    return `
      <div class="share-qr-wrap">
        <div class="share-qr qr-host" aria-label="QR code for the address below" role="img"></div>
        <div class="share-qr-side">
          <label class="share-check"><input type="checkbox" id="share-signin"${signIn ? ' checked' : ''}> <span>Sign the other device in automatically</span></label>
          <p class="share-expiry setting-help"></p>
          <label class="sr-only" for="share-link">Link</label>
          <div class="input-with-actions">
            <input class="form-input" id="share-link" readonly spellcheck="false">
            <button type="button" class="btn btn-secondary" data-action="copy">${icon('copy', { size: 15 })}<span>Copy</span></button>
          </div>
        </div>
      </div>`;
  }

  function wireQr(baseUrl) {
    panel.querySelector('#share-signin')?.addEventListener('change', (e) => {
      localStorage.setItem(SIGN_IN_PREF, e.target.checked ? '1' : '0');
      showQr(selectedUrl || baseUrl);
    });
    showQr(baseUrl);
  }

  // ---------------------------------------------------------------- LAN
  function paintLan() {
    const lan = status.lan;
    const addresses = [
      ...(lan.mdns?.url ? [{ url: lan.mdns.url, label: 'Name on your network', interface: 'mDNS' }] : []),
      ...lan.addresses.map(a => ({ url: a.url, label: a.virtual ? `${a.interface} (virtual adapter)` : a.linkLocal ? `${a.interface} (no network address yet)` : a.interface })),
    ];
    if (!lan.reachable) {
      panel.innerHTML = `
        <div class="share-step">
          <p class="settings-callout">${icon('lock', { size: 15 })}<span>Right now Vault only accepts connections from this computer.</span></p>
          <p class="setting-help">Allow devices on your home network to connect? They still need your password and grid (or a QR sign-in code from here).</p>
          <div class="settings-actions"><button type="button" class="btn btn-primary" data-action="open-lan">${icon('wifi', { size: 15 })}<span>Allow devices on my network</span></button></div>
        </div>`;
      return;
    }
    if (!addresses.length) {
      panel.innerHTML = `<p class="settings-callout is-error">${icon('wifi-off', { size: 15 })}<span>This computer isn’t connected to a network right now. Connect to Wi-Fi or Ethernet, then reopen this.</span></p>`;
      return;
    }
    selectedUrl = selectedUrl && addresses.some(a => a.url === selectedUrl) ? selectedUrl : addresses[0].url;
    panel.innerHTML = `
      <p class="share-lead">Scan with the phone or tablet’s camera. Both devices must be on the same Wi-Fi.</p>
      ${addresses.length > 1 ? `
        <fieldset class="share-addresses">
          <legend class="setting-label">Address</legend>
          ${addresses.map((a, i) => `
            <label class="share-address"><input type="radio" name="share-address" value="${escapeHtml(a.url)}"${a.url === selectedUrl ? ' checked' : ''}>
              <span class="share-address-url">${escapeHtml(a.url)}</span><span class="share-address-meta">${escapeHtml(a.label || '')}${i === 0 ? ' · recommended' : ''}</span></label>`).join('')}
        </fieldset>` : ''}
      ${qrBlock()}
      <details class="share-help">
        <summary>The other device can’t connect?</summary>
        <ul>
          <li>Check both devices are on the same Wi-Fi (not a guest network).</li>
          <li>Windows: when asked, allow <strong>Node.js</strong> on <strong>Private networks</strong> (Windows Security → Firewall → Allow an app).</li>
          <li>Try another address from the list — computers with VPNs or virtual machines have several.</li>
          <li>Away from home? Use the <button type="button" class="btn-link" data-action="to-remote">Anywhere</button> tab.</li>
        </ul>
      </details>`;
    panel.querySelectorAll('input[name="share-address"]').forEach(r => r.addEventListener('change', () => {
      selectedUrl = r.value;
      showQr(selectedUrl);
    }));
    wireQr(selectedUrl);
  }

  // ---------------------------------------------------------------- Remote
  function paintRemote() {
    const t = status.tunnel || { status: 'off' };
    const cf = status.cloudflared || {};
    clearInterval(countdown);
    if (t.status === 'installing') {
      const pct = t.install?.total ? Math.round((t.install.received / t.install.total) * 100) : null;
      panel.innerHTML = `
        <div class="share-step">
          <p class="share-lead">${icon('download', { size: 16 })} Downloading Cloudflare’s tunnel program (first time only)…</p>
          <div class="progress" role="progressbar" aria-label="Download progress" aria-valuemin="0" aria-valuemax="100"${pct != null ? ` aria-valuenow="${pct}"` : ''}><div class="progress-bar" style="width:${pct ?? 15}%"></div></div>
          <p class="setting-help">${t.install?.total ? `${formatMb(t.install.received)} of ${formatMb(t.install.total)}` : 'Starting download…'} · checked against Cloudflare’s published checksum before it runs.</p>
        </div>`;
      return;
    }
    if (t.status === 'starting') {
      panel.innerHTML = `<div class="share-step"><p class="share-lead share-busy">${icon('loader', { size: 16 })}<span>Opening a secure address…</span></p><p class="setting-help">This usually takes 5–15 seconds.</p></div>`;
      return;
    }
    if (t.status === 'on' && t.url) {
      panel.innerHTML = `
        <p class="share-lead"><span class="status-dot is-on" aria-hidden="true"></span> Remote access is on. Open this address on any device, anywhere:</p>
        ${qrBlock()}
        <label class="share-check share-keep"><input type="checkbox" role="switch" class="switch" id="share-keep"${status.tunnelOnStartup ? ' checked' : ''}> <span>Turn on again when the server restarts</span></label>
        <p class="setting-help">The address changes every time remote access starts. Anyone who has it still needs your password and grid.</p>
        <div class="settings-actions"><button type="button" class="btn btn-secondary" data-action="tunnel-off">${icon('power', { size: 15 })}<span>Turn off remote access</span></button></div>`;
      panel.querySelector('#share-keep').addEventListener('change', async (e) => {
        try {
          const res = await api.setRemoteSettings({ tunnelOnStartup: e.target.checked });
          status.tunnelOnStartup = res.tunnelOnStartup;
        } catch (err) { toast.error(err.message); e.target.checked = !e.target.checked; }
      });
      wireQr(t.url);
      return;
    }
    const error = t.status === 'error' && t.error
      ? `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>${escapeHtml(t.error)}</span></p>` : '';
    panel.innerHTML = `
      <div class="share-step">
        ${error}
        <p class="share-lead">Get a private <strong>https://</strong> address that works from mobile data, work or a friend’s house.</p>
        <ul class="share-points">
          <li>${icon('shield-check', { size: 15 })}<span>Free, through Cloudflare — no account, no router settings.</span></li>
          <li>${icon('lock', { size: 15 })}<span>Your password and grid still protect Vault.</span></li>
          <li>${icon('download', { size: 15 })}<span>${cf.installed ? `Uses cloudflared ${escapeHtml(cf.version || '')} on this computer.` : cf.installable === false ? 'Needs cloudflared — Cloudflare doesn’t publish it for this system, so install it yourself.' : 'Downloads Cloudflare’s small tunnel program (about 40 MB) the first time.'}</span></li>
        </ul>
        <div class="settings-actions"><button type="button" class="btn btn-primary" data-action="tunnel-on"${!cf.installed && cf.installable === false ? ' disabled' : ''}>${icon('globe', { size: 15 })}<span>${t.status === 'error' ? 'Try again' : 'Turn on remote access'}</span></button></div>
      </div>`;
  }

  function startPolling() {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (closed) return clearInterval(poll);
      try {
        const next = await api.remoteStatus();
        const changed = JSON.stringify(next.tunnel) !== JSON.stringify(status.tunnel);
        status = next;
        if (changed && active === 'remote') paintRemote();
        if (!['installing', 'starting'].includes(next.tunnel?.status)) clearInterval(poll);
      } catch { /* keep trying */ }
    }, 1200);
  }

  // ---------------------------------------------------------------- actions
  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'copy') {
      const value = panel.querySelector('#share-link')?.value;
      if (value && await copyText(value)) toast.success('Link copied');
    } else if (action === 'renew') {
      showQr(active === 'remote' ? status.tunnel.url : selectedUrl);
    } else if (action === 'to-remote') {
      select('remote');
    } else if (action === 'tunnel-on') {
      btn.disabled = true;
      try {
        status.tunnel = await api.startTunnel();
        paintRemote();
        startPolling();
      } catch (err) {
        toast.error(err.message);
        btn.disabled = false;
      }
    } else if (action === 'tunnel-off') {
      btn.disabled = true;
      try {
        await api.stopTunnel();
        status.tunnel = { status: 'off' };
        paintRemote();
      } catch (err) {
        toast.error(err.message);
        btn.disabled = false;
      }
    } else if (action === 'open-lan') {
      btn.disabled = true;
      try {
        const res = await api.setLanAccess(true);
        if (!res.restartRequired) { status = await api.remoteStatus(); paintLan(); return; }
        if (!res.supervised) {
          panel.innerHTML = `<p class="settings-callout">${icon('refresh', { size: 15 })}<span>Saved. Restart the Vault server (close its window, then run <code>npm start</code>) and reopen this.</span></p>`;
          return;
        }
        panel.innerHTML = `<p class="share-lead share-busy">${icon('loader', { size: 16 })}<span>Restarting the server so other devices can connect…</span></p>`;
        await api.restartServer();
        await waitForServerDown({ timeoutMs: 15000 });
        if (await waitForServer({ timeoutMs: 120000 })) {
          status = await api.remoteStatus();
          if (!closed) paintLan();
        } else {
          panel.innerHTML = `<p class="settings-callout is-error">${icon('alert-circle', { size: 15 })}<span>The server didn’t come back. Open Settings → Connection to start it.</span></p>`;
        }
      } catch (err) {
        toast.error(err.message);
        btn.disabled = false;
      }
    }
  });

  // Keyboard: arrow keys move between the two tabs (WAI-ARIA tabs pattern).
  backdrop.querySelector('.share-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = active === 'lan' ? 'remote' : 'lan';
    select(next);
    backdrop.querySelector(`[data-tab="${next}"]`).focus();
  });

  load();
  return { close };
}

export default { openShareDevice };
