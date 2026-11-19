'use strict';
/**
 * Where Vault keeps things. Dependency-free (the launcher uses it too).
 *
 * Code lives in SERVER_DIR (this repository's server/ folder, or the
 * read-only resources of the desktop app). Everything Vault *writes* lives
 * under HOME, which defaults to SERVER_DIR — so running from a git clone
 * works exactly as before — and can be moved with VAULT_HOME. The desktop
 * app points it at the per-user app-data folder, because an installed app's
 * own folder is read-only (AppImage, /Applications, /opt, Program Files).
 *
 *   VAULT_HOME         base for everything below (default: server/)
 *   VAULT_CONFIG_PATH  config.json             (default: HOME/config.json)
 *   VAULT_DATA_DIR     JSON data               (default: HOME/data)
 *   VAULT_MEDIA_DIR    default media folders   (default: HOME/media)
 *   VAULT_BIN_DIR      downloaded helpers      (default: HOME/bin)
 *   VAULT_DOCS_DIR     the web app it serves   (default: server/../docs)
 */
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const fromEnv = (name, fallback) => (process.env[name] ? path.resolve(process.env[name]) : fallback);

const HOME = fromEnv('VAULT_HOME', SERVER_DIR);
const CONFIG_PATH = fromEnv('VAULT_CONFIG_PATH', path.join(HOME, 'config.json'));
const DATA_DIR = fromEnv('VAULT_DATA_DIR', path.join(HOME, 'data'));
const CACHE_DIR = path.join(HOME, 'cache');
const MEDIA_DIR = fromEnv('VAULT_MEDIA_DIR', path.join(HOME, 'media'));
const UPLOADS_DIR = path.join(HOME, 'uploads');
const LOGS_DIR = path.join(HOME, 'logs');
const BIN_DIR = fromEnv('VAULT_BIN_DIR', path.join(HOME, 'bin'));
const DOCS_DIR = fromEnv('VAULT_DOCS_DIR', path.join(SERVER_DIR, '..', 'docs'));

/** A folder inside the cache, e.g. cacheDir('covers'). */
function cacheDir(...parts) {
  return path.join(CACHE_DIR, ...parts);
}

/** A default media folder, e.g. mediaDir('music'). */
function mediaDir(...parts) {
  return path.join(MEDIA_DIR, ...parts);
}

/** Relative paths in config.json are relative to HOME (it used to be server/, which is the default HOME). */
function resolveHome(p) {
  return path.isAbsolute(p) ? p : path.resolve(HOME, p);
}

module.exports = {
  SERVER_DIR,
  HOME,
  CONFIG_PATH,
  DATA_DIR,
  CACHE_DIR,
  MEDIA_DIR,
  UPLOADS_DIR,
  LOGS_DIR,
  BIN_DIR,
  DOCS_DIR,
  cacheDir,
  mediaDir,
  resolveHome,
  relocated: HOME !== SERVER_DIR,
};
