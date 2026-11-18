/**
 * Start the Vault server from the app.
 *
 * A web page can't run programs, so this talks to the small Vault launcher
 * (`server/launcher.js`, started by `npm start` or at sign-in) on
 * http://127.0.0.1:4001. The launcher only listens on this computer, so the
 * Start button is offered only when the server address points here too —
 * probing it from a phone would just fail (and newer Chrome versions would
 * ask for local-network permission for nothing).
 */
import { getApiBaseUrl } from '../config.js';

const DEFAULT_PORT = 4001;

export function launcherPort() {
  return Number(localStorage.getItem('vault_launcher_port')) || DEFAULT_PORT;
}

/** Loopback server address → the launcher (if any) is on this machine. */
export function serverIsOnThisDevice(base = getApiBaseUrl()) {
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host)
      || (host === location.hostname && /^(localhost|127\.|::1)/.test(location.hostname));
  } catch {
    return false;
  }
}

async function launcherFetch(path, { method = 'GET', timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${launcherPort()}${path}`, {
      method,
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Launcher answered ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Launcher status, or null when there is none on this computer. */
export async function probeLauncher() {
  if (!serverIsOnThisDevice()) return null;
  try {
    const data = await launcherFetch('/launcher/status');
    return data?.launcher ? data : null;
  } catch {
    return null;
  }
}

export async function startServer() {
  return launcherFetch('/launcher/start', { method: 'POST', timeoutMs: 4000 });
}

/** Is the Vault server answering right now? */
export async function serverIsUp({ timeoutMs = 2500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/health`, { signal: controller.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll until the server answers (resolves true) or gives up (false).
 * `onTick(launcherStatus)` reports progress, e.g. a crash reason.
 */
export async function waitForServer({ timeoutMs = 120000, onTick, signal } = {}) {
  const started = Date.now();
  let limit = timeoutMs;
  while (Date.now() - started < limit) {
    if (signal?.aborted) return false;
    // eslint-disable-next-line no-await-in-loop
    if (await serverIsUp()) return true;
    // eslint-disable-next-line no-await-in-loop
    const status = await probeLauncher();
    onTick?.(status);
    if (status?.status === 'crashed' || status?.status === 'stopped') return false;
    // A first-run `npm install` on a slow connection can outlast the usual wait.
    if (status?.installing) limit = Math.max(limit, Date.now() - started + 10 * 60 * 1000);
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/** Wait for the server to go away (after Stop/Restart). */
export async function waitForServerDown({ timeoutMs = 20000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await serverIsUp({ timeoutMs: 1200 }))) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export const START_COMMAND = 'cd Vault-V2/server && npm start';

export default { probeLauncher, startServer, serverIsUp, waitForServer, waitForServerDown, serverIsOnThisDevice };
