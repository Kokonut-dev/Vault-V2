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
 * Settings → "Pair a device" panel body: creates a short-lived pair link
 * server-side (`POST /api/auth/pair`) and renders it as a QR code.
 */
export async function renderPairingPanel(container) {
  const host = typeof container === 'string' ? document.querySelector(container) : container;
  if (!host) return;
  host.innerHTML = `
    <p class="row-meta">Open Vault on another device and scan this code — it carries the server URL and a single-use pairing token.</p>
    <div class="qr-pair">
      <div id="pair-qr" class="qr-host"></div>
      <div class="pair-code" id="pair-code">······</div>
      <div class="page-actions">
        <button type="button" class="btn btn-primary btn-sm" id="pair-new">${icon('refresh', { size: 14 })}<span>New code</span></button>
      </div>
    </div>
    <details>
      <summary class="row-meta">Can't scan? Enter the code manually</summary>
      <p class="row-meta">On the other device open <code>Settings → Connect to a server → Enter code</code> and type the 6-digit code above.</p>
    </details>
  `;

  async function refresh() {
    const codeHost = host.querySelector('#pair-code');
    const qrHost = host.querySelector('#pair-qr');
    try {
      const baseUrl = window.location.origin;
      const data = await api.createPairingCode(baseUrl);
      const code = data.code || data.pairingCode || '';
      const url = data.url || `${baseUrl}/#/pair?code=${encodeURIComponent(code)}`;
      codeHost.textContent = code.split('').join(' ') || '······';
      const ok = await renderQr(qrHost, url);
      if (!ok) qrHost.innerHTML = `<code class="row-meta">${url}</code>`;
    } catch (err) {
      codeHost.textContent = '······';
      qrHost.innerHTML = `<div class="empty-state"><div class="empty-state-message">${err.message}</div></div>`;
    }
  }

  host.querySelector('#pair-new').addEventListener('click', refresh);
  await refresh();

  // Poll so the panel can celebrate when the other device approves.
  const timer = setInterval(async () => {
    if (!document.body.contains(host)) { clearInterval(timer); return; }
    try {
      const code = host.querySelector('#pair-code').textContent.replace(/\s/g, '');
      const status = await api.pairingStatus(code);
      if (status?.approved || status?.used) {
        clearInterval(timer);
        toast.success('Device paired');
        host.querySelector('#pair-qr').innerHTML = `<div class="health-item ok">${icon('shield-check', { size: 16 })}<div class="row-main"><div class="row-title">Device paired</div></div></div>`;
      }
    } catch { /* pending */ }
  }, 4000);
}

/** Guest side: deep-link handler for `/#/pair?code=123456`. */
export async function joinWithPairingCode(code, name = 'Paired device') {
  try {
    const result = await api.approvePairing({ code, name });
    if (result?.token) {
      localStorage.setItem('vault_token', result.token);
      toast.success('Paired — signing you in');
      setTimeout(() => location.reload(), 600);
      return true;
    }
  } catch (err) {
    toast.error(`Pairing failed: ${err.message}`);
  }
  return false;
}

export default { renderQr, renderPairingPanel, joinWithPairingCode };
