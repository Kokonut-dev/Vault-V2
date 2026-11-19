/**
 * Which profile this tab is using, and keeping per-profile data per profile.
 *
 * The server decides the profile (it's bound to the session); this module
 * only mirrors it: `store.profile` / `store.profileId` for the UI, the last
 * used profile per device (so the next sign-in lands on it), and the local
 * caches of favourites and history, which must never show one profile's
 * data to another on a shared device.
 */
import { api } from './api.js';
import { store } from './store.js';

export const LAST_PROFILE_KEY = 'vault_last_profile';
// Which profile the cached favourites/history in localStorage belong to.
const DATA_PROFILE_KEY = 'vault_data_profile';
// Device-local caches that belong to a person, not to the device.
const PROFILE_LOCAL_KEYS = [
  'vault_favourites', 'vault_history', 'vault_queue', 'vault_queue_index',
  'vault_recent_searches', 'vault_search_history',
];

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode / quota: the server copy still works */ }
}

/** The profile the next sign-in on this device should ask for. */
export function lastProfileId() {
  return safeGet(LAST_PROFILE_KEY);
}

/** Record the profile the server says this tab is using. */
export function rememberProfile(profile) {
  if (!profile || !profile.id) return;
  store.set('profile', profile);
  store.set('profileId', profile.id);
  safeSet(LAST_PROFILE_KEY, profile.id);
}

export function currentProfile() {
  return store.get('profile') || null;
}

/** Forget everything profile-specific held on this device. */
export function clearLocalProfileData() {
  for (const key of PROFILE_LOCAL_KEYS) safeSet(key, null);
  safeSet(DATA_PROFILE_KEY, null);
  store.update({
    favourites: [],
    history: [],
    queue: [],
    queueIndex: -1,
    recentSearches: [],
    searchHistory: [],
  });
}

/**
 * Before reloading as another profile: drop this profile's local caches and
 * remember the new one for the next sign-in.
 */
export function prepareProfileSwitch(profile, token) {
  clearLocalProfileData();
  if (token) {
    store.set('token', token, true);
    safeSet('vault_token', token);
  }
  if (profile) safeSet(LAST_PROFILE_KEY, profile.id);
}

/**
 * Load this profile's favourites and history from the server, which keeps
 * them per profile. Local entries are only merged in when they're known to
 * belong to the same profile (or to the owner profile on an install that
 * predates this) — never another person's.
 */
export async function hydrateProfileData(profileId) {
  if (!profileId) return;
  const owner = safeGet(DATA_PROFILE_KEY);
  const sameOwner = owner ? owner === profileId : profileId === 'default';
  if (!sameOwner) clearLocalProfileData();

  const [favs, hist] = await Promise.allSettled([api.getFavourites(), api.getHistory()]);

  if (favs.status === 'fulfilled') {
    const ids = (favs.value?.items || []).map(item => item.id).filter(Boolean);
    const local = sameOwner ? (store.get('favourites') || []) : [];
    // Server first; a local-only id means a toggle that never reached it.
    store.set('favourites', [...new Set([...ids, ...local.filter(id => !ids.includes(id))])], true);
  }

  if (hist.status === 'fulfilled') {
    const merged = new Map();
    for (const entry of (sameOwner ? store.get('history') : []) || []) {
      if (entry?.itemId) merged.set(entry.itemId, entry);
    }
    for (const entry of hist.value?.history || []) {
      if (!entry?.itemId) continue;
      const local = merged.get(entry.itemId);
      // Whichever was watched more recently wins (video progress used to be
      // saved on this device only).
      if (!local || new Date(entry.watchedAt || 0) >= new Date(local.watchedAt || 0)) {
        merged.set(entry.itemId, { itemId: entry.itemId, progress: entry.progress || 0, watchedAt: entry.watchedAt });
      }
    }
    const list = [...merged.values()]
      .sort((a, b) => new Date(b.watchedAt || 0) - new Date(a.watchedAt || 0))
      .slice(0, 100);
    store.set('history', list, true);
  }

  if (favs.status === 'fulfilled' || hist.status === 'fulfilled') safeSet(DATA_PROFILE_KEY, profileId);
}

export default {
  lastProfileId, rememberProfile, currentProfile, clearLocalProfileData,
  prepareProfileSwitch, hydrateProfileData, LAST_PROFILE_KEY,
};
