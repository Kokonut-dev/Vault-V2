const express = require('express');
const router = express.Router();
const profiles = require('../services/profiles');
const libraryService = require('../services/library');
const events = require('../services/events');
const { requireAdmin, isAdminProfile } = require('../middleware/requireAdmin');

// Fields only an admin may change. Otherwise a Kids profile could lift its
// own rating limit, or any profile could make itself admin and get past the
// server-settings gate.
const PRIVILEGED_FIELDS = ['isAdmin', 'kids', 'maxRating'];

// Profile switching issues a new token bound to that profile (PIN required when
// the profile has one).
router.get('/', (req, res) => {
  res.json({ profiles: profiles.listPublic(), activeProfileId: req.profileId || 'default' });
});

router.post('/', requireAdmin, (req, res) => {
  const { name, color, kids, maxRating, pin } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const profile = profiles.create({ name, color, kids, maxRating, pin });
    res.json(profiles.toPublic(profile));
  } catch (err) {
    res.status(400).json({ error: err.message });
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
  }
  try {
    const profile = profiles.update(req.params.id, body);
    if (!profile) return res.status(404).json({ error: 'Profile not found' });
    res.json(profiles.toPublic(profile));
  } catch (err) {
    res.status(400).json({ error: err.message, code: 'LAST_ADMIN' });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  if (req.params.id === (req.profileId || 'default')) {
    return res.status(400).json({ error: 'Switch to another profile before deleting this one', code: 'PROFILE_IN_USE' });
  }
  try {
    const ok = profiles.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Profile not found' });
    res.json({ message: 'Profile removed', id: req.params.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/switch', (req, res) => {
  const profile = profiles.get(req.params.id);
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  if (profiles.hasPin(req.params.id) && !profiles.checkPin(req.params.id, req.body?.pin)) {
    // 403, not 401: the client treats any 401 as an expired session and
    // signs the user out, and a mistyped PIN must not do that.
    return res.status(403).json({ error: req.body?.pin ? 'That PIN isn’t right' : 'Profile PIN required', code: 'PROFILE_PIN_REQUIRED' });
  }

  const authService = require('../services/authService');
  const sessions = require('../services/sessions');
  const token = authService.generateAccessToken(req.user.username, {
    sid: req.user.sid,
    profileId: profile.id,
    remember: !!req.user.remember,
  });

  if (req.user.sid) sessions.setProfile(req.user.sid, profile.id);

  profiles.setActive(profile.id);
  events.broadcast('profile:changed', { id: profile.id, action: 'switch' });
  res.json({ token, profile: profiles.toPublic(profile) });
});

/** Everything a profile needs for "Continue watching" after a switch. */
router.get('/:id/summary', (req, res) => {
  const profileId = req.params.id;
  const scoped = libraryService.forProfile(profileId);
  const history = scoped.getHistory();
  const items = history
    .map(h => ({ ...libraryService.getById(h.itemId), progress: h.progress, watchedAt: h.watchedAt }))
    .filter(i => i && i.id)
    .filter(i => i.progress > 5 && i.progress < 95)
    .slice(0, 20);

  res.json({
    profile: profiles.toPublic(profiles.get(profileId)),
    favourites: scoped.getFavourites().length,
    playlists: scoped.getPlaylists().length,
    history: history.length,
    continueWatching: items,
  });
});

module.exports = router;
