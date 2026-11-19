/**
 * SyncPlay — watch together.
 *
 * A room holds the item being played plus a reference clock. The host's
 * play/pause/seek is published to the room; guests report their position and
 * get told to nudge or seek. Transport is SSE (out) + JSON POST (in).
 *
 * Membership: joining returns a member `token` that only that device gets.
 * Every room action (state, item, chat, leave, reading the chat) needs it —
 * member ids are public (they are in the member list) and are not a
 * credential. Room events go only to the devices in the room.
 */
const crypto = require('crypto');
const events = require('./events');
const logger = require('../utils/logger');

const rooms = new Map(); // id -> room
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
// Members that haven't been heard from (state report, chat, room refresh) for
// this long are dropped. Clients refresh every few seconds while in a room.
const MEMBER_TIMEOUT_MS = 2 * 60 * 1000;
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function shortCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (![...rooms.values()].some(r => r.code === code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

const newId = () => crypto.randomBytes(6).toString('hex');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function checkPassword(room, password) {
  if (!room.passwordHash) return true;
  if (typeof password !== 'string' || !password) return false;
  const [saltHex, hashHex] = room.passwordHash.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function createRoom({ name, profileId = 'default', itemId = null, password = null }) {
  const room = {
    id: newId(),
    code: shortCode(),
    name: String(name || 'Watch party').slice(0, 80),
    passwordHash: password ? hashPassword(password) : null,
    hostMemberId: null,
    profileId,
    itemId,
    playing: false,
    position: 0,
    startedAt: null,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    emptySince: null,
    members: [],
    chat: [],
  };
  rooms.set(room.id, room);
  return room;
}

function getRoom(idOrCode) {
  if (idOrCode == null) return null;
  const key = String(idOrCode);
  return rooms.get(key) || [...rooms.values()].find(r => r.code === key.toUpperCase()) || null;
}

/** The member a request's token belongs to (and mark them as seen). */
function memberByToken(room, token) {
  if (!room || typeof token !== 'string' || !token) return null;
  const member = room.members.find(m => m.token.length === token.length
    && crypto.timingSafeEqual(Buffer.from(m.token), Buffer.from(token)));
  if (member) member.lastSeen = Date.now();
  return member || null;
}

function isHost(room, member) {
  return !!member && room.hostMemberId === member.id;
}

function join(room, { name, profileId = 'default', sid = null, host = false }) {
  const member = {
    id: newId(),
    token: crypto.randomBytes(24).toString('hex'),
    name: String(name || 'Guest').slice(0, 40),
    profileId,
    sid,
    joinedAt: new Date().toISOString(),
    lastSeen: Date.now(),
  };
  room.members.push(member);
  room.emptySince = null;
  if (host || !room.hostMemberId) room.hostMemberId = member.id;
  broadcast(room, 'syncplay:members', publicRoom(room));
  return member;
}

/** The host left or timed out: the longest-standing member takes over. */
function ensureHost(room) {
  if (room.members.some(m => m.id === room.hostMemberId)) return;
  room.hostMemberId = room.members[0]?.id || null;
}

function leave(room, memberId) {
  const before = room.members.length;
  room.members = room.members.filter(m => m.id !== memberId);
  if (room.members.length === before) return false;
  ensureHost(room);
  if (!room.members.length) room.emptySince = Date.now();
  broadcast(room, 'syncplay:members', publicRoom(room));
  return true;
}

/** Room events go to the room's devices only — not every signed-in browser. */
function broadcast(room, event, data) {
  events.sendToSessions(room.members.map(m => m.sid), event, { roomId: room.id, code: room.code, ...data });
}

/** Where playback should be right now, from the reference clock. */
function currentPosition(room, now = Date.now()) {
  const elapsed = room.playing && room.startedAt ? (now - room.startedAt) / 1000 : 0;
  return room.position + elapsed;
}

function stateEvent(room, byMember) {
  return {
    itemId: room.itemId,
    playing: room.playing,
    position: currentPosition(room),
    by: byMember?.name || 'Host',
    at: Date.now(),
  };
}

function setItem(room, itemId, byMember) {
  room.itemId = itemId;
  room.position = 0;
  room.playing = true;
  room.startedAt = Date.now();
  room.updatedAt = Date.now();
  broadcast(room, 'syncplay:state', stateEvent(room, byMember));
  return room;
}

function setState(room, { playing, position, itemId }, byMember) {
  if (typeof position === 'number' && Number.isFinite(position) && position >= 0) {
    room.position = position;
    room.startedAt = Date.now();
  } else if (typeof playing === 'boolean' && playing !== room.playing) {
    // Pausing/resuming without a position: freeze/restart the clock where it is.
    room.position = currentPosition(room);
    room.startedAt = Date.now();
  }
  if (typeof playing === 'boolean') room.playing = playing;
  if (itemId) room.itemId = itemId;
  room.updatedAt = Date.now();
  broadcast(room, 'syncplay:state', stateEvent(room, byMember));
  return room;
}

/** Guests report their own position; the server replies with a nudge. */
function reportPosition(room, member, position) {
  if (member) member.lastSeen = Date.now();
  const expected = currentPosition(room);
  const drift = position - expected;
  const base = { playing: room.playing, itemId: room.itemId, expected };
  if (Math.abs(drift) > 2.5) return { ...base, action: 'seek', position: Math.max(0, expected), drift };
  if (Math.abs(drift) > 0.75) return { ...base, action: drift > 0 ? 'nudge-back' : 'nudge-forward', amount: Math.abs(drift), drift };
  return { ...base, action: 'ok', drift };
}

function addChat(room, member, text) {
  const message = {
    id: newId(),
    memberId: member.id,
    name: member.name,
    text: String(text || '').slice(0, 600),
    at: new Date().toISOString(),
  };
  room.chat.push(message);
  if (room.chat.length > 200) room.chat = room.chat.slice(-200);
  broadcast(room, 'syncplay:chat', { message });
  return message;
}

/** What anyone signed in may see about a room (no tokens, no password). */
function publicRoom(room) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    host: room.members.find(m => m.id === room.hostMemberId)?.name || null,
    hostMemberId: room.hostMemberId,
    itemId: room.itemId,
    playing: room.playing,
    position: currentPosition(room),
    hasPassword: !!room.passwordHash,
    members: room.members.map(m => ({ id: m.id, name: m.name, joinedAt: m.joinedAt, host: m.id === room.hostMemberId })),
  };
}

/** A member's own credentials (returned only to that member). */
function privateMember(room, member) {
  return { id: member.id, token: member.token, name: member.name, host: isHost(room, member) };
}

function listRooms() {
  return [...rooms.values()].map(publicRoom);
}

/** Sweep stale rooms + members. */
function sweep(now = Date.now()) {
  for (const [id, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS && now - Math.max(0, ...room.members.map(m => m.lastSeen)) > ROOM_TTL_MS) {
      rooms.delete(id);
      continue;
    }
    const before = room.members.length;
    room.members = room.members.filter(m => now - m.lastSeen < MEMBER_TIMEOUT_MS);
    if (room.members.length !== before) {
      ensureHost(room);
      if (!room.members.length && !room.emptySince) room.emptySince = now;
      broadcast(room, 'syncplay:members', publicRoom(room));
    }
    // Empty rooms are kept briefly so a page refresh doesn't end the party.
    if (!room.members.length && room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) rooms.delete(id);
  }
}

const sweepTimer = setInterval(sweep, 30000);
if (sweepTimer.unref) sweepTimer.unref();

module.exports = {
  createRoom,
  getRoom,
  join,
  leave,
  setItem,
  setState,
  reportPosition,
  addChat,
  publicRoom,
  privateMember,
  memberByToken,
  isHost,
  checkPassword,
  listRooms,
  sweep,
  currentPosition,
  _rooms: rooms,
  logger,
};
