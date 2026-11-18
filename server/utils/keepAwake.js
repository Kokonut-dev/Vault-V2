/**
 * Keep the computer awake while Vault is running.
 *
 * Locking a Mac (or a PC) doesn't stop programs — but a locked, idle
 * computer goes to sleep a few minutes later, and a sleeping computer
 * serves nothing: every phone, TV and browser loses the server until
 * someone wakes it up. This holds the operating system's own "don't idle
 * sleep" switch for exactly as long as the Vault server process lives:
 *
 *   macOS    /usr/bin/caffeinate -i -m -s -w <pid>   (built in)
 *   Windows  SetThreadExecutionState(ES_SYSTEM_REQUIRED) in a hidden
 *            PowerShell that exits with the server
 *   Linux    systemd-inhibit --what=idle:sleep … tail --pid=<pid>
 *
 * The helper is tied to the server's pid, so even a hard crash or
 * `kill -9` releases it — the computer can never be left stuck awake.
 * The screen still turns off and locks as usual; only *system* sleep is
 * held off. Closing a laptop's lid still sleeps it (macOS only stays
 * awake lid-closed when it's on power with an external display).
 *
 * Zero dependencies: also used before node_modules exist.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let helper = null;
let wanted = false;
let lastError = null;
let restarts = 0;
let platformOverride = null;
let spawnImpl = spawn;

function platform() {
  return platformOverride || process.platform;
}

function inContainer() {
  if (process.env.VAULT_KEEP_AWAKE_TEST) return false;
  try {
    return fs.existsSync('/.dockerenv') || /docker|containerd|kubepods/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

function onPath(binary) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return path.join(dir, binary);
    } catch { /* keep looking */ }
  }
  return null;
}

/** The command that holds the "stay awake" switch for `pid`, or null. */
function command(pid, os = platform()) {
  if (os === 'darwin') {
    // -i idle sleep, -m disk sleep, -s system sleep on AC power,
    // -w exit (and release) as soon as `pid` exits.
    return { method: 'macOS caffeinate', cmd: '/usr/bin/caffeinate', args: ['-i', '-m', '-s', '-w', String(pid)] };
  }
  if (os === 'win32') {
    const script = [
      "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
      '$k = Add-Type -MemberDefinition $sig -Name VaultAwake -Namespace Vault -PassThru',
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED — the display may still sleep.
      '[void]$k::SetThreadExecutionState([uint32]2147483649)',
      `Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
    ].join('; ');
    return { method: 'Windows power request', cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script] };
  }
  if (os === 'linux') {
    const inhibit = onPath('systemd-inhibit');
    const tail = onPath('tail');
    if (!inhibit || !tail) return null;
    return {
      method: 'systemd-inhibit',
      cmd: inhibit,
      args: ['--what=idle:sleep', '--who=Vault', '--why=Vault is serving your media', '--mode=block', tail, `--pid=${Number(pid)}`, '-f', '/dev/null'],
    };
  }
  return null;
}

function unsupportedReason(os = platform()) {
  if (inContainer()) return 'Vault runs in a container here — the host decides when the computer sleeps.';
  if (os === 'linux') return 'systemd-inhibit isn’t available on this system. Turn off automatic suspend in your power settings instead.';
  if (!['darwin', 'win32', 'linux'].includes(os)) return 'Not available on this operating system.';
  return null;
}

function supported(os = platform()) {
  return !unsupportedReason(os) && Boolean(command(process.pid, os));
}

function note(os = platform()) {
  if (os === 'darwin') return 'The screen can still turn off and lock. Closing a MacBook’s lid still puts it to sleep unless it’s plugged in with an external display.';
  if (os === 'win32') return 'The screen can still turn off and lock. Closing a laptop’s lid follows your Windows lid setting.';
  return 'The screen can still turn off and lock.';
}

function start(pid = process.pid) {
  wanted = true;
  if (helper) return true;
  if (!supported()) {
    lastError = unsupportedReason() || 'Not available on this system';
    return false;
  }
  const plan = command(pid);
  let proc;
  try {
    proc = spawnImpl(plan.cmd, plan.args, { stdio: 'ignore', windowsHide: true, detached: false });
  } catch (err) {
    lastError = `Couldn’t start ${plan.method}: ${err.message}`;
    return false;
  }
  helper = { proc, method: plan.method, startedAt: Date.now() };
  lastError = null;
  proc.on('error', (err) => {
    if (helper?.proc !== proc) return;
    helper = null;
    lastError = `Couldn’t start ${plan.method}: ${err.message}`;
  });
  proc.on('exit', (code, signal) => {
    if (helper?.proc !== proc) return;
    const ranFor = Date.now() - helper.startedAt;
    helper = null;
    if (!wanted) return;
    // The helper ended on its own (killed by hand, a policy refused it …):
    // try again a few times, then report it instead of looping forever.
    if (ranFor > 60000) restarts = 0;
    if (restarts < 3) {
      restarts += 1;
      setTimeout(() => { if (wanted && !helper) start(pid); }, 2000).unref?.();
    } else {
      lastError = `${plan.method} keeps stopping (${signal || `exit ${code}`})`;
    }
  });
  proc.unref?.();
  return true;
}

function stop() {
  wanted = false;
  restarts = 0;
  const current = helper;
  helper = null;
  if (current) {
    try { current.proc.kill(); } catch { /* already gone */ }
  }
}

/** Turn the hold on or off to match the setting. */
function apply(enabled, pid = process.pid) {
  if (enabled) return start(pid);
  stop();
  return false;
}

function status(enabled) {
  const reason = unsupportedReason();
  const ok = supported();
  return {
    supported: ok,
    enabled: Boolean(enabled),
    active: Boolean(helper),
    method: helper?.method || (ok ? command(process.pid).method : null),
    reason: ok ? null : (reason || 'Not available on this system'),
    error: lastError,
    note: note(),
    platform: platform(),
  };
}

/** Test hooks. */
function _setPlatform(os) { platformOverride = os; }
function _setSpawn(fn) { spawnImpl = fn || spawn; }

module.exports = { start, stop, apply, status, command, supported, _setPlatform, _setSpawn };
