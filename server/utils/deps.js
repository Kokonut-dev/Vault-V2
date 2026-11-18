'use strict';
/**
 * Install preflight — uses nothing from node_modules, so it works before
 * `npm install` has run.
 *
 * Without it, starting Vault in a fresh clone (or after `npm install` ran in
 * the wrong folder) failed with Node's "Cannot find module 'dotenv'" stack
 * trace, and the launcher restarted that crash over and over.
 *
 * Used by:
 * - index.js: a one-line explanation + exit 78 (the launcher does not retry
 *   that code).
 * - launcher.js: runs `npm install` itself, then starts the server.
 */
const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.join(__dirname, '..');
const MIN_NODE_MAJOR = 20; // file-type (via music-metadata) needs Node 20+

/** Resolves like Node does: server/node_modules, then each parent's. */
function isInstalled(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** Required (non-optional) dependencies that aren't installed. */
function missingDependencies(serverDir = SERVER_DIR) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'), 'utf8'));
  } catch {
    return [];
  }
  return Object.keys(pkg.dependencies || {}).filter(name => !isInstalled(name, serverDir));
}

function listNames(names, max = 3) {
  return names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');
}

/** One line — the launcher shows the last error line as the reason in the app. */
function explainMissing(missing, serverDir = SERVER_DIR) {
  return `Error: Vault's packages are not installed (missing ${listNames(missing)}). `
    + `Run "npm install" in ${serverDir} (or in the Vault-V2 folder), then start Vault again.`;
}

function nodeTooOld(version = process.versions.node) {
  return Number(String(version).split('.')[0]) < MIN_NODE_MAJOR;
}

function explainNodeTooOld(version = process.versions.node) {
  return `Error: Vault needs Node.js ${MIN_NODE_MAJOR} or newer, but this is Node.js ${version}. `
    + 'Install the current LTS from https://nodejs.org (or your package manager / nvm), then start Vault again.';
}

/**
 * How to run npm from inside Node. Prefer the npm that started us
 * (`npm start` sets npm_execpath), then the copy bundled next to this Node
 * binary, then whatever `npm` is on PATH.
 */
function npmCommand(args, env = process.env) {
  const execPath = env.npm_execpath;
  if (execPath && /npm-cli\.c?js$/.test(execPath) && fs.existsSync(execPath)) {
    return { command: process.execPath, args: [execPath, ...args], shell: false };
  }
  const nodeDir = path.dirname(process.execPath);
  const bundled = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // macOS / Linux
  ].find(p => fs.existsSync(p));
  if (bundled) return { command: process.execPath, args: [bundled, ...args], shell: false };
  return process.platform === 'win32'
    ? { command: 'npm.cmd', args, shell: true }
    : { command: 'npm', args, shell: false };
}

/**
 * Environment for a child npm. Drops the npm_* variables inherited from an
 * outer `npm start` (e.g. npm_config_prefix from `npm --prefix server start`),
 * which would otherwise point the install somewhere else.
 */
function cleanNpmEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^npm_/.test(key)) out[key] = value; // npm's own (lowercase) vars; keeps NPM_CONFIG_* the user set
  }
  return out;
}

module.exports = {
  SERVER_DIR,
  MIN_NODE_MAJOR,
  missingDependencies,
  explainMissing,
  nodeTooOld,
  explainNodeTooOld,
  npmCommand,
  cleanNpmEnv,
};
