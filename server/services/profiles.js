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

const store = createJsonStore('profiles.json', { profiles: [], activeProfileId: 'default' });

const COLORS = ['#7C5CFF', '#22D3EE', '#F59E0B', '#EC4899', '#22C55E', '#3B82F6', '#EF4444', '#14B8A6'];

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
      createdAt: new Date().toISOString(),
    });
    store.set(data);
  }
  if (!data.activeProfileId) data.activeProfileId = data.profiles[0].id;
  return data;
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

function create({ name, color, kids = false, maxRating = null, pin = null, isAdmin = false }) {
  const data = ensureDefaults();
  if (data.profiles.length >= 12) throw new Error('Maximum of 12 profiles');
  const profile = {
    id: `p_${randomUUID().slice(0, 8)}`,
    name: String(name || 'New Profile').slice(0, 40),
    color: color || COLORS[data.profiles.length % COLORS.length],
    avatar: null,
    pinHash: pin ? bcrypt.hashSync(String(pin), 10) : null,
    isAdmin: !!isAdmin,
    kids: !!kids,
    maxRating: kids ? (maxRating ?? 7) : (maxRating ?? null),
    createdAt: new Date().toISOString(),
  };
  data.profiles.push(profile);
  store.set(data);
  events.broadcast('profile:changed', { id: profile.id, action: 'create' });
  return profile;
}

function update(id, updates) {
  const data = ensureDefaults();
  const idx = data.profiles.findIndex(p => p.id === id);
  if (idx === -1) return null;
  const next = { ...data.profiles[idx] };
  if (updates.name !== undefined) next.name = String(updates.name).slice(0, 40);
  if (updates.color !== undefined) next.color = updates.color;
  if (updates.avatar !== undefined) next.avatar = updates.avatar;
  if (updates.kids !== undefined) next.kids = !!updates.kids;
  if (updates.maxRating !== undefined) next.maxRating = updates.maxRating === null ? null : Number(updates.maxRating);
  if (updates.isAdmin !== undefined) next.isAdmin = !!updates.isAdmin;
  if (updates.pin !== undefined) next.pinHash = updates.pin ? bcrypt.hashSync(String(updates.pin), 10) : null;
  data.profiles[idx] = next;
  store.set(data);
  events.broadcast('profile:changed', { id, action: 'update' });
  return next;
}

function remove(id) {
  const data = ensureDefaults();
  if (data.profiles.length <= 1) throw new Error('At least one profile is required');
  const next = data.profiles.filter(p => p.id !== id);
  if (next.length === data.profiles.length) return false;
  data.profiles = next;
  if (data.activeProfileId === id) data.activeProfileId = next[0].id;
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
  return { ...rest, hasPin: !!pinHash };
}

function listPublic() {
  return list().map(toPublic);
}

/**
 * Kids/max-rating filter. Returns the rating ceiling for a profile, or null if
 * unrestricted. Items with no rating are always allowed.
 */
function ratingCeiling(profileId) {
  const profile = get(profileId);
  if (!profile) return null;
  if (profile.maxRating !== null && profile.maxRating !== undefined) return Number(profile.maxRating);
  return null;
}

function setActive(id) {
  const data = ensureDefaults();
  if (!data.profiles.some(p => p.id === id)) return null;
  data.activeProfileId = id;
  store.set(data);
  return data.activeProfileId;
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
  setActive,
  ensureDefaults,
  flush,
  COLORS,
};
