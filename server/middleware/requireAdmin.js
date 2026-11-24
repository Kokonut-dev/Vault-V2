/**
 * Gate for server-wide configuration and anything that makes the server fetch
 * a user-supplied URL. Runs after authMiddleware. A profile counts as admin
 * when its `isAdmin` flag is set (the default/owner profile always is).
 */
const profiles = require('../services/profiles');

function isAdminProfile(profileId) {
  // A profile that doesn't exist (deleted, or a stale token) is never admin —
  // not even when it is called "default".
  // The profile of an account made with "Create a new account" never is.
  const profile = profiles.get(profileId || 'default');
  return Boolean(profile?.isAdmin && !profile.accountId);
}

function requireAdmin(req, res, next) {
  if (!req.accountId && isAdminProfile(req.profileId)) return next();
  return res.status(403).json({
    error: 'Only an admin profile can change server settings',
    code: 'ADMIN_REQUIRED',
  });
}

module.exports = { requireAdmin, isAdminProfile };
