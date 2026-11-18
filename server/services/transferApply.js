/**
 * Finish an import from another Vault server — runs at the very top of
 * index.js, before config, the library or any other store is loaded.
 *
 * An import can't overwrite server/data while the server runs: every
 * service keeps its data in memory and writes it back on shutdown, which
 * would silently undo the import. So services/transfer.js prepares
 * everything in server/.transfer-staging/ and marks it READY; the next
 * start swaps it in here:
 *
 *   server/data          → server/backups/before-transfer-<time>/data
 *   staging/data         → server/data          (old data/backups kept)
 *   server/config.json   → backups/…/config.json, staged config.json in
 *   staging/cache/<x>/*  → merged into server/cache/<x>/
 *
 * Built-in modules only. If anything fails, the old data is put back and
 * the staging folder is renamed so the server never boot-loops on it.
 */
const fs = require('fs');
const path = require('path');

const STAGING_NAME = '.transfer-staging';
const READY_FILE = 'READY';

function stagingDir(serverDir) {
  return path.join(serverDir, STAGING_NAME);
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function copyTreeMerge(from, to) {
  if (!exists(from)) return 0;
  let count = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) count += copyTreeMerge(src, dest);
    else if (entry.isFile()) { fs.copyFileSync(src, dest); count += 1; }
  }
  return count;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * @returns {null | { backupDir: string, summary: object }} null when there's
 *          nothing to apply.
 */
function applyPendingTransfer(serverDir, log = console) {
  const staging = stagingDir(serverDir);
  const ready = path.join(staging, READY_FILE);
  if (!exists(ready)) return null;

  let summary = {};
  try { summary = JSON.parse(fs.readFileSync(path.join(staging, 'transfer.json'), 'utf8')); } catch { /* optional */ }

  const dataDir = path.join(serverDir, 'data');
  const configPath = path.join(serverDir, 'config.json');
  const backupDir = path.join(serverDir, 'backups', `before-transfer-${stamp()}`);
  const movedData = path.join(backupDir, 'data');
  let dataMoved = false;
  let dataSwapped = false;
  let configBacked = false;

  try {
    fs.mkdirSync(backupDir, { recursive: true });
    if (exists(path.join(staging, 'data'))) {
      if (exists(dataDir)) {
        fs.renameSync(dataDir, movedData);
        dataMoved = true;
      }
      fs.renameSync(path.join(staging, 'data'), dataDir);
      dataSwapped = true;
      // Zip backups made on this server stay with this server.
      if (dataMoved && exists(path.join(movedData, 'backups')) && !exists(path.join(dataDir, 'backups'))) {
        fs.renameSync(path.join(movedData, 'backups'), path.join(dataDir, 'backups'));
      }
    }
    if (exists(path.join(staging, 'config.json'))) {
      if (exists(configPath)) {
        fs.copyFileSync(configPath, path.join(backupDir, 'config.json'));
        configBacked = true;
      }
      fs.copyFileSync(path.join(staging, 'config.json'), configPath);
    }
    let cacheFiles = 0;
    const stagedCache = path.join(staging, 'cache');
    if (exists(stagedCache)) {
      for (const sub of fs.readdirSync(stagedCache)) {
        cacheFiles += copyTreeMerge(path.join(stagedCache, sub), path.join(serverDir, 'cache', sub));
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    log.log?.(`[Transfer] Imported Vault data from ${summary.source?.hostname || 'another server'} (${summary.items ?? '?'} library items, ${cacheFiles} artwork files). Your previous data is in ${backupDir}`);
    return { backupDir, summary };
  } catch (err) {
    log.error?.(`[Transfer] Couldn't finish the import: ${err.message} — keeping your current data`);
    try {
      if (dataSwapped && dataMoved) {
        fs.renameSync(dataDir, path.join(staging, 'data-failed'));
        fs.renameSync(movedData, dataDir);
      } else if (dataMoved && !dataSwapped) {
        fs.renameSync(movedData, dataDir);
      }
      if (configBacked) fs.copyFileSync(path.join(backupDir, 'config.json'), configPath);
    } catch (rollbackErr) {
      log.error?.(`[Transfer] Rollback problem: ${rollbackErr.message}. Your previous data is in ${backupDir}`);
    }
    try {
      fs.renameSync(staging, path.join(serverDir, `.transfer-failed-${stamp()}`));
    } catch { /* leave it */ }
    return null;
  }
}

module.exports = { applyPendingTransfer, stagingDir, STAGING_NAME, READY_FILE };
