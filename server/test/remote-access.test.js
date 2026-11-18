/**
 * "Use Vault on another device" + "start the server from the app":
 *   - cloudflared install: right asset per OS, checksum from the release
 *     notes, refuses mismatches, unpacks macOS .tgz, never writes partials,
 *   - quick tunnel lifecycle with a fake cloudflared (URL parsing, stop,
 *     crash reporting) and the SSE `remote:changed` updates,
 *   - LAN addresses: link-local and virtual adapters are listed last,
 *   - autostart files per platform (into a temp HOME),
 *   - the launcher: Host/Origin guards, start → server → stop (exit 0),
 *     restart (exit 75), port-in-use (exit 78, no restart loop).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-remote-'));
process.env.VAULT_BIN_DIR = path.join(tmp, 'bin');

// Fake GitHub release API (must be set before remoteAccess is required).
let release = null;
let assetBody = null;
const github = http.createServer((req, res) => {
  if (req.url === '/release') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(release));
  }
  if (req.url.startsWith('/asset/')) {
    res.writeHead(302, { Location: `/cdn${req.url}` }); // like github.com → CDN
    return res.end();
  }
  if (req.url.startsWith('/cdn/asset/')) {
    res.writeHead(200, { 'Content-Length': assetBody.length });
    return res.end(assetBody);
  }
  res.writeHead(404);
  res.end();
});

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => Object.assign(memory, next);

let remote;
let githubBase;
test.before(async () => {
  await new Promise(r => github.listen(0, '127.0.0.1', r));
  githubBase = `http://127.0.0.1:${github.address().port}`;
  process.env.VAULT_CLOUDFLARED_RELEASE_API = `${githubBase}/release`;
  remote = require('../services/remoteAccess');
});
test.after(() => {
  remote?._resetForTests();
  github.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FAKE_CLOUDFLARED = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "cloudflared version 2026.11.1 (built 2026-11-01)"; exit 0; fi
if [ -n "$FAKE_CF_CRASH" ]; then echo "2026-11-17T10:00:00Z ERR failed to request quick Tunnel: 429 Too Many Requests" >&2; exit 1; fi
echo "2026-11-17T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "2026-11-17T10:00:01Z INF |  https://happy-otter-tiny-lamp.trycloudflare.com  |" >&2
trap 'exit 0' TERM
while true; do sleep 1; done
`;

test('assetName picks the published build for each OS/CPU', () => {
  assert.equal(remote.assetName('linux', 'x64'), 'cloudflared-linux-amd64');
  assert.equal(remote.assetName('linux', 'arm64'), 'cloudflared-linux-arm64');
  assert.equal(remote.assetName('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
  assert.equal(remote.assetName('win32', 'x64'), 'cloudflared-windows-amd64.exe');
  assert.equal(remote.assetName('freebsd', 'x64'), null);
});

test('checksumFor reads the SHA256 block of the release notes', () => {
  const body = '### SHA256 Checksums:\n```\ncloudflared-linux-amd64: 97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7\ncloudflared-linux-amd64.deb: ' + 'a'.repeat(64) + '\n```';
  assert.equal(remote.checksumFor(body, 'cloudflared-linux-amd64'), '97bb3b02d23a5980fc9c15a1a270e692da1923f103f920d5b16d4931d5ab55e7');
  assert.equal(remote.checksumFor(body, 'cloudflared-linux-amd64.deb'), 'a'.repeat(64));
  assert.equal(remote.checksumFor(body, 'cloudflared-linux-arm64'), null);
});

function tarWith(name, content) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000755\0', 100);
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('0', 156);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, pad, Buffer.alloc(1024)]);
}

test('extractFromTar finds cloudflared inside the macOS archive', () => {
  const tar = Buffer.concat([tarWith('README.md', Buffer.from('hi')).subarray(0, 1024), tarWith('cloudflared', Buffer.from('BINARY'))]);
  assert.equal(remote.extractFromTar(tar, 'cloudflared').toString(), 'BINARY');
  assert.equal(remote.extractFromTar(tar, 'missing'), null);
});

const posix = process.platform !== 'win32';

test('install: verifies the checksum, refuses a mismatch, leaves nothing behind', { skip: !posix }, async () => {
  const asset = remote.assetName();
  if (!asset || asset.endsWith('.tgz')) return; // the tgz path is covered above
  assetBody = Buffer.from(FAKE_CLOUDFLARED);
  const good = crypto.createHash('sha256').update(assetBody).digest('hex');
  release = {
    tag_name: '2026.11.1',
    body: `### SHA256 Checksums:\n\`\`\`\n${asset}: ${'0'.repeat(64)}\n\`\`\``,
    assets: [{ name: asset, size: assetBody.length, browser_download_url: `${githubBase}/asset/${asset}` }],
  };
  await assert.rejects(remote.installCloudflared(), { code: 'CHECKSUM_MISMATCH' });
  assert.deepEqual(fs.existsSync(process.env.VAULT_BIN_DIR) ? fs.readdirSync(process.env.VAULT_BIN_DIR) : [], []);

  release.body = `### SHA256 Checksums:\n\`\`\`\n${asset}: ${good}\n\`\`\``;
  const progress = [];
  const binary = await remote.installCloudflared({ onProgress: p => progress.push(p) });
  assert.equal(binary.version, '2026.11.1');
  assert.ok(binary.path.startsWith(process.env.VAULT_BIN_DIR));
  assert.equal(progress.at(-1).received, assetBody.length);
  assert.equal(fs.statSync(binary.path).mode & 0o111, 0o111, 'executable');
});

test('no checksum in the notes → not installed', { skip: !posix }, async () => {
  const asset = remote.assetName();
  if (!asset) return;
  release = { tag_name: 'x', body: 'no checksums here', assets: [{ name: asset, browser_download_url: `${githubBase}/asset/${asset}` }] };
  await assert.rejects(remote.installCloudflared(), { code: 'NO_CHECKSUM' });
});

test('tunnel: start reports the trycloudflare URL, stop turns it off, crashes explain themselves', { skip: !posix }, async () => {
  const fake = path.join(tmp, 'fake-cloudflared');
  fs.writeFileSync(fake, FAKE_CLOUDFLARED, { mode: 0o755 });
  memory.remoteAccess = { cloudflaredPath: fake };
  remote._resetForTests();

  const events = require('../services/events');
  const seen = [];
  const client = events.addClient({ write: (p) => { if (p.startsWith('event: remote:changed')) seen.push(JSON.parse(p.split('data: ')[1]).status); } });

  const state = await remote.startTunnel({ timeoutMs: 5000 });
  assert.equal(state.status, 'on');
  assert.equal(state.url, 'https://happy-otter-tiny-lamp.trycloudflare.com');
  assert.deepEqual(seen.slice(0, 2), ['starting', 'on']);
  const again = await remote.startTunnel();
  assert.equal(again.url, state.url, 'a second start reuses the running tunnel');

  remote.stopTunnel();
  for (let i = 0; i < 50 && remote.publicState().status !== 'off'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(remote.publicState().status, 'off');

  process.env.FAKE_CF_CRASH = '1';
  try {
    await assert.rejects(remote.startTunnel({ timeoutMs: 5000 }));
    const after = remote.publicState();
    assert.equal(after.status, 'error');
    assert.match(after.error, /429 Too Many Requests/);
  } finally {
    delete process.env.FAKE_CF_CRASH;
    events.removeClient(client);
  }
});

test('LAN: link-local and virtual adapters sort after real Wi-Fi/Ethernet', () => {
  const realIfaces = os.networkInterfaces;
  os.networkInterfaces = () => ({
    'docker0': [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    eth1: [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlan0: [{ address: '192.168.1.42', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  });
  try {
    const list = remote.lanAddresses();
    assert.deepEqual(list.map(a => a.address), ['192.168.1.42', '172.17.0.1', '169.254.10.2']);
    assert.equal(list[2].linkLocal, true);
    assert.equal(list[1].virtual, true);
  } finally {
    os.networkInterfaces = realIfaces;
  }
  assert.equal(remote.listensOnAllInterfaces('0.0.0.0'), true);
  assert.equal(remote.listensOnAllInterfaces('127.0.0.1'), false);
});

test('autostart writes and removes the sign-in entry for this platform', async () => {
  process.env.VAULT_AUTOSTART_HOME = path.join(tmp, 'home');
  const autostart = require('../services/autostart');
  for (const platform of ['linux', 'darwin', 'win32']) {
    const plan = autostart.plan(platform);
    assert.ok(plan.files?.length || plan.file || plan.path, `${platform} has a plan`);
  }
  const status = autostart.status();
  if (!status.supported) return; // e.g. running inside Docker
  const on = await autostart.enable({ startServer: true });
  assert.equal(on.installed, true);
  assert.equal(on.startServer, true);
  assert.ok(on.path.startsWith(process.env.VAULT_AUTOSTART_HOME), 'only writes inside HOME');
  const content = fs.readFileSync(on.path, 'utf8');
  assert.match(content, /launcher\.js/);
  assert.match(content, /--background/);
  assert.doesNotMatch(content, /--no-server/);
  const off = await autostart.disable();
  assert.equal(off.installed, false);
  assert.equal(fs.existsSync(on.path), false);
});

// ---------------------------------------------------------------------------
// Launcher (real child processes, fake server script)
// ---------------------------------------------------------------------------
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function request(port, { method = 'GET', pathname = '/launcher/status', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function until(fn, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 60));
  }
}

test('launcher: guards, start, stop, restart and config errors', { skip: !posix }, async (t) => {
  // A stand-in for index.js: HTTP on VAULT_PORT (the variable the real server
  // and the launcher's health check both read); /exit?code=N exits with N.
  const dir = path.join(tmp, 'launcher');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'launcher.js'), path.join(dir, 'launcher.js'));
  fs.writeFileSync(path.join(dir, 'index.js'), `
    const http = require('http');
    if (process.env.FAKE_MODE === 'config') { console.error('EADDRINUSE: port taken'); process.exit(78); }
    http.createServer((req, res) => {
      const code = new URL(req.url, 'http://x').searchParams.get('exit');
      res.end(JSON.stringify({ ok: true, pid: process.pid, supervised: process.env.VAULT_SUPERVISED }));
      if (code !== null) setTimeout(() => process.exit(Number(code)), 20);
    }).listen(Number(process.env.VAULT_PORT), '127.0.0.1', () => console.log('Vault server ready!'));
  `);
  const launcherPort = await freePort();
  const serverPort = await freePort();
  const env = { ...process.env, VAULT_LAUNCHER_PORT: String(launcherPort), VAULT_PORT: String(serverPort) };
  const proc = spawn(process.execPath, [path.join(dir, 'launcher.js'), '--no-server'], { env, stdio: 'pipe' });
  t.after(() => proc.kill('SIGTERM'));
  await until(() => request(launcherPort).then(r => r.status === 200, () => false));

  // Guards: DNS rebinding + foreign pages.
  assert.equal((await request(launcherPort, { headers: { Host: `evil.example:${launcherPort}` } })).status, 421);
  assert.equal((await request(launcherPort, { method: 'POST', pathname: '/launcher/start', headers: { Origin: 'https://evil.example' } })).status, 403);
  const preflight = await request(launcherPort, { method: 'OPTIONS', pathname: '/launcher/start', headers: { Origin: 'https://kokonut-dev.github.io', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');

  let status = (await request(launcherPort)).body;
  assert.equal(status.status, 'stopped');

  // Start from "the app".
  const started = await request(launcherPort, { method: 'POST', pathname: '/launcher/start', headers: { Origin: `http://localhost:${serverPort}` } });
  assert.equal(started.status, 202);
  assert.equal(started.headers['access-control-allow-origin'], `http://localhost:${serverPort}`);
  status = await until(async () => { const s = (await request(launcherPort)).body; return s.status === 'running' && s; });
  const first = await until(() => fetch(`http://127.0.0.1:${serverPort}/`).then(r => r.json(), () => null));
  assert.equal(first.supervised, '1');

  // Restart: exit 75 → a new process.
  await fetch(`http://127.0.0.1:${serverPort}/?exit=75`).catch(() => {});
  const second = await until(() => fetch(`http://127.0.0.1:${serverPort}/`).then(r => r.json(), () => null).then(b => b && b.pid !== first.pid && b));
  assert.ok(second.pid);

  // Stop: exit 0 → stays stopped.
  await fetch(`http://127.0.0.1:${serverPort}/?exit=0`).catch(() => {});
  status = await until(async () => { const s = (await request(launcherPort)).body; return s.status === 'stopped' && s; });
  assert.equal(status.lastExit.code, 0);
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await request(launcherPort)).body.status, 'stopped', 'no automatic restart after a stop');
});

test('launcher: a config error (exit 78) is reported, not retried', { skip: !posix }, async (t) => {
  const dir = path.join(tmp, 'launcher');
  const launcherPort = await freePort();
  const env = { ...process.env, VAULT_LAUNCHER_PORT: String(launcherPort), VAULT_PORT: String(await freePort()), FAKE_MODE: 'config' };
  const proc = spawn(process.execPath, [path.join(dir, 'launcher.js')], { env, stdio: 'pipe' });
  t.after(() => proc.kill('SIGTERM'));
  const status = await until(async () => {
    const s = await request(launcherPort).then(r => r.body, () => null);
    return s && s.status !== 'starting' && s.status !== 'running' && s.lastExit && s;
  });
  assert.equal(status.lastExit.code, 78);
  assert.match(status.reason || '', /EADDRINUSE|port/i);
  const pidBefore = status.pid;
  await new Promise(r => setTimeout(r, 600));
  const later = (await request(launcherPort)).body;
  assert.equal(later.pid, pidBefore, 'not restarted in a loop');
});
