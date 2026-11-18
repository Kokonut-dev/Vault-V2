/**
 * Recovery from deploy version skew.
 *
 * A tab opened before a deploy keeps the OLD versions of already-evaluated
 * modules (themes.js, api.js, …) in its module map. Views are imported lazily,
 * so after a deploy the tab can load a NEW view that imports a name the old
 * in-memory module never exported, e.g.:
 *
 *   Chrome:  "The requested module '../themes.js' does not provide an export named 'THEME_META'"
 *   Firefox: "ambiguous indirect export: THEME_META" / "… doesn't provide an export named …"
 *   Safari:  "Importing binding name 'THEME_META' is not found."
 *
 * or the old chunk is gone ("Failed to fetch dynamically imported module").
 * A module map can't be patched in place, so the only fix is a fresh page load.
 * We reload once, and the guard stops a reload loop if the error comes back.
 */

const GUARD_KEY = 'vault_stale_module_reload';
const GUARD_WINDOW_MS = 30_000;

const STALE_PATTERNS = [
  /does not provide an export named/i,
  /doesn't provide an export named/i,
  /ambiguous indirect export/i,
  /importing binding name .* is not found/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
];

export function isStaleModuleError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return STALE_PATTERNS.some(re => re.test(msg));
}

function recentlyReloaded() {
  try {
    const at = Number(sessionStorage.getItem(GUARD_KEY) || 0);
    return at > 0 && Date.now() - at < GUARD_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * If `err` is a version-skew error and we haven't just reloaded for one,
 * reload the page and return true. Otherwise return false so the caller
 * can show its normal error UI.
 */
export function recoverFromStaleModule(err) {
  if (!isStaleModuleError(err) || recentlyReloaded()) return false;
  try { sessionStorage.setItem(GUARD_KEY, String(Date.now())); } catch { /* private mode */ }
  console.warn('[Vault] A new version was deployed while this tab was open — reloading.', err);
  // Make sure the newest service worker is used for the reload.
  const reload = () => window.location.reload();
  try {
    const sw = navigator.serviceWorker;
    if (sw && sw.getRegistration) {
      sw.getRegistration().then(reg => reg && reg.update()).catch(() => {}).finally(reload);
      setTimeout(reload, 1500); // never hang on update()
      return true;
    }
  } catch { /* fall through */ }
  reload();
  return true;
}

let installed = false;

/** Catch skew errors from lazy imports that happen outside the router. */
export function installStaleModuleGuard() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('unhandledrejection', (event) => {
    if (recoverFromStaleModule(event.reason)) event.preventDefault();
  });
  window.addEventListener('error', (event) => {
    if (recoverFromStaleModule(event.error || event.message)) event.preventDefault();
  });
}
