/**
 * Delete a profile together with everything that belongs to it: its devices'
 * sessions, watchlist, bookmarks and library data (watch history, ratings…),
 * and — for a profile that came with a sign-up account — the account itself.
 *
 * Used by DELETE /api/profiles/:id and DELETE /api/accounts/:id so both
 * clean up the same way. Throws profiles.ProfileError when the profile can't
 * be removed (last profile, last admin).
 */
const profiles = require('./profiles');
const sessions = require('./sessions');
const logger = require('../utils/logger');

async function removeProfileCompletely(id) {
  const target = profiles.get(id);
  if (!target) return null;
  const ok = profiles.remove(id); // throws ProfileError
  if (!ok) return null;

  // A device still signed in as the deleted profile must not keep working.
  const signedOut = sessions.revokeProfile(id);

  let accountRemoved = false;
  if (target.accountId) {
    const accounts = require('./accounts');
    accountRemoved = accounts.remove(target.accountId);
    sessions.revokeAccount(target.accountId);
    require('./recovery').forget(target.accountId);
  }

  const extras = require('./extras');
  const watchlist = extras.removeProfileWatchlist(id);
  const bookmarks = extras.removeProfileBookmarks(id);
  try {
    await require('./library').removeProfileData(id);
  } catch (err) {
    logger.warn(`[Profiles] could not remove data for ${id}: ${err.message}`);
  }
  return { id, signedOut, watchlistRemoved: watchlist, bookmarksRemoved: bookmarks, accountRemoved };
}

module.exports = { removeProfileCompletely };
