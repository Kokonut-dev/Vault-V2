/**
 * PWA — Service Worker registration
 */
import { toast } from './components/toast.js';

// QoL: surface vault:update-available (fired above) — a sticky toast with a
// Refresh action; the waiting worker activates on reload (sw.js skipWaiting).
window.addEventListener('vault:update-available', () => {
  const t = toast.show('A new version of Vault is ready.', {
    title: 'Update available',
    type: 'info',
    duration: 0,
  });
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary btn-sm';
  btn.style.cssText = 'margin-top:10px;';
  btn.textContent = 'Refresh';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    window.location.reload();
  });
  t.querySelector('.toast-content')?.appendChild(btn);
});

export function initPWA() {
  initInstallPrompt();

  if (!('serviceWorker' in navigator)) {
    console.warn('[PWA] Service Worker not supported');
    return;
  }

  const isGitHubPages = window.location.hostname.includes('github.io');

  window.addEventListener('load', async () => {
    try {
      // Local server: unregister any SW so it cannot intercept SPA navigations
      // with the GitHub Pages /Vault-V2 cache paths.
      if (!isGitHubPages) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
        return;
      }
      const basePath = window.VAULT_CONFIG?.basePath || '/Vault-V2';
      const swPath = `${basePath}/sw.js`;
      // Never let the HTTP cache hide a changed worker script. The worker then
      // fetches JS/CSS network-first, keeping api.js and dynamically imported
      // views on the same deployment instead of mixing incompatible versions.
      const reg = await navigator.serviceWorker.register(swPath, { updateViaCache: 'none' });
      let updateAnnounced = false;
      const announceUpdate = () => {
        if (updateAnnounced || !navigator.serviceWorker.controller) return;
        updateAnnounced = true;
        window.dispatchEvent(new CustomEvent('vault:update-available'));
      };
      const watchInstalling = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed') announceUpdate();
        });
      };

      reg.addEventListener('updatefound', () => watchInstalling(reg.installing));
      // updatefound can fire while register() itself is resolving.
      watchInstalling(reg.installing);
      if (reg.waiting) announceUpdate();
      // Explicitly check on every app load rather than waiting for the
      // browser's periodic service-worker update window. Registration still
      // remains usable if a browser rejects a redundant in-progress check.
      try {
        await reg.update();
      } catch (err) {
        console.warn('[PWA] Update check failed:', err.message);
      }
    } catch (err) {
      console.warn('[PWA] Service Worker registration failed:', err.message);
    }
  });

  // Handle online/offline
  window.addEventListener('online', () => {
    window.dispatchEvent(new CustomEvent('vault:online'));
  });

  window.addEventListener('offline', () => {
    window.dispatchEvent(new CustomEvent('vault:offline'));
  });
}

/**
 * Install-to-home-screen support. The browser fires `beforeinstallprompt`
 * once; we keep the event so the UI (Settings → Devices) can offer a button
 * and call `window.vaultInstall.prompt()` on demand.
 */
export function initInstallPrompt() {
  let deferredPrompt = null;

  const api = {
    available: () => Boolean(deferredPrompt),
    /** Resolve true when the user accepted, false otherwise/unavailable. */
    async prompt() {
      if (!deferredPrompt) return false;
      const event = deferredPrompt;
      deferredPrompt = null;
      window.dispatchEvent(new CustomEvent('vault:install-state'));
      event.prompt();
      const { outcome } = await event.userChoice;
      return outcome === 'accepted';
    },
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('vault:install-state'));
  });

  window.vaultInstall = api;
  return api;
}
