/**
 * Process lifecycle shared by index.js and the admin "Restart / Stop server"
 * buttons. When the server runs under the Vault launcher (VAULT_SUPERVISED=1)
 * exiting with RESTART_CODE brings it straight back; exiting with 0 leaves it
 * stopped until the app's Start button (or `npm start`) is used.
 */
const RESTART_CODE = 75;
const CONFIG_ERROR_CODE = 78;

let shutdownHook = async () => {};
let exiting = false;

function setShutdownHook(fn) {
  shutdownHook = fn;
}

function supervised() {
  return process.env.VAULT_SUPERVISED === '1';
}

function launcherPort() {
  return supervised() ? Number(process.env.VAULT_LAUNCHER_PORT || 4001) : null;
}

/** Flush state, then exit. Returns immediately; the exit happens shortly after. */
function exitSoon(code, { delayMs = 250 } = {}) {
  if (exiting) return false;
  exiting = true;
  setTimeout(async () => {
    try { await shutdownHook(); } catch { /* best effort */ }
    process.exit(code);
  }, delayMs);
  return true;
}

module.exports = { RESTART_CODE, CONFIG_ERROR_CODE, setShutdownHook, supervised, launcherPort, exitSoon };
