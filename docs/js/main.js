/**
 * App start-up: sign-in gate, onboarding, router and the app shell. Was an
 * inline module in index.html; external so the Content-Security-Policy can
 * forbid inline scripts. Loaded with <script type="module" src="./js/main.js">.
 */
import { getApiBaseUrl, setApiBaseUrl, getBasePath } from './config.js';
import { store } from './store.js';
import { api } from './api.js';
import { authManager } from './auth.js';
import { lastProfileId, hydrateProfileData } from './profileSession.js';
import { themeManager } from './themes.js';
import { initEffects } from './effects.js';
import { keyboardManager } from './keyboard.js';
import { initPWA } from './pwa.js';
import { router } from './router.js';
import { toast } from './components/toast.js';
import { renderSidebar } from './components/sidebar.js';
import { searchModal } from './components/searchModal.js';
import { runViewCleanups } from './utils/lifecycle.js';
import { swapView } from './utils/pageTransition.js';
import { icon, hydrateIcons } from './utils/icons.js';
import { installImageFallbacks, activateAsyncStylesheets } from './utils/imageFallback.js';
import { ensureTermsAccepted, termsGateOpen, prefetchTermsStatus } from './components/termsGate.js';
import { mountAccountForms, takeResetLink } from './components/accountForms.js';
import { HOME_MODULES, APP_MODULES } from './utils/preloadGraph.js';

// No inline event handlers (CSP): image fallbacks and the async onboarding
// stylesheet are wired up here, before any view renders.
installImageFallbacks();
activateAsyncStylesheets();

// Onboarding is lazy-loaded: the 35KB wizard module is only fetched when
// the setup gate actually needs it (cold start no longer blocks on it).
let onboardingManager = null;
async function loadOnboardingModule() {
  if (!onboardingManager) {
    const mod = await import('./onboarding.js');
    onboardingManager = mod.onboardingManager;
  }
  return onboardingManager;
}

// The players, shortcuts panel and v3 extras every signed-in session starts
// (initApp). One shared load, started as soon as initApp() begins (before
// the media token and the library are back); a failed load is retried next time.
let appModulesLoad = null;
function loadAppModules() {
  appModulesLoad ||= Promise.all([
    import('./components/audioPlayer.js'),
    import('./components/videoPlayer.js'),
    import('./components/miniPlayer.js'),
    import('./components/shortcutsPanel.js'),
    import('./app-extras.js'),
  ]).catch((err) => { appModulesLoad = null; throw err; });
  return appModulesLoad;
}

/**
 * <link rel="modulepreload"> for every module in `paths` (relative to js/):
 * the whole graph downloads in one parallel wave instead of one round trip
 * per import level. import.meta.resolve applies the server's import map, so
 * the URLs are the same module-map entries the imports will ask for.
 */
function preloadModules(paths) {
  for (const rel of paths) {
    let href;
    try {
      href = typeof import.meta.resolve === 'function' ? import.meta.resolve(rel) : new URL(rel, import.meta.url).href;
    } catch {
      continue;
    }
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = href;
    document.head.appendChild(link);
  }
}

/** Is the page being opened on Home (the router's '/' route)? */
function openingOnHome() {
  try {
    if (sessionStorage.getItem('vault_redirect')) return false;
    const raw = location.hash.startsWith('#/')
      ? location.hash.slice(1)
      : location.pathname.slice(location.pathname.startsWith(getBasePath()) ? getBasePath().length : 0);
    return router.normalizePath(router.stripFragment(raw || '/')) === '/';
  } catch {
    return false;
  }
}

// A session check started by start() alongside the setup check (see
// warmSignedInStart); checkAuth() takes it instead of asking again.
let pendingVerify = null;

/**
 * This device has a saved session: everything opening the app needs is
 * asked for at once instead of one round trip after another — the session
 * check, the Terms of Use status and the media token go out together with
 * the setup check, and Home's code downloads and compiles meanwhile. An expired token just fails these early, which is
 * what checkAuth() would have found out a moment later.
 */
function warmSignedInStart() {
  pendingVerify = authManager.verify();
  prefetchTermsStatus();
  api.ensureMediaToken().catch(() => {});
  // Home's code too: it is what the person sees first. The players and
  // extras wait for initApp(), so they don't queue ahead of these requests
  // (a browser opens only ~6 connections to one HTTP/1.1 server).
  if (openingOnHome()) {
    preloadModules(HOME_MODULES);
    import('./views/home.js').catch(() => {});
  }
}

// Inline the icon set into every [data-icon] slot in this document
// (docs/js/utils/icons.js) — the app shell is still hidden behind the auth
// gate at this point, so there is no flash of empty buttons.
hydrateIcons();

// Initialize
const serverUrlDisplay = document.getElementById('server-url-display');
const changeServerBtn = document.getElementById('change-server-btn');

function updateServerDisplay() {
  if (serverUrlDisplay) serverUrlDisplay.textContent = getApiBaseUrl();
}
updateServerDisplay();

if (changeServerBtn) {
  changeServerBtn.addEventListener('click', () => {
    const current = getApiBaseUrl();
    const newUrl = prompt('Enter Vault server URL (e.g., http://localhost:4000 or https://your-tunnel.trycloudflare.com)', current);
    if (newUrl && newUrl.trim()) {
      setApiBaseUrl(newUrl.trim());
      updateServerDisplay();
      updateMixedContentWarning();
// A reset link for another server switched the server address.
window.addEventListener('vault:server-changed', () => {
  updateServerDisplay();
  updateMixedContentWarning();
});
      toast.info(`Server URL set to ${newUrl.trim()}. Please login again.`);
    }
  });
}

// Warn on the login screen when the configured server URL is one the
// browser will actually block from this HTTPS page (non-loopback HTTP).
// http://localhost / http://127.0.0.1 are allowed by browsers, so no warning.
function updateMixedContentWarning() {
  const box = document.getElementById('mixed-content-warning');
  if (!box) return;
  const base = getApiBaseUrl();
  if (api.isMixedContent(base)) {
    box.innerHTML = `
      <strong>${icon('alert-triangle', { size: 16, className: 'icon icon-inline' })} This server URL will be blocked.</strong> Browsers block HTTP media on HTTPS pages
      (only <code>localhost</code> is allowed).<br>
      Fixes: use <code>http://localhost:4000</code> if Vault runs on this computer,
      or give the server HTTPS (<code>npm run generate-cert</code> in <code>server/</code>,
      enable <code>server.https</code> in config.json), or use an HTTPS tunnel
      (<code>cloudflared tunnel --url http://localhost:4000</code>).
    `;
    box.style.display = 'block';
  } else {
    box.style.display = 'none';
  }
}
updateMixedContentWarning();

// "Server isn't running" card with a Start button (Vault launcher).
let serverDownCard = null;
async function checkServerOnGate() {
  const host = document.getElementById('server-down');
  if (!host) return;
  try {
    if (!serverDownCard) {
      const { mountServerDown } = await import('./components/serverDown.js');
      serverDownCard = mountServerDown(host, {
        onUp: () => { if (localStorage.getItem('vault_token')) checkAuth(); },
      });
    }
    await serverDownCard.refresh();
  } catch (err) {
    console.warn('Server status card failed:', err.message);
  }
}

// Auth Gate Logic
const authGate = document.getElementById('auth-gate');
const appEl = document.getElementById('app');
const onboardingHost = document.getElementById('onboarding-host');
const loginStep = document.getElementById('login-step');
const gridStep = document.getElementById('grid-step');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const gridContainer = document.getElementById('grid-container');
const gridError = document.getElementById('grid-error');
const gridCount = document.getElementById('grid-count');
const gridClear = document.getElementById('grid-clear');
const gridSubmit = document.getElementById('grid-submit');

let selectedSquares = [];

// --- Sign-in screen steps: password, grid, and the account forms ----------
// (components/accountForms.js builds "Create a new account", "Forgot
// password?" and the page a reset link opens.)
function showStep(name) {
  const target = document.getElementById(`${name}-step`);
  if (!target) return;
  authGate?.querySelectorAll('.auth-step').forEach(step => step.classList.toggle('active', step === target));
  if (name === 'login') {
    if (loginError) loginError.style.display = 'none';
    document.getElementById('username')?.focus();
  }
}

let accountForms = null;
function getAccountForms() {
  if (!accountForms) {
    accountForms = mountAccountForms(authGate.querySelector('.auth-container'), {
      showStep,
      onSignedIn: (result) => {
        toast.success(`Welcome, ${result.profile?.name || result.user?.username || 'to Vault'}! Your account is ready.`);
        showStep('login');
        showApp();
      },
      onResetDone: (username) => {
        // Every device of the account was signed out, this one included.
        api.clearTokenCache();
        store.clearAuth();
        try { localStorage.removeItem('vault_token'); } catch { /* private mode */ }
        showAuthGate();
        const user = document.getElementById('username');
        if (user && username) user.value = username;
        toast.success('Password and grid changed. Sign in with them now.');
        document.getElementById(username ? 'password' : 'username')?.focus();
      },
    });
  }
  return accountForms;
}

/** "Create a new account" only shows when the server allows it. */
function updateSignupOffer(status) {
  const offer = document.getElementById('signup-offer');
  if (offer) offer.hidden = !status?.signup;
}

async function refreshSignupOffer() {
  try {
    updateSignupOffer(await api.getSetupStatus());
  } catch {
    updateSignupOffer(null);
  }
}

document.getElementById('forgot-link')?.addEventListener('click', () => {
  getAccountForms().openForgot(document.getElementById('username')?.value.trim() || '');
});
document.getElementById('signup-link')?.addEventListener('click', () => {
  getAccountForms().openRegister();
});

function initGrid() {
  if (!gridContainer) return;
  gridContainer.innerHTML = '';
  selectedSquares = [];
  for (let i = 0; i < 16; i++) {
    const sq = document.createElement('div');
    sq.className = 'grid-square';
    sq.dataset.index = i;
    sq.textContent = i;
    sq.setAttribute('role', 'button');
    sq.setAttribute('aria-label', `Grid square ${i}`);
    sq.setAttribute('tabindex', '0');
    sq.addEventListener('click', () => toggleSquare(i));
    sq.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSquare(i);
      }
    });
    gridContainer.appendChild(sq);
  }
  updateGridUI();
}

function toggleSquare(index) {
  const idx = selectedSquares.indexOf(index);
  if (idx >= 0) {
    selectedSquares.splice(idx, 1);
  } else {
    if (selectedSquares.length >= 8) {
      toast.info('You can only select 8 squares');
      return;
    }
    selectedSquares.push(index);
  }
  updateGridUI();
}

function updateGridUI() {
  if (!gridContainer) return;
  gridContainer.querySelectorAll('.grid-square').forEach(el => {
    const i = parseInt(el.dataset.index, 10);
    const selected = selectedSquares.includes(i);
    el.classList.toggle('selected', selected);
    el.setAttribute('aria-pressed', String(selected));
  });
  if (gridCount) gridCount.textContent = `${selectedSquares.length} / 8 selected`;
  if (gridSubmit) gridSubmit.disabled = selectedSquares.length !== 8;
}

if (gridClear) {
  gridClear.addEventListener('click', () => {
    selectedSquares = [];
    updateGridUI();
  });
}

/**
 * Submit the grid, asking for a profile PIN when the server needs one.
 * Cancelling the PIN for the device's last profile signs in as a profile
 * without a PIN instead (the server picks it).
 */
async function submitGridWithProfile(pattern) {
  let options = {};
  let result = await authManager.submitGrid(pattern, options);
  for (let tries = 0; !result.success && result.code === 'PROFILE_PIN_REQUIRED' && tries < 5; tries++) {
    // promptModal escapes the title (the profile name) itself.
    const { promptModal } = await import('./components/modal.js');
    document.body.classList.add('auth-prompt-open');
    const pin = await promptModal({
      title: `PIN for ${result.profile?.name || 'this profile'}`,
      message: options.profilePin ? 'That PIN isn’t right. Try again.' : 'This profile is protected with a PIN.',
      label: 'PIN',
      inputType: 'password',
      inputMode: 'numeric',
      confirmLabel: 'Sign in',
    }).finally(() => document.body.classList.remove('auth-prompt-open'));
    if (pin === null) {
      if (result.askedFor) {
        options = { profileId: null };
        result = await authManager.submitGrid(pattern, options);
        continue;
      }
      return { success: false, code: 'PROFILE_PIN_CANCELLED', error: 'Sign-in needs the profile PIN.' };
    }
    options = { profileId: result.profile?.id || options.profileId || null, profilePin: pin };
    result = await authManager.submitGrid(pattern, options);
  }
  return result;
}

if (gridSubmit) {
  gridSubmit.addEventListener('click', async () => {
    if (selectedSquares.length !== 8) return;
    gridSubmit.disabled = true;
    gridSubmit.textContent = 'Verifying...';
    if (gridError) gridError.style.display = 'none';

    const hadProfile = !!lastProfileId();
    const result = await submitGridWithProfile(selectedSquares.slice());

    if (result.success) {
      toast.success(result.profile?.name ? `Welcome, ${result.profile.name}` : 'Welcome to Vault!');
      showApp();
      // First sign-in on this device with several profiles: ask who's
      // watching instead of silently using the owner's profile.
      if (!hadProfile && result.profileCount > 1) router.navigate('/profiles', true);
    } else if (result.code === 'PROFILE_PIN_CANCELLED') {
      if (gridError) {
        gridError.textContent = result.error;
        gridError.style.display = 'block';
      }
    } else if (result.code === 'INVALID_CHALLENGE' || result.code === 'NO_CHALLENGE') {
      // The 5-minute challenge window expired (or was lost) — this is NOT a
      // wrong pattern. Send the user back to the password step instead of
      // leaving them stuck on a dead grid.
      if (gridStep) gridStep.classList.remove('active');
      if (loginStep) loginStep.classList.add('active');
      if (loginError) {
        loginError.textContent = 'Your login session expired — please enter your password again.';
        loginError.style.display = 'block';
      }
      selectedSquares = [];
      updateGridUI();
    } else {
      if (gridError) {
        gridError.textContent = result.error;
        gridError.style.display = 'block';
      }
      selectedSquares = [];
      updateGridUI();
      // Shake animation
      if (gridContainer) {
        gridContainer.style.animation = 'shake 0.4s ease-out';
        setTimeout(() => gridContainer.style.animation = '', 400);
      }
    }

    gridSubmit.disabled = false;
    gridSubmit.textContent = 'Unlock Vault';
  });
}

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    const btn = document.getElementById('login-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking...';
    }
    if (loginError) loginError.style.display = 'none';

    const result = await authManager.login(username, password);

    if (result.success) {
      if (loginStep) loginStep.classList.remove('active');
      if (gridStep) gridStep.classList.add('active');
      initGrid();
    } else {
      if (loginError) {
        loginError.textContent = result.error;
        loginError.style.display = 'block';
      }
      if (/connect|fetch|network/i.test(result.error || '')) checkServerOnGate();
      // This server hasn't been set up yet and refuses sign-in from other
      // devices until it is: go to the setup wizard (it asks for the code).
      if (result.code === 'SETUP_REQUIRED') showOnboarding();
    }

    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Continue';
    }
  });
}

async function checkAuth() {
  const verifying = pendingVerify;
  pendingVerify = null;
  const token = localStorage.getItem('vault_token');
  if (!token) {
    if (authGate) authGate.style.display = 'flex';
    if (appEl) appEl.style.display = 'none';
    checkServerOnGate();
    refreshSignupOffer();
    return false;
  }

  try {
    const res = await (verifying || authManager.verify());
    if (res.valid) {
      showApp();
      return true;
    }
  } catch {}

  if (authGate) authGate.style.display = 'flex';
  if (appEl) appEl.style.display = 'none';
  checkServerOnGate();
  refreshSignupOffer();
  return false;
}

let appReady = false;

async function showApp() {
  if (authGate) authGate.style.display = 'none';
  // Hide onboarding if still present
  const obGate = document.getElementById('onboarding-gate');
  if (obGate) obGate.remove();
  // Terms of Use first: nobody gets into the app without accepting the
  // current version (the server refuses everything else until then too).
  if (!(await passTermsGate())) return;
  if (appEl) appEl.style.display = 'flex';
  initApp();
}

/** Show the Terms of Use if this profile hasn't accepted them. False = declined. */
async function passTermsGate() {
  let accepted = false;
  try {
    accepted = await ensureTermsAccepted();
  } catch (err) {
    toast.error(err.message);
  }
  if (!accepted) await declineTerms();
  return accepted;
}

/** Declined (or can't be shown): sign this device out, back to the sign-in screen. */
async function declineTerms() {
  try { await api.logout(); } catch { /* signed out locally either way */ }
  api.clearTokenCache();
  store.clearAuth();
  if (appEl) appEl.style.display = 'none';
  showAuthGate();
  toast.info('You need to accept the Terms of Use to use Vault.');
}

// The server asks for the terms (another profile, or the terms were updated
// while the app was open). After accepting, reload so every view refetches.
window.addEventListener('vault:terms-required', async () => {
  if (termsGateOpen()) return;
  const accepted = await passTermsGate();
  if (accepted && appReady) window.location.reload();
});

function showAuthGate() {
  if (authGate) authGate.style.display = 'flex';
  if (appEl) appEl.style.display = 'none';
  const obGate = document.getElementById('onboarding-gate');
  if (obGate) obGate.remove();
  if (loginStep) showStep('login');
  refreshSignupOffer();
}

async function showOnboarding() {
  if (authGate) authGate.style.display = 'none';
  if (appEl) appEl.style.display = 'none';
  if (onboardingHost) {
    try {
      const manager = await loadOnboardingModule();
      manager.render(onboardingHost);
    } catch (err) {
      console.warn('Failed to load onboarding wizard:', err.message);
      // Never trap the user: fall back to the normal auth check.
      checkAuth();
    }
  }
}

async function initApp() {
  // The library and the app's modules don't wait for the media token below:
  // all three go out at once (they used to be one round trip after another).
  const firstInit = !appReady;
  const libraryLoad = firstInit ? api.getLibrary({ limit: 1000 }) : null;
  libraryLoad?.catch(() => { /* reported below */ });
  // Favourites, history and resume points are per profile on the server;
  // the device cache must not show another profile's. Fetched alongside the
  // library so Home draws once with all of it.
  if (firstInit) hydrateProfileData(store.get('profileId') || 'default').catch(err => console.warn('Profile data:', err.message));
  if (firstInit) {
    preloadModules(APP_MODULES);
    loadAppModules().catch(() => { /* reported below */ });
  }
  // Media links (covers, streams, subtitles, live events) carry a
  // read-only media token, never the sign-in token: get one for this
  // session before the first view builds its image and video URLs.
  await api.ensureMediaToken().catch(() => {});
  api.startMediaTokenRefresh();
  if (appReady) {
    router.handleRoute();
    return;
  }
  appReady = true;

  // Theme
  themeManager.init();
  initEffects();
  keyboardManager.init();
  initPWA();

  // Sidebar
  renderSidebar(document.getElementById('sidebar-container'));

  // Search
  searchModal.init();

  // Router
  setupRoutes();
  router.init();

  // Load library
  try {
    const data = await libraryLoad;
    store.setLibrary(data.items || []);
  } catch (err) {
    console.warn('Failed to load library:', err.message);
    if (err.message.includes('Cannot connect')) {
      toast.error(err.message);
      const connStatus = document.getElementById('connection-status');
      if (connStatus) connStatus.style.display = 'block';
      // Deferred: the banner's listeners are attached further down initApp().
      setTimeout(() => window.dispatchEvent(new CustomEvent('vault:server-down', { detail: { message: 'Can’t reach the Vault server' } })), 0);
    }
  }

  // Mobile menu
  const mobileBtn = document.getElementById('mobile-menu-btn');
  const syncMobileBtn = () => {
    if (!mobileBtn) return;
    mobileBtn.style.display = window.innerWidth <= 1024 ? 'flex' : 'none';
  };
  if (mobileBtn) {
    syncMobileBtn();
    mobileBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:toggle-sidebar'));
    });
    window.addEventListener('resize', syncMobileBtn);
  }

  const ROUTE_TITLES = {
    '/': 'Home',
    '/home': 'Home',
    '/movies': 'Movies & Series',
    '/music': 'Music',
    '/artists': 'Artists',
    '/videos': 'Videos',
    '/playlists': 'Playlists',
    '/favourites': 'Favourites',
    '/liked': 'Liked Songs',
    '/history': 'History',
    '/upload': 'Upload',
    '/torrents': 'Torrents',
    '/settings': 'Settings',
  };
  window.addEventListener('vault:route-changed', (e) => {
    const el = document.getElementById('breadcrumb');
    if (!el) return;
    const path = e.detail?.path || '/';
    // C-15: on top-level pages the header title repeats the page H1, so it
    // stays hidden until the H1 scrolls away (iOS "large title" pattern).
    const isRoot = !!ROUTE_TITLES[path];
    el.classList.toggle('is-root', isRoot);
    if (isRoot) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
    if (ROUTE_TITLES[path]) {
      el.textContent = ROUTE_TITLES[path];
    } else if (path.startsWith('/watch') || path.startsWith('/movie') || path.startsWith('/album')) {
      // QoL2: section › title breadcrumb (falls back to 'Details' when the
      // item isn't in the loaded library yet, e.g. cold deep-links)
      const id = decodeURIComponent(path.split('/').pop());
      const item = (store.get('library') || []).find(i => String(i.id) === String(id));
      const section = path.startsWith('/movie') ? 'Movies' : path.startsWith('/album') ? 'Albums' : 'Videos';
      const sectionRoute = path.startsWith('/movie') ? '/movies' : path.startsWith('/album') ? '/music' : '/videos';
      const label = item ? (path.startsWith('/album') ? (item.album || item.title) : item.title) : '';
      if (label) {
        const link = document.createElement('a');
        link.className = 'breadcrumb-link';
        link.setAttribute('data-route', sectionRoute);
        link.href = sectionRoute;
        link.textContent = section;
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        const current = document.createElement('span');
        current.className = 'breadcrumb-current';
        current.textContent = label;
        current.title = label;
        el.replaceChildren(link, sep, current);
      } else {
        el.textContent = 'Details';
      }
    } else if (path.startsWith('/artist/')) {
      let name = path.slice('/artist/'.length);
      try { name = decodeURIComponent(name); } catch { /* already decoded */ }
      const link = document.createElement('a');
      link.className = 'breadcrumb-link';
      link.setAttribute('data-route', '/artists');
      link.href = '/artists';
      link.textContent = 'Artists';
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      const current = document.createElement('span');
      current.className = 'breadcrumb-current';
      current.textContent = name;
      current.title = name;
      el.replaceChildren(link, sep, current);
    } else {
      el.textContent = 'Vault';
    }
  });

  // QoL4: back-to-top — appears on long scrolls, respects reduced motion
  const backToTop = document.getElementById('back-to-top');
  if (backToTop) {
    let bttFrame = 0;
    window.addEventListener('scroll', () => {
      if (bttFrame) return;
      bttFrame = requestAnimationFrame(() => {
        backToTop.classList.toggle('visible', window.scrollY > 600);
        document.body.classList.toggle('is-scrolled', window.scrollY > 96);
        bttFrame = 0;
      });
    }, { passive: true });
    backToTop.addEventListener('click', () => {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });
  }

  window.addEventListener('vault:open-detail', (e) => {
    const item = e.detail?.item;
    if (!item) return;
    const prefix = item.type === 'music' ? '/album' : item.type === 'movie' ? '/movie' : '/watch';
    router.navigate(`${prefix}/${item.id}`);
  });

  // Header actions
  const searchTrigger = document.getElementById('search-trigger');
  if (searchTrigger) {
    searchTrigger.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:open-search'));
    });
  }

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      themeManager.toggleTheme();
    });
  }

  document.getElementById('share-device-btn')?.addEventListener('click', async () => {
    const { openShareDevice } = await import('./components/shareDevice.js');
    openShareDevice();
  });
  const shortcutsBtn = document.getElementById('shortcuts-btn');
  if (shortcutsBtn) {
    shortcutsBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:show-shortcuts'));
    });
  }

  // Logout
  window.addEventListener('vault:logout', async () => {
    await authManager.logout();
  });

  // Auth required
  window.addEventListener('vault:auth-required', () => {
    showAuthGate();
  });

  // Connection status
  window.addEventListener('vault:online', () => {
    const connStatus = document.getElementById('connection-status');
    if (connStatus) connStatus.style.display = 'none';
    toast.success('Back online');
  });
  window.addEventListener('vault:offline', () => {
    const connStatus = document.getElementById('connection-status');
    if (connStatus) connStatus.style.display = 'block';
    offerBannerStart();
  });
  window.addEventListener('vault:server-down', (e) => {
    const connStatus = document.getElementById('connection-status');
    const text = document.getElementById('connection-status-text');
    if (text) text.textContent = e.detail?.message || 'The Vault server is not running';
    if (connStatus) connStatus.style.display = 'block';
    offerBannerStart();
  });
  const startBannerBtn = document.getElementById('start-server-banner');
  async function offerBannerStart() {
    if (!startBannerBtn) return;
    const { probeLauncher } = await import('./utils/serverLauncher.js');
    const launcher = await probeLauncher();
    startBannerBtn.hidden = !launcher || launcher.status === 'running';
  }
  async function onServerBack() {
    const connStatus = document.getElementById('connection-status');
    if (connStatus) connStatus.style.display = 'none';
    const text = document.getElementById('connection-status-text');
    if (text) text.textContent = 'Server disconnected — retrying...';
    try {
      const data = await api.getLibrary({ limit: 1000 });
      store.setLibrary(data.items || []);
      hydrateProfileData(store.get('profileId') || 'default').catch(() => {});
    } catch { /* the banner logic will retry */ }
    window.dispatchEvent(new CustomEvent('vault:server-up'));
  }
  // A Start button elsewhere (Settings → Connection) brought it back.
  window.addEventListener('vault:server-back', () => onServerBack());
  startBannerBtn?.addEventListener('click', async () => {
    const { startServer, waitForServer } = await import('./utils/serverLauncher.js');
    startBannerBtn.disabled = true;
    const label = startBannerBtn.querySelector('span:last-child');
    if (label) label.textContent = 'Starting…';
    try {
      await startServer();
      if (await waitForServer()) {
        toast.success('The Vault server is running');
        onServerBack();
      } else {
        toast.error('The server didn’t start — see Settings → Connection for details');
      }
    } catch (err) {
      toast.error(`Couldn’t start the server: ${err.message}`);
    } finally {
      startBannerBtn.disabled = false;
      if (label) label.textContent = 'Start server';
    }
  });
  const retryBtn = document.getElementById('retry-connection');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      try {
        await api.health();
        toast.success('Server connected');
        onServerBack();
      } catch (err) {
        toast.error('Still cannot connect to server');
      }
    });
  }

  // Init players and the shortcuts panel (already loading since start()).
  const [
    { initAudioPlayer }, { initVideoPlayer }, { initMiniPlayer },
    { initShortcutsPanel }, { initAppExtras },
  ] = await loadAppModules();
  initAudioPlayer();
  initVideoPlayer();
  initMiniPlayer();
  initShortcutsPanel();

  // v3 client layer: live SSE updates, Up Next queue, synced lyrics,
  // context menus, multi-select, gestures, bottom nav, ambient artwork,
  // SyncPlay follower, sleep timer, offline downloads.
  initAppExtras();
}

function setupRoutes() {
  const viewContainer = document.getElementById('view-container');

  // Every view swap goes through swapView (SR-15 page transitions): it
  // plays a short exit, renders, and starts the entrance without waiting
  // on the view's data. Cleanups still run right before the DOM is wiped.
  const swap = (nav, paint) => swapView(viewContainer, () => {
    // Detach the previous view's store subscriptions before wiping its DOM
    // (F-4: listeners used to accumulate on every navigation).
    runViewCleanups();
    viewContainer.innerHTML = '';
    return paint();
  }, { path: nav?.path, nav });

  const mount = (render) => async (params, nav) => {
    if (nav && !nav.isCurrent()) return;
    await swap(nav, () => render(viewContainer, params));
  };

  router.addRoute('/', async (params, nav) => {
    const { renderHome } = await import('./views/home.js');
    return mount(renderHome)(params, nav);
  });

  router.addRoute('/home', async (params, nav) => {
    const { renderHome } = await import('./views/home.js');
    return mount(renderHome)(params, nav);
  });

  router.addRoute('/movies', async (params, nav) => {
    const { renderMovies } = await import('./views/movies.js');
    return mount(renderMovies)(params, nav);
  });

  router.addRoute('/music', async (params, nav) => {
    const { renderMusic } = await import('./views/music.js');
    return mount(renderMusic)(params, nav);
  });

  router.addRoute('/videos', async (params, nav) => {
    const { renderVideos } = await import('./views/videos.js');
    return mount(renderVideos)(params, nav);
  });

  router.addRoute('/playlists', async (params, nav) => {
    const { renderPlaylists } = await import('./views/playlists.js');
    return mount(renderPlaylists)(params, nav);
  });

  router.addRoute('/liked', async (params, nav) => {
    const { renderLiked } = await import('./views/liked.js');
    return mount(renderLiked)(params, nav);
  });

  router.addRoute('/favourites', async (params, nav) => {
    const { renderFavourites } = await import('./views/favourites.js');
    return mount(renderFavourites)(params, nav);
  });

  router.addRoute('/history', async (params, nav) => {
    const { renderHistory } = await import('./views/history.js');
    return mount(renderHistory)(params, nav);
  });

  router.addRoute('/upload', async (params, nav) => {
    const { renderUpload } = await import('./views/upload.js');
    return mount(renderUpload)(params, nav);
  });

  router.addRoute('/torrents', async (params, nav) => {
    const { renderTorrents } = await import('./views/torrents.js');
    return mount(renderTorrents)(params, nav);
  });

  router.addRoute('/settings', async (params, nav) => {
    const { renderSettings } = await import('./views/settings.js');
    return mount(renderSettings)(params, nav);
  });

  const mountDetail = async (params, nav) => {
    const { renderDetail } = await import('./views/detail.js');
    if (nav && !nav.isCurrent()) return;
    await swap(nav, () => { renderDetail(viewContainer, params.id); });
  };
  router.addRoute('/watch/:id', mountDetail);
  router.addRoute('/movie/:id', mountDetail);
  router.addRoute('/album/:id', mountDetail);

  // ---- v3 routes -------------------------------------------------------
  const mountKeyed = (render) => async (params, nav) => {
    if (nav && !nav.isCurrent()) return;
    await swap(nav, () => render(viewContainer, params.key || params.id || params.name, params));
  };

  router.addRoute('/artists', async (params, nav) => {
    const { renderArtists } = await import('./views/artists.js');
    return mount(renderArtists)(params, nav);
  });
  router.addRoute('/artist/:name', async (params, nav) => {
    const { renderArtist } = await import('./views/artists.js');
    return mountKeyed(renderArtist)(params, nav);
  });
  router.addRoute('/audiobooks', async (params, nav) => {
    const { renderAudiobooks } = await import('./views/audiobooks.js');
    return mount(renderAudiobooks)(params, nav);
  });
  router.addRoute('/shows', async (params, nav) => {
    const { renderShows } = await import('./views/shows.js');
    return mount(renderShows)(params, nav);
  });
  router.addRoute('/show/:key', async (params, nav) => {
    const { renderShowDetail } = await import('./views/shows.js');
    return mountKeyed(renderShowDetail)(params, nav);
  });
  router.addRoute('/watchlist', async (params, nav) => {
    const { renderWatchlist } = await import('./views/watchlist.js');
    return mount(renderWatchlist)(params, nav);
  });
  router.addRoute('/continue', async (params, nav) => {
    const { renderContinue } = await import('./views/watchlist.js');
    return mount(renderContinue)(params, nav);
  });
  router.addRoute('/stats', async (params, nav) => {
    const { renderStats } = await import('./views/stats.js');
    return mount(renderStats)(params, nav);
  });
  router.addRoute('/profiles', async (params, nav) => {
    const { renderProfiles } = await import('./views/profiles.js');
    return mount(renderProfiles)(params, nav);
  });
  router.addRoute('/system', async (params, nav) => {
    const { renderSystem } = await import('./views/system.js');
    return mount(renderSystem)(params, nav);
  });
  router.addRoute('/trash', async (params, nav) => {
    const { renderTrash } = await import('./views/trash.js');
    return mount(renderTrash)(params, nav);
  });
  router.addRoute('/downloads', async (params, nav) => {
    const { renderDownloads } = await import('./views/trash.js');
    return mount(renderDownloads)(params, nav);
  });
  router.addRoute('/podcasts', async (params, nav) => {
    const { renderPodcasts } = await import('./views/podcasts.js');
    return mount(renderPodcasts)(params, nav);
  });
  router.addRoute('/podcast/:id', async (params, nav) => {
    const { renderPodcasts } = await import('./views/podcasts.js');
    return mount(renderPodcasts)(params, nav);
  });
  router.addRoute('/comics', async (params, nav) => {
    const { renderComics } = await import('./views/comics.js');
    return mount(renderComics)(params, nav);
  });
  router.addRoute('/read/:id', async (params, nav) => {
    const { renderComicReader } = await import('./views/comics.js');
    return mountKeyed(renderComicReader)(params, nav);
  });
  // QR pairing deep link: /pair?code=123456 (scanned from Settings → Devices)
  router.addRoute('/pair', async (params, nav) => {
    const { joinWithPairingCode } = await import('./components/qrPair.js');
    const code = (params && (params.code || params.query?.code)) || new URLSearchParams(location.search).get('code');
    if (!code) {
      viewContainer.innerHTML = `
        <div class="page">
          <div class="page-header"><h1 class="page-title">Pair this device</h1></div>
          <div class="empty-state">
            <div class="empty-state-title">No pairing code</div>
            <div class="empty-state-message">Open Settings → Devices on an already-signed-in device and scan the QR code, or enter the 6-digit code below.</div>
            <form id="pair-form" style="display:flex; gap:8px; justify-content:center; margin-top:12px">
              <input class="form-input" id="pair-code" inputmode="numeric" maxlength="6" placeholder="123456" aria-label="Pairing code">
              <button class="btn btn-primary" type="submit">Pair</button>
            </form>
          </div>
        </div>`;
      viewContainer.querySelector('#pair-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = viewContainer.querySelector('#pair-code').value.trim();
        if (value) await joinWithPairingCode(value);
      });
      return;
    }
    viewContainer.innerHTML = '<div class="page"><div class="page-header"><h1 class="page-title">Pairing…</h1></div></div>';
    await joinWithPairingCode(code);
  });
  router.addRoute('/livetv', async (params, nav) => {
    const { renderLiveTV } = await import('./views/livetv.js');
    return mount(renderLiveTV)(params, nav);
  });
  router.addRoute('/syncplay', async (params, nav) => {
    const { renderSyncPlay } = await import('./views/syncplay.js');
    return mount(renderSyncPlay)(params, nav);
  });
  router.addRoute('/syncplay/:id', async (params, nav) => {
    const { renderSyncPlay } = await import('./views/syncplay.js');
    return mount(renderSyncPlay)(params, nav);
  });
}

// The sign-in "shake" keyframes live in css/auth-gate.css (no inline <style>: CSP).

// Start — check onboarding first, then auth
// Centralized onboarding event listeners — setup once
function setupOnboardingListeners() {
  // Use { once: false } but guard against double registration by removing existing if any
  // We add listeners once at startup
  window.addEventListener('vault:onboarding-complete', (e) => {
    // NOTE: e.detail carries the auth token — never log it (F-29).
    if (e.detail && e.detail.token) {
      showApp();
    } else {
      checkAuth();
    }
  });

  window.addEventListener('vault:onboarding-complete-no-token', () => {
    showAuthGate();
    toast.info('Setup complete — please login with your new credentials');
  });

  window.addEventListener('vault:onboarding-skipped', () => {
    showAuthGate();
  });
}

/** A QR from "Use on another device" opens /?pair=<token>: swap it for a
 *  session, then drop it from the address bar and history. */
async function redeemPairingLink() {
  const params = new URLSearchParams(location.search);
  const pairToken = params.get('pair');
  if (!pairToken) return;
  params.delete('pair');
  const clean = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`;
  history.replaceState(history.state, '', clean);
  try {
    const result = await api.exchangePairingToken(pairToken);
    if (result?.token) {
      localStorage.setItem('vault_token', result.token);
      localStorage.setItem('vault_onboarded', '1');
      api.clearTokenCache();
      toast.success('This device is now signed in to Vault');
    } else {
      toast.info('Waiting for approval on the other device…');
    }
  } catch (err) {
    toast.error(err.code === 'PAIR_EXPIRED'
      ? 'That sign-in code has expired or was already used — show a new QR code on the other device'
      : `Couldn’t sign in with that code: ${err.message}`);
  }
}

document.getElementById('auth-code-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('auth-code-input');
  const code = input.value.replace(/\D/g, '');
  if (code.length !== 6) { toast.error('The code has 6 digits'); input.focus(); return; }
  const btn = e.submitter || e.target.querySelector('button');
  btn.disabled = true;
  const { joinWithPairingCode } = await import('./components/qrPair.js');
  if (!(await joinWithPairingCode(code, 'Signed in with a code'))) btn.disabled = false;
});

async function start() {
  // A "Forgot password?" link (#reset=…): taken out of the address bar first.
  const resetLink = takeResetLink();
  // Setup listeners once
  setupOnboardingListeners();
  if (resetLink) {
    showAuthGate();
    getAccountForms().openReset(resetLink);
    return;
  }
  await redeemPairingLink();
  if (localStorage.getItem('vault_token')) warmSignedInStart();

  // Show loading state? Hide both initially
  if (authGate) authGate.style.display = 'none';
  if (appEl) appEl.style.display = 'none';

  // Try to determine if setup is needed
  try {
    const status = await api.getSetupStatus();
    if (status.needsSetup) {
      pendingVerify = null;
      showOnboarding();
      return;
    }
  } catch (err) {
    console.warn('Could not check setup status:', err.message);
    // If no token and server unreachable, show onboarding in connection mode to help user
    const token = localStorage.getItem('vault_token');
    // Someone who has used Vault before just needs the server started —
    // the sign-in screen offers that; the wizard is for first runs.
    if (!token && !localStorage.getItem('vault_onboarded')) {
      const isLocalhost = getApiBaseUrl().includes('localhost') || getApiBaseUrl().includes('127.0.0.1');
      if (isLocalhost) {
        console.warn('No token and server unreachable — showing onboarding for connection help');
        showOnboarding();
        return;
      }
    }
  }

  // Normal flow — check auth
  await checkAuth();
}

start();

// Expose for debugging (onboardingManager via getter: lazy-loaded module)
window.Vault = {
  store, api, router, authManager, themeManager, toast,
  get onboardingManager() { return onboardingManager; },
};
