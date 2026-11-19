const express = require('express');
const router = express.Router();
const profiles = require('../services/profiles');
const libraryService = require('../services/library');
const extras = require('../services/extras');
const sessions = require('../services/sessions');
const events = require('../services/events');
const logger = require('../utils/logger');
const { AGE_LIMITS } = require('../services/contentRating');
const { requireAdmin, isAdminProfile } = require('../middleware/requireAdmin');

// Fields only an admin may change. Otherwise a Kids profile could lift its
// own rating limit, or any profile could make itself admin and get past the
// server-settings gate.
const PRIVILEGED_FIELDS = ['isAdmin', 'kids', 'maxRating', 'allowUnrated'];
// Everything a profile may change about itself.
const SELF_FIELDS = ['name', 'color', 'avatar', 'pin'];
const EDITABLE_FIELDS = [...SELF_FIELDS, ...PRIVILEGED_FIELDS];

function pick(body, keys) {
  const out = {};
  for (const key of keys) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

function sendProfileError(res, err) {
  // Validation and last-admin/last-profile rules are the caller's problem
  // (400); anything else is ours.
  if (err instanceof profiles.ProfileError) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  logger.error('[Profiles]', err.message);
  return res.status(500).json({ error: 'Profile change failed' });
}

router.get('/', (req, res) => {
  res.json({
    profiles: profiles.listPublic(),
    activeProfileId: req.profileId || 'default',
    colors: profiles.COLORS,
    ageLimits: AGE_LIMITS,
  });
});

router.post('/', requireAdmin, (req, res) => {
  const body = req.body || {};
  // isAdmin is deliberately not accepted here: new profiles start without
  // admin rights and are promoted explicitly.
  const fields = pick(body, ['name', 'color', 'avatar', 'kids', 'maxRating', 'allowUnrated', 'pin']);
  if (!fields.name || !String(fields.name).trim()) {
    return res.status(400).json({ error: 'A profile needs a name', code: 'NAME_REQUIRED' });
  }
  try {
    const profile = profiles.create(fields);
    res.json(profiles.toPublic(profile));
  } catch (err) {
    sendProfileError(res, err);
  }
});

router.put('/:id', (req, res) => {
  const body = req.body || {};
  const self = req.profileId || 'default';
  if (!isAdminProfile(self)) {
    if (req.params.id !== self) {
      return res.status(403).json({ error: 'Only an admin profile can change other profiles', code: 'ADMIN_REQUIRED' });
    }
    const blocked = PRIVILEGED_FIELDS.filter(key => body[key] !== undefined);
    if (blocked.length) {
      return res.status(403).json({ error: 'Only an admin profile can change admin rights or rating limits', code: 'ADMIN_REQUIRED', fields: blocked });
    }
    // Changing or removing your own PIN needs the current one: otherwise
    // anyone handed an unlocked device could lock its owner out.
    if (body.pin !== undefined && profiles.hasPin(self) && !profiles.checkPin(self, body.currentPin)) {
      return res.status(403).json({ error: body.currentPin ? 'That PIN isn’t right' : 'Enter the current PIN to change it', code: 'PROFILE_PIN_REQUIRED' });
    }
  }
  try {
    const profile = profiles.update(req.params.id, pick(body, EDITABLE_FIELDS));
    if (!profile) return res.status(404).json({ error: 'Profile not found', code: 'NOT_FOUND' });
    res.json(profiles.toPublic(profile));
  } catch (err) {
    sendProfileError(res, err);
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (id === (req.profileId || 'default')) {
    return res.status(400).json({ error: 'Switch to another profile before deleting this one', code: 'PROFILE_IN_USE' });
  }
  try {
    const ok = profiles.remove(id);
    if (!ok) return res.status(404).json({ error: 'Profile not found', code: 'NOT_FOUND' });
  } catch (err) {
    return sendProfileError(res, err);
  }
  // The dialog promises the profile's data goes with it, and a device still
  // signed in as the deleted profile must not keep working as a ghost.
  const signedOut = sessions.revokeProfile(id);
  const watchlist = extras.removeProfileWatchlist(id);
  try {
    await libraryService.removeProfileData(id);
  } catch (err) {
    logger.warn(`[Profiles] could not remove data for ${id}: ${err.message}`);
  }
  res.json({ message: 'Profile removed', id, signedOut, watchlistRemoved: watchlist });
});

router.post('/:id/switch', (req, res) => {
  const profile = profiles.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found', code: 'NOT_FOUND' });

  if (profiles.hasPin(req.params.id) && !profiles.checkPin(req.params.id, req.body?.pin)) {
    // 403, not 401: the client treats any 401 as an expired session and
    // signs the user out, and a mistyped PIN must not do that.
    return res.status(403).json({ error: req.body?.pin ? 'That PIN isn’t right' : 'Profile PIN required', code: 'PROFILE_PIN_REQUIRED' });
  }

  const authService = require('../services/authService');
  const token = authService.generateAccessToken(req.user.username, {
    sid: req.user.sid,
    profileId: profile.id,
    remember: !!req.user.remember,
  });

  // The session is what the auth middleware trusts, so older tokens from
  // this device follow the switch instead of keeping the previous profile.
  if (req.user.sid) sessions.setProfile(req.user.sid, profile.id);

  events.broadcast('profile:changed', { id: profile.id, action: 'switch' });
  res.json({ token, profile: profiles.toPublic(profile) });
});

/** Everything a profile needs for "Continue watching" after a switch. */
router.get('/:id/summary', (req, res) => {
  const profileId = req.params.id;
  const self = req.profileId || 'default';
  // History is private: only the profile itself or an admin may read it.
  if (profileId !== self && !isAdminProfile(self)) {
    return res.status(403).json({ error: 'You can only see your own profile summary', code: 'ADMIN_REQUIRED' });
  }
  const profile = profiles.get(profileId);
  if (!profile) return res.status(404).json({ error: 'Profile not found', code: 'NOT_FOUND' });

  const scoped = libraryService.forProfile(profileId);
  const history = scoped.getHistory();
  const items = profiles.filterItems(profileId, history
    .map(h => ({ ...libraryService.getById(h.itemId), progress: h.progress, watchedAt: h.watchedAt }))
    .filter(i => i && i.id))
    .filter(i => i.progress > 5 && i.progress < 95)
    .slice(0, 20);

  res.json({
    profile: profiles.toPublic(profile),
    favourites: scoped.getFavourites().length,
    playlists: scoped.getPlaylists().length,
    history: history.length,
    continueWatching: items,
  });
});

module.exports = router;
