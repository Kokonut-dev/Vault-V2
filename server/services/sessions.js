/**
 * Per-device sessions and revocable tokens.
 *
 * Every successful login creates a session record (device label, IP, user
 * agent, last seen). Tokens carry the session id, so a session can be revoked
 * server-side without touching the token blacklist, and `/api/sessions` can list
 * "Signed-in devices" the way Netflix/Plex do.
 */
const { createJsonStore } = require('../utils/jsonStore');

const store = createJsonStore('sessions.json', []);
// Per account (the owner counts as one account): anyone who signs up can't
// push the owner's devices out by signing in over and over.
const MAX_SESSIONS = 50;
const MAX_SESSIONS_TOTAL = 1000;

function describeDevice(ua = '') {
  const s = ua.toLowerCase();
  const browser =
    s.includes('edg/') ? 'Edge' :
    s.includes('chrome/') && !s.includes('chromium') ? 'Chrome' :
    s.includes('firefox/') ? 'Firefox' :
    s.includes('safari/') && !s.includes('chrome') ? 'Safari' :
    s.includes('curl') ? 'curl' : 'Browser';
  const os =
    s.includes('windows') ? 'Windows' :
    s.includes('android') ? 'Android' :
    s.includes('iphone') || s.includes('ipad') ? 'iOS' :
    s.includes('mac os') ? 'macOS' :
    s.includes('linux') ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function create({ username, profileId = 'default', req, remember = false, label = null, accountId = null }) {
  const ua = req?.headers?.['user-agent'] || '';
  const session = {
    id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    username,
    profileId,
    // null = the server owner's account; otherwise an account made with
    // "Create a new account" (services/accounts.js).
    accountId: accountId || null,
    device: label || describeDevice(ua),
    userAgent: ua.slice(0, 300),
    ip: req?.ip || req?.connection?.remoteAddress || 'unknown',
    // Signed in through the Cloudflare tunnel (or another proxy on this computer).
    remote: req ? require('../utils/clientAddress').cameThroughProxy(req) : false,
    remember: !!remember,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  const list = store.get();
  list.unshift(session);
  const perAccount = new Map();
  const kept = list.filter((s) => {
    const key = s.accountId || '';
    const n = (perAccount.get(key) || 0) + 1;
    perAccount.set(key, n);
    return n <= MAX_SESSIONS;
  });
  store.set(kept.slice(0, MAX_SESSIONS_TOTAL));
  return session;
}

function list() {
  return store.get();
}

function get(id) {
  return store.get().find(s => s.id === id) || null;
}

function touch(id) {
  const list = store.get();
  const idx = list.findIndex(s => s.id === id);
  if (idx === -1) return;
  // Only write every ~2 minutes to avoid disk churn on every request.
  const last = new Date(list[idx].lastSeen).getTime();
  if (Date.now() - last < 120000) return;
  list[idx].lastSeen = new Date().toISOString();
  store.set(list);
}

/** Re-bind a session to another profile (profile switching). */
function setProfile(id, profileId) {
  const list = store.get();
  const idx = list.findIndex(s => s.id === id);
  if (idx === -1) return null;
  list[idx].profileId = profileId;
  store.set(list);
  return list[idx];
}

function isValid(id) {
  if (!id) return false;
  return store.get().some(s => s.id === id);
}

function revoke(id) {
  const list = store.get();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  store.set(next);
  return true;
}

/**
 * Sign out every other device. With `accountId` (null = the owner), only that
 * account's devices; without it (undefined), every device on the server.
 */
function revokeOthers(keepId, accountId) {
  const list = store.get();
  const scoped = accountId !== undefined;
  const next = list.filter(s => s.id === keepId || (scoped && (s.accountId || null) !== (accountId || null)));
  store.set(next);
  return list.length - next.length;
}

/** Sign out every device of one account (null = the owner's devices). */
function revokeAccount(accountId) {
  const list = store.get();
  const next = list.filter(s => (s.accountId || null) !== (accountId || null));
  if (next.length === list.length) return 0;
  store.set(next);
  return list.length - next.length;
}

/** Sign out every device using a profile (the profile was deleted). */
function revokeProfile(profileId) {
  const list = store.get();
  const next = list.filter(s => (s.profileId || 'default') !== profileId);
  if (next.length === list.length) return 0;
  store.set(next);
  return list.length - next.length;
}

function revokeAll() {
  const count = store.get().length;
  store.set([]);
  return count;
}

async function flush() {
  await store.flush();
}

module.exports = { create, list, get, touch, isValid, revoke, revokeOthers, revokeAccount, revokeProfile, revokeAll, describeDevice, setProfile, flush, MAX_SESSIONS };
