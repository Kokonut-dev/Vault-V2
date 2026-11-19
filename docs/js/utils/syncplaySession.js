/**
 * The SyncPlay room this tab is in, shared by the SyncPlay page and the
 * playback controller (app-extras). Kept in sessionStorage so a refresh
 * rejoins the same room with the same member token instead of creating a
 * new (ghost) member.
 *
 *   { roomId, code, memberId, token, host }
 */
const KEY = 'vault_syncplay';

export function getSyncSession() {
  try {
    const raw = sessionStorage.getItem(KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && value.roomId && value.token ? value : null;
  } catch {
    return null;
  }
}

export function setSyncSession(value) {
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode: room only lasts for this page */ }
  window.dispatchEvent(new CustomEvent('vault:syncplay-session', { detail: value || null }));
}

/** Store the room + member from a create/join/get response. */
export function rememberRoom(room, member) {
  if (!room?.id || !member?.token) return null;
  const value = { roomId: room.id, code: room.code, memberId: member.id, token: member.token, host: !!member.host };
  setSyncSession(value);
  return value;
}

export function clearSyncSession() {
  setSyncSession(null);
}
