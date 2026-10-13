/**
 * Vault Service Worker — PWA offline shell
 */
// Bump when the shell contract changes so already-installed clients replace
// incompatible module sets. v3 cached api.js forever while detail.js updated
// from the network, producing errors such as "updateAlbumOrder is not a
// function". Shell reads below are now network-first to prevent that mismatch
// from recurring; the version bump repairs clients that already have v3.
const CACHE_NAME = 'vault-v2-shell-v4';
const BASE_PATH = '/Vault-V2';

const SHELL_ASSETS = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/config.js`,
  `${BASE_PATH}/manifest.json`,
  `${BASE_PATH}/favicon.svg`,
  `${BASE_PATH}/css/vault.css`,
  `${BASE_PATH}/css/onboarding.css`,
  `${BASE_PATH}/js/config.js`,
  `${BASE_PATH}/js/api.js`,
  `${BASE_PATH}/js/auth.js`,
  `${BASE_PATH}/js/onboarding.js`,
  `${BASE_PATH}/js/store.js`,
  `${BASE_PATH}/js/router.js`,
  `${BASE_PATH}/js/themes.js`,
  `${BASE_PATH}/js/effects.js`,
  `${BASE_PATH}/js/keyboard.js`,
  `${BASE_PATH}/js/pwa.js`,
  `${BASE_PATH}/js/utils/icons.js`,
];

self.addEventListener('install', (event) => {
  console.log('[SW] Install');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(SHELL_ASSETS.map(url => new Request(url, { cache: 'no-cache' }))).catch(err => {
        console.warn('[SW] Failed to cache shell', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activate');
  event.waitUntil(
    caches.keys().then(keys => {
      // Only retire our old app shells. `vault-offline` contains media the user
      // explicitly downloaded and must survive an application update.
      return Promise.all(keys
        .filter(k => k.startsWith('vault-v2-shell-') && k !== CACHE_NAME)
        .map(k => caches.delete(k)));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skip API requests — network first
  if (url.pathname.includes('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(JSON.stringify({ error: 'Offline — server unreachable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // For navigation requests, serve index.html from cache (SPA)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(`${BASE_PATH}/index.html`) || caches.match(`${BASE_PATH}/`);
      })
    );
    return;
  }

  // Shell modules must move forward as one compatible set. Cache-first kept an
  // old api.js indefinitely while dynamically imported views came from the
  // network; new views then called methods the cached client did not have.
  // Prefer the current deployment and retain the cache strictly as an offline
  // fallback. Successful responses refresh the cached copy for the next load.
  if (SHELL_ASSETS.some(asset => url.pathname.endsWith(asset.replace(BASE_PATH, '')) || url.pathname === asset)) {
    const networkRequest = new Request(event.request, { cache: 'no-cache' });
    event.respondWith(
      fetch(networkRequest).then(async res => {
        if (!res.ok) return (await caches.match(event.request)) || res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Default: network-first, fallback to cache
  event.respondWith(
    fetch(event.request).then(res => {
      // Cache successful GETs for same origin
      if (res.ok && event.request.method === 'GET' && url.origin === self.location.origin) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return res;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});
