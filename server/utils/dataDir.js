/**
 * Where Vault keeps its JSON data (library, favourites, profiles, sessions…).
 *
 * Defaults to `server/data`. `VAULT_DATA_DIR` moves it — `npm test` points it
 * at a throwaway temp folder so a test run never writes into (or reads from)
 * a real install's data.
 */
const path = require('path');

const DATA_DIR = process.env.VAULT_DATA_DIR
  ? path.resolve(process.env.VAULT_DATA_DIR)
  : path.join(__dirname, '..', 'data');

module.exports = { DATA_DIR };
