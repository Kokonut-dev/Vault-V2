/**
 * PWA — Service Worker registration
 */

export function initPWA() {
  if (!('serviceWorker' in navigator)) {
    console.log('[PWA] Service Worker not supported');
    return;
  }

  const basePath = window.VAULT_CONFIG?.basePath || '';
  const swPath = `${basePath}/sw.js`;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register(swPath);
      console.log('[PWA] Service Worker registered:', reg.scope);

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version available
            window.dispatchEvent(new CustomEvent('vault:update-available'));
            console.log('[PWA] New version available');
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
