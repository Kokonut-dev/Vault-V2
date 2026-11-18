#!/usr/bin/env node
/**
 * Move Vault to another computer from a terminal — handy for very large
 * libraries or when the old server has no browser nearby.
 *
 *   npm run export -- <folder> [--zip] [--no-media]
 *       Writes a transfer package into <folder> (e.g. /Volumes/MyDrive):
 *       a plain folder by default, or one .zip file with --zip.
 *       --no-media: settings, library data and artwork only.
 *
 *   npm run import -- <package.zip | package folder> [--media-dir <dir>] [--in-place]
 *       Copies the media into --media-dir (default: server/media) and
 *       prepares the library data and settings. They are loaded the next
 *       time Vault starts (npm start, or Restart in the app).
 *       --in-place: use the media where it is in an unzipped package
 *       folder instead of copying it (e.g. keep it on that USB drive).
 *
 * Works from the Vault-V2 folder or Vault-V2/server.
 */
const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const deps = require(path.join(SERVER_DIR, 'utils', 'deps'));
if (deps.nodeTooOld()) { console.error(deps.explainNodeTooOld()); process.exit(1); }
const missing = deps.missingDependencies(SERVER_DIR);
if (missing.length) { console.error(deps.explainMissing(missing)); process.exit(1); }

const transfer = require(path.join(SERVER_DIR, 'services', 'transfer'));
const zip = require(path.join(SERVER_DIR, 'utils', 'zipStream'));

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith('--')));
const positional = [];
let mediaDir = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--media-dir') { mediaDir = rest[++i]; continue; }
  if (rest[i].startsWith('--media-dir=')) { mediaDir = rest[i].slice('--media-dir='.length); continue; }
  if (!rest[i].startsWith('--')) positional.push(rest[i]);
}

function usage(code = 1) {
  console.log(`Usage:
  npm run export -- <folder> [--zip] [--no-media]
  npm run import -- <package.zip | folder> [--media-dir <dir>] [--in-place]`);
  process.exit(code);
}

let lastLine = 0;
function progress(p) {
  const now = Date.now();
  if (now - lastLine < 1000 && p.phase !== 'done') return;
  lastLine = now;
  const pct = p.bytesTotal ? Math.floor((p.bytesDone / p.bytesTotal) * 100) : 100;
  const what = p.phase === 'data' ? 'library data' : `${p.filesDone}/${p.filesTotal} files`;
  process.stdout.write(`  ${String(pct).padStart(3)}%  ${transfer.formatBytes(p.bytesDone)} of ${transfer.formatBytes(p.bytesTotal)}  (${what})\n`);
}

const abort = new AbortController();
process.on('SIGINT', () => { console.log('\nStopping…'); abort.abort(); });

async function runExport() {
  const target = positional[0] && path.resolve(positional[0]);
  if (!target) usage();
  if (!fs.existsSync(target)) throw new Error(`${target} doesn't exist (is the drive plugged in?)`);
  const includeMedia = !flags.has('--no-media');
  if (flags.has('--zip')) {
    const { entries, manifest } = await transfer.planExport({ includeMedia, serverDir: SERVER_DIR });
    const plan = zip.layout(entries);
    const free = await transfer.freeBytes(target);
    if (free !== null && free < plan.totalBytes) throw new Error(`Not enough space: needs ${transfer.formatBytes(plan.totalBytes)}, ${transfer.formatBytes(free)} free`);
    const file = path.join(target, `${transfer.packageName()}${includeMedia ? '' : ' (settings only)'}.zip`);
    console.log(`Writing ${file}\n  ${manifest.counts.mediaFiles} media files, ${manifest.counts.libraryItems} library items, ${transfer.formatBytes(plan.totalBytes)}`);
    const out = fs.createWriteStream(`${file}.vault-partial`);
    await zip.writeZip(plan, out, { signal: abort.signal, onProgress: (done, total) => progress({ phase: 'zip', bytesDone: done, bytesTotal: total, filesDone: 0, filesTotal: plan.entries.length }) });
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
    fs.renameSync(`${file}.vault-partial`, file);
    console.log(`\nDone: ${file}`);
  } else {
    console.log(`Copying Vault into ${target} …`);
    const result = await transfer.exportToFolder({ dir: target, includeMedia, serverDir: SERVER_DIR, onProgress: progress, signal: abort.signal });
    console.log(`\nDone: ${result.folder}\n  ${result.counts.mediaFiles} media files, ${result.counts.libraryItems} library items, ${transfer.formatBytes(result.bytes)}`);
  }
  console.log('\nOn the new computer: install Vault, then import this package from the setup wizard,\nSettings → Move to another server, or with: npm run import -- "<path to the package>"');
}

async function runImport() {
  const source = positional[0] && path.resolve(positional[0]);
  if (!source) usage();
  const info = await transfer.inspect(source);
  console.log(`Importing Vault from ${info.source.hostname || 'another computer'} (${info.createdAt})`);
  console.log(`  ${info.counts.libraryItems} library items${info.includesMedia ? `, ${info.counts.mediaFiles} media files (${transfer.formatBytes(info.counts.mediaBytes)})` : ', no media files'}`);
  const result = await transfer.importTransfer({
    source,
    mediaDir: mediaDir ? path.resolve(mediaDir) : undefined,
    copyMedia: !flags.has('--in-place'),
    serverDir: SERVER_DIR,
    onProgress: progress,
    signal: abort.signal,
  });
  console.log('\nMedia folders:');
  for (const f of result.folders) console.log(`  ${f.label}: ${f.path}`);
  console.log(`\nReady. ${result.media.copied} files copied${result.media.skipped ? `, ${result.media.skipped} already there` : ''}.`);
  console.log('Start Vault (npm start) — or press Restart in the app if it is running — to finish.');
  console.log('Sign in with the username, password and grid from your old server.');
}

(async () => {
  if (command === 'export') await runExport();
  else if (command === 'import') await runImport();
  else usage(command ? 1 : 0);
})().catch((err) => {
  console.error(`\n${err.code === 'CANCELLED' ? 'Stopped.' : `Error: ${err.message}`}`);
  process.exit(1);
});
