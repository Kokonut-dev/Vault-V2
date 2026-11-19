/**
 * Age limits for profiles, applied at the routes.
 *
 * Kids (and other age-limited) profiles must not see, open or stream items
 * above their limit. Lists are filtered with `profiles.filterItems`; routes
 * keyed by an item id use `itemParam` so a guessed id behaves exactly like
 * an id that doesn't exist (404 — no hint that something is hidden).
 */
const profiles = require('../services/profiles');
const libraryService = require('../services/library');

/** router.param('id', itemParam): 404 for items the profile may not see. */
function itemParam(req, res, next, id) {
  const restriction = profiles.restrictionFor(req.profileId);
  if (!restriction) return next();
  const item = libraryService.getById(id);
  if (item && !profiles.canAccess(req.profileId, item)) {
    return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });
  }
  return next();
}

/**
 * Library edits (metadata, age ratings, deleting files) are off-limits for
 * age-limited profiles: otherwise a Kids profile could re-rate a film to get
 * past its own limit.
 */
function blockRestricted(req, res, next) {
  if (!profiles.restrictionFor(req.profileId)) return next();
  return res.status(403).json({
    error: 'This profile has an age limit and can’t change the library',
    code: 'PROFILE_RESTRICTED',
  });
}

/** The visible library for a request's profile. */
function visibleItems(req, items = libraryService.getAll()) {
  return profiles.filterItems(req.profileId || 'default', items);
}

module.exports = { itemParam, blockRestricted, visibleItems };
