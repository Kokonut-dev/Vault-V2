/**
 * Remote access — "use Vault on another device" without a terminal.
 *
 *  - Same network: list the addresses other devices can open
 *    (http://192.168.x.x:4000, http://vault.local:4000).
 *  - Anywhere: run a Cloudflare quick tunnel (`cloudflared tunnel --url …`)
 *    as a child process and report its public https://….trycloudflare.com
 *    address. If cloudflared isn't installed, download the official binary
 *    from Cloudflare's GitHub releases and verify its SHA-256 against the
 *    checksums published in the release notes before it is ever run.
 *
 * Quick tunnels need no Cloudflare account; the address changes every time
 * the tunnel starts. Nothing here runs unless an admin presses the button
 * (or enabled "keep remote access on" in config.remoteAccess.tunnelOnStartup).
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const { getConfig } = require('../config');
const events = require('./events');
const logger = require('../utils/logger');

const BIN_DIR = process.env.VAULT_BIN_DIR || path.join(__dirname, '..', 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const RELEASE_API = process.env.VAULT_CLOUDFLARED_RELEASE_API
  || 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
// Release downloads redirect from github.com to GitHub's asset CDN.
const DOWNLOAD_HOSTS = [/^github\.com$/, /^api\.github\.com$/, /(^|\.)githubusercontent\.com$/];

const state = {
  status: 'off', // off | installing | starting | on | error
  url: null,
  error: null,
  startedAt: null,
  install: null, // { received, total }
};
let child = null;
let stopping = false;
let cachedBinary = undefined; // undefined = not probed, null = none

// ---------------------------------------------------------------------------
// Same network
// ---------------------------------------------------------------------------

/** IPv4 addresses of this machine that other devices can reach. */
function lanAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : `IPv${entry.family}`;
      if (family !== 'IPv4' || entry.internal) continue;
      // Docker/VM bridges are rarely what a phone can reach; list them last.
      const virtual = /^(docker|br-|veth|virbr|vmnet|vboxnet|utun|tun|tap|zt|wg)/i.test(name)
        || /^(vEthernet|VirtualBox|VMware)/i.test(name);
      // 169.254.x.x means "no DHCP lease" — phones can't normally reach it.
      const linkLocal = entry.address.startsWith('169.254.');
      out.push({ address: entry.address, interface: name, virtual, ...(linkLocal ? { linkLocal: true } : {}) });
    }
  }
  const isPrivate = ip => /^(192\.168|10)\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const rank = a => (a.linkLocal ? 4 : 0) + (a.virtual ? 2 : 0) + (isPrivate(a.address) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

function listensOnAllInterfaces(host) {
  const h = String(host ?? '').trim();
  return h === '' || h === '0.0.0.0' || h === '::' || h === '[::]';
}

function lanInfo() {
  const config = getConfig();
  const port = config.server?.port || 4000;
  const scheme = config.server?.https?.enabled ? 'https' : 'http';
  const host = config.server?.host;
  const reachable = listensOnAllInterfaces(host);
  const addresses = lanAddresses().map(a => ({ ...a, url: `${scheme}://${a.address}:${port}` }));
  const mdns = config.server?.mdns || {};
  const mdnsOn = Boolean(mdns.enabled || process.env.VAULT_MDNS === '1');
  return {
    port,
    scheme,
    host,
    reachable,
    addresses,
    mdns: { enabled: mdnsOn, url: mdnsOn ? `${scheme}://${mdns.hostname || 'vault'}.local:${port}` : null },
  };
}

// ---------------------------------------------------------------------------
// cloudflared discovery + install
// ---------------------------------------------------------------------------

function binaryCandidates() {
  const config = getConfig();
  return [
    config.remoteAccess?.cloudflaredPath,
    process.env.CLOUDFLARED_PATH,
    path.join(BIN_DIR, `cloudflared${EXE}`),
    `cloudflared${EXE}`, // on PATH
  ].filter(Boolean);
}

function probe(bin) {
  return new Promise(resolve => {
    execFile(bin, ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const text = `${stdout} ${stderr}`;
      const version = (text.match(/version\s+([\w.-]+)/i) || [])[1] || 'unknown';
      resolve({ path: bin, version });
    });
  });
}

async function findCloudflared({ refresh = false } = {}) {
  if (!refresh && cachedBinary !== undefined) return cachedBinary;
  for (const candidate of binaryCandidates()) {
    // eslint-disable-next-line no-await-in-loop
    const found = await probe(candidate);
    if (found) { cachedBinary = found; return found; }
  }
  cachedBinary = null;
  return null;
}

/** Release asset for this OS/CPU, or null when Cloudflare doesn't ship one. */
function assetName(platform = process.platform, arch = process.arch) {
  const table = {
    linux: { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm', ia32: 'cloudflared-linux-386' },
    darwin: { x64: 'cloudflared-darwin-amd64.tgz', arm64: 'cloudflared-darwin-arm64.tgz' },
    win32: { x64: 'cloudflared-windows-amd64.exe', ia32: 'cloudflared-windows-386.exe', arm64: 'cloudflared-windows-amd64.exe' },
  };
  return table[platform]?.[arch] || null;
}

/** GitHub's own SHA-256 of a release asset ("sha256:<hex>"), when published. */
function githubDigest(entry) {
  const m = /^sha256:([a-f0-9]{64})$/i.exec(String(entry?.digest || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Pull "<asset>: <sha256>" out of the release notes. */
function checksumFor(body, asset) {
  const escaped = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(body || '').match(new RegExp(`^\\s*${escaped}\\s*:\\s*([a-f0-9]{64})\\s*$`, 'mi'));
  return m ? m[1].toLowerCase() : null;
}

function allowedDownloadHost(url) {
  try {
    const u = new URL(url);
    if (process.env.VAULT_CLOUDFLARED_RELEASE_API && u.origin === new URL(RELEASE_API).origin) return true; // tests
    return u.protocol === 'https:' && DOWNLOAD_HOSTS.some(re => re.test(u.hostname));
  } catch { return false; }
}

/** GET with redirects, restricted to GitHub hosts. Resolves the response. */
function githubGet(url, { accept = '*/*', hops = 5 } = {}) {
  return new Promise((resolve, reject) => {
    if (!allowedDownloadHost(url)) return reject(new Error(`Refusing to download from ${new URL(url).hostname}`));
    const lib = url.startsWith('https:') ? https : require('http');
    const req = lib.get(url, { headers: { 'User-Agent': 'Vault/3.0 (cloudflared installer)', Accept: accept }, timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops <= 0) return reject(new Error('Too many redirects'));
        return resolve(githubGet(new URL(res.headers.location, url).toString(), { accept, hops: hops - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GitHub answered ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub took too long to answer')));
    req.on('error', reject);
  });
}

async function readJson(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Pull one regular file out of a (gzipped) tar buffer. */
function extractFromTar(tarBuffer, wanted) {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const full = prefix ? `${prefix}/${name}` : name;
    const start = offset + 512;
    if ((type === '0' || type === '\0') && path.posix.basename(full) === wanted) {
      return tarBuffer.subarray(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

let installing = null;
/**
 * Download, verify and install cloudflared.
 *
 * Verification: GitHub's own SHA-256 of the asset (the `digest` the release
 * API reports for every upload) is authoritative when present — the download
 * must match it. The SHA256 block in the release notes is the fallback.
 * Cloudflare's notes list a hash for the macOS .tgz that never matches the
 * archive GitHub serves (true for every release checked, 2026.10.4–2026.11.1;
 * every Linux/Windows entry matches), which made the install fail on every Mac
 * with "did not match its published checksum". A notes hash is therefore also
 * accepted when it matches the extracted binary, and only logged when GitHub's
 * digest already vouched for the file.
 */
async function installCloudflared({ onProgress, platform = process.platform, arch = process.arch } = {}) {
  if (installing) return installing;
  installing = (async () => {
    const asset = assetName(platform, arch);
    if (!asset) throw Object.assign(new Error(`Cloudflare doesn't publish cloudflared for ${platform}/${arch} — install it yourself and set remoteAccess.cloudflaredPath`), { code: 'UNSUPPORTED_PLATFORM' });
    const release = await readJson(await githubGet(RELEASE_API, { accept: 'application/vnd.github+json' }));
    const entry = (release.assets || []).find(a => a.name === asset);
    if (!entry) throw new Error(`The latest cloudflared release has no ${asset}`);
    const digest = githubDigest(entry);
    const noted = checksumFor(release.body, asset);
    if (!digest && !noted) throw Object.assign(new Error('Neither GitHub nor the release notes publish a checksum for this download, so it was not installed'), { code: 'NO_CHECKSUM' });

    fs.mkdirSync(BIN_DIR, { recursive: true });
    const res = await githubGet(entry.browser_download_url);
    const total = Number(res.headers['content-length'] || entry.size || 0);
    const hash = crypto.createHash('sha256');
    const chunks = [];
    let received = 0;
    for await (const chunk of res) {
      hash.update(chunk);
      chunks.push(chunk);
      received += chunk.length;
      onProgress?.({ received, total });
      if (received > 300 * 1024 * 1024) throw new Error('Download is unexpectedly large');
    }
    const actual = hash.digest('hex');
    const mismatch = () => Object.assign(new Error('The download did not match its published checksum and was discarded'), { code: 'CHECKSUM_MISMATCH' });
    if (digest && actual !== digest) throw mismatch();

    let binary = Buffer.concat(chunks);
    if (asset.endsWith('.tgz')) {
      try {
        binary = extractFromTar(zlib.gunzipSync(binary), 'cloudflared');
      } catch {
        binary = null;
      }
      if (!binary) throw new Error('cloudflared was not found inside the download');
    }
    if (noted && noted !== actual) {
      const innerHash = binary !== null && asset.endsWith('.tgz') ? crypto.createHash('sha256').update(binary).digest('hex') : null;
      if (noted !== innerHash) {
        if (!digest) throw mismatch();
        logger.info(`[Remote] ${asset}: the release notes' checksum differs from GitHub's; GitHub's digest matched, so the download is genuine`);
      }
    }
    const target = path.join(BIN_DIR, `cloudflared${EXE}`);
    const tmp = `${target}.download`;
    fs.writeFileSync(tmp, binary, { mode: 0o755 });
    fs.renameSync(tmp, target);
    cachedBinary = undefined;
    logger.info(`[Remote] Installed cloudflared ${release.tag_name || ''} → ${target}`);
    return findCloudflared({ refresh: true });
  })();
  try {
    return await installing;
  } finally {
    installing = null;
  }
}

// ---------------------------------------------------------------------------
// Tunnel lifecycle
// ---------------------------------------------------------------------------

function publicState() {
  return {
    status: state.status,
    url: state.url,
    error: state.error,
    startedAt: state.startedAt,
    install: state.install,
  };
}

function setState(patch) {
  Object.assign(state, patch);
  events.broadcast('remote:changed', publicState());
}

async function status() {
  const binary = await findCloudflared();
  return {
    tunnel: publicState(),
    cloudflared: binary ? { installed: true, version: binary.version, bundled: binary.path.startsWith(BIN_DIR) } : { installed: false, installable: Boolean(assetName()) },
    tunnelOnStartup: Boolean(getConfig().remoteAccess?.tunnelOnStartup),
    lan: lanInfo(),
  };
}

/**
 * Start a quick tunnel. Resolves once the public URL is known (or rejects
 * with a readable error). Installs cloudflared first when `install` is set.
 */
async function startTunnel({ install = true, timeoutMs = 60000 } = {}) {
  if (child && (state.status === 'on' || state.status === 'starting')) return publicState();
  let binary = await findCloudflared({ refresh: true });
  if (!binary) {
    if (!install) throw Object.assign(new Error('cloudflared is not installed'), { code: 'NOT_INSTALLED' });
    setState({ status: 'installing', error: null, url: null, install: { received: 0, total: 0 } });
    let last = 0;
    try {
      binary = await installCloudflared({
        onProgress: (p) => {
          state.install = p;
          if (Date.now() - last > 400) { last = Date.now(); events.broadcast('remote:changed', publicState()); }
        },
      });
    } catch (err) {
      setState({ status: 'error', error: `Couldn't install cloudflared: ${err.message}`, install: null });
      throw err;
    }
    if (!binary) {
      setState({ status: 'error', error: 'cloudflared was installed but does not run on this machine', install: null });
      throw new Error(state.error);
    }
  }

  const config = getConfig();
  const port = config.server?.port || 4000;
  const scheme = config.server?.https?.enabled ? 'https' : 'http';
  const args = ['tunnel', '--no-autoupdate', '--url', `${scheme}://127.0.0.1:${port}`];
  if (scheme === 'https') args.push('--no-tls-verify'); // self-signed local cert

  setState({ status: 'starting', error: null, url: null, install: null, startedAt: null });
  stopping = false;
  const proc = spawn(binary.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  const tail = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => {
      const reason = tail.slice(-3).join(' ').slice(0, 300);
      setState({ status: 'error', error: `The tunnel didn't come up in time${reason ? ` (${reason})` : ''}` });
      try { proc.kill(); } catch { /* gone */ }
      settle(reject, new Error(state.error));
    }, timeoutMs);

    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line.replace(/^\S+\s+(INF|ERR|WRN)\s+/, '').trim());
        if (tail.length > 20) tail.shift();
        const m = line.match(TUNNEL_URL_RE);
        // cloudflared prints the URL before the edge connection is ready;
        // that's still the moment a person can copy it.
        if (m && !state.url) {
          setState({ status: 'on', url: m[0], startedAt: new Date().toISOString() });
          logger.info(`[Remote] Tunnel up: ${m[0]}`);
          settle(resolve, publicState());
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      child = null;
      setState({ status: 'error', error: `cloudflared failed to start: ${err.message}`, url: null });
      settle(reject, err);
    });
    proc.on('exit', (code) => {
      if (child === proc) child = null;
      if (stopping) {
        setState({ status: 'off', url: null, startedAt: null, error: null });
      } else {
        const reason = tail.filter(l => /error|failed|unable/i.test(l)).slice(-1)[0] || tail.slice(-1)[0] || `exit code ${code}`;
        setState({ status: 'error', url: null, error: `The tunnel stopped: ${reason}`.slice(0, 300) });
        logger.warn(`[Remote] Tunnel exited (${code}): ${reason}`);
      }
      settle(reject, new Error(state.error || 'The tunnel stopped'));
    });
  });
}

function stopTunnel() {
  if (!child) {
    setState({ status: 'off', url: null, error: null, startedAt: null });
    return publicState();
  }
  stopping = true;
  const proc = child;
  try { proc.kill('SIGTERM'); } catch { /* gone */ }
  const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 4000);
  force.unref?.();
  return { ...publicState(), status: 'stopping' };
}

function autoStart() {
  if (!getConfig().remoteAccess?.tunnelOnStartup) return;
  startTunnel({ install: false }).catch(err => logger.warn(`[Remote] Tunnel on startup failed: ${err.message}`));
}

module.exports = {
  lanAddresses,
  lanInfo,
  listensOnAllInterfaces,
  findCloudflared,
  installCloudflared,
  assetName,
  checksumFor,
  githubDigest,
  extractFromTar,
  status,
  startTunnel,
  stopTunnel,
  autoStart,
  publicState,
  _resetForTests() { cachedBinary = undefined; if (child) { stopping = true; try { child.kill('SIGKILL'); } catch { /* gone */ } } child = null; Object.assign(state, { status: 'off', url: null, error: null, startedAt: null, install: null }); },
};
