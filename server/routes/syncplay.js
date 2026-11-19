const express = require('express');
const router = express.Router();
const syncplay = require('../services/syncplay');
const libraryService = require('../services/library');
const profiles = require('../services/profiles');

/** The member token: X-SyncPlay-Member header or `memberToken` in the body. */
function tokenFrom(req) {
  return req.get('x-syncplay-member') || req.body?.memberToken || null;
}

/** Room + the calling member (null when the token doesn't belong to it). */
function lookup(req) {
  const room = syncplay.getRoom(req.params.id);
  if (!room) return { room: null, member: null };
  return { room, member: syncplay.memberByToken(room, tokenFrom(req)) };
}

/** The room's item, if this profile may see it (age limits). */
function visibleItem(req, itemId) {
  if (!itemId) return null;
  const item = libraryService.getById(itemId);
  return item && profiles.canAccess(req.profileId || 'default', item) ? item : null;
}

function displayName(req, field = 'name') {
  const fromBody = typeof req.body?.[field] === 'string' ? req.body[field].trim() : '';
  if (fromBody) return fromBody;
  return profiles.get(req.profileId || 'default')?.name || req.user?.username || 'Guest';
}

router.get('/rooms', (req, res) => {
  res.json({ rooms: syncplay.listRooms() });
});

router.post('/rooms', (req, res) => {
  const itemId = req.body?.itemId || null;
  if (itemId && !visibleItem(req, itemId)) return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });
  const password = typeof req.body?.password === 'string' && req.body.password ? req.body.password : null;
  const room = syncplay.createRoom({
    name: req.body?.name,
    profileId: req.profileId || 'default',
    itemId,
    password,
  });
  // (`name` is the room's name here; the host's own name is `hostName`.)
  const host = syncplay.join(room, { name: displayName(req, 'hostName'), profileId: req.profileId, sid: req.user?.sid, host: true });
  res.json({ room: syncplay.publicRoom(room), member: syncplay.privateMember(room, host), item: visibleItem(req, room.itemId) });
});

// Anyone may see that a room exists; the chat and the item are for members.
router.get('/rooms/:id', (req, res) => {
  const { room, member } = lookup(req);
  if (!room) return res.status(404).json({ error: 'Room not found', code: 'NOT_FOUND' });
  const payload = syncplay.publicRoom(room);
  if (member) {
    payload.item = visibleItem(req, room.itemId);
    payload.chat = room.chat.slice(-50);
    payload.member = syncplay.privateMember(room, member);
  }
  res.json(payload);
});

router.post('/rooms/:id/join', (req, res) => {
  const room = syncplay.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found', code: 'NOT_FOUND' });
  // Rejoining (e.g. after a refresh) with a still-valid token keeps the same member.
  const existing = syncplay.memberByToken(room, tokenFrom(req));
  if (!existing && !syncplay.checkPassword(room, req.body?.password)) {
    // 403, not 401: the client treats any 401 as an expired sign-in.
    return res.status(403).json({ error: req.body?.password ? 'Wrong room password' : 'This room has a password', code: 'ROOM_PASSWORD' });
  }
  const joined = existing || syncplay.join(room, { name: displayName(req), profileId: req.profileId, sid: req.user?.sid });
  if (existing && req.user?.sid) existing.sid = req.user.sid;
  res.json({ room: syncplay.publicRoom(room), member: syncplay.privateMember(room, joined), item: visibleItem(req, room.itemId) });
});

router.post('/rooms/:id/leave', (req, res) => {
  const { room, member } = lookup(req);
  if (!room) return res.status(404).json({ error: 'Room not found', code: 'NOT_FOUND' });
  if (!member) return res.status(403).json({ error: 'Not in this room', code: 'NOT_A_MEMBER' });
  syncplay.leave(room, member.id);
  res.json({ message: 'Left room' });
});

router.post('/rooms/:id/item', (req, res) => {
  const { room, member } = lookup(req);
  if (!room) return res.status(404).json({ error: 'Room not found', code: 'NOT_FOUND' });
  if (!member) return res.status(403).json({ error: 'Not in this room', code: 'NOT_A_MEMBER' });
  if (!syncplay.isHost(room, member)) return res.status(403).json({ error: 'Only the host can change the item', code: 'HOST_ONLY' });
  const item = visibleItem(req, req.body?.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });
  syncplay.setItem(room, item.id, member);
  res.json({ item, room: syncplay.publicRoom(room) });
});

router.post('/rooms/:id/state', (req, res) => {
  const { room, member } = lookup(req);
  if (!room) return res.status(404).json({ error: 'Room not found', code: 'NOT_FOUND' });
  if (!member) return res.status(403).json({ error: 'Not in this room', code: 'NOT_A_MEMBER' });
  const { playing } = req.body || {};
  const position = Number(req.body?.position);
  // Guests may only report their own drift, never command the room.
  if (!syncplay.isHost(room, member)) {
    const nudge = syncplay.reportPosition(room, member, Number.isFinite(position) ? position : 0);
    return res.json({ role: 'guest', ...nudge });
  }
  syncplay.setState(room, {
    playing: typeof playing === 'boolean' ? playing : undefined,
    position: Number.isFinite(position) && position >= 0 ? position : undefined,
  }, member);
  res.json({ role: 'host', room: syncplay.publicRoom(room) });
});

router.post('/rooms/:id/chat', (req, res) => {
  const { room, member } = lookup(req);
  if (!room) return res.status(404).json({ error: 'Room not found', code: 'NOT_FOUND' });
  if (!member) return res.status(403).json({ error: 'Not in this room', code: 'NOT_A_MEMBER' });
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'Message is empty', code: 'EMPTY' });
  res.json(syncplay.addChat(room, member, text));
});

module.exports = router;
