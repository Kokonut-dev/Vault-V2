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
    host.innerHTML = `<div class="empty-state"><div class="empty-state-message">QR library unavailable: ${err.message}</div></div>`;
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
      <p class="row-meta">On the other device open <code>${window.location.origin}/pair</code> and enter the 6 digits above.</p>
    </details>
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
      if (!ok) qrHost.innerHTML = `<code class="row-meta">${url}</code>`;
      clearInterval(pollTimer);
      pollTimer = setInterval(poll, 3000);
    } catch (err) {
      code = '';
      codeHost.textContent = '······';
      qrHost.innerHTML = `<div class="empty-state"><div class="empty-state-message">${err.message}</div></div>`;
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

/**
 * /pair?code=123456 or the /pair form. Signed out: redeem the code shown on
 * a signed-in device and sign in. Signed in: approve a code shown by a
 * device that is waiting (TV flow).
 */
export async function joinWithPairingCode(code, name = 'Paired device') {
  const clean = String(code).replace(/\D/g, '');
  try {
    if (localStorage.getItem('vault_token')) {
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

export default { renderQr, renderPairingPanel, joinWithPairingCode };
