/**
 * Move Vault to another computer — everything, with its formatting.
 *
 * EXPORT produces one package (a .zip download, or a plain folder written to
 * e.g. a USB drive) that contains:
 *
 *   vault-transfer.json   manifest: where every media folder came from
 *   README.txt            what this is and how to import it
 *   media/<Library>/…     every library folder with its exact sub-folders,
 *                         file names, posters, .nfo, subtitles and lyrics
 *   data/…                library index, playlists, favourites, watch
 *                         history and progress, profiles, collections,
 *                         markers, podcasts, Live TV, sign-in sessions …
 *   cache/covers, lyrics  uploaded / extracted artwork and lyrics
 *   config/config.json    settings, account, grid pattern, libraries
 *
 * Regenerable caches (thumbnails, scrub previews, transcodes), the trash and
 * old backups are left out.
 *
 * IMPORT on the new server copies the media into a folder of your choice and
 * then rewrites every reference to the old locations. Library item ids are
 * derived from the file path (md5), so a different path means a different
 * id: playlists, favourites, watched state, markers, per-profile history and
 * artwork file names all point at the old ids. The import builds an
 * old-id → new-id map and rewrites every JSON file (values *and* keys), so
 * everything lines up on the new machine. The result is staged and swapped
 * in on the next start (services/transferApply.js) — the running server
 * would otherwise overwrite it from memory on shutdown.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const zip = require('../utils/zipStream');
const { stagingDir, READY_FILE } = require('./transferApply');

const SERVER_DIR = path.join(__dirname, '..');
const FORMAT = 'vault-transfer';
const VERSION = 1;
const MANIFEST = 'vault-transfer.json';

// Top-level names in server/data that must not travel.
const SKIP_DATA = new Set(['backups', 'trash', 'trash.json', 'bruteforce.json', 'library.db', 'library.db-wal', 'library.db-shm', 'library.db-journal']);
const CACHE_DIRS = ['covers', 'lyrics'];
const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.+|\.Spotlight-V100|\.Trashes|\.fseventsd|\.TemporaryItems|\.AppleDouble|__MACOSX|.+\.vault-partial|\.vault-transfer-upload-.+)$/i;
const ID_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

function isInside(child, parent) {
  if (child === parent) return true;
  const base = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(base);
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A folder/file name that is valid on every OS. */
function safeSegment(name, fallback = 'Library') {
  let out = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!out) out = fallback;
  if (WINDOWS_RESERVED.test(out)) out = `${out}_`;
  return out.slice(0, 120);
}

/** Names inside the media folders are kept exactly, except where this OS can't store them. */
function localSegment(name, platform = process.platform) {
  return platform === 'win32' ? safeSegment(name, '_') : name;
}

function uniqueName(base, used) {
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base} (${n++})`;
  used.add(name.toLowerCase());
  return name;
}

async function freeBytes(dir) {
  let d = path.resolve(dir);
  while (!exists(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    const s = await fsp.statfs(d);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(i && value < 10 ? 1 : 0)} ${units[i]}`;
}

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
}

/** Walk a folder: yields { rel (posix), path, size, mtime }. Skips OS junk and symlinked folders. */
async function* walk(root, { skipDirs = new Set() } = {}) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const dirs = [];
    for (const entry of entries) {
      if (JUNK.test(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(path.resolve(childAbs))) dirs.push(childRel);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let stat;
      try { stat = await fsp.stat(childAbs); } catch { continue; }
      if (!stat.isFile()) continue; // symlinked folders could loop forever
      yield { rel: childRel, path: childAbs, size: stat.size, mtime: stat.mtime };
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
/**
 * Every media folder Vault knows about, each mapped to a folder in the
 * package. Folders inside another library folder are recorded but not
 * walked twice.
 */
function collectRoots(config) {
  const media = config?.media || {};
  const refs = [];
  for (const [key, dir] of Object.entries(media.paths || {})) {
    if (typeof dir === 'string' && dir) refs.push({ dir: path.resolve(dir), label: key.charAt(0).toUpperCase() + key.slice(1), pathKeys: [key] });
  }
  for (const lib of Array.isArray(media.libraries) ? media.libraries : []) {
    if (!lib) continue;
    const dirs = Array.isArray(lib.paths) && lib.paths.length ? lib.paths : (lib.path ? [lib.path] : []);
    for (const d of dirs) if (typeof d === 'string' && d) refs.push({ dir: path.resolve(d), label: lib.name || lib.type || 'Library' });
  }
  const seen = new Map();
  for (const ref of refs) {
    const first = seen.get(ref.dir);
    if (!first) seen.set(ref.dir, { ...ref, pathKeys: [...(ref.pathKeys || [])] });
    else first.pathKeys.push(...(ref.pathKeys || []));
  }
  const sorted = [...seen.values()].sort((a, b) => a.dir.length - b.dir.length);

  const used = new Set(['other']);
  const roots = [];
  for (const ref of sorted) {
    const parent = roots.find(r => !r.parent && isInside(ref.dir, r.original));
    if (parent) {
      const rel = path.relative(parent.original, ref.dir).split(path.sep).join('/');
      roots.push({ original: ref.dir, label: ref.label, pathKeys: ref.pathKeys, parent: parent.archive, archive: `${parent.archive}/${rel}` });
    } else {
      roots.push({ original: ref.dir, label: ref.label, pathKeys: ref.pathKeys, archive: `media/${uniqueName(safeSegment(ref.label), used)}` });
    }
  }
  return roots;
}

/** Library items whose files live outside every library folder (rare: moved roots, old uploads). */
function outsideRoots(items, roots) {
  const top = roots.filter(r => !r.parent);
  const byDir = new Map();
  for (const item of items) {
    if (!item?.path || typeof item.path !== 'string') continue;
    const p = path.resolve(item.path);
    if (top.some(r => isInside(p, r.original))) continue;
    const dir = path.dirname(p);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(p);
  }
  const used = new Set();
  return [...byDir.entries()].map(([dir, files]) => ({
    original: dir,
    label: path.basename(dir) || 'Other',
    archive: `media/Other/${uniqueName(safeSegment(path.basename(dir), 'Files'), used)}`,
    files,
    other: true,
  }));
}

function readme(manifest) {
  const lines = [
    'VAULT TRANSFER PACKAGE',
    '======================',
    '',
    `Made on ${manifest.source.hostname} (${manifest.source.platform}) on ${manifest.createdAt}.`,
    manifest.includesMedia
      ? `Contains ${manifest.counts.mediaFiles} media files (${formatBytes(manifest.counts.mediaBytes)}) and ${manifest.counts.libraryItems} library items.`
      : `Settings and library data only (${manifest.counts.libraryItems} library items) — no media files.`,
    '',
    'WHAT IS INSIDE',
    '  media/          your library folders, exactly as they were organised',
    '  data/           playlists, favourites, watch history, profiles, collections …',
    '  cache/          uploaded and extracted cover art, lyrics',
    '  config/         settings, sign-in and library setup',
    '',
    'The media/ folder is just your files: you can open and copy them anywhere.',
    '',
    'MOVE IT TO A NEW VAULT SERVER',
    '  1. Install Vault on the new computer (git clone …, npm install, npm start).',
    '  2. Open Vault there. In the setup wizard choose "Import from another Vault",',
    '     or in Settings > Move to another server choose "Import".',
    '     Pick this .zip (or this folder, if you unzipped it).',
    '  Or from a terminal in the new Vault-V2 folder:',
    '       npm run import -- "/path/to/this/package"',
    '',
    'You sign in on the new server with the same username, password and grid.',
    '',
    'Library folders in this package:',
    ...manifest.roots.filter(r => !r.parent).map(r => `  ${r.archive}/   (was ${r.original})`),
    '',
  ];
  return lines.join('\n');
}

/**
 * List everything that goes into a transfer package.
 * @returns {{ entries: object[], manifest: object }}
 */
async function planExport({ includeMedia = true, serverDir = SERVER_DIR, config, signal } = {}) {
  config = config || require('../config').getConfig();
  const dataDir = path.join(serverDir, 'data');
  const items = readJsonFile(path.join(dataDir, 'library.json'), []);
  const roots = collectRoots(config);
  const extra = outsideRoots(Array.isArray(items) ? items : [], roots);
  const allRoots = [...roots, ...extra];
  const skipDirs = new Set(['cache', 'data', 'backups', 'node_modules', '.transfer-staging'].map(n => path.resolve(serverDir, n)));

  const entries = [];
  const counts = { mediaFiles: 0, mediaBytes: 0, dataFiles: 0, artworkFiles: 0, libraryItems: Array.isArray(items) ? items.length : 0 };
  const rootStats = new Map(allRoots.map(r => [r.archive, { files: 0, bytes: 0 }]));

  if (includeMedia) {
    for (const root of roots.filter(r => !r.parent)) {
      for await (const file of walk(root.original, { skipDirs })) {
        checkAbort(signal);
        entries.push({ name: `${root.archive}/${file.rel}`, size: file.size, mtime: file.mtime, path: file.path });
        counts.mediaFiles += 1;
        counts.mediaBytes += file.size;
        const stat = rootStats.get(root.archive);
        stat.files += 1;
        stat.bytes += file.size;
      }
    }
    for (const root of extra) {
      for (const file of root.files) {
        let stat;
        try { stat = await fsp.stat(file); } catch { continue; }
        if (!stat.isFile()) continue;
        entries.push({ name: `${root.archive}/${path.basename(file)}`, size: stat.size, mtime: stat.mtime, path: file });
        counts.mediaFiles += 1;
        counts.mediaBytes += stat.size;
        const s = rootStats.get(root.archive);
        s.files += 1;
        s.bytes += stat.size;
      }
    }
  }

  for await (const file of walk(dataDir)) {
    const top = file.rel.split('/')[0];
    if (SKIP_DATA.has(top) || /\.tmp$/i.test(file.rel)) continue;
    entries.push({ name: `data/${file.rel}`, size: file.size, mtime: file.mtime, path: file.path });
    counts.dataFiles += 1;
  }
  for (const sub of CACHE_DIRS) {
    for await (const file of walk(path.join(serverDir, 'cache', sub))) {
      entries.push({ name: `cache/${sub}/${file.rel}`, size: file.size, mtime: file.mtime, path: file.path });
      counts.artworkFiles += 1;
    }
  }
  const configFile = path.join(serverDir, 'config.json');
  if (exists(configFile)) {
    entries.push({ name: 'config/config.json', data: fs.readFileSync(configFile), mtime: fs.statSync(configFile).mtime });
  }

  let vaultVersion = null;
  try { vaultVersion = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8')).version; } catch { /* unknown */ }
  const manifest = {
    format: FORMAT,
    version: VERSION,
    createdAt: new Date().toISOString(),
    vaultVersion,
    includesMedia: Boolean(includeMedia),
    source: { hostname: os.hostname(), platform: process.platform, sep: path.sep, serverDir: path.resolve(serverDir) },
    roots: allRoots.map(r => ({
      archive: r.archive,
      original: r.original,
      label: r.label,
      ...(r.parent ? { parent: r.parent } : {}),
      ...(r.other ? { other: true } : {}),
      // Which media.paths keys point here — so a folder that was only a
      // built-in default (not written in config.json) still gets wired up.
      ...(r.pathKeys?.length ? { pathKeys: r.pathKeys } : {}),
      files: rootStats.get(r.archive).files,
      bytes: rootStats.get(r.archive).bytes,
    })),
    counts,
  };
  const now = new Date();
  entries.unshift(
    { name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: now },
    { name: 'README.txt', data: Buffer.from(readme(manifest).replace(/\n/g, os.EOL)), mtime: now },
  );
  return { entries, manifest };
}

function packageName(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return `Vault transfer - ${safeSegment(os.hostname(), 'server')} - ${day}`;
}

/** Summary for the UI: how big the package will be. */
async function summarize(options = {}) {
  const { entries, manifest } = await planExport(options);
  const plan = zip.layout(entries);
  return {
    includesMedia: manifest.includesMedia,
    counts: manifest.counts,
    roots: manifest.roots.filter(r => !r.parent).map(r => ({ label: r.label, original: r.original, archive: r.archive, files: r.files, bytes: r.bytes })),
    zipBytes: plan.totalBytes,
    fileName: `${packageName()}.zip`,
  };
}

/** Write the package as a plain folder (e.g. onto a USB drive). Manifest goes last: a half-copied folder is never mistaken for a complete one. */
async function exportToFolder({ dir, includeMedia = true, serverDir = SERVER_DIR, config, onProgress, signal } = {}) {
  if (!dir || !path.isAbsolute(dir)) throw Object.assign(new Error('Choose a full folder path, e.g. /Volumes/MyDrive'), { code: 'INVALID' });
  if (!exists(dir)) throw Object.assign(new Error(`The folder ${dir} doesn’t exist (is the drive plugged in?)`), { code: 'NOT_FOUND' });
  const { entries, manifest } = await planExport({ includeMedia, serverDir, config, signal });
  const total = entries.reduce((sum, e) => sum + (e.data ? e.data.length : e.size), 0);
  const free = await freeBytes(dir);
  if (free !== null && free < total + 50 * 1024 * 1024) {
    throw Object.assign(new Error(`Not enough space in ${dir}: the transfer needs ${formatBytes(total)} but only ${formatBytes(free)} is free`), { code: 'NO_SPACE' });
  }
  const base = packageName();
  let target = path.join(dir, base);
  for (let n = 2; exists(target); n++) target = path.join(dir, `${base} (${n})`);
  await fsp.mkdir(target, { recursive: true });

  let done = 0;
  const ordered = [...entries.slice(1), entries[0]];
  for (const [index, entry] of ordered.entries()) {
    checkAbort(signal);
    const dest = path.join(target, ...entry.name.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (entry.data) await fsp.writeFile(dest, entry.data);
    else await fsp.copyFile(entry.path, dest);
    if (entry.mtime) await fsp.utimes(dest, entry.mtime, entry.mtime).catch(() => {});
    done += entry.data ? entry.data.length : entry.size;
    onProgress?.({ phase: 'copy', bytesDone: done, bytesTotal: total, filesDone: index + 1, filesTotal: ordered.length, current: entry.name });
  }
  return { folder: target, files: entries.length, bytes: total, counts: manifest.counts };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
function cleanRel(name) {
  const parts = String(name).replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..') || /^[a-z]:$/i.test(parts[0] || '')) return null; // zip-slip guard
  return parts.join('/');
}

/** Open a .zip or an unzipped folder as a list of entries. */
async function openSource(source) {
  if (!source || !path.isAbsolute(source)) throw Object.assign(new Error('Enter the full path to the transfer .zip or folder'), { code: 'INVALID' });
  let stat;
  try { stat = await fsp.stat(source); } catch {
    throw Object.assign(new Error(`Can’t find ${source}`), { code: 'NOT_FOUND' });
  }
  let entries;
  let kind;
  if (stat.isDirectory()) {
    kind = 'folder';
    entries = [];
    for await (const file of walk(source)) entries.push({ name: file.rel, size: file.size, mtime: file.mtime, path: file.path });
  } else {
    kind = 'zip';
    entries = (await zip.listZip(source)).filter(e => !e.directory);
  }
  // The package may sit one level down (a re-zipped or copied folder).
  const manifests = entries.filter(e => e.name === MANIFEST || e.name.endsWith(`/${MANIFEST}`)).filter(e => !e.name.startsWith('__MACOSX/'));
  manifests.sort((a, b) => a.name.length - b.name.length);
  if (!manifests.length) {
    throw Object.assign(new Error('This isn’t a Vault transfer package (vault-transfer.json is missing). If you copied it to a drive, make sure the copy finished.'), { code: 'NOT_A_TRANSFER' });
  }
  const prefix = manifests[0].name.slice(0, manifests[0].name.length - MANIFEST.length);
  const scoped = [];
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const rel = cleanRel(e.name.slice(prefix.length));
    if (!rel) continue;
    if (rel.split('/').some(seg => JUNK.test(seg))) continue;
    scoped.push({ ...e, rel });
  }
  const open = (entry) => (kind === 'zip' ? zip.openEntry(source, entry) : fs.createReadStream(entry.path));
  const read = async (entry) => {
    const chunks = [];
    for await (const chunk of await open(entry)) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const manifestEntry = scoped.find(e => e.rel === MANIFEST);
  let manifest;
  try { manifest = JSON.parse((await read(manifestEntry)).toString('utf8')); } catch {
    throw Object.assign(new Error('The package’s vault-transfer.json is damaged'), { code: 'NOT_A_TRANSFER' });
  }
  if (manifest.format !== FORMAT) throw Object.assign(new Error('This isn’t a Vault transfer package'), { code: 'NOT_A_TRANSFER' });
  if (Number(manifest.version) > VERSION) {
    throw Object.assign(new Error('This package was made by a newer Vault. Update this server (git pull, npm install) and try again.'), { code: 'TOO_NEW' });
  }
  const folderRoot = kind === 'folder' ? path.join(source, ...prefix.split('/').filter(Boolean)) : null;
  return { kind, source, folderRoot, entries: scoped, manifest, open, read };
}

async function inspect(source) {
  const src = await openSource(source);
  const { manifest } = src;
  return {
    kind: src.kind,
    createdAt: manifest.createdAt,
    source: { hostname: manifest.source?.hostname, platform: manifest.source?.platform },
    vaultVersion: manifest.vaultVersion,
    includesMedia: manifest.includesMedia,
    counts: manifest.counts,
    roots: (manifest.roots || []).filter(r => !r.parent).map(r => ({ label: r.label, archive: r.archive, original: r.original, files: r.files, bytes: r.bytes })),
    mediaBytesPresent: src.entries.filter(e => e.rel.startsWith('media/')).reduce((s, e) => s + e.size, 0),
  };
}

/**
 * Where each package folder goes on this computer.
 *   copyMedia (default)       <mediaDir>/<Library>/…
 *   folder + copyMedia=false  use the unzipped package's media/ folders where they are
 *   no media in the package   the old location if it exists here, else <mediaDir>/<Library>
 */
function planTargets(src, { mediaDir, copyMedia }) {
  const { manifest } = src;
  const inPlace = !copyMedia && src.kind === 'folder' && manifest.includesMedia;
  const targets = new Map();
  const roots = manifest.roots || [];
  for (const root of roots.filter(r => !r.parent)) {
    const segs = root.archive.split('/').slice(1);
    let target;
    if (inPlace) target = path.join(src.folderRoot, ...root.archive.split('/'));
    else if (manifest.includesMedia) target = path.join(mediaDir, ...segs.map(s => localSegment(s)));
    else target = path.isAbsolute(root.original) && exists(root.original) ? root.original : path.join(mediaDir, ...segs.map(s => localSegment(s)));
    targets.set(root.archive, path.resolve(target));
  }
  for (const root of roots.filter(r => r.parent)) {
    const parent = targets.get(root.parent);
    if (!parent) continue;
    const rest = root.archive.slice(root.parent.length + 1).split('/').filter(Boolean);
    targets.set(root.archive, path.join(parent, ...rest.map(s => localSegment(s))));
  }
  return { targets, inPlace };
}

/** Rewrites old absolute paths to new ones and old item ids to new ones. */
function createRemapper(manifest, targets, serverDir, items) {
  const srcSep = manifest.source?.sep === '\\' ? '\\' : '/';
  const prefixes = [];
  for (const root of manifest.roots || []) {
    const to = targets.get(root.archive);
    if (root.original && to) prefixes.push({ from: root.original, to });
  }
  if (manifest.source?.serverDir) prefixes.push({ from: manifest.source.serverDir, to: path.resolve(serverDir) });
  prefixes.sort((a, b) => b.from.length - a.from.length);
  const splitRest = rest => (srcSep === '\\' ? rest.split(/[\\/]/) : rest.split('/')).filter(Boolean);
  const fold = s => (srcSep === '\\' ? s.toLowerCase() : s);

  function remapPath(value) {
    if (typeof value !== 'string' || !value) return null;
    const v = fold(value);
    for (const p of prefixes) {
      const from = fold(p.from);
      if (v === from) return p.to;
      const base = from.endsWith(srcSep) ? from : from + srcSep;
      if (v.startsWith(base)) return path.join(p.to, ...splitRest(value.slice(base.length)).map(s => localSegment(s)));
    }
    return null;
  }

  const idMap = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item.path !== 'string' || typeof item.id !== 'string') continue;
    const next = remapPath(item.path);
    if (!next) continue;
    const newId = md5(next);
    if (newId !== item.id) idMap.set(item.id, newId);
  }

  function remapString(value) {
    if (idMap.has(value)) return idMap.get(value);
    let out = remapPath(value) ?? value;
    if (idMap.size && out.length >= 32) out = out.replace(ID_RE, m => idMap.get(m) || m);
    return out;
  }

  function remapValue(value) {
    if (typeof value === 'string') return remapString(value);
    if (Array.isArray(value)) return value.map(remapValue);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, inner] of Object.entries(value)) out[remapString(key)] = remapValue(inner);
      return out;
    }
    return value;
  }

  return { remapPath, remapString, remapValue, idMap };
}

async function copyStream(readable, dest, mtime, signal) {
  const partial = `${dest}.vault-partial`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(readable, fs.createWriteStream(partial), { signal });
  await fsp.rename(partial, dest);
  if (mtime) await fsp.utimes(dest, mtime, mtime).catch(() => {});
}

/**
 * Import a package. Media is copied right away; data and settings are
 * staged and swapped in on the next start.
 */
async function importTransfer({ source, mediaDir, copyMedia = true, serverDir = SERVER_DIR, onProgress, signal } = {}) {
  const src = await openSource(source);
  const { manifest } = src;
  mediaDir = path.resolve(mediaDir || path.join(serverDir, 'media'));
  if (!path.isAbsolute(mediaDir)) throw Object.assign(new Error('Choose a full folder path for your media'), { code: 'INVALID' });
  const { targets, inPlace } = planTargets(src, { mediaDir, copyMedia });

  // --- 1. media files
  const topRoots = (manifest.roots || []).filter(r => !r.parent).sort((a, b) => b.archive.length - a.archive.length);
  const mediaEntries = inPlace ? [] : src.entries.filter(e => e.rel.startsWith('media/'));
  const plan = mediaEntries.map((entry) => {
    const root = topRoots.find(r => entry.rel === r.archive || entry.rel.startsWith(`${r.archive}/`));
    const base = root ? targets.get(root.archive) : mediaDir;
    const rest = root ? entry.rel.slice(root.archive.length + 1) : entry.rel.slice('media/'.length);
    return { entry, dest: path.join(base, ...rest.split('/').map(s => localSegment(s))) };
  });
  let needed = 0;
  for (const { entry, dest } of plan) {
    let present = null;
    try { present = fs.statSync(dest); } catch { /* new file */ }
    if (!present || present.size !== entry.size) needed += entry.size;
  }
  const free = await freeBytes(mediaDir);
  if (free !== null && free < needed + 100 * 1024 * 1024) {
    throw Object.assign(new Error(`Not enough space in ${mediaDir}: the media needs ${formatBytes(needed)} but only ${formatBytes(free)} is free. Choose a folder on a bigger drive.`), { code: 'NO_SPACE' });
  }
  const bytesTotal = plan.reduce((s, p) => s + p.entry.size, 0);
  let bytesDone = 0;
  let copied = 0;
  let skipped = 0;
  let replaced = 0;
  for (const [index, { entry, dest }] of plan.entries()) {
    checkAbort(signal);
    let present = null;
    try { present = fs.statSync(dest); } catch { /* new file */ }
    if (present && present.size === entry.size) {
      skipped += 1; // already there (e.g. an earlier, interrupted import)
    } else {
      if (present) replaced += 1;
      await copyStream(await src.open(entry), dest, entry.mtime, signal);
      copied += 1;
    }
    bytesDone += entry.size;
    onProgress?.({ phase: 'media', bytesDone, bytesTotal, filesDone: index + 1, filesTotal: plan.length, current: entry.rel });
  }

  // --- 2. library data + settings → staging
  onProgress?.({ phase: 'data', bytesDone, bytesTotal, filesDone: plan.length, filesTotal: plan.length });
  const staging = stagingDir(serverDir);
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });

  const libEntry = src.entries.find(e => e.rel === 'data/library.json');
  let library = [];
  let libraryParsed = false;
  if (libEntry) {
    try { library = JSON.parse((await src.read(libEntry)).toString('utf8')); libraryParsed = true; } catch { library = []; }
  }
  const remap = createRemapper(manifest, targets, serverDir, library);
  const renameRel = rel => rel.split('/').map(seg => seg.replace(ID_RE, m => remap.idMap.get(m) || m)).join('/');

  let dataFiles = 0;
  let artworkFiles = 0;
  for (const entry of src.entries) {
    checkAbort(signal);
    let destRel = null;
    if (entry.rel.startsWith('data/')) {
      const top = entry.rel.split('/')[1];
      if (SKIP_DATA.has(top)) continue;
      destRel = renameRel(entry.rel);
      dataFiles += 1;
    } else if (CACHE_DIRS.some(sub => entry.rel.startsWith(`cache/${sub}/`))) {
      destRel = renameRel(entry.rel);
      artworkFiles += 1;
    } else {
      continue;
    }
    const dest = path.join(staging, ...destRel.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (/\.json$/i.test(entry.rel)) {
      const isLibrary = entry === libEntry && libraryParsed;
      const raw = isLibrary ? null : (await src.read(entry)).toString('utf8');
      let value;
      try { value = isLibrary ? library : JSON.parse(raw); } catch { value = undefined; }
      if (value === undefined) { await fsp.writeFile(dest, raw); continue; }
      value = remap.remapValue(value);
      if (isLibrary && Array.isArray(value)) {
        for (const item of value) {
          if (!item || typeof item !== 'object') continue;
          item.mtime = null; // rescan once on the new machine (thumbnails, codecs) — hand edits are kept
          delete item.trickplay; // scrub previews are regenerated
        }
      }
      await fsp.writeFile(dest, JSON.stringify(value));
    } else {
      await copyStream(await src.open(entry), dest, entry.mtime, signal);
    }
  }
  // Trash stays behind with the old server.
  if (exists(path.join(staging, 'data'))) await fsp.writeFile(path.join(staging, 'data', 'trash.json'), '[]');

  // --- 3. settings
  const cfgEntry = src.entries.find(e => e.rel === 'config/config.json');
  if (cfgEntry) {
    let imported = null;
    try { imported = JSON.parse((await src.read(cfgEntry)).toString('utf8')); } catch { imported = null; }
    if (imported && typeof imported === 'object') {
      const next = remap.remapValue(imported);
      const current = readJsonFile(path.join(serverDir, 'config.json'), null);
      // Network settings belong to the machine, not the library.
      if (current?.server) next.server = current.server;
      const origins = new Set([...(next.cors?.origins || []), ...(current?.cors?.origins || [])]);
      if (origins.size) next.cors = { ...(next.cors || {}), origins: [...origins] };
      const cacheDir = next.media?.transcoding?.cacheDir;
      if (cacheDir && (!path.isAbsolute(cacheDir) || !exists(path.dirname(cacheDir)))) next.media.transcoding.cacheDir = path.join(serverDir, 'cache', 'transcoded');
      // Folders the old server used by default (absent from its config.json)
      // would otherwise fall back to this machine's defaults and lose their files.
      for (const root of manifest.roots || []) {
        if (!root.files || !Array.isArray(root.pathKeys)) continue;
        const target = targets.get(root.archive);
        if (!target) continue;
        next.media = next.media || {};
        next.media.paths = next.media.paths || {};
        for (const key of root.pathKeys) if (typeof next.media.paths[key] !== 'string') next.media.paths[key] = target;
      }
      if (next.media?.paths) for (const dir of Object.values(next.media.paths)) if (typeof dir === 'string') await fsp.mkdir(dir, { recursive: true }).catch(() => {});
      next.onboarding = { ...(next.onboarding || {}), completedAt: next.onboarding?.completedAt || new Date().toISOString(), enablement: true };
      await fsp.writeFile(path.join(staging, 'config.json'), JSON.stringify(next, null, 2));
    }
  }
  // Report (and create) the folders that hold something; empty libraries
  // keep this machine's defaults.
  const reportRoots = (manifest.roots || []).filter(r => !r.parent && targets.get(r.archive));
  const shown = reportRoots.some(r => r.files) ? reportRoots.filter(r => r.files) : reportRoots;
  for (const r of shown) await fsp.mkdir(targets.get(r.archive), { recursive: true }).catch(() => {});

  const summary = {
    importedAt: new Date().toISOString(),
    source: { hostname: manifest.source?.hostname, platform: manifest.source?.platform, createdAt: manifest.createdAt },
    items: Array.isArray(library) ? library.length : 0,
    idsRemapped: remap.idMap.size,
    media: { copied, skipped, replaced, bytes: bytesTotal, inPlace },
    dataFiles,
    artworkFiles,
    folders: shown.map(r => ({ label: r.label, path: targets.get(r.archive) })),
    settings: Boolean(cfgEntry),
  };
  await fsp.writeFile(path.join(staging, 'transfer.json'), JSON.stringify(summary, null, 2));
  await fsp.writeFile(path.join(staging, READY_FILE), summary.importedAt);
  onProgress?.({ phase: 'done', bytesDone, bytesTotal, filesDone: plan.length, filesTotal: plan.length });
  return { ...summary, restartRequired: true };
}

function hasPendingImport(serverDir = SERVER_DIR) {
  return exists(path.join(stagingDir(serverDir), READY_FILE));
}

module.exports = {
  FORMAT,
  VERSION,
  MANIFEST,
  SERVER_DIR,
  planExport,
  summarize,
  exportToFolder,
  packageName,
  inspect,
  importTransfer,
  hasPendingImport,
  freeBytes,
  formatBytes,
  _internals: { collectRoots, outsideRoots, createRemapper, planTargets, safeSegment, cleanRel, openSource },
};
