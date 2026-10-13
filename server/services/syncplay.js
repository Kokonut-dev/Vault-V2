/**
 * SyncPlay — watch together.
 *
 * A room holds the item being played plus a reference clock. Guests report
 * drift and get told to nudge; the host's play/pause/seek commands are relayed.
 * Transport is SSE (out) + JSON POST (in), which is all this needs and works
 * through the same tunnel as everything else.
 */
const { randomUUID } = require('crypto');
const events = require('./events');
const logger = require('../utils/logger');

const rooms = new Map(); // id -> room
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

function shortCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createRoom({ name, hostName, profileId = 'default', itemId = null, password = null }) {
  const room = {
    id: randomUUID().slice(0, 8),
    code: shortCode(),
    name: name || 'Watch Party',
    password,
    hostId: randomUUID().slice(0, 8),
    hostName: hostName || 'Host',
    profileId,
    itemId,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    members: [],
    chat: [],
  };
  rooms.set(room.id, room);
  return room;
}

function getRoom(id) {
  return rooms.get(id) || Array.from(rooms.values()).find(r => r.code === String(id).toUpperCase()) || null;
}

function join(room, { name, profileId = 'default' }) {
  const member = {
    id: randomUUID().slice(0, 8),
    name: String(name || 'Guest').slice(0, 40),
    profileId,
    joinedAt: new Date().toISOString(),
    lastSeen: Date.now(),
  };
  room.members.push(member);
  broadcast(room, 'syncplay:members', publicRoom(room));
  return member;
}

function leave(room, memberId) {
  room.members = room.members.filter(m => m.id !== memberId);
  broadcast(room, 'syncplay:members', publicRoom(room));
  if (room.members.length === 0 && Date.now() - room.updatedAt > 60_000) {
    // keep empty rooms briefly so a refresh does not kill the party
    setTimeout(() => {
      const current = rooms.get(room.id);
      if (current && current.members.length === 0) rooms.delete(room.id);
    }, 5 * 60 * 1000);
  }
}

function broadcast(room, event, data) {
  events.broadcast(event, { roomId: room.id, code: room.code, ...data });
}

function setItem(room, itemId, byMember) {
  room.itemId = itemId;
  room.position = 0;
  room.playing = true;
  room.startedAt = Date.now();
  room.updatedAt = Date.now();
  broadcast(room, 'syncplay:state', { itemId, playing: true, position: 0, by: byMember?.name || 'Host' });
  return room;
}

function setState(room, { playing, position, itemId }, byMember) {
  if (typeof playing === 'boolean') room.playing = playing;
  if (typeof position === 'number') {
    room.position = position;
    room.startedAt = Date.now();
  }
  if (itemId) room.itemId = itemId;
  room.updatedAt = Date.now();
  broadcast(room, 'syncplay:state', {
    itemId: room.itemId,
    playing: room.playing,
    position: room.position,
    by: byMember?.name || 'Host',
    at: Date.now(),
  });
  return room;
}

/** Guests report their own position; the server replies with a nudge. */
function reportPosition(room, memberId, position) {
  const member = room.members.find(m => m.id === memberId);
  if (member) member.lastSeen = Date.now();

  const elapsed = room.playing && room.startedAt ? (Date.now() - room.startedAt) / 1000 : 0;
  const expected = room.position + elapsed;
  const drift = position - expected;

  if (Math.abs(drift) > 2.5) {
    return { action: 'seek', position: Math.max(0, expected), drift };
  }
  if (Math.abs(drift) > 0.75) {
    return { action: drift > 0 ? 'nudge-back' : 'nudge-forward', amount: Math.abs(drift) };
  }
  return { action: 'ok', drift };
}

function addChat(room, member, text) {
  const message = {
    id: randomUUID().slice(0, 8),
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

function publicRoom(room) {
  return {
    id: room.id,
    code: room.code,
    name: room.name,
    hostName: room.hostName,
    hostId: room.hostId,
    itemId: room.itemId,
    playing: room.playing,
    position: room.position,
    hasPassword: !!room.password,
    members: room.members.map(m => ({ id: m.id, name: m.name, joinedAt: m.joinedAt })),
  };
}

function listRooms() {
  return Array.from(rooms.values()).map(publicRoom);
}

/** Sweep stale rooms + members. */
function sweep() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) {
      rooms.delete(id);
      continue;
    }
    const before = room.members.length;
    room.members = room.members.filter(m => now - m.lastSeen < 60_000);
    if (room.members.length !== before) broadcast(room, 'syncplay:members', publicRoom(room));
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
  listRooms,
  logger,
};
