#!/usr/bin/env node
/**
 * Smoke-tests a built desktop app (CI runs it on every platform):
 *
 *   node scripts/smoke.js dist/linux-unpacked/vault        (under xvfb-run on Linux)
 *   node scripts/smoke.js dist/mac-arm64/Vault.app/Contents/MacOS/Vault
 *   node scripts/smoke.js dist/win-unpacked/Vault.exe
 *
 * Starts the app with a throwaway home folder and checks that it serves the
 * API and the web app, wrote its state outside the install folder, ships
 * working ffmpeg/ffprobe, and takes the server down with it when it quits.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const exe = path.resolve(process.argv[2] || '');
if (!fs.existsSync(exe)) { console.error(`No app at ${exe}`); process.exit(2); }

const PORT = 4180;
const LAUNCHER_PORT = 4181;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-smoke-'));
const resources = process.platform === 'darwin'
  ? path.join(path.dirname(exe), '..', 'Resources')
  : path.join(path.dirname(exe), 'resources');

function get(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function until(what, fn, ms) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
let failed = false;
// On GitHub Actions failures also become annotations, readable on the PR
// without opening the raw log.
const annotate = (title, text) => {
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=${title}::${String(text).replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')}`);
};
function check(ok, message) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) { failed = true; annotate(`Smoke test (${process.platform}-${process.arch})`, message); }
}
function dumpLogs() {
  const logs = path.join(home, 'logs');
  if (!fs.existsSync(logs)) return;
  for (const f of fs.readdirSync(logs)) {
    const lines = fs.readFileSync(path.join(logs, f), 'utf8').split('\n').slice(-60).join('\n');
    console.log(`--- ${f} ---`);
    console.log(lines);
    annotate(`Log ${f}`, lines.slice(-3500));
  }
}

(async () => {
  // 1. What's inside the app
  const server = path.join(resources, 'vault', 'server');
  check(fs.existsSync(path.join(resources, 'app.asar')), 'app code is packed (app.asar)');
  check(fs.existsSync(path.join(server, 'launcher.js')) && fs.existsSync(path.join(resources, 'vault', 'docs', 'index.html')), 'server and web app are bundled');
  check(!fs.existsSync(path.join(server, 'config.json')) && !fs.existsSync(path.join(server, 'data')) && !fs.existsSync(path.join(server, 'test')), 'no config, data or tests shipped');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const ffmpeg = path.join(server, 'node_modules', 'ffmpeg-static', `ffmpeg${ext}`);
  const ffprobe = path.join(server, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, `ffprobe${ext}`);
  for (const [name, bin] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]]) {
    const run = fs.existsSync(bin) ? spawnSync(bin, ['-version'], { encoding: 'utf8' }) : null;
    const why = !fs.existsSync(bin) ? ` — missing ${path.relative(resources, bin)}` : run?.status !== 0 ? ` — exit ${run?.status ?? run?.error?.message} ${String(run?.stderr || '').slice(0, 300)}` : '';
    check(run?.status === 0, `${name} is bundled and runs${run?.stdout ? ` (${run.stdout.split('\n')[0].slice(0, 60)})` : ''}${why}`);
  }

  // 2. Start it like a user would
  const args = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const app = spawn(exe, args, {
    env: { ...process.env, VAULT_HOME: home, VAULT_MEDIA_DIR: path.join(home, 'Media'), VAULT_PORT: String(PORT), VAULT_LAUNCHER_PORT: String(LAUNCHER_PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  let appExited = false;
  app.on('exit', (code, signal) => { appExited = true; console.log(`app exited (${code ?? signal})`); });

  try {
    const health = await until('the server', async () => {
      const r = await get(PORT, '/api/health');
      return r?.status === 200 && r;
    }, 120000);
    check(JSON.parse(health.body).status === 'ok', 'server answers /api/health');
    const page = await get(PORT, '/');
    check(page?.status === 200 && /<html/i.test(page.body), 'web app is served');
    // The launcher notices on its next health poll (every 0.7 s).
    const running = await until('the launcher to report running', async () => {
      const st = await get(LAUNCHER_PORT, '/launcher/status');
      return st && JSON.parse(st.body).status === 'running';
    }, 15000).catch(() => false);
    check(running, 'launcher reports the server running');
    check(fs.existsSync(path.join(home, 'data', 'setup-code.txt')), 'state is written to the home folder');
    check(fs.existsSync(path.join(home, 'logs', 'launcher.log')), 'logs are written to the home folder');
    check(fs.existsSync(path.join(home, 'Media', 'music')), 'default media folders are created');
    check(!fs.existsSync(path.join(server, 'cache')) && !fs.existsSync(path.join(server, 'logs')), 'nothing written into the install folder');
  } catch (err) {
    check(false, err.message);
    dumpLogs();
  }

  // 3. Quit: the server must go with it
  if (!appExited) app.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
  try {
    await until('the server to stop', async () => (await get(PORT, '/api/health')) === null, 30000);
    check(true, 'server stops when the app quits');
  } catch (err) {
    check(false, err.message);
    dumpLogs();
  }
  if (!appExited) app.kill('SIGKILL');
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows may still hold a log */ }
  process.exit(failed ? 1 : 0);
})();
