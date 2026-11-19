/**
 * Torrents: download a magnet link or .torrent file straight into the library.
 *
 * Off by default, admin-only, and only after the admin has acknowledged the
 * responsibility notice (Settings → Torrents). The engine is WebTorrent 2.x,
 * loaded lazily so a server without it (optional dependency) still runs.
 *
 * Flow
 *   add(magnet | .torrent)  → status "metadata": fetch the file list
 *                           → status "ready": the admin picks files + library
 *   start(id, files, type)  → "downloading" (or "queued" past maxActive)
 *   finished                → files move (or, while sharing, hard-link) from
 *                             the hidden staging folder into the library, keep
 *                             the torrent's folder layout, and get scanned
 *                           → "done" (or "seeding" until the share ratio)
 *
 * Downloads are staged in `<library>/.vault-downloads/<id>/`, which both the
 * watcher (dot folder) and full scans (built-in ignore) skip, so half-written
 * files never show up in the library. Pausing, the VPN guard and a server
 * restart all work the same way: the torrent is dropped from the engine and
 * re-added later from its saved .torrent; WebTorrent re-checks what's on disk
 * and carries on where it stopped.
 *
 * VPN guard: WebTorrent can't bind to a network interface, so instead Vault
 * only runs torrents while the named interface (wg0, tun0…) is up and drops
 * every connection the moment it disappears.
 */
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs-extra');
const { getConfig, saveConfig } = require('../config');
const logger = require('../utils/logger');
const events = require('./events');
const { safeRelativeParts } = require('../utils/validators');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STAGING_DIR = '.vault-downloads';
const LIBRARY_KEYS = { movie: 'movies', music: 'music', video: 'videos' };
const MAX_JOBS = 200;
const MAX_TORRENT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MAGNET_LENGTH = 8192;
const POLL_MS = 1000;
const VPN_CHECK_MS = 3000;

const SIDECAR_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub', '.idx', '.jpg', '.jpeg', '.png', '.webp', '.nfo', '.cue', '.lrc']);
const NEVER_EXT = new Set(['.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.sh', '.js', '.vbs', '.ps1', '.php', '.py', '.dll', '.so', '.dmg', '.app', '.apk', '.jar', '.lnk']);

// Swappable for tests (no network, no real engine install needed).
const deps = {
  loadEngine: async () => (await import('webtorrent')).default,
  networkInterfaces: () => os.networkInterfaces(),
  scanFile: (filePath) => require('./scanner').scanFile(filePath),
  clientOptions: {},
  stateFile: path.join(DATA_DIR, 'torrents.json'),
  torrentDir: path.join(DATA_DIR, 'torrents'),
};

const DEFAULT_SETTINGS = {
  enabled: false,
  acknowledged: false,
  maxActive: 3,
  downloadLimitKBs: 0,
  uploadLimitKBs: 0,
  seedRatio: 0,
  requireInterface: '',
  upnp: false,
  dht: true,
};

class TorrentError extends Error {
  constructor(message, code, status = 400, fields = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    if (fields) this.fields = fields;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function settings() {
  return { ...DEFAULT_SETTINGS, ...(getConfig().torrent || {}) };
}

const clampInt = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};

function updateSettings(patch = {}) {
  const config = getConfig();
  const current = settings();
  const next = { ...current };
  const fields = {};
  if (patch.acknowledged !== undefined) next.acknowledged = Boolean(patch.acknowledged);
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  if (next.enabled && !next.acknowledged) {
    fields.acknowledged = 'Confirm that you’ll only download things you have the right to';
  }
  if (patch.maxActive !== undefined) next.maxActive = clampInt(patch.maxActive, 1, 10, current.maxActive);
  if (patch.downloadLimitKBs !== undefined) next.downloadLimitKBs = clampInt(patch.downloadLimitKBs, 0, 10_000_000, 0);
  if (patch.uploadLimitKBs !== undefined) next.uploadLimitKBs = clampInt(patch.uploadLimitKBs, 0, 10_000_000, 0);
  if (patch.seedRatio !== undefined) {
    const r = Number(patch.seedRatio);
    next.seedRatio = Number.isFinite(r) && r > 0 ? Math.min(Math.round(r * 10) / 10, 10) : 0;
  }
  if (patch.requireInterface !== undefined) {
    const name = String(patch.requireInterface || '').trim();
    if (name && !/^[A-Za-z0-9._:@-]{1,32}$/.test(name)) fields.requireInterface = 'Use the interface name, e.g. wg0 or tun0';
    else next.requireInterface = name;
  }
  if (patch.upnp !== undefined) next.upnp = Boolean(patch.upnp);
  if (patch.dht !== undefined) next.dht = Boolean(patch.dht);
  if (Object.keys(fields).length) throw new TorrentError('Some fields need fixing', 'INVALID', 400, fields);

  config.torrent = next;
  saveConfig(config);

  const engineChanged = ['enabled', 'upnp', 'dht', 'requireInterface'].some(k => next[k] !== current[k]);
  if (!next.enabled) {
    stopEngine('Torrents switched off');
  } else if (engineChanged && client) {
    // Network options only apply to a new engine; restart it and pick up again.
    stopEngine('Torrent settings changed');
    resumeAll();
  } else {
    applyThrottle();
    if (next.enabled) resumeAll();
  }
  pumpQueue();
  return publicSettings(next);
}

function publicSettings(s = settings()) {
  return { ...s };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const jobs = new Map(); // id → job
const live = new Map(); // id → WebTorrent torrent
let client = null;
let enginePromise = null;
let engineError = null;
let pollTimer = null;
let vpnTimer = null;
let loaded = false;
let saveTimer = null;

function stagingRoot() {
  const paths = getConfig().media?.paths || {};
  const base = paths.videos || paths.movies || paths.music || path.join(__dirname, '..', 'media');
  return path.join(base, STAGING_DIR);
}

function stagingFor(job) {
  return path.join(stagingRoot(), job.id);
}

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const saved = fs.readJsonSync(deps.stateFile, { throws: false });
    for (const job of saved?.jobs || []) {
      if (!job?.id) continue;
      // Anything that was mid-flight resumes when the engine starts.
      if (['metadata', 'downloading', 'moving', 'waiting-vpn', 'seeding'].includes(job.status)) job.resume = true;
      job.downloadSpeed = 0;
      job.uploadSpeed = 0;
      job.peers = 0;
      jobs.set(job.id, job);
    }
  } catch (err) {
    logger.warn(`[Torrents] couldn't read saved torrents: ${err.message}`);
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 500);
  saveTimer.unref?.();
}

function persistNow() {
  clearTimeout(saveTimer);
  try {
    fs.ensureDirSync(path.dirname(deps.stateFile));
    const out = [...jobs.values()].map(({ resume, downloadSpeed, uploadSpeed, peers, eta, ...job }) => job);
    fs.writeJsonSync(deps.stateFile, { jobs: out }, { spaces: 1 });
  } catch (err) {
    logger.warn(`[Torrents] couldn't save torrent list: ${err.message}`);
  }
}

let changedTimer = null;
function changed() {
  persist();
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    // No names in the broadcast: every signed-in device gets SSE events, only
    // admins can see the list.
    events.broadcast('torrents:changed', { at: Date.now() });
  }, 250);
  changedTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
async function engineAvailable() {
  try {
    await deps.loadEngine();
    return { installed: true, error: null };
  } catch (err) {
    return { installed: false, error: err.message };
  }
}

function vpnStatus(s = settings()) {
  const name = s.requireInterface;
  if (!name) return { required: false, interface: '', up: true };
  const addrs = deps.networkInterfaces()[name] || [];
  return { required: true, interface: name, up: addrs.some(a => !a.internal) };
}

function listInterfaces() {
  return Object.entries(deps.networkInterfaces())
    .filter(([, addrs]) => (addrs || []).some(a => !a.internal))
    .map(([name, addrs]) => ({
      name,
      addresses: addrs.filter(a => !a.internal).map(a => a.address),
      likelyVpn: /^(wg|tun|tap|ppp|utun|ipsec|nordlynx|proton|mullvad|tailscale)/i.test(name),
    }));
}

async function ensureClient() {
  const s = settings();
  if (!s.enabled) throw new TorrentError('Torrents are switched off. Turn them on in Settings → Torrents.', 'TORRENTS_OFF', 409);
  const vpn = vpnStatus(s);
  if (!vpn.up) throw new TorrentError(`Waiting for the VPN: network interface “${vpn.interface}” isn’t up.`, 'VPN_DOWN', 409);
  if (client) return client;
  if (!enginePromise) {
    enginePromise = (async () => {
      let WebTorrent;
      try {
        WebTorrent = await deps.loadEngine();
      } catch (err) {
        engineError = err.message;
        throw new TorrentError('The torrent engine isn’t installed on the server. Run “npm install” in the server folder and restart Vault.', 'NO_ENGINE', 503);
      }
      engineError = null;
      const kb = (n) => (n > 0 ? n * 1024 : -1);
      const c = new WebTorrent({
        dht: s.dht,
        lsd: true,
        utPex: true,
        natUpnp: s.upnp,
        natPmp: s.upnp,
        downloadLimit: kb(s.downloadLimitKBs),
        uploadLimit: kb(s.uploadLimitKBs),
        ...deps.clientOptions,
      });
      c.on('error', (err) => logger.warn(`[Torrents] engine error: ${err.message}`));
      client = c;
      startTimers();
      return c;
    })().finally(() => { enginePromise = null; });
  }
  return enginePromise;
}

function applyThrottle() {
  if (!client) return;
  const s = settings();
  try {
    client.throttleDownload?.(s.downloadLimitKBs > 0 ? s.downloadLimitKBs * 1024 : -1);
    client.throttleUpload?.(s.uploadLimitKBs > 0 ? s.uploadLimitKBs * 1024 : -1);
  } catch (err) {
    logger.warn(`[Torrents] couldn't apply speed limits: ${err.message}`);
  }
}

/** Drop every connection; jobs keep their state and resume later. */
function stopEngine(why, { status } = {}) {
  for (const [id, torrent] of live) {
    const job = jobs.get(id);
    detach(id, torrent);
    if (job && ['metadata', 'downloading', 'seeding', 'moving'].includes(job.status)) {
      job.resume = true;
      if (status) {
        job.resumeAs = job.status;
        job.status = status;
      }
      job.downloadSpeed = 0;
      job.uploadSpeed = 0;
      job.peers = 0;
    }
  }
  if (client) {
    const c = client;
    client = null;
    c.destroy(() => {});
    logger.info(`[Torrents] engine stopped: ${why}`);
  }
  stopPolling();
  if (!settings().requireInterface || !settings().enabled) stopVpnWatch();
  changed();
}

/**
 * Take a torrent out of the engine, keeping its files. Resolves once its
 * files are closed (Windows can't move open files).
 */
function detach(id, torrent = live.get(id)) {
  live.delete(id);
  if (!torrent || torrent.destroyed) return Promise.resolve();
  try { torrent.removeAllListeners?.(); } catch { /* ignore */ }
  torrent.on?.('error', () => {}); // late store errors after removal
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    timer.unref?.();
    try {
      // destroy() also removes it from the client.
      torrent.destroy({ destroyStore: false }, () => { clearTimeout(timer); resolve(); });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function startTimers() {
  if (!pollTimer) {
    pollTimer = setInterval(poll, POLL_MS);
    pollTimer.unref?.();
  }
  startVpnWatch();
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function startVpnWatch() {
  if (vpnTimer || !settings().requireInterface) return;
  vpnTimer = setInterval(checkVpn, VPN_CHECK_MS);
  vpnTimer.unref?.();
}

function stopVpnWatch() {
  clearInterval(vpnTimer);
  vpnTimer = null;
}

function checkVpn() {
  const s = settings();
  if (!s.enabled || !s.requireInterface) return stopVpnWatch();
  const { up, interface: name } = vpnStatus(s);
  if (!up && client) {
    logger.warn(`[Torrents] VPN interface ${name} went down — pausing all torrents`);
    stopEngine(`VPN interface ${name} is down`, { status: 'waiting-vpn' });
    startVpnWatch();
  } else if (up && !client && [...jobs.values()].some(j => j.resume)) {
    logger.info(`[Torrents] VPN interface ${name} is back — resuming`);
    resumeAll();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
const extOf = (name) => path.extname(String(name || '')).toLowerCase();

function mediaKind(name) {
  const ext = extOf(name);
  const supported = getConfig().media?.supportedExtensions || {};
  if ((supported.video || []).includes(ext)) return 'video';
  if ((supported.audio || []).includes(ext)) return 'audio';
  if (SIDECAR_EXT.has(ext)) return 'sidecar';
  return 'other';
}

/** Best guess at the library: mostly audio → Music; episode/year/movie names → Movies & Series; else Videos. */
function guessType(files) {
  let audio = 0;
  let video = 0;
  const videoNames = [];
  for (const f of files) {
    const kind = mediaKind(f.name);
    if (kind === 'audio') audio += f.length;
    if (kind === 'video') {
      video += f.length;
      videoNames.push(f.path);
    }
  }
  if (audio > video) return 'music';
  if (!videoNames.length) return 'video';
  const moviey = videoNames.filter(n => /\bS\d{1,2}\s*E\d{1,3}\b|\b\d{1,2}x\d{2}\b|[([ ._-](19|20)\d{2}[)\] ._-]|\b(1080p|2160p|720p|bluray|web-?dl|webrip|remux)\b/i.test(n));
  return moviey.length * 2 >= videoNames.length ? 'movie' : 'video';
}

function publicJob(job) {
  const { magnet, resume, resumeAs, uploadedBase, ...rest } = job;
  return rest;
}

function list() {
  load();
  return [...jobs.values()].sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt))).map(publicJob);
}

function get(id) {
  load();
  const job = jobs.get(id);
  if (!job) throw new TorrentError('That torrent is no longer in the list.', 'NOT_FOUND', 404);
  return job;
}

function parseMagnet(input) {
  const magnet = String(input || '').trim();
  if (!magnet) throw new TorrentError('Paste a magnet link or choose a .torrent file', 'INVALID', 400, { magnet: 'Paste a magnet link' });
  if (magnet.length > MAX_MAGNET_LENGTH) throw new TorrentError('That magnet link is too long', 'INVALID', 400, { magnet: 'That link is too long' });
  if (!/^magnet:\?/i.test(magnet)) throw new TorrentError('That isn’t a magnet link (they start with “magnet:?”)', 'INVALID', 400, { magnet: 'Magnet links start with “magnet:?”' });
  const params = new URLSearchParams(magnet.slice(8));
  const xts = params.getAll('xt');
  let infoHash = null;
  for (const xt of xts) {
    const hex = /^urn:btih:([0-9a-f]{40})$/i.exec(xt);
    if (hex) { infoHash = hex[1].toLowerCase(); break; }
    const b32 = /^urn:btih:([a-z2-7]{32})$/i.exec(xt);
    if (b32) { infoHash = base32ToHex(b32[1]); break; }
  }
  if (!infoHash) throw new TorrentError('This magnet link has no BitTorrent info-hash (xt=urn:btih:…)', 'INVALID', 400, { magnet: 'No info-hash (xt=urn:btih:…) in this link' });
  return { magnet, infoHash, name: (params.get('dn') || '').slice(0, 200) };
}

function base32ToHex(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

/**
 * Add a torrent. Resolves once the job exists (status "metadata"); the file
 * list arrives a moment later (status "ready").
 */
async function add({ magnet, torrentFile, type = 'auto', profileId = null } = {}) {
  load();
  if (jobs.size >= MAX_JOBS) throw new TorrentError(`The list is full (${MAX_JOBS}). Remove finished torrents first.`, 'TOO_MANY', 409);
  if (type !== 'auto' && !LIBRARY_KEYS[type]) throw new TorrentError('Pick Movies & Series, Music or Videos', 'INVALID', 400, { type: 'Pick a library' });

  let source;
  let infoHash = null;
  let name = '';
  if (torrentFile) {
    const buf = Buffer.isBuffer(torrentFile) ? torrentFile : Buffer.from(torrentFile);
    if (buf.length > MAX_TORRENT_FILE_BYTES) throw new TorrentError('That .torrent file is too big', 'INVALID', 400, { torrent: 'Too big for a .torrent file' });
    if (buf[0] !== 0x64 /* "d" */ || !buf.includes(Buffer.from('4:info'))) throw new TorrentError('That doesn’t look like a .torrent file', 'INVALID', 400, { torrent: 'Not a .torrent file' });
    source = buf;
  } else {
    ({ magnet, infoHash, name } = parseMagnet(magnet));
    source = magnet;
    const dupe = [...jobs.values()].find(j => j.infoHash === infoHash);
    if (dupe) throw new TorrentError(`“${dupe.name || 'This torrent'}” is already in the list.`, 'DUPLICATE', 409);
  }

  await ensureClient();

  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    infoHash,
    name: name || 'Fetching details…',
    status: 'metadata',
    requestedType: type,
    type: type === 'auto' ? null : type,
    files: [],
    totalBytes: 0,
    selectedBytes: 0,
    downloadedBytes: 0,
    progress: 0,
    downloadSpeed: 0,
    uploadSpeed: 0,
    uploaded: 0,
    peers: 0,
    error: null,
    addedAt: new Date().toISOString(),
    addedBy: profileId,
    magnet: torrentFile ? null : magnet,
    library: [],
  };
  if (torrentFile) await saveTorrentFile(job.id, source);
  jobs.set(job.id, job);
  changed();
  try {
    await attach(job, source);
  } catch (err) {
    jobs.delete(job.id);
    await fs.remove(path.join(deps.torrentDir, `${job.id}.torrent`)).catch(() => {});
    changed();
    throw err;
  }
  return publicJob(job);
}

async function saveTorrentFile(id, buf) {
  await fs.ensureDir(deps.torrentDir);
  await fs.writeFile(path.join(deps.torrentDir, `${id}.torrent`), buf);
}

async function readTorrentFile(id) {
  try {
    return await fs.readFile(path.join(deps.torrentDir, `${id}.torrent`));
  } catch {
    return null;
  }
}

/** Hand a job to the engine. Wires metadata/done/error and file selection. */
async function attach(job, source) {
  const c = await ensureClient();
  if (live.has(job.id)) return;
  const src = source || await readTorrentFile(job.id) || job.magnet;
  if (!src) throw new TorrentError('The torrent’s details are missing; remove it and add it again.', 'MISSING', 410);

  const staging = stagingFor(job);
  await fs.ensureDir(staging);
  if (job.status === 'waiting-vpn') {
    job.status = job.resumeAs || (job.files.length ? 'downloading' : 'metadata');
    delete job.resumeAs;
  }

  await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let torrent;
    try {
      torrent = c.add(src, { path: staging, deselect: true, announce: deps.clientOptions.announce });
    } catch (err) {
      settle(reject, new TorrentError(err.message, 'ENGINE', 400));
      return;
    }
    live.set(job.id, torrent);
    deps.onTorrent?.(torrent, job);

    torrent.on('infoHash', () => {
      const dupe = [...jobs.values()].find(j => j.id !== job.id && j.infoHash === torrent.infoHash);
      if (dupe) {
        detach(job.id, torrent);
        settle(reject, new TorrentError(`“${dupe.name}” is already in the list.`, 'DUPLICATE', 409));
        return;
      }
      job.infoHash = torrent.infoHash;
      settle(resolve);
    });
    torrent.on('metadata', () => onMetadata(job, torrent).catch(err => fail(job, err)));
    torrent.on('ready', () => onReady(job, torrent));
    torrent.on('done', () => checkFinished(job));
    torrent.on('error', (err) => {
      if (!settled) settle(reject, new TorrentError(friendly(err), 'ENGINE', 400));
      else fail(job, err);
    });
    torrent.on('warning', (err) => logger.debug?.(`[Torrents] ${job.id}: ${err.message}`));
  });
}

async function onMetadata(job, torrent) {
  const firstTime = !job.files.length;
  job.name = torrent.name || job.name;
  job.totalBytes = torrent.length;
  if (firstTime) {
    job.files = torrent.files.map((f, index) => {
      const kind = mediaKind(f.name);
      return {
        index,
        path: f.path,
        name: f.name,
        length: f.length,
        kind,
        // Preselect what Vault can use; leave out samples, .exe, .txt…
        selected: (kind === 'video' || kind === 'audio' || kind === 'sidecar')
          && !NEVER_EXT.has(extOf(f.name))
          && !/(^|[\/\\ ._-])sample([\/\\ ._-]|$)/i.test(f.path),
        downloaded: 0,
      };
    });
    job.suggestedType = guessType(job.files);
    if (!job.type) job.type = job.suggestedType;
    job.selectedBytes = job.files.filter(f => f.selected).reduce((n, f) => n + f.length, 0);
    if (job.status === 'metadata') job.status = 'ready';
    if (torrent.torrentFile && !(await readTorrentFile(job.id))) await saveTorrentFile(job.id, torrent.torrentFile);
    events.jobStart(`torrent:${job.id}`, 'torrent', `Torrent: ${job.name}`, 0, { torrentId: job.id });
  }
  changed();
}

function onReady(job, torrent) {
  // Re-attached after pause/VPN/restart: re-select what was chosen.
  if (job.status === 'downloading' || job.status === 'seeding' || job.status === 'moving') {
    select(job, torrent);
    if (job.status === 'downloading') checkFinished(job);
    if (job.status === 'moving') finish(job).catch(err => fail(job, err));
  }
  job.resume = false;
  changed();
}

function select(job, torrent = live.get(job.id)) {
  if (!torrent?.files?.length) return;
  torrent.files.forEach((file, i) => {
    if (job.files[i]?.selected) file.select();
    else file.deselect();
  });
}

function activeCount() {
  return [...jobs.values()].filter(j => j.status === 'downloading').length;
}

/** The admin picked files and a library: download. */
async function start(id, { files, type } = {}) {
  const job = get(id);
  if (!['ready', 'paused', 'error'].includes(job.status) && !(job.status === 'queued')) {
    throw new TorrentError('This torrent is already downloading.', 'BUSY', 409);
  }
  if (type !== undefined) {
    if (!LIBRARY_KEYS[type]) throw new TorrentError('Pick Movies & Series, Music or Videos', 'INVALID', 400, { type: 'Pick a library' });
    job.type = type;
  }
  if (!job.files.length) throw new TorrentError('Still fetching the file list — try again in a moment.', 'NO_METADATA', 409);
  if (Array.isArray(files)) {
    const wanted = new Set(files.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < job.files.length));
    job.files.forEach(f => {
      f.selected = wanted.has(f.index) && !NEVER_EXT.has(extOf(f.name));
    });
  }
  const chosen = job.files.filter(f => f.selected);
  if (!chosen.length) throw new TorrentError('Pick at least one file', 'INVALID', 400, { files: 'Pick at least one file' });
  job.selectedBytes = chosen.reduce((n, f) => n + f.length, 0);
  job.error = null;

  if (activeCount() >= settings().maxActive) {
    job.status = 'queued';
    changed();
    return publicJob(job);
  }
  job.status = 'downloading';
  job.startedAt = job.startedAt || new Date().toISOString();
  events.jobStart(`torrent:${job.id}`, 'torrent', `Torrent: ${job.name}`, job.selectedBytes, { torrentId: job.id });
  if (live.has(job.id)) {
    select(job);
  } else {
    job.resume = true;
    await attach(job);
  }
  changed();
  checkFinished(job);
  return publicJob(job);
}

async function pause(id) {
  const job = get(id);
  if (!['downloading', 'queued', 'waiting-vpn', 'metadata', 'seeding'].includes(job.status)) {
    throw new TorrentError('Only active torrents can be paused.', 'BUSY', 409);
  }
  const wasSeeding = job.status === 'seeding';
  await detach(job.id);
  job.resume = false;
  job.downloadSpeed = 0;
  job.uploadSpeed = 0;
  job.peers = 0;
  if (wasSeeding) {
    // "Stop sharing": the files are already in the library.
    await fs.remove(stagingFor(job)).catch(() => {});
    job.status = 'done';
    events.jobFinish(`torrent:${job.id}`, 'done', { name: job.name });
  } else {
    job.status = job.files.length ? 'paused' : 'ready';
  }
  changed();
  pumpQueue();
  return publicJob(job);
}

async function resume(id) {
  const job = get(id);
  if (!['paused', 'error', 'waiting-vpn'].includes(job.status)) throw new TorrentError('This torrent isn’t paused.', 'BUSY', 409);
  return start(id, {});
}

async function remove(id) {
  const job = get(id);
  jobs.delete(job.id);
  await detach(job.id);
  await fs.remove(stagingFor(job)).catch(() => {});
  await fs.remove(path.join(deps.torrentDir, `${job.id}.torrent`)).catch(() => {});
  if (!['done'].includes(job.status)) events.jobFinish(`torrent:${job.id}`, 'cancelled', { name: job.name });
  changed();
  pumpQueue();
  return { removed: true, id };
}

function pumpQueue() {
  const s = settings();
  if (!s.enabled) return;
  let slots = s.maxActive - activeCount();
  const queued = [...jobs.values()].filter(j => j.status === 'queued').sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
  for (const job of queued) {
    if (slots <= 0) break;
    slots -= 1;
    start(job.id, {}).catch(err => fail(job, err));
  }
}

/** Start the engine and pick up every job that was mid-flight. */
function resumeAll() {
  load();
  const s = settings();
  if (!s.enabled) return;
  const pending = [...jobs.values()].filter(j => j.resume);
  if (!pending.length) return;
  if (!vpnStatus(s).up) {
    pending.forEach(j => {
      if (['metadata', 'downloading', 'seeding', 'moving'].includes(j.status)) {
        j.resumeAs = j.status;
        j.status = 'waiting-vpn';
      }
    });
    startVpnWatch();
    changed();
    return;
  }
  for (const job of pending) {
    attach(job).catch((err) => {
      if (err.code === 'VPN_DOWN') return;
      fail(job, err);
    });
  }
}

function friendly(err) {
  const msg = String(err?.message || err || 'Unknown error');
  if (/ENOSPC/.test(msg)) return 'The disk is full.';
  if (/EACCES|EPERM/.test(msg)) return 'Vault can’t write to the library folder (permissions).';
  if (/Invalid torrent identifier/i.test(msg)) return 'That isn’t a valid magnet link or .torrent file.';
  return msg;
}

function fail(job, err) {
  logger.warn(`[Torrents] ${job.name}: ${err?.message || err}`);
  detach(job.id);
  job.status = 'error';
  job.error = err instanceof TorrentError ? err.message : friendly(err);
  job.downloadSpeed = 0;
  job.uploadSpeed = 0;
  job.resume = false;
  events.jobFinish(`torrent:${job.id}`, 'error', { name: job.name, error: job.error });
  changed();
  pumpQueue();
}

// ---------------------------------------------------------------------------
// Progress, completion, move into the library
// ---------------------------------------------------------------------------
function poll() {
  let any = false;
  for (const [id, torrent] of live) {
    const job = jobs.get(id);
    if (!job) continue;
    any = true;
    job.downloadSpeed = Math.round(torrent.downloadSpeed || 0);
    job.uploadSpeed = Math.round(torrent.uploadSpeed || 0);
    job.peers = torrent.numPeers || 0;
    job.uploaded = (job.uploadedBase || 0) + (torrent.uploaded || 0);
    if (job.status === 'downloading' && torrent.files?.length) {
      let done = 0;
      torrent.files.forEach((file, i) => {
        if (!job.files[i]) return;
        job.files[i].downloaded = Math.min(file.downloaded || 0, file.length);
        if (job.files[i].selected) done += job.files[i].downloaded;
      });
      job.downloadedBytes = done;
      job.progress = job.selectedBytes ? done / job.selectedBytes : 0;
      job.eta = job.downloadSpeed > 0 ? Math.round((job.selectedBytes - done) / job.downloadSpeed) : null;
      events.jobProgress(`torrent:${job.id}`, done, job.selectedBytes);
      checkFinished(job);
    }
    if (job.status === 'seeding') {
      const ratio = job.selectedBytes ? job.uploaded / job.selectedBytes : 0;
      job.ratio = Math.round(ratio * 100) / 100;
      if (ratio >= settings().seedRatio) pause(job.id).catch(() => {});
    }
  }
  if (any) changed();
}

function checkFinished(job) {
  if (job.status !== 'downloading') return;
  const torrent = live.get(job.id);
  if (!torrent?.files?.length) return;
  const complete = job.files.every((f, i) => !f.selected || (torrent.files[i] && (torrent.files[i].done || torrent.files[i].downloaded >= f.length)));
  if (!complete) return;
  job.status = 'moving';
  job.progress = 1;
  job.downloadedBytes = job.selectedBytes;
  changed();
  finish(job).catch(err => fail(job, err));
}

function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base}_${n}${ext}`);
  return candidate;
}

async function finish(job) {
  const root = getConfig().media?.paths?.[LIBRARY_KEYS[job.type] || 'videos'];
  if (!root) throw new TorrentError('That library has no folder set up.', 'NO_LIBRARY', 400);
  const seed = settings().seedRatio > 0;
  const staging = stagingFor(job);
  const torrent = live.get(job.id);
  if (!seed && torrent) {
    job.uploadedBase = (job.uploadedBase || 0) + (torrent.uploaded || 0);
    await detach(job.id, torrent);
  }

  const placed = [];
  for (const file of job.files.filter(f => f.selected)) {
    const parts = safeRelativeParts(file.path);
    if (!parts.length) continue;
    const src = path.join(staging, ...file.path.split(/[\\/]+/));
    // Never follow anything outside staging, whatever the torrent claims.
    if (!path.resolve(src).startsWith(path.resolve(staging) + path.sep)) continue;
    if (!(await fs.pathExists(src))) continue;
    const dir = path.join(root, ...parts.slice(0, -1));
    if (!path.resolve(dir).startsWith(path.resolve(root))) continue;
    await fs.ensureDir(dir);
    const target = uniqueTarget(dir, parts[parts.length - 1]);
    if (seed) {
      // Keep sharing from staging; the library gets a hard link (same disk)
      // or a copy (different disk).
      try {
        await fs.link(src, target);
      } catch {
        await fs.copy(src, target);
      }
    } else {
      await fs.move(src, target);
    }
    placed.push({ target, kind: file.kind });
  }

  const added = [];
  for (const { target, kind } of placed) {
    if (kind !== 'video' && kind !== 'audio') continue;
    try {
      const item = await deps.scanFile(target);
      if (item?.id) added.push(item.id);
    } catch (err) {
      logger.warn(`[Torrents] couldn't index ${path.basename(target)}: ${err.message}`);
    }
  }
  job.library = added;
  job.placed = placed.length;
  job.finishedAt = new Date().toISOString();
  job.downloadSpeed = 0;
  job.eta = null;

  if (seed && live.has(job.id)) {
    job.status = 'seeding';
  } else {
    if (live.has(job.id)) await detach(job.id);
    await fs.remove(staging).catch(() => {});
    job.status = 'done';
  }
  events.jobFinish(`torrent:${job.id}`, 'done', { name: job.name, imported: added.length });
  logger.info(`[Torrents] “${job.name}” finished — ${placed.length} file(s) in ${job.type}`);
  changed();
  pumpQueue();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function status() {
  load();
  const s = settings();
  return {
    settings: publicSettings(s),
    engine: client ? { installed: true, running: true, error: null } : { ...(await engineAvailable()), running: false },
    vpn: vpnStatus(s),
    stagingDir: stagingRoot(),
    jobs: list(),
  };
}

/** Called once at server start: resume what was downloading. */
function init() {
  load();
  if (settings().enabled && [...jobs.values()].some(j => j.resume)) {
    // Let the server finish starting first.
    const t = setTimeout(() => { resumeAll(); pumpQueue(); }, 3000);
    t.unref?.();
  } else if (settings().enabled) {
    pumpQueue();
  }
}

async function shutdown() {
  persistNow();
  stopVpnWatch();
  if (client) {
    const c = client;
    client = null;
    live.clear();
    stopPolling();
    await new Promise(resolve => c.destroy(() => resolve()));
  }
}

/** Test helper: forget all in-memory state. */
function _reset() {
  for (const id of [...live.keys()]) detach(id);
  jobs.clear();
  loaded = false;
  engineError = null;
}

module.exports = {
  settings,
  updateSettings,
  publicSettings,
  status,
  list,
  add,
  start,
  pause,
  resume,
  remove,
  listInterfaces,
  vpnStatus,
  parseMagnet,
  guessType,
  init,
  shutdown,
  checkVpn,
  TorrentError,
  STAGING_DIR,
  deps,
  _reset,
  get _engineError() { return engineError; },
};
