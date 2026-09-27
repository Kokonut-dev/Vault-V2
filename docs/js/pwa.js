/**
 * PWA — Service Worker registration
 */

export function initPWA() {
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
      const reg = await navigator.serviceWorker.register(swPath);

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available — UI listens for this event
            window.dispatchEvent(new CustomEvent('vault:update-available'));
          }
        });
      });
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

export function showInstallPrompt() {
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    window.dispatchEvent(new CustomEvent('vault:install-prompt', { detail: { prompt: e } }));
  });

  return {
    prompt: async () => {
      if (!deferredPrompt) return false;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
      return outcome === 'accepted';
    }
  };
}
