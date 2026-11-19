#!/usr/bin/env node
/**
 * `npm test` (in server/): runs every server/test/*.test.js with
 * VAULT_DATA_DIR (and the SQLite index) pointed at a throwaway temp folder,
 * so a test run never writes into — or picks up state from — the real
 * `server/data`.
 *
 * Arguments are passed to `node --test`; naming test files runs only those
 * (e.g. `npm test -- test/restream.test.js`).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const serverDir = path.join(__dirname, '..', 'server');
const args = process.argv.slice(2);
const files = args.some(a => a.endsWith('.js'))
  ? []
  : fs.readdirSync(path.join(serverDir, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-data-'));
const env = {
  ...process.env,
  VAULT_DATA_DIR: process.env.VAULT_DATA_DIR || dataDir,
  VAULT_INDEX_DB: process.env.VAULT_INDEX_DB || path.join(dataDir, 'library.db'),
};

const result = spawnSync(process.execPath, ['--test', ...args, ...files], { cwd: serverDir, env, stdio: 'inherit' });
fs.rmSync(dataDir, { recursive: true, force: true });
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
