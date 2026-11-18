'use strict';
/**
 * Fresh-clone install: `npm start` without `npm install` (or after running it
 * in the wrong folder) used to crash-loop on "Cannot find module 'dotenv'".
 * The server now explains it in one line, and the launcher installs the
 * packages itself, then starts the server.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const deps = require('../utils/deps');

const SERVER = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-install-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('missingDependencies lists required packages that are not installed, resolving like Node', () => {
  const dir = path.join(tmp, 'resolve', 'server');
  write(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { here: '1', 'in-parent': '1', '@scope/pkg': '1', absent: '1' },
    optionalDependencies: { 'optional-absent': '1' },
  }));
  write(path.join(dir, 'node_modules', 'here', 'package.json'), '{}');
  write(path.join(dir, 'node_modules', '@scope', 'pkg', 'package.json'), '{}');
  write(path.join(tmp, 'resolve', 'node_modules', 'in-parent', 'package.json'), '{}'); // hoisted
  assert.deepEqual(deps.missingDependencies(dir), ['absent'], 'optional packages (ffmpeg-static) never block a start');
  assert.deepEqual(deps.missingDependencies(path.join(tmp, 'no-such-dir')), [], 'no package.json → nothing to check');
});

test('the real server package resolves completely in this checkout', () => {
  assert.deepEqual(deps.missingDependencies(SERVER), []);
});

test('explanations are one actionable line', () => {
  const msg = deps.explainMissing(['dotenv', 'express', 'helmet', 'cors', 'morgan'], '/home/me/Vault-V2/server');
  assert.doesNotMatch(msg, /\n/);
  assert.match(msg, /missing dotenv, express, helmet and 2 more/);
  assert.match(msg, /npm install/);
  assert.match(msg, /\/home\/me\/Vault-V2\/server/);
  assert.equal(deps.nodeTooOld('18.20.8'), true);
  assert.equal(deps.nodeTooOld('20.0.0'), false);
  assert.equal(deps.nodeTooOld('26.13.1'), false);
  assert.match(deps.explainNodeTooOld('18.20.8'), /Node\.js 20 or newer.*18\.20\.8/);
});

test('npmCommand prefers the npm that ran `npm start`; child env drops only npm\'s own variables', () => {
  const cli = path.join(tmp, 'npmbin', 'npm-cli.js');
  write(cli, '');
  const viaNpm = deps.npmCommand(['install'], { npm_execpath: cli });
  assert.equal(viaNpm.command, process.execPath);
  assert.deepEqual(viaNpm.args, [cli, 'install']);
  const env = deps.cleanNpmEnv({ PATH: '/bin', npm_config_prefix: 'server', npm_lifecycle_event: 'start', NPM_CONFIG_REGISTRY: 'https://mirror.example' });
  assert.deepEqual(env, { PATH: '/bin', NPM_CONFIG_REGISTRY: 'https://mirror.example' });
});

test('index.js without node_modules: one line, exit 78 (no crash loop), no stack trace', () => {
  const dir = path.join(tmp, 'fresh', 'server');
  write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { dotenv: '^16' } }));
  fs.copyFileSync(path.join(SERVER, 'index.js'), path.join(dir, 'index.js'));
  write(path.join(dir, 'utils', 'deps.js'), fs.readFileSync(path.join(SERVER, 'utils', 'deps.js')));
  const run = spawnSync(process.execPath, [path.join(dir, 'index.js')], { encoding: 'utf8', cwd: dir });
  assert.equal(run.status, 78);
  assert.match(run.stderr, /^Error: Vault's packages are not installed \(missing dotenv\)\. Run "npm install"/);
  assert.doesNotMatch(run.stderr, /Cannot find module|at Module/);
});

// ---------------------------------------------------------------------------
// Launcher: installs the packages itself
// ---------------------------------------------------------------------------
const posix = process.platform !== 'win32';

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function status(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/launcher/status' }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
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

/** A server dir with one missing dependency and a fake `npm`. */
function fakeInstall(name, npmScript) {
  const dir = path.join(tmp, name);
  write(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'fake-dep': '1.0.0' } }));
  fs.copyFileSync(path.join(SERVER, 'launcher.js'), path.join(dir, 'launcher.js'));
  write(path.join(dir, 'utils', 'deps.js'), fs.readFileSync(path.join(SERVER, 'utils', 'deps.js')));
  write(path.join(dir, 'index.js'), `
    require('fake-dep');
    require('http').createServer((req, res) => res.end('{"ok":true}'))
      .listen(Number(process.env.VAULT_PORT), '127.0.0.1');
  `);
  const cli = path.join(dir, 'fakenpm', 'npm-cli.js');
  write(cli, npmScript);
  return { dir, cli };
}

async function launch(t, { dir, cli }) {
  const launcherPort = await freePort();
  const serverPort = await freePort();
  const proc = spawn(process.execPath, [path.join(dir, 'launcher.js')], {
    env: { ...process.env, VAULT_LAUNCHER_PORT: String(launcherPort), VAULT_PORT: String(serverPort), npm_execpath: cli },
    stdio: 'pipe',
  });
  let output = '';
  proc.stdout.on('data', (c) => { output += c; });
  proc.stderr.on('data', (c) => { output += c; });
  t.after(() => proc.kill('SIGTERM'));
  return { launcherPort, serverPort, log: () => output };
}

test('launcher: missing packages → runs npm install, then starts the server', { skip: !posix }, async (t) => {
  const fake = fakeInstall('auto', `
    const fs = require('fs'); const path = require('path');
    if (process.argv[2] !== 'install') process.exit(2);
    if (process.env.npm_config_prefix) { console.error('inherited npm_config_prefix'); process.exit(3); }
    setTimeout(() => {
      fs.mkdirSync(path.join(process.cwd(), 'node_modules', 'fake-dep'), { recursive: true });
      fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'fake-dep', 'package.json'), '{"main":"index.js"}');
      fs.writeFileSync(path.join(process.cwd(), 'node_modules', 'fake-dep', 'index.js'), '');
      console.log('added 1 package');
    }, 400);
  `);
  const { launcherPort, serverPort, log } = await launch(t, fake);
  const during = await until(async () => { const s = await status(launcherPort); return s?.installing && s; });
  assert.equal(during.status, 'starting', 'the app shows "Installing…", not a crash');
  const up = await until(async () => { const s = await status(launcherPort); return s?.status === 'running' && s; });
  assert.equal(up.installing, false);
  const body = await fetch(`http://127.0.0.1:${serverPort}/`).then(r => r.json());
  assert.equal(body.ok, true);
  assert.match(log(), /packages aren't installed yet \(missing fake-dep\)/);
  assert.match(log(), /packages installed/);
});

test('launcher: a failed install is reported once with the fix — no restart loop', { skip: !posix }, async (t) => {
  const fake = fakeInstall('fails', `
    const fs = require('fs');
    fs.appendFileSync(__dirname + '/runs', 'x');
    console.error('npm error network request failed'); process.exit(1);
  `);
  const { launcherPort } = await launch(t, fake);
  const s = await until(async () => { const st = await status(launcherPort); return st?.status === 'crashed' && st; });
  assert.match(s.reason, /Couldn't install Vault's packages automatically/);
  assert.match(s.reason, /run "npm install"/);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await status(launcherPort)).status, 'crashed');
  assert.equal(fs.readFileSync(path.join(path.dirname(fake.cli), 'runs'), 'utf8'), 'x', 'npm ran exactly once');
});
