/**
 * Where Vault keeps its JSON data (library, favourites, profiles, sessions…).
 *
 * Defaults to `server/data`. `VAULT_DATA_DIR` moves it — `npm test` points it
 * at a throwaway temp folder so a test run never writes into (or reads from)
 * a real install's data.
 */
// VAULT_HOME (the desktop app) moves it with everything else: utils/paths.js.
const { DATA_DIR } = require('./paths');

module.exports = { DATA_DIR };
