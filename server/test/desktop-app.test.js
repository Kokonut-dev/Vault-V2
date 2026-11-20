'use strict';
/**
 * The desktop app (desktop/) runs this server from a read-only install
 * folder with Electron's Node. These tests pin what that relies on:
 *
 *   - VAULT_HOME moves *everything* Vault writes (config, data, cache,
 *     media defaults, uploads, logs) out of server/, and without it nothing
 *     changes for git-clone, Docker and service installs;
 *   - the launcher in packaged mode never runs npm, talks to the app over
 *     IPC, and stops the server when the app quits or dies;
 *   - "start at sign-in" starts the app, not `node launcher.js`;
 *   - the build only ships code (no config.json, data or secrets).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..');
const REPO = path.join(SERVER, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-desktop-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Evaluate `code` in a fresh Node with a clean set of VAULT_* variables. */
function evalWith(env, code) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VAULT_')));
  const run = spawnSync(process.execPath, ['-e', code], { cwd: SERVER, env: { ...clean, ...env }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

const DUMP_PATHS = `const p = require('./utils/paths'); console.log(JSON.stringify({ ...p, sample: p.cacheDir('covers'), rel: p.resolveHome('media/x') }));`;

test('without VAULT_HOME every path stays where it always was (server/)', () => {
  const p = evalWith({}, DUMP_PATHS);
  assert.equal(p.HOME, SERVER);
  assert.equal(p.relocated, false);
  assert.equal(p.CONFIG_PATH, path.join(SERVER, 'config.json'));
  assert.equal(p.DATA_DIR, path.join(SERVER, 'data'));
  assert.equal(p.CACHE_DIR, path.join(SERVER, 'cache'));
  assert.equal(p.MEDIA_DIR, path.join(SERVER, 'media'));
  assert.equal(p.UPLOADS_DIR, path.join(SERVER, 'uploads'));
  assert.equal(p.LOGS_DIR, path.join(SERVER, 'logs'));
  assert.equal(p.BIN_DIR, path.join(SERVER, 'bin'));
  assert.equal(p.DOCS_DIR, path.join(REPO, 'docs'));
  assert.equal(p.rel, path.join(SERVER, 'media', 'x'), 'relative config paths keep meaning server/…');
});

test('VAULT_HOME moves everything Vault writes; specific overrides still win', () => {
  const home = path.join(tmp, 'home');
  const p = evalWith({ VAULT_HOME: home }, DUMP_PATHS);
  assert.equal(p.relocated, true);
  for (const key of ['CONFIG_PATH', 'DATA_DIR', 'CACHE_DIR', 'MEDIA_DIR', 'UPLOADS_DIR', 'LOGS_DIR', 'BIN_DIR', 'sample', 'rel']) {
    assert.ok(p[key].startsWith(home + path.sep), `${key} = ${p[key]} should be inside VAULT_HOME`);
  }
  assert.equal(p.DOCS_DIR, path.join(REPO, 'docs'), 'the web app is code, it stays next to the server');
  const o = evalWith({ VAULT_HOME: home, VAULT_DATA_DIR: path.join(tmp, 'd'), VAULT_MEDIA_DIR: path.join(tmp, 'm') }, DUMP_PATHS);
  assert.equal(o.DATA_DIR, path.join(tmp, 'd'));
  assert.equal(o.MEDIA_DIR, path.join(tmp, 'm'));
  assert.equal(evalWith({ VAULT_HOME: home }, `console.log(JSON.stringify(require('./utils/dataDir').DATA_DIR))`), path.join(home, 'data'));
});

test('config.json is read from VAULT_HOME and its relative paths resolve there', () => {
  const home = path.join(tmp, 'config-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    server: { port: 4999 },
    media: { paths: { music: 'My Music' }, transcoding: { cacheDir: 'cache/tx' } },
  }));
  const c = evalWith({ VAULT_HOME: home, VAULT_MEDIA_DIR: path.join(tmp, 'media') }, `
    const { loadConfig } = require('./config'); const c = loadConfig();
    console.log(JSON.stringify({ port: c.server.port, music: c.media.paths.music, movies: c.media.paths.movies, cache: c.media.transcoding.cacheDir }));
  `);
  assert.equal(c.port, 4999);
  assert.equal(c.music, path.join(home, 'My Music'));
  assert.equal(c.movies, path.join(tmp, 'media', 'movies'), 'defaults come from VAULT_MEDIA_DIR');
  assert.equal(c.cache, path.join(home, 'cache', 'tx'));
});

test('no server module builds a writable path from __dirname any more (only utils/paths.js may)', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'test', 'vendor', 'data', 'cache', 'media', 'uploads', 'logs', 'bin'].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith('.js')) {
        const src = fs.readFileSync(full, 'utf8');
        if (/__dirname[^\n]*['"`](\.\.\/)?(cache|media|uploads|logs|data|bin|config\.json)\b/.test(src)) offenders.push(path.relative(SERVER, full));
      }
    }
  };
  walk(SERVER);
  assert.deepEqual(offenders, []);
});

test('start at sign-in starts the desktop app (with --background) when VAULT_APP_EXECUTABLE is set', () => {
  const exe = path.join(tmp, 'Apps', 'Vault.AppImage');
  const home = path.join(tmp, 'signin-home');
  const out = evalWith({ VAULT_APP_EXECUTABLE: exe, VAULT_AUTOSTART_HOME: home, VAULT_HOME: path.join(tmp, 'vh') }, `
    const a = require('./services/autostart');
    const plans = Object.fromEntries(['linux', 'win32', 'darwin'].map(p => [p, a.plan(p, { startServer: true }).files[0].content]));
    console.log(JSON.stringify({ args: a.launchArgs({ startServer: false }), plans }));
  `);
  assert.deepEqual(out.args, [exe, '--background', '--no-server']);
  assert.match(out.plans.linux, new RegExp(`Exec="${exe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "--background"`));
  assert.doesNotMatch(out.plans.linux, /launcher\.js/);
  assert.match(out.plans.win32, /--background/);
  assert.doesNotMatch(out.plans.darwin, /launcher\.js/);
  assert.match(out.plans.darwin, new RegExp(path.join(tmp, 'vh', 'logs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'launchd logs go to VAULT_HOME/logs');
  // A git clone keeps `node launcher.js`.
  const clone = evalWith({}, `console.log(JSON.stringify(require('./services/autostart').launchArgs({ startServer: true })))`);
  assert.deepEqual(clone.slice(1), [path.join(SERVER, 'launcher.js'), '--background']);
});

// ---------------------------------------------------------------------------
// Launcher, packaged mode
// ---------------------------------------------------------------------------
const posix = process.platform !== 'win32';

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function get(port, p) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    }).on('error', () => resolve(null));
  });
}
async function until(fn, ms = 10000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 50));
  }
}

/** A minimal server folder: the real launcher + a tiny index.js. */
function fakeServer(name, { deps = {} } = {}) {
  const dir = path.join(tmp, name, 'server');
  fs.mkdirSync(path.join(dir, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: deps }));
  fs.copyFileSync(path.join(SERVER, 'launcher.js'), path.join(dir, 'launcher.js'));
  for (const f of ['deps.js', 'paths.js']) fs.copyFileSync(path.join(SERVER, 'utils', f), path.join(dir, 'utils', f));
  fs.writeFileSync(path.join(dir, 'index.js'), `
    require('http').createServer((req, res) => res.end('{"status":"ok"}')).listen(Number(process.env.VAULT_PORT), '127.0.0.1');
    process.on('SIGTERM', () => process.exit(0));
  `);
  return dir;
}

test('packaged launcher never runs npm: a damaged install says "reinstall"', { skip: !posix }, async (t) => {
  const dir = fakeServer('damaged', { deps: { 'fake-dep': '1.0.0' } });
  const npm = path.join(tmp, 'damaged', 'npm-cli.js');
  fs.writeFileSync(npm, `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'damaged', 'npm-ran'))}, 'x')`);
  const launcherPort = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, 'launcher.js'), '--background'], {
    env: { ...process.env, VAULT_PACKAGED: '1', VAULT_HOME: path.join(tmp, 'damaged', 'home'), VAULT_LAUNCHER_PORT: String(launcherPort), VAULT_PORT: String(await freePort()), npm_execpath: npm },
    stdio: 'ignore',
  });
  t.after(() => proc.kill('SIGTERM'));
  const s = await until(async () => { const st = await get(launcherPort, '/launcher/status'); return st?.status === 'crashed' && st; });
  assert.match(s.reason, /incomplete.*Reinstall Vault/);
  assert.equal(s.installing, false);
  assert.equal(fs.existsSync(path.join(tmp, 'damaged', 'npm-ran')), false, 'npm must not run inside an installed app');
});

test('launcher over IPC: says ready, logs to VAULT_HOME, stops the server on "shutdown" and when the app dies', { skip: !posix }, async () => {
  const dir = fakeServer('ipc');
  const home = path.join(tmp, 'ipc', 'home');
  const start = async () => {
    const launcherPort = await freePort();
    const serverPort = await freePort();
    const proc = spawn(process.execPath, [path.join(dir, 'launcher.js'), '--background'], {
      env: { ...process.env, VAULT_PACKAGED: '1', VAULT_HOME: home, VAULT_LAUNCHER_PORT: String(launcherPort), VAULT_PORT: String(serverPort) },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const ready = await new Promise((resolve) => proc.on('message', (m) => m?.type === 'ready' && resolve(m)));
    assert.equal(ready.port, launcherPort);
    await until(async () => (await get(launcherPort, '/launcher/status'))?.status === 'running');
    assert.equal((await get(serverPort, '/')).status, 'ok');
    return { proc, serverPort };
  };

  // 1. The app quits: asks politely.
  const a = await start();
  a.proc.send({ type: 'shutdown' });
  const code = await new Promise((resolve) => a.proc.on('exit', resolve));
  assert.equal(code, 0);
  assert.equal(await get(a.serverPort, '/'), null, 'server stopped with the launcher');

  // 2. The app crashes: the IPC channel closes and the launcher cleans up.
  const b = await start();
  const exited = new Promise((resolve) => b.proc.on('exit', resolve));
  b.proc.disconnect();
  await exited;
  await until(async () => (await get(b.serverPort, '/')) === null);

  assert.match(fs.readFileSync(path.join(home, 'logs', 'launcher.log'), 'utf8'), /starting server/);
  assert.equal(fs.existsSync(path.join(dir, 'logs')), false, 'nothing is written next to the code');
});

// ---------------------------------------------------------------------------
// The desktop build itself
// ---------------------------------------------------------------------------
const DESKTOP = path.join(REPO, 'desktop');

test('desktop build ships code only, for every platform, with icons', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'main.js');
  assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8')).version, 'desktop and server versions match');
  const b = pkg.build;
  assert.deepEqual(b.extraResources, [{ from: 'stage/vault', to: 'vault' }]);
  assert.ok(b.linux.target.includes('AppImage') && b.linux.target.includes('deb'));
  assert.ok(b.win.target.includes('nsis'));
  assert.ok(b.mac.target.includes('dmg'));
  assert.equal(b.mac.identity, '-', 'unsigned Mac builds are still ad-hoc signed so Apple silicon will open them');
  assert.equal(b.nsis.deleteAppDataOnUninstall, false, 'uninstalling never deletes a library');

  const stage = fs.readFileSync(path.join(DESKTOP, 'scripts', 'stage.js'), 'utf8');
  for (const secret of ['config.json', "'data'", "'cache'", "'media'", "'.env'", "'node_modules'", "'certs'"]) {
    assert.ok(stage.includes(secret), `stage.js must skip ${secret}`);
  }
  assert.match(stage, /npm', \['ci', '--omit=dev'\]/);

  for (const [file, size] of [['icon.png', 1024], ['icon-mac.png', 1024], ['tray.png', 16], ['tray@2x.png', 32], ['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
    const buf = fs.readFileSync(path.join(DESKTOP, 'assets', file));
    assert.equal(buf.toString('latin1', 1, 4), 'PNG', file);
    assert.equal(buf.readUInt32BE(16), size, `${file} width`);
    assert.equal(buf.readUInt32BE(20), size, `${file} height`);
  }
});

test('desktop window: locked down, only shows this computer\'s Vault, stops the server on quit', () => {
  const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.doesNotMatch(main, /preload:/, 'the page gets no bridge into Node');
  assert.match(main, /will-navigate/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /url\.hostname = '127\.0\.0\.1'/, 'always loopback, so the window counts as "this computer"');
  assert.match(main, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(main, /VAULT_PACKAGED: '1'/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /type: 'shutdown'/);
});
