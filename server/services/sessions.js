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
const MAX_SESSIONS = 50;

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

function create({ username, profileId = 'default', req, remember = false, label = null }) {
  const ua = req?.headers?.['user-agent'] || '';
  const session = {
    id: `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    username,
    profileId,
    device: label || describeDevice(ua),
    userAgent: ua.slice(0, 300),
    ip: req?.ip || req?.connection?.remoteAddress || 'unknown',
    remember: !!remember,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  const list = store.get();
  list.unshift(session);
  store.set(list.slice(0, MAX_SESSIONS));
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

function revokeOthers(keepId) {
  const list = store.get();
  const next = list.filter(s => s.id === keepId);
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

module.exports = { create, list, get, touch, isValid, revoke, revokeOthers, revokeAll, describeDevice, setProfile, flush };
