/**
 * Multi-user profiles ("Who's watching?").
 *
 * Profiles are lightweight — no separate passwords required. An optional PIN
 * gates a profile, `kids` profiles are restricted by rating, and every profile
 * gets its own favourites/history/playlists/watchlist/continue-watching.
 *
 * The `default` profile maps to the existing flat data files, so existing
 * installs keep their data untouched.
 */
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { createJsonStore } = require('../utils/jsonStore');
const { getConfig } = require('../config');
const events = require('./events');
const contentRating = require('./contentRating');

const { KIDS_DEFAULT_AGE } = contentRating;

const store = createJsonStore('profiles.json', { profiles: [] });

// Profile identity colours. Muted, evenly spaced hues of similar lightness
// (replaces the Tailwind 500-series defaults — violet, cyan, pink… — that the
// first version shipped with). Each still reads clearly as "a different person".
const COLORS = ['#5B87C9', '#4D9A8C', '#C48A3F', '#B5636F', '#6D9656', '#8574AE', '#BF6B4C', '#5E8A9B'];

function ensureDefaults() {
  const data = store.get();
  if (!Array.isArray(data.profiles)) data.profiles = [];
  if (data.profiles.length === 0) {
    const config = getConfig();
    data.profiles.push({
      id: 'default',
      name: config?.auth?.username || 'Me',
      color: COLORS[0],
      avatar: null,
      pinHash: null,
      isAdmin: true,
      kids: false,
      maxRating: null,
      allowUnrated: true,
      createdAt: new Date().toISOString(),
    });
    store.set(data);
  }
  // There must always be an admin, otherwise nobody can change server
  // settings and no screen can fix it. This heals installs where the owner
  // profile was deleted (or predates the flag): the original `default`
  // profile, or failing that the oldest one, becomes admin again.
  if (!data.profiles.some(p => p.isAdmin)) {
    const owner = data.profiles.find(p => p.id === 'default') || data.profiles[0];
    owner.isAdmin = true;
    store.set(data);
  }
  return data;
}

function adminCount(profiles) {
  return profiles.filter(p => p.isAdmin).length;
}

function list() {
  const data = ensureDefaults();
  return data.profiles;
}

function get(id) {
  return list().find(p => p.id === id) || null;
}

function getDefault() {
  return list()[0];
}

/** Thrown for bad input; routes turn it into a 400 with this code. */
class ProfileError extends Error {
  constructor(message, code = 'INVALID_PROFILE') {
    super(message);
    this.code = code;
  }
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const PIN_FORMAT = /^\d{4,8}$/;

function cleanName(value) {
  const name = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  if (!name) throw new ProfileError('A profile needs a name', 'NAME_REQUIRED');
  return name;
}

function cleanColor(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!HEX_COLOR.test(String(value))) throw new ProfileError('Colour must be a hex value like #5B87C9', 'INVALID_COLOR');
  return String(value);
}

/**
 * Avatars are a short emoji/text badge. No markup, no URLs: the picker only
 * offers emoji, and a URL here would make every client fetch it.
 */
function cleanAvatar(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > 16 || /[<>"'`]|:\/\//.test(text)) {
    throw new ProfileError('Avatar must be a short emoji', 'INVALID_AVATAR');
  }
  return text;
}

/** Age limit: null (no limit) or a whole age from 0 to 18. */
function cleanMaxRating(value) {
  if (value === null || value === '' || value === undefined) return null;
  const age = Number(value);
  if (!Number.isInteger(age) || age < 0 || age > 18) {
    throw new ProfileError('Age limit must be a whole number from 0 to 18, or none', 'INVALID_RATING');
  }
  return age;
}

function hashPin(value) {
  if (value === null || value === undefined || value === '' || value === false) return null;
  const pin = String(value);
  if (!PIN_FORMAT.test(pin)) throw new ProfileError('PIN must be 4 to 8 digits', 'INVALID_PIN');
  return bcrypt.hashSync(pin, 10);
}

function create({ name, color, avatar = null, kids = false, maxRating, allowUnrated, pin = null, isAdmin = false }) {
  const data = ensureDefaults();
  if (data.profiles.length >= 12) throw new ProfileError('Maximum of 12 profiles', 'PROFILE_LIMIT');
  const isKids = !!kids;
  const limit = maxRating === undefined ? (isKids ? KIDS_DEFAULT_AGE : null) : cleanMaxRating(maxRating);
  const profile = {
    id: `p_${randomUUID().slice(0, 8)}`,
    name: cleanName(name || 'New profile'),
    color: cleanColor(color) || COLORS[data.profiles.length % COLORS.length],
    avatar: cleanAvatar(avatar),
    pinHash: hashPin(pin),
    isAdmin: !!isAdmin,
    kids: isKids,
    maxRating: limit,
    // Kids profiles hide films and videos nobody has rated yet, unless an
    // admin says otherwise; grown-up limits let them through.
    allowUnrated: allowUnrated === undefined ? !isKids : !!allowUnrated,
    createdAt: new Date().toISOString(),
  };
  data.profiles.push(profile);
  store.set(data);
  events.broadcast('profile:changed', { id: profile.id, action: 'create' });
  return profile;
}

function update(id, updates = {}) {
  const data = ensureDefaults();
  const idx = data.profiles.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const current = data.profiles[idx];
  const next = { ...current };
  if (updates.name !== undefined) next.name = cleanName(updates.name);
  if (updates.color !== undefined) next.color = cleanColor(updates.color) || current.color;
  if (updates.avatar !== undefined) next.avatar = cleanAvatar(updates.avatar);
  if (updates.kids !== undefined) {
    next.kids = !!updates.kids;
    // Turning Kids on without picking a limit must not leave it unlimited.
    if (next.kids && !current.kids && updates.maxRating === undefined && (current.maxRating === null || current.maxRating === undefined)) {
      next.maxRating = KIDS_DEFAULT_AGE;
    }
    if (next.kids && !current.kids && updates.allowUnrated === undefined) next.allowUnrated = false;
  }
  if (updates.maxRating !== undefined) next.maxRating = cleanMaxRating(updates.maxRating);
  if (updates.allowUnrated !== undefined) next.allowUnrated = !!updates.allowUnrated;
  if (updates.isAdmin !== undefined) {
    next.isAdmin = !!updates.isAdmin;
    if (!next.isAdmin && current.isAdmin && adminCount(data.profiles) <= 1) {
      throw new ProfileError('Vault needs at least one admin profile. Make another profile an admin first.', 'LAST_ADMIN');
    }
  }
  if (updates.pin !== undefined) next.pinHash = hashPin(updates.pin);
  data.profiles[idx] = next;
  store.set(data);
  events.broadcast('profile:changed', { id, action: 'update' });
  return next;
}

function remove(id) {
  const data = ensureDefaults();
  const target = data.profiles.find(p => p.id === id);
  if (!target) return false;
  if (data.profiles.length <= 1) throw new ProfileError('At least one profile is required', 'LAST_PROFILE');
  if (target.isAdmin && adminCount(data.profiles) <= 1) {
    throw new ProfileError('This is the only admin profile. Make another profile an admin before deleting it.', 'LAST_ADMIN');
  }
  data.profiles = data.profiles.filter(p => p.id !== id);
  store.set(data);
  events.broadcast('profile:changed', { id, action: 'delete' });
  return true;
}

function checkPin(id, pin) {
  const profile = get(id);
  if (!profile) return false;
  if (!profile.pinHash) return true;
  try {
    return bcrypt.compareSync(String(pin || ''), profile.pinHash);
  } catch {
    return false;
  }
}

function hasPin(id) {
  const profile = get(id);
  return !!(profile && profile.pinHash);
}

/** Public shape — never leak pin hashes to the client. */
function toPublic(profile) {
  if (!profile) return null;
  const { pinHash, ...rest } = profile;
  return {
    ...rest,
    maxRating: rest.maxRating ?? null,
    allowUnrated: rest.allowUnrated ?? !rest.kids,
    hasPin: !!pinHash,
  };
}

function listPublic() {
  return list().map(toPublic);
}

// ---------------------------------------------------------------------------
// Age limits
// ---------------------------------------------------------------------------
// Types whose unrated items a restricted profile may be asked to hide. Music,
// audiobooks, podcasts and comics are only limited when they carry a rating.
const RATED_TYPES = new Set(['movie', 'video', 'show', 'episode']);

/**
 * The limit that applies to a profile, or null when it may see everything.
 * `maxAge` is null for "no age limit" (a Kids profile can still hide unrated
 * items without one).
 */
function restrictionFor(profileId) {
  const profile = get(profileId || 'default');
  if (!profile) return null;
  const maxAge = profile.maxRating === null || profile.maxRating === undefined || profile.maxRating === ''
    ? null : Number(profile.maxRating);
  const allowUnrated = profile.allowUnrated ?? !profile.kids;
  if ((maxAge === null || Number.isNaN(maxAge)) && allowUnrated) return null;
  return { maxAge: Number.isNaN(maxAge) ? null : maxAge, allowUnrated };
}

/** Kept for older callers: the age ceiling, or null when unrestricted. */
function ratingCeiling(profileId) {
  return restrictionFor(profileId)?.maxAge ?? null;
}

function itemAllowed(item, restriction) {
  if (!restriction || !item) return true;
  const age = contentRating.ageFor(item.contentRating);
  if (age === null) return restriction.allowUnrated || !RATED_TYPES.has(item.type);
  return restriction.maxAge === null || age <= restriction.maxAge;
}

/** Can this profile see / play this item? */
function canAccess(profileId, item) {
  return itemAllowed(item, restrictionFor(profileId));
}

/** The items a profile may see (the same array when unrestricted). */
function filterItems(profileId, items) {
  const restriction = restrictionFor(profileId);
  if (!restriction || !Array.isArray(items)) return items;
  return items.filter(item => itemAllowed(item, restriction));
}

async function flush() {
  await store.flush();
}

module.exports = {
  list,
  listPublic,
  get,
  getDefault,
  create,
  update,
  remove,
  checkPin,
  hasPin,
  toPublic,
  ratingCeiling,
  restrictionFor,
  canAccess,
  filterItems,
  ProfileError,
  ensureDefaults,
  flush,
  COLORS,
};
