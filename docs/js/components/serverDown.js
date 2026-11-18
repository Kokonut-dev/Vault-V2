/**
 * "The Vault server isn't running" — shown on the sign-in screen and in the
 * disconnected banner, with a Start button whenever the Vault launcher is
 * available on this computer (see utils/serverLauncher.js).
 */
import { getApiBaseUrl } from '../config.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { copyText } from '../utils/clipboard.js';
import {
  probeLauncher, startServer, serverIsUp, waitForServer, serverIsOnThisDevice, START_COMMAND,
} from '../utils/serverLauncher.js';
import { toast } from './toast.js';

/**
 * Render into `host` and keep it in sync until the server is reachable.
 * @param {HTMLElement} host
 * @param {{ onUp?: () => void, compact?: boolean }} options
 * @returns {{ refresh: () => Promise<boolean>, destroy: () => void }}
 */
export function mountServerDown(host, { onUp, compact = false } = {}) {
  let destroyed = false;
  let busy = false;
  let pollTimer = null;

  const paint = (state) => {
    if (destroyed) return;
    host.hidden = false;
    host.classList.add('server-down');
    host.classList.toggle('is-compact', compact);
    const base = escapeHtml(getApiBaseUrl());
    const local = serverIsOnThisDevice();
    const { launcher, phase, reason } = state;

    if (phase === 'starting') {
      host.innerHTML = `
        <div class="server-down-head">
          <span class="server-down-icon is-busy" aria-hidden="true">${icon('loader', { size: 18 })}</span>
          <div><p class="server-down-title">${launcher?.installing ? 'Installing Vault’s packages…' : 'Starting the Vault server…'}</p>
          <p class="server-down-text">${launcher?.installing
            ? 'First run only — this downloads what the server needs and usually takes under a minute.'
            : 'The first start scans your library, which can take a minute.'}</p></div>
        </div>`;
      return;
    }

    const title = local ? 'The Vault server isn’t running' : 'Can’t reach the Vault server';
    let body;
    if (launcher) {
      body = `
        <p class="server-down-text">${reason ? `It stopped: <span class="server-down-reason">${escapeHtml(reason)}</span>` : 'Start it here — no terminal needed.'}</p>
        <div class="server-down-actions">
          <button type="button" class="btn btn-primary" data-action="start">${icon('power', { size: 16 })}<span>${reason ? 'Try again' : 'Start server'}</span></button>
        </div>`;
    } else if (local) {
      body = `
        <p class="server-down-text">Start it on this computer once:</p>
        <div class="server-down-command">
          <code>${escapeHtml(START_COMMAND)}</code>
          <button type="button" class="btn btn-ghost btn-sm" data-action="copy" aria-label="Copy the start command">${icon('copy', { size: 14 })}<span>Copy</span></button>
        </div>
        <p class="server-down-hint">Then turn on <strong>Settings → Connection → Start Vault when this computer starts</strong> and this screen gets a Start button.</p>
        <div class="server-down-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="check">${icon('refresh', { size: 14 })}<span>Check again</span></button>
        </div>`;
    } else {
      body = `
        <p class="server-down-text">Nothing answered at <code>${base}</code>. Check that the computer running Vault is on and connected, or change the server address below.</p>
        <div class="server-down-actions">
          <button type="button" class="btn btn-secondary btn-sm" data-action="check">${icon('refresh', { size: 14 })}<span>Check again</span></button>
        </div>`;
    }
    host.innerHTML = `
      <div class="server-down-head">
        <span class="server-down-icon" aria-hidden="true">${icon('power', { size: 18 })}</span>
        <div><p class="server-down-title">${title}</p>${body}</div>
      </div>`;
  };

  async function refresh() {
    if (destroyed || busy) return false;
    if (await serverIsUp()) {
      hide();
      onUp?.();
      return true;
    }
    const launcher = await probeLauncher();
    if (launcher && (launcher.status === 'starting' || launcher.status === 'running')) {
      // Started elsewhere (terminal, sign-in) and still warming up.
      paint({ launcher, phase: 'starting' });
      follow();
      return false;
    }
    paint({ launcher, phase: 'down', reason: launcher?.status === 'crashed' ? launcher.reason : null });
    schedulePoll();
    return false;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, 5000);
  }

  function hide() {
    clearTimeout(pollTimer);
    host.hidden = true;
    host.innerHTML = '';
  }

  async function follow() {
    busy = true;
    const up = await waitForServer({
      onTick: (status) => { if (status && status.status === 'starting') paint({ launcher: status, phase: 'starting' }); },
    });
    busy = false;
    if (destroyed) return;
    if (up) {
      toast.success('The Vault server is running');
      hide();
      onUp?.();
    } else {
      refresh();
    }
  }

  host.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'copy') {
      if (await copyText(START_COMMAND)) toast.success('Command copied');
      return;
    }
    if (action === 'check') {
      const btn = e.target.closest('button');
      btn.disabled = true;
      const up = await refresh();
      btn.disabled = false;
      if (!up) toast.info('Still not reachable');
      return;
    }
    if (action === 'start') {
      try {
        paint({ phase: 'starting' });
        await startServer();
        follow();
      } catch (err) {
        toast.error(`Couldn’t start the server: ${err.message}`);
        refresh();
      }
    }
  });

  return {
    refresh,
    destroy() {
      destroyed = true;
      clearTimeout(pollTimer);
    },
  };
}

export default { mountServerDown };
