const express = require('express');
const router = express.Router();
const syncplay = require('../services/syncplay');
const libraryService = require('../services/library');

function member(req) {
  const room = syncplay.getRoom(req.params.id || req.body.roomId);
  if (!room) return { room: null, member: null };
  const found = room.members.find(m => m.id === (req.body?.memberId || req.query.memberId));
  return { room, member: found };
}

router.get('/rooms', (req, res) => {
  res.json({ rooms: syncplay.listRooms() });
});

router.post('/rooms', (req, res) => {
  const room = syncplay.createRoom({
    name: req.body?.name,
    hostName: req.body?.hostName || req.user?.username,
    profileId: req.profileId || 'default',
    itemId: req.body?.itemId || null,
    password: req.body?.password || null,
  });
  const hostMember = syncplay.join(room, { name: req.body?.hostName || 'Host', profileId: req.profileId });
  res.json({ room: syncplay.publicRoom(room), hostId: room.hostId, member: hostMember });
});

router.get('/rooms/:id', (req, res) => {
  const room = syncplay.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const payload = syncplay.publicRoom(room);
  payload.item = room.itemId ? libraryService.getById(room.itemId) : null;
  payload.chat = room.chat.slice(-50);
  res.json(payload);
});

router.post('/rooms/:id/join', (req, res) => {
  const room = syncplay.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.password && req.body?.password !== room.password) {
    return res.status(401).json({ error: 'Wrong room password', code: 'ROOM_PASSWORD' });
  }
  const joined = syncplay.join(room, { name: req.body?.name, profileId: req.profileId });
  res.json({ room: syncplay.publicRoom(room), member: joined, item: room.itemId ? libraryService.getById(room.itemId) : null });
});

router.post('/rooms/:id/leave', (req, res) => {
  const { room } = member(req);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  syncplay.leave(room, req.body?.memberId);
  res.json({ message: 'Left room' });
});

router.post('/rooms/:id/item', (req, res) => {
  const { room, member: who } = member(req);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (who?.id !== room.hostId) return res.status(403).json({ error: 'Only the host can change the item' });
  syncplay.setItem(room, req.body.itemId, who);
  res.json({ item: libraryService.getById(req.body.itemId), room: syncplay.publicRoom(room) });
});

router.post('/rooms/:id/state', (req, res) => {
  const { room, member: who } = member(req);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const isHost = who?.id === room.hostId;
  const { playing, position } = req.body || {};
  // Guests may only report their own drift, never command the room.
  if (!isHost) {
    const nudge = syncplay.reportPosition(room, who?.id, Number(position) || 0);
    return res.json({ role: 'guest', ...nudge });
  }
  syncplay.setState(room, { playing, position: Number(position) || 0 }, who);
  res.json({ role: 'host', room: syncplay.publicRoom(room) });
});

router.post('/rooms/:id/chat', (req, res) => {
  const { room, member: who } = member(req);
  if (!room || !who) return res.status(404).json({ error: 'Not in this room' });
  res.json(syncplay.addChat(room, who, req.body?.text));
});

module.exports = router;
