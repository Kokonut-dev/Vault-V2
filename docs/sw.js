/**
 * Vault Service Worker — PWA offline shell
 */
const CACHE_NAME = 'vault-v2-shell-v2';
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
      return Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
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

  // For shell assets, cache-first
  if (SHELL_ASSETS.some(asset => url.pathname.endsWith(asset.replace(BASE_PATH, '')) || url.pathname === asset)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        });
      })
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
