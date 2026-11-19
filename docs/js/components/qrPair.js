/**
 * QR pairing — show a code that a phone can scan to open the server, and
 * (for the desktop side) approve a 6-digit pairing request.
 *
 * The QR library (`docs/vendor/qrcode.mjs`, qrcode-generator, MIT) is loaded
 * lazily so the ~12 KB never ships to users who never pair a device.
 */
import { api } from '../api.js';
import { icon } from '../utils/icons.js';
import { toast } from './toast.js';
import { escapeHtml } from '../utils/format.js';
import { createModal } from './modal.js';
import { securityNotes } from './securityNotes.js';

let qrModule = null;
async function loadQr() {
  if (!qrModule) {
    const mod = await import('../../vendor/qrcode.mjs');
    // The vendored build exports the factory as default.
    qrModule = mod.default?.qrcode || mod.default || mod.qrcode || mod;
  }
  return qrModule;
}

/**
 * Render a QR code for `text` into `container` (an element or a selector).
 * Returns false when the library could not be loaded (offline / blocked) —
 * callers should show the raw URL as a fallback.
 */
export async function renderQr(container, text, { size = 220 } = {}) {
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) return false;
  try {
    const factory = await loadQr();
    const qr = factory(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const cell = size / count;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(Math.floor(col * cell), Math.floor(row * cell), Math.ceil(cell), Math.ceil(cell));
        }
      }
    }
    host.replaceChildren(canvas);
    host.dataset.qrReady = 'true';
    return true;
  } catch (err) {
    host.innerHTML = `<div class="empty-state"><div class="empty-state-message">QR library unavailable: ${escapeHtml(err.message)}</div></div>`;
    return false;
  }
}

/**
 * Settings → "Pair a device" panel body. The signed-in device mints a
 * single-use, pre-approved code (`POST /api/auth/pair` with its token): the
 * QR opens `/?pair=<token>`, which signs the other device straight in; the
 * 6 digits do the same when typed on /pair.
 */
export async function renderPairingPanel(container) {
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) return;
  host.innerHTML = `
    <p class="row-meta">Scan this with the other device’s camera to sign it in — no password needed. The code works once and expires after 5 minutes.</p>
    <div class="qr-pair">
      <div id="pair-qr" class="qr-host" role="img" aria-label="Sign-in QR code"></div>
      <div class="pair-code" id="pair-code" aria-label="Pairing code">······</div>
      <p class="row-meta" id="pair-state" aria-live="polite"></p>
      <div class="page-actions">
        <button type="button" class="btn btn-primary btn-sm" id="pair-new">${icon('refresh', { size: 14 })}<span>New code</span></button>
      </div>
    </div>
    <details>
      <summary class="row-meta">Can’t scan? Type the code instead</summary>
      <p class="row-meta">On the other device open <code>${escapeHtml(window.location.origin)}/pair</code> and enter the 6 digits above.</p>
    </details>
    ${securityNotes('pair')}
  `;

  let code = '';
  let left = 0;
  let pollTimer = null;
  const stateEl = host.querySelector('#pair-state');

  async function refresh() {
    const codeHost = host.querySelector('#pair-code');
    const qrHost = host.querySelector('#pair-qr');
    try {
      const baseUrl = window.location.origin;
      const data = await api.createSignInLink(baseUrl, 'Device added with a QR code');
      code = data.code || '';
      left = data.expiresIn || 300;
      const url = data.url || `${baseUrl}/?pair=${encodeURIComponent(data.token)}`;
      codeHost.textContent = code.split('').join(' ') || '······';
      stateEl.textContent = '';
      const ok = await renderQr(qrHost, url);
      if (!ok) qrHost.innerHTML = `<code class="row-meta">${escapeHtml(url)}</code>`;
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, 3000);
    } catch (err) {
      code = '';
      codeHost.textContent = '······';
      qrHost.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
    }
  }

  // Ask (without redeeming) whether the other device has used the code.
  async function poll() {
    if (!document.body.contains(host)) { clearInterval(pollTimer); return; }
    if (!code) return;
    left -= 3;
    try {
      const { status } = await api.pairingState(code);
      if (status === 'used') {
        clearInterval(pollTimer);
        toast.success('Device signed in');
        host.querySelector('#pair-qr').innerHTML = `<div class="health-item ok">${icon('shield-check', { size: 16 })}<div class="row-main"><div class="row-title">Device signed in</div></div></div>`;
        host.querySelector('#pair-code').textContent = '';
        stateEl.textContent = 'You’ll find it under Signed-in devices below.';
      } else if (status === 'expired' || left <= 0) {
        clearInterval(pollTimer);
        stateEl.textContent = 'This code expired — press New code.';
        host.querySelector('#pair-qr').classList.add('is-expired');
      }
    } catch { /* offline: keep trying */ }
  }

  host.querySelector('#pair-new').addEventListener('click', () => {
    host.querySelector('#pair-qr').classList.remove('is-expired');
    refresh();
  });
  await refresh();
}

/** Who is asking, in words: "a device on your home network (192.168.1.5)". */
export function describeRequester(requester) {
  if (!requester) return '';
  const ip = requester.ip ? ` (${escapeHtml(String(requester.ip).replace(/^::ffff:/, ''))})` : '';
  switch (requester.network) {
    case 'this computer': return `This code was made on <strong>the computer running Vault</strong>${ip}.`;
    case 'your network': return `This code was made by <strong>a device on your home network</strong>${ip}.`;
    case 'internet': return `This code was made by <strong>a device on the internet</strong>${ip}. If you aren’t setting up a device of your own somewhere else right now, don’t approve it.`;
    default: return '';
  }
}

/**
 * Ask before letting another device in. A signed-in person opening a
 * /pair?code= link someone sent them used to approve it on the spot, which
 * would sign the sender's device in as them.
 */
export function confirmApproval(code, requester = null) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
    const who = describeRequester(requester);
    const { backdrop, close } = createModal({
      title: 'Let this device sign in?',
      content: `
        <div class="pair-approve">
          <p class="setting-help">A device is waiting to sign in to your Vault with this code:</p>
          <div class="pair-code" aria-label="Pairing code">${escapeHtml(String(code).split('').join(' '))}</div>
          ${who ? `<p class="pair-requester">${who}</p>` : ''}
          ${securityNotes('approve', { open: true, title: 'Before you approve' })}
          <div class="settings-actions" style="justify-content:flex-end; margin-top:16px;">
            <button type="button" class="btn btn-secondary" data-pair="cancel">Don’t approve</button>
            <button type="button" class="btn btn-primary" data-pair="ok">Approve device</button>
          </div>
        </div>`,
      onClose: () => settle(false),
    });
    backdrop.querySelector('[data-pair="cancel"]').addEventListener('click', () => { settle(false); close(); });
    backdrop.querySelector('[data-pair="ok"]').addEventListener('click', () => { settle(true); close(); });
    backdrop.querySelector('[data-pair="cancel"]').focus();
  });
}

/**
 * /pair?code=123456 or the /pair form. Signed out: redeem the code shown on
 * a signed-in device and sign in. Signed in: approve a code shown by a
 * device that is waiting (TV flow) — always after an explicit confirmation.
 */
export async function joinWithPairingCode(code, name = 'Paired device') {
  const clean = String(code).replace(/\D/g, '');
  try {
    if (localStorage.getItem('vault_token')) {
      let requester = null;
      try {
        const state = await api.pairingState(clean);
        if (state?.status === 'expired' || state?.status === 'used') {
          toast.error('That code expired or was already used — make a new one');
          return false;
        }
        requester = state?.requester || null;
      } catch { /* older server: still ask */ }
      if (!(await confirmApproval(clean, requester))) {
        toast.info('Not approved — the other device stays signed out');
        return false;
      }
      await api.approvePairing({ code: clean, deviceLabel: name });
      toast.success('Device approved — it will sign in in a moment');
      return true;
    }
    const result = await api.pairingStatus(clean);
    if (result?.token) {
      localStorage.setItem('vault_token', result.token);
      localStorage.setItem('vault_onboarded', '1');
      toast.success('Signed in — loading your library');
      setTimeout(() => location.replace('/'), 500);
      return true;
    }
    toast.info('That code hasn’t been approved yet');
  } catch (err) {
    toast.error(err.code === 'PAIR_EXPIRED' ? 'That code expired or was already used — make a new one' : `Pairing failed: ${err.message}`);
  }
  return false;
}

export default { renderQr, renderPairingPanel, joinWithPairingCode, confirmApproval, describeRequester };
