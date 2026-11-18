/**
 * Start the Vault launcher when the user signs in to this computer, so the
 * app's "Start server" button works after a reboot without a terminal.
 *
 *   Windows  a hidden .vbs in the Startup folder (no console window)
 *   macOS    ~/Library/LaunchAgents/com.vault.launcher.plist (RunAtLoad;
 *            KeepAlive brings it back after a crash, ProcessType
 *            Interactive stops macOS throttling it while the screen is
 *            locked — App Nap / background QoS made streams stall)
 *   Linux    ~/.config/autostart/vault-launcher.desktop (desktop sessions;
 *            headless boxes should use deploy/vault.service instead)
 *
 * Every entry runs `node launcher.js --background`, plus `--no-server` when
 * the server should wait for the button instead of starting immediately.
 * Nothing needs admin rights; everything lives in the user's own profile.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const LAUNCHER = path.join(__dirname, '..', 'launcher.js');
const LABEL = 'com.vault.launcher';

function home() {
  return process.env.VAULT_AUTOSTART_HOME || os.homedir();
}

/** A per-user base dir from the environment (XDG_CONFIG_HOME, APPDATA) — unless
 *  VAULT_AUTOSTART_HOME overrides HOME, in which case everything stays under it
 *  (CI runners set XDG_CONFIG_HOME, which would otherwise escape the sandbox). */
function userDir(envVar, ...fallback) {
  if (!process.env.VAULT_AUTOSTART_HOME && process.env[envVar]) return process.env[envVar];
  return path.join(home(), ...fallback);
}

function inContainer() {
  if (process.env.VAULT_AUTOSTART_HOME) return false; // tests
  try {
    return fs.existsSync('/.dockerenv') || /docker|containerd|kubepods/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch { return false; }
}

function launchArgs({ startServer }) {
  return [process.execPath, LAUNCHER, '--background', ...(startServer ? [] : ['--no-server'])];
}

function quoteWin(arg) {
  return `""${arg.replace(/"/g, '')}""`;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function desktopQuote(arg) {
  return `"${String(arg).replace(/(["`$\\])/g, '\\$1')}"`;
}

/** File(s) to write for each platform. */
function plan(platform = process.platform, opts = { startServer: false }) {
  const argv = launchArgs(opts);
  if (platform === 'win32') {
    const startup = path.join(userDir('APPDATA', 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const command = argv.map(quoteWin).join(' ');
    return {
      method: 'Windows Startup folder',
      files: [{
        path: path.join(startup, 'Vault Launcher.vbs'),
        // 0 = hidden window, False = don't wait.
        content: `' Starts the Vault launcher at sign-in (created by Vault Settings).\r\nCreateObject("WScript.Shell").Run "${command}", 0, False\r\n`,
      }],
    };
  }
  if (platform === 'darwin') {
    const logs = path.join(__dirname, '..', 'logs');
    return {
      method: 'macOS Login Items (LaunchAgent)',
      files: [{
        path: path.join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`),
        content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(path.dirname(LAUNCHER))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(logs, 'launcher.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(logs, 'launcher.err.log'))}</string>
</dict>
</plist>
`,
      }],
      after: [['launchctl', ['load', '-w', path.join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`)]]],
      before: [['launchctl', ['unload', path.join(home(), 'Library', 'LaunchAgents', `${LABEL}.plist`)]]],
    };
  }
  // Linux / BSD
  const exec = argv.map(desktopQuote).join(' ');
  const files = [{
    path: path.join(userDir('XDG_CONFIG_HOME', '.config'), 'autostart', 'vault-launcher.desktop'),
    content: `[Desktop Entry]
Type=Application
Name=Vault Launcher
Comment=Lets the Vault app start your media server
Exec=${exec}
Path=${path.dirname(LAUNCHER)}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`,
  }];
  return { method: 'Desktop sign-in (XDG autostart)', files };
}

function readSettingsFrom(content) {
  return { startServer: !/--no-server/.test(content || '') };
}

function status() {
  if (inContainer()) {
    return { supported: false, installed: false, reason: 'Vault runs in a container here — let Docker restart it (restart: unless-stopped) instead.' };
  }
  const p = plan(process.platform);
  const file = p.files[0].path;
  let installed = false;
  let startServer = false;
  try {
    const content = fs.readFileSync(file, 'utf8');
    installed = content.includes(LAUNCHER);
    startServer = readSettingsFrom(content).startServer;
  } catch { /* not installed */ }
  return { supported: true, installed, startServer, method: p.method, path: file, platform: process.platform };
}

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, () => resolve());
  });
}

async function enable({ startServer = false } = {}) {
  const current = status();
  if (!current.supported) throw Object.assign(new Error(current.reason), { code: 'UNSUPPORTED' });
  const p = plan(process.platform, { startServer });
  if (!process.env.VAULT_AUTOSTART_HOME) for (const [cmd, args] of p.before || []) await run(cmd, args);
  for (const file of p.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.content, { mode: 0o644 });
  }
  if (!process.env.VAULT_AUTOSTART_HOME) for (const [cmd, args] of p.after || []) await run(cmd, args);
  return status();
}

async function disable() {
  const current = status();
  if (!current.supported) return current;
  const p = plan(process.platform);
  if (!process.env.VAULT_AUTOSTART_HOME) for (const [cmd, args] of p.before || []) await run(cmd, args);
  for (const file of p.files) {
    try { fs.unlinkSync(file.path); } catch { /* already gone */ }
  }
  return status();
}

/**
 * Rewrite an installed entry when this version of Vault would write a
 * different one (e.g. the macOS entry gained KeepAlive/ProcessType). Only
 * the file changes — it takes effect at the next sign-in, so a running
 * launcher (and the server it owns) is never interrupted.
 */
function refresh() {
  const current = status();
  if (!current.supported || !current.installed) return false;
  const p = plan(process.platform, { startServer: current.startServer });
  let changed = false;
  for (const file of p.files) {
    let existing = null;
    try { existing = fs.readFileSync(file.path, 'utf8'); } catch { /* missing */ }
    if (existing !== file.content) {
      fs.writeFileSync(file.path, file.content, { mode: 0o644 });
      changed = true;
    }
  }
  return changed;
}

module.exports = { status, enable, disable, refresh, plan, launchArgs };
