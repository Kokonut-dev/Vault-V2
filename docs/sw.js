/**
 * Vault Service Worker — PWA offline shell
 */
// Bump when the shell contract changes so already-installed clients replace
// incompatible module sets. v3 cached api.js forever while detail.js updated
// from the network, producing errors such as "updateAlbumOrder is not a
// function". Shell reads below are now network-first to prevent that mismatch
// from recurring; the version bump repairs clients that already have v3.
// v5: "Hearth" UI revamp — new tokens, fonts, logo and brand module.
// v10: Server page fixes; api.js offers a reload when the server's client build
//      changes (X-Vault-Build).
// v8: new Torrents page + magnet icon (utils/icons.js is in the shell list),
//     folder upload (utils/folderUpload.js), Live TV channel-list groups.
// v7: page transitions (utils/pageTransition.js) are imported by the shell;
//     Settings was split into views/settings/*.
// v6: navigations and ALL same-origin code (not just the shell list) revalidate
// with `cache: 'no-cache'`. GitHub Pages sends max-age=600, so the HTTP cache
// could hand an old index.html or view module to a reload for 10 minutes,
// mixing builds ("does not provide an export named 'THEME_META'").
// v11: 3.0 colour refresh — new theme tokens, favicon and manifest colours.
// v12: profiles — auth.js imports js/profileSession.js (in the shell list).
// v16: the sign-in form opens setup when a fresh server refuses remote sign-in.
// v17: strict CSP — index.html's inline start-up code moved to js/boot-head.js
//      and js/main.js (both in the shell list); media links use media tokens.
// v18: Terms of Use — main.js imports js/components/termsGate.js, and the
//      stand-alone terms.html page is cached so it can be read offline.
// v20: now-playing marks on every page (js/utils/nowPlaying.js) and per-page
//      Grid/List (js/utils/viewMode.js); store.js gained `viewModes`.
const CACHE_NAME = 'vault-v2-shell-v20';
// Media the user saved with "Download for offline" (docs/js/app-extras.js).
const OFFLINE_CACHE = 'vault-offline';
const BASE_PATH = '/Vault-V2';

const SHELL_ASSETS = [
  `${BASE_PATH}/`,
  `${BASE_PATH}/index.html`,
  `${BASE_PATH}/config.js`,
  `${BASE_PATH}/js/boot-head.js`,
  `${BASE_PATH}/js/main.js`,
  `${BASE_PATH}/manifest.json`,
  `${BASE_PATH}/favicon.svg`,
  `${BASE_PATH}/icon-maskable.svg`,
  `${BASE_PATH}/css/vault.css`,
  `${BASE_PATH}/css/fonts.css`,
  `${BASE_PATH}/fonts/figtree-latin-wght-normal.woff2`,
  `${BASE_PATH}/fonts/fraunces-latin-full-normal.woff2`,
  `${BASE_PATH}/css/onboarding.css`,
  `${BASE_PATH}/js/config.js`,
  `${BASE_PATH}/js/api.js`,
  `${BASE_PATH}/js/auth.js`,
  `${BASE_PATH}/js/profileSession.js`,
  `${BASE_PATH}/js/onboarding.js`,
  `${BASE_PATH}/js/store.js`,
  `${BASE_PATH}/js/router.js`,
  `${BASE_PATH}/js/themes.js`,
  `${BASE_PATH}/js/effects.js`,
  `${BASE_PATH}/js/keyboard.js`,
  `${BASE_PATH}/js/pwa.js`,
  `${BASE_PATH}/js/utils/icons.js`,
  `${BASE_PATH}/js/utils/brand.js`,
  `${BASE_PATH}/js/utils/staleModule.js`,
  `${BASE_PATH}/js/utils/pageTransition.js`,
  `${BASE_PATH}/js/utils/imageFallback.js`,
  `${BASE_PATH}/js/components/termsGate.js`,
  `${BASE_PATH}/terms.html`,
  `${BASE_PATH}/css/legal.css`,
  `${BASE_PATH}/js/legal-page.js`,
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
    // A stream the user saved for offline (Downloads) is cached under its
    // address without the query string: the ?token= media link rotates, so the
    // saved copy must be found by path alone.
    const isStream = event.request.method === 'GET' && url.pathname.includes('/api/media/stream/');
    event.respondWith(
      fetch(event.request).catch(async () => {
        if (isStream) {
          const saved = await caches.open(OFFLINE_CACHE).then(cache => cache.match(url.origin + url.pathname));
          if (saved) return saved;
        }
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
    // A navigate-mode Request can't be cloned with init options, so build a
    // plain same-origin GET that revalidates against the server.
    const fresh = new Request(event.request.url, { cache: 'no-cache', credentials: 'same-origin' });
    event.respondWith(
      fetch(fresh).catch(() => {
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

  // Any other same-origin code (lazily imported views, components, CSS) must
  // come from the same deployment as the shell, so revalidate it too.
  const isCode = /\.(?:m?js|css|json|html)$/i.test(url.pathname);
  const isSameOriginGet = url.origin === self.location.origin && event.request.method === 'GET';
  const request = isCode && isSameOriginGet
    ? new Request(event.request, { cache: 'no-cache' })
    : event.request;

  // Default: network-first, fallback to cache
  event.respondWith(
    fetch(request).then(res => {
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
