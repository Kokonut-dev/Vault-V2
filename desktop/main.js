/**
 * Vault desktop app — the Vault server as an ordinary app on Linux, macOS
 * and Windows.
 *
 * What it does:
 *   - runs the server's own launcher (server/launcher.js) with Electron's
 *     built-in Node, so nobody has to install Node or run npm;
 *   - keeps your library, settings and logs in the per-user app-data folder
 *     (the app's own folder is read-only once installed);
 *   - opens the Vault web app in a window, and keeps the server running from
 *     the tray / menu bar when the window is closed — phones and TVs on your
 *     network keep working until you choose Quit.
 *
 * Security: the window only ever shows this computer's own Vault server
 * (http://127.0.0.1:<port>); anything else opens in your normal browser.
 * The page has no Node access (sandbox + context isolation, no preload).
 * Being on this computer, the window can finish first-run setup without the
 * setup code — every other device still needs it (server/services/setupGuard.js).
 */
'use strict';

const { app, BrowserWindow, Menu, Tray, shell, nativeImage, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const args = new Set(process.argv.slice(1));
const START_HIDDEN = args.has('--background') || args.has('--hidden');
const NO_SERVER = args.has('--no-server');

// --------------------------------------------------------------------------
// Where things live
// --------------------------------------------------------------------------
// Packaged: resources/vault/{server,docs} (copied by scripts/stage.js).
// `npm start` in desktop/: the repository itself.
const VAULT_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'vault') : path.join(__dirname, '..');
const SERVER_DIR = path.join(VAULT_ROOT, 'server');
const VAULT_HOME = process.env.VAULT_HOME || path.join(app.getPath('userData'), 'server');
const MEDIA_DIR = process.env.VAULT_MEDIA_DIR || path.join(app.getPath('home'), 'Vault Media');
const LOGS_DIR = path.join(VAULT_HOME, 'logs');
// What "start at sign-in" should run: the AppImage file itself on Linux
// (its mount point changes every launch), otherwise this executable.
const APP_EXECUTABLE = app.isPackaged ? (process.env.APPIMAGE || process.execPath) : null;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const config = () => readJson(path.join(VAULT_HOME, 'config.json'));
const LAUNCHER_PORT = Number(process.env.VAULT_LAUNCHER_PORT || config().launcher?.port || 4001);

// --------------------------------------------------------------------------
// One copy of the app at a time
// --------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--background')) showWindow();
  });
  main();
}

let win = null;
let tray = null;
let launcher = null;
let quitting = false;
let serverUrl = null; // set once the server answers
let lastStatus = { status: 'starting' };
let toldAboutTray = false;

function main() {
  if (process.platform === 'win32') app.setAppUserModelId('dev.kokonut.vault');
  app.whenReady().then(() => {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    lockDownSessions();
    createTray();
    startLauncher();
    if (!START_HIDDEN) showWindow();
    else if (process.platform === 'darwin') app.dock?.hide();
    pollStatus();
  });

  // Closing the window keeps the server running (tray); quitting stops it.
  app.on('window-all-closed', () => { /* stay in the tray */ });
  app.on('activate', () => showWindow());
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    if (!launcher) return;
    event.preventDefault();
    stopLauncher().finally(() => app.exit(0));
  });
}

// --------------------------------------------------------------------------
// The server (via its launcher)
// --------------------------------------------------------------------------
function startLauncher() {
  if (launcher) return;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // the launcher and server run as plain Node
    VAULT_HOME,
    VAULT_MEDIA_DIR: MEDIA_DIR,
    VAULT_LAUNCHER_PORT: String(LAUNCHER_PORT),
    ...(app.isPackaged ? { VAULT_PACKAGED: '1' } : {}),
    ...(APP_EXECUTABLE ? { VAULT_APP_EXECUTABLE: APP_EXECUTABLE } : {}),
  };
  const argv = [path.join(SERVER_DIR, 'launcher.js'), '--background', ...(NO_SERVER ? ['--no-server'] : [])];
  let proc;
  try {
    // --background: the launcher writes everything to VAULT_HOME/logs.
    proc = spawn(process.execPath, argv, { cwd: SERVER_DIR, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  } catch (err) {
    lastStatus = { status: 'crashed', reason: `Couldn't start Vault's server: ${err.message}` };
    return;
  }
  launcher = proc;
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  proc.on('exit', (code) => {
    if (launcher !== proc) return;
    launcher = null;
    if (quitting) return;
    // Exit 0 straight away = another Vault launcher already owns the port
    // (e.g. one started from a git clone); pollStatus() simply uses it.
    if (code !== 0) {
      lastStatus = { status: 'crashed', reason: lastLine(stderr) || `Vault's server stopped unexpectedly (code ${code}).` };
      refreshUi();
    }
  });
}

function lastLine(text) {
  return String(text).trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
}

function stopLauncher() {
  const proc = launcher;
  if (!proc) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 15000);
    proc.once('exit', done);
    try { proc.send({ type: 'shutdown' }); } catch { try { proc.kill('SIGTERM'); } catch { /* gone */ } }
  });
}

/** Ask the launcher (ours, or one already running) how the server is doing. */
function launcherStatus() {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port: LAUNCHER_PORT, path: '/launcher/status', timeout: 2000,
      headers: { Host: `127.0.0.1:${LAUNCHER_PORT}` },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function pollStatus() {
  if (quitting) return;
  const info = await launcherStatus();
  if (info?.launcher) {
    lastStatus = info;
    if (info.status === 'running') {
      // Always talk to the server over loopback (it may advertise "localhost").
      const url = new URL(info.serverUrl || `http://127.0.0.1:${info.port || 4000}`);
      url.hostname = '127.0.0.1';
      const next = url.origin;
      const changed = next !== serverUrl;
      serverUrl = next;
      if (changed && win && !win.isDestroyed()) win.loadURL(`${serverUrl}/`);
    } else if (serverUrl && info.status !== 'running') {
      serverUrl = null;
      if (win && !win.isDestroyed()) showLoading();
    }
  } else if (!launcher && lastStatus.status !== 'crashed') {
    lastStatus = { status: 'crashed', reason: 'Vault’s server isn’t running.' };
  }
  refreshUi();
  setTimeout(pollStatus, serverUrl ? 4000 : 800).unref?.();
}

// --------------------------------------------------------------------------
// Window
// --------------------------------------------------------------------------
function isServerUrl(raw) {
  if (!serverUrl) return false;
  try { return new URL(raw).origin === serverUrl; } catch { return false; }
}

function isLoadingPage(raw) {
  return raw.startsWith('file:') && decodeURIComponent(new URL(raw).pathname).endsWith('/loading.html');
}

function openExternally(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') shell.openExternal(url.href);
  } catch { /* ignore */ }
}

function showWindow() {
  if (process.platform === 'darwin') app.dock?.show();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 500,
    title: 'Vault',
    backgroundColor: '#161719',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());

  // Only this computer's Vault server and the local loading page may load in
  // the window; buttons on the loading page use vault-action: links.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('vault-action:')) {
      event.preventDefault();
      return handleAction(url.slice('vault-action:'.length));
    }
    if (isServerUrl(url) || isLoadingPage(url)) return;
    event.preventDefault();
    openExternally(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isServerUrl(url)) { event.preventDefault(); openExternally(url); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Pop-outs of Vault itself (e.g. a player window) stay in the app.
    if (isServerUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#161719', icon: path.join(__dirname, 'assets', 'icon.png') } };
    }
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    // The server went away mid-load: back to the status page until it returns.
    if (isMainFrame && code !== -3 && isServerUrl(url)) { serverUrl = null; showLoading(); }
  });

  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (process.platform === 'darwin') app.dock?.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({
        title: 'Vault is still running',
        body: process.platform === 'darwin'
          ? 'Your other devices can keep streaming. Use the Vault icon in the menu bar to open it again or quit.'
          : 'Your other devices can keep streaming. Use the Vault tray icon (or open Vault again) to show it, or Quit to stop the server.',
        silent: true,
      }).show();
    }
  });

  if (serverUrl) win.loadURL(`${serverUrl}/`);
  else showLoading();
}

function showLoading() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'loading.html')).then(refreshUi).catch(() => {});
}

function handleAction(action) {
  if (action === 'retry') {
    lastStatus = { status: 'starting' };
    if (launcher) { try { launcher.send({ type: 'start' }); } catch { /* restarting below */ } } else startLauncher();
    refreshUi();
  } else if (action === 'logs') {
    shell.openPath(LOGS_DIR);
  } else if (action === 'data') {
    shell.openPath(VAULT_HOME);
  }
}

// --------------------------------------------------------------------------
// Tray / menu bar
// --------------------------------------------------------------------------
function trayImage() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', file));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  return image;
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch {
    tray = null; // some Linux desktops have no tray; reopening the app shows the window
    return;
  }
  tray.setToolTip('Vault');
  tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });
  refreshUi();
}

const STATUS_TEXT = {
  running: 'Server is running',
  starting: 'Server is starting…',
  stopping: 'Server is stopping…',
  stopped: 'Server is stopped',
  crashed: 'Server has a problem',
};

function refreshUi() {
  const status = lastStatus.status || 'starting';
  if (tray) {
    const port = lastStatus.port || 4000;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Vault', click: showWindow },
      { label: 'Open in your browser', enabled: Boolean(serverUrl), click: () => serverUrl && shell.openExternal(`${serverUrl}/`) },
      { type: 'separator' },
      { label: STATUS_TEXT[status] || status, enabled: false },
      { label: `Port ${port} · other devices: Settings → Use on another device`, enabled: false },
      ...(status === 'stopped' || status === 'crashed' ? [{ label: 'Start server', click: () => handleAction('retry') }] : []),
      { type: 'separator' },
      { label: 'Open media folder', click: () => { fs.mkdirSync(MEDIA_DIR, { recursive: true }); shell.openPath(MEDIA_DIR); } },
      { label: 'Open Vault data folder', click: () => shell.openPath(VAULT_HOME) },
      { label: 'Open logs', click: () => shell.openPath(LOGS_DIR) },
      { type: 'separator' },
      { label: 'Quit Vault (stops the server)', click: () => app.quit() },
    ]));
    tray.setToolTip(`Vault — ${STATUS_TEXT[status] || status}`);
  }
  // Paint the loading page, if that's what the window shows.
  if (win && !win.isDestroyed() && isLoadingPage(win.webContents.getURL() || 'about:blank')) {
    const payload = JSON.stringify({ status, reason: lastStatus.reason || null, installing: Boolean(lastStatus.installing), home: VAULT_HOME });
    win.webContents.executeJavaScript(`window.vaultStatus && window.vaultStatus(${payload})`).catch(() => {});
  }
}

// --------------------------------------------------------------------------
// Session hardening
// --------------------------------------------------------------------------
function lockDownSessions() {
  const ses = session.defaultSession;
  // Vault uses fullscreen (video), media keys/notifications and the clipboard
  // (copy link). Nothing else — no camera, microphone, location, USB, …
  const allowed = new Set(['fullscreen', 'notifications', 'clipboard-sanitized-write', 'media-key-system', 'idle-detection']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed.has(permission) && isServerUrl(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && isServerUrl(origin));

  // Self-signed HTTPS (server.https with a generated cert) is accepted only
  // for this computer's own Vault server.
  app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
    let ok = false;
    try {
      const u = new URL(url);
      ok = u.hostname === '127.0.0.1' && isServerUrl(url);
    } catch { /* not ok */ }
    if (ok) { event.preventDefault(); callback(true); } else callback(false);
  });

  // Never let a page create webviews or navigate the app to other schemes.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}
