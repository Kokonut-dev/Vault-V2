#!/usr/bin/env node
/**
 * Vault launcher — lets the app start, restart and stop the server.
 *
 * A web page can't start a program on your computer, so this tiny process
 * (no dependencies, ~20 MB of RAM) keeps running and owns the real server
 * (`node index.js`) as a child:
 *
 *   npm start                       launcher + server (Ctrl+C stops both)
 *   node launcher.js --no-server    launcher only; the app shows "Start server"
 *   node launcher.js --background   no console output (used at sign-in)
 *
 * It listens on 127.0.0.1 only (default port 4001, VAULT_LAUNCHER_PORT) and
 * answers just three things: status, start, and a short error tail when the
 * server crashed. Only Vault's own pages may call it (Origin allowlist), and
 * requests addressed to any other Host are refused (DNS-rebinding guard).
 * Stopping/restarting goes through the server's own admin-only API; the
 * server exits with code 75 ("restart me") or 0 ("stay stopped").
 */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const deps = require('./utils/deps');

const SERVER_DIR = __dirname;
const VERSION = 1;
const RESTART_CODE = 75;
const CONFIG_ERROR_CODE = 78;

const args = new Set(process.argv.slice(2));
const background = args.has('--background');
const startServerNow = !args.has('--no-server');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const LAUNCHER_PORT = Number(process.env.VAULT_LAUNCHER_PORT || readConfig().launcher?.port || 4001);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
let logStream = null;
if (background) {
  try {
    fs.mkdirSync(path.join(SERVER_DIR, 'logs'), { recursive: true });
    logStream = fs.createWriteStream(path.join(SERVER_DIR, 'logs', 'launcher.log'), { flags: 'a' });
  } catch { /* no log file; stay silent */ }
}
function say(message) {
  const line = `[launcher] ${message}\n`;
  if (logStream) logStream.write(`${new Date().toISOString()} ${line}`);
  else if (!background) process.stdout.write(line);
}

// Last lines of server output, so the app can say *why* it crashed.
const tail = [];
function remember(chunk) {
  for (const line of chunk.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    tail.push(line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400));
    if (tail.length > 40) tail.shift();
  }
}

// ---------------------------------------------------------------------------
// Server child process
// ---------------------------------------------------------------------------
const state = {
  status: 'stopped', // stopped | starting | running | stopping | crashed
  pid: null,
  startedAt: null,
  lastExit: null, // { code, signal, at }
  reason: null,
  installing: false, // running `npm install` before the first start
};
let child = null;
let installer = null; // `npm install` child on a fresh clone
let stopRequested = false;
let readyTimer = null;
const crashes = [];

function serverPort() {
  return Number(process.env.VAULT_PORT || readConfig().server?.port || 4000);
}
function serverScheme() {
  return readConfig().server?.https?.enabled ? 'https' : 'http';
}

/** Poll /api/health until the server answers, then mark it running. */
function waitUntilReady(proc) {
  clearInterval(readyTimer);
  const started = Date.now();
  readyTimer = setInterval(() => {
    if (child !== proc) return clearInterval(readyTimer);
    const lib = serverScheme() === 'https' ? require('https') : http;
    const req = lib.get({ host: '127.0.0.1', port: serverPort(), path: '/api/health', timeout: 1500, rejectUnauthorized: false }, (res) => {
      res.resume();
      if (res.statusCode === 200 && child === proc && state.status === 'starting') {
        clearInterval(readyTimer);
        state.status = 'running';
        say(`server is up on port ${serverPort()}`);
      }
    });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    if (Date.now() - started > 10 * 60 * 1000) clearInterval(readyTimer);
  }, 700);
  readyTimer.unref?.();
}

/**
 * A fresh clone (or `npm install` run in the wrong folder) has no
 * node_modules: install them here instead of crash-looping on
 * "Cannot find module 'dotenv'".
 */
function installDependencies(missing) {
  if (installer) return true;
  stopRequested = false;
  state.status = 'starting';
  state.installing = true;
  state.reason = null;
  state.startedAt = new Date().toISOString();
  say(`Vault's packages aren't installed yet (missing ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}).`);
  say(`installing them now with "npm install" in ${SERVER_DIR} — first run only, usually under a minute…`);
  const { command, args, shell } = deps.npmCommand(['install', '--no-audit', '--no-fund']);
  let proc;
  try {
    proc = spawn(command, args, { cwd: SERVER_DIR, env: deps.cleanNpmEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell, windowsHide: true });
  } catch (err) {
    return installFailed(`could not run npm (${err.message})`);
  }
  installer = proc;
  const forward = (stream, target) => stream.on('data', (chunk) => {
    remember(chunk);
    if (logStream) logStream.write(chunk);
    else if (!background) target.write(chunk);
  });
  forward(proc.stdout, process.stdout);
  forward(proc.stderr, process.stderr);
  let failed = null;
  proc.on('error', (err) => { failed = `could not run npm (${err.message})`; });
  proc.on('close', (code) => {
    if (installer !== proc) return;
    installer = null;
    state.installing = false;
    if (stopRequested) {
      state.status = 'stopped';
      say('install cancelled');
      if (shuttingDown) process.exit(0);
      return;
    }
    const still = deps.missingDependencies(SERVER_DIR);
    if (failed || code !== 0 || still.length) return installFailed(failed || `npm install exited with code ${code}`);
    say('packages installed');
    startServer();
  });
  return true;
}

function installFailed(why) {
  installer = null;
  state.installing = false;
  state.status = 'crashed';
  state.reason = `Couldn't install Vault's packages automatically (${why}). Open a terminal in ${SERVER_DIR}, run "npm install", then press Try again.`;
  say(state.reason);
  return false;
}

function startServer() {
  if (child || installer) return false;
  if (deps.nodeTooOld()) {
    state.status = 'crashed';
    state.reason = deps.explainNodeTooOld().replace(/^Error:\s*/, '');
    say(state.reason);
    return false;
  }
  const missing = deps.missingDependencies(SERVER_DIR);
  if (missing.length) return installDependencies(missing);
  stopRequested = false;
  state.status = 'starting';
  state.reason = null;
  state.startedAt = new Date().toISOString();
  const env = { ...process.env, VAULT_SUPERVISED: '1', VAULT_LAUNCHER_PORT: String(LAUNCHER_PORT) };
  const proc = spawn(process.execPath, [path.join(SERVER_DIR, 'index.js')], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = proc;
  state.pid = proc.pid;
  say(`starting server (pid ${proc.pid})`);
  const forward = (stream, target) => stream.on('data', (chunk) => {
    remember(chunk);
    if (logStream) logStream.write(chunk);
    else if (!background) target.write(chunk);
  });
  forward(proc.stdout, process.stdout);
  forward(proc.stderr, process.stderr);
  proc.on('error', (err) => {
    remember(Buffer.from(`Could not start the server: ${err.message}`));
  });
  proc.on('exit', (code, signal) => onExit(proc, code, signal));
  waitUntilReady(proc);
  return true;
}

function onExit(proc, code, signal) {
  if (child !== proc) return;
  child = null;
  clearInterval(readyTimer);
  state.pid = null;
  state.lastExit = { code, signal, at: new Date().toISOString() };

  if (stopRequested || code === 0) {
    state.status = 'stopped';
    say('server stopped');
    if (shuttingDown) process.exit(0);
    return;
  }
  if (code === RESTART_CODE) {
    say('server asked to be restarted');
    startServer();
    return;
  }
  if (code === CONFIG_ERROR_CODE) {
    // e.g. the port is already in use — restarting won't help.
    state.status = 'crashed';
    state.reason = lastProblem() || 'The server could not start with the current settings';
    say(`server can't start: ${state.reason}`);
    return;
  }

  // Unexpected crash: restart with backoff, give up after 5 in 2 minutes.
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0] > 2 * 60 * 1000) crashes.shift();
  if (crashes.length >= 5) {
    state.status = 'crashed';
    state.reason = lastProblem() || `The server keeps stopping (exit code ${code ?? signal})`;
    say(`server crashed ${crashes.length} times — not restarting. Press Start in the app to try again.`);
    return;
  }
  const delay = Math.min(30000, 1000 * 2 ** (crashes.length - 1));
  state.status = 'starting';
  say(`server exited (${code ?? signal}); restarting in ${delay / 1000}s`);
  setTimeout(() => { if (!child && state.status === 'starting' && !stopRequested) startServer(); }, delay).unref?.();
}

function lastProblem() {
  const interesting = tail.filter(l => /error|EADDRINUSE|cannot|failed|not found|denied/i.test(l));
  const line = (interesting.length ? interesting : tail).slice(-1)[0] || '';
  if (/EADDRINUSE/.test(line)) return `Port ${serverPort()} is already in use — another Vault (or another app) is running on it`;
  return line.replace(/^Error:\s*/, '').replace(/^.*?\]\s*/, '').slice(0, 300);
}

function stopServer() {
  if (installer) {
    stopRequested = true;
    state.status = 'stopping';
    try { installer.kill('SIGTERM'); } catch { /* gone */ }
    return true;
  }
  if (!child) return false;
  stopRequested = true;
  state.status = 'stopping';
  const proc = child;
  try { proc.kill('SIGTERM'); } catch { /* gone */ }
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 10000).unref?.();
  return true;
}

// ---------------------------------------------------------------------------
// HTTP control API (127.0.0.1 only)
// ---------------------------------------------------------------------------
function localAddresses() {
  const out = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) out.add(entry.family === 'IPv6' || entry.family === 6 ? `[${entry.address}]` : entry.address);
  }
  return out;
}

/** Vault pages allowed to drive the launcher. Deliberately stricter than CORS. */
function originAllowed(origin) {
  if (!origin) return true; // not a browser cross-origin request (curl, scripts)
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (origin === 'https://kokonut-dev.github.io') return true;
  const host = url.hostname.includes(':') ? `[${url.hostname.replace(/^\[|\]$/g, '')}]` : url.hostname;
  if (localAddresses().has(host)) return true; // the Vault UI served by this machine
  const configured = [...(readConfig().cors?.origins || []), ...(readConfig().launcher?.allowedOrigins || [])];
  return configured.some(allowed => typeof allowed === 'string' && !allowed.includes('*') && allowed.replace(/\/$/, '') === origin);
}

function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').toLowerCase();
  return host === `127.0.0.1:${LAUNCHER_PORT}` || host === `localhost:${LAUNCHER_PORT}` || host === `[::1]:${LAUNCHER_PORT}`;
}

function publicStatus(includeDetail) {
  return {
    launcher: true,
    version: VERSION,
    status: state.status,
    pid: state.pid,
    startedAt: state.startedAt,
    lastExit: state.lastExit,
    reason: includeDetail ? state.reason : null,
    installing: Boolean(state.installing),
    serverUrl: `${serverScheme()}://localhost:${serverPort()}`,
    port: serverPort(),
    platform: process.platform,
  };
}

function send(res, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin && originAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(body === null ? '' : JSON.stringify(body));
}

const control = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://127.0.0.1');

  if (!hostAllowed(req.headers.host)) return send(res, 421, { error: 'Wrong host' });
  if (!originAllowed(origin)) return send(res, 403, { error: 'This page may not control the Vault launcher' });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      // Chrome Private/Local Network Access: a public page (github.io)
      // calling 127.0.0.1 must be explicitly allowed by the target.
      ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/launcher/status') {
    return send(res, 200, publicStatus(true), origin);
  }
  if (req.method === 'POST' && url.pathname === '/launcher/start') {
    if (state.status === 'running' || state.status === 'starting') return send(res, 200, { ...publicStatus(true), message: 'Already running' }, origin);
    crashes.length = 0;
    startServer();
    return send(res, 202, { ...publicStatus(true), message: 'Starting' }, origin);
  }
  return send(res, 404, { error: 'Not found' }, origin);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  say('shutting down');
  control.close();
  if (!stopServer()) process.exit(0);
  setTimeout(() => process.exit(0), 12000).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Another launcher already owns the port: hand over to it and exit. */
function handOff() {
  const req = http.request({ host: '127.0.0.1', port: LAUNCHER_PORT, path: startServerNow ? '/launcher/start' : '/launcher/status', method: startServerNow ? 'POST' : 'GET', timeout: 3000, headers: { Host: `127.0.0.1:${LAUNCHER_PORT}` } }, (res) => {
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => {
      let info = {};
      try { info = JSON.parse(body); } catch { /* not a launcher */ }
      if (info.launcher) {
        say(`a Vault launcher is already running — ${startServerNow ? `asked it to start the server (${info.serverUrl})` : 'nothing to do'}`);
        process.exit(0);
      }
      say(`port ${LAUNCHER_PORT} is used by another program; set VAULT_LAUNCHER_PORT to a free port`);
      // At sign-in (launchd KeepAlive) a non-zero exit means "restart me";
      // retrying can't free someone else's port, so don't loop.
      process.exit(background ? 0 : 1);
    });
  });
  req.on('error', () => { say(`port ${LAUNCHER_PORT} is busy`); process.exit(1); });
  req.end();
}

control.on('error', (err) => {
  if (err.code === 'EADDRINUSE') return handOff();
  say(`control port failed: ${err.message}`);
  process.exit(1);
});

control.listen(LAUNCHER_PORT, '127.0.0.1', () => {
  say(`ready on http://127.0.0.1:${LAUNCHER_PORT} — the app can now start/stop the server`);
  if (startServerNow) startServer();
});

