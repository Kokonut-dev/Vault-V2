const express = require('express');
const router = express.Router();
const profiles = require('../services/profiles');
const libraryService = require('../services/library');
const events = require('../services/events');

// Profile switching issues a new token bound to that profile (PIN required when
// the profile has one).
router.get('/', (req, res) => {
  res.json({ profiles: profiles.listPublic(), activeProfileId: req.profileId || 'default' });
});

router.post('/', (req, res) => {
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
  const profile = profiles.update(req.params.id, req.body || {});
  if (!profile) return res.status(404).json({ error: 'Profile not found' });
  res.json(profiles.toPublic(profile));
});

router.delete('/:id', (req, res) => {
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
    return res.status(401).json({ error: 'Profile PIN required', code: 'PROFILE_PIN_REQUIRED' });
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
