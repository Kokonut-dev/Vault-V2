/**
 * SyncPlay — watch together with friends (host/guest sync + chat).
 * Server: /api/syncplay (short codes, member tokens, drift correction).
 * Playback sync itself lives in app-extras (initSyncPlayFollower).
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { promptModal } from '../components/modal.js';
import { getSyncSession, rememberRoom, clearSyncSession } from '../utils/syncplaySession.js';
import { onUnmount } from '../utils/lifecycle.js';

let chatTimer = null;
let offChat = null;

/** This device's display name, if known (otherwise the server uses the profile name). */
function memberName() {
  return store.get('profile')?.name || store.get('user')?.username || undefined;
}

function stopRoomTimers() {
  clearInterval(chatTimer);
  chatTimer = null;
  offChat?.();
  offChat = null;
}

/** Join (or rejoin with this tab's token), asking for the password if needed. */
async function joinWithPrompt(idOrCode) {
  const session = getSyncSession();
  const token = session && (session.roomId === idOrCode || session.code === String(idOrCode).toUpperCase()) ? session.token : null;
  let password;
  for (let tries = 0; tries < 4; tries++) {
    try {
      const result = await api.joinRoom(idOrCode, { name: memberName(), password }, token);
      rememberRoom(result.room, result.member);
      return result;
    } catch (err) {
      if (err.code !== 'ROOM_PASSWORD') throw err;
      password = await promptModal({
        title: 'Room password',
        message: password ? 'That password isn’t right. Try again.' : 'This watch party has a password.',
        label: 'Password',
        inputType: 'password',
        confirmLabel: 'Join',
      });
      if (password === null) return null;
    }
  }
  return null;
}

export async function renderSyncPlay(container, params = {}) {
  stopRoomTimers();
  container.className = 'page';
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">${icon('users', { size: 26 })}<span>SyncPlay</span></h1>
      <p class="page-subtitle">Watch in sync with other devices or friends on the same server</p>
    </div>
    <div id="syncplay-body"></div>
  `;
  const body = container.querySelector('#syncplay-body');

  async function loadRooms() {
    stopRoomTimers();
    let rooms = [];
    try {
      rooms = (await api.getRooms()).rooms || [];
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }
    const mine = getSyncSession();

    body.innerHTML = `
      <div class="page-actions" style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn btn-primary" id="room-create">${icon('plus', { size: 15 })}<span>Create room</span></button>
        <button class="btn btn-secondary" id="room-join">${icon('link', { size: 15 })}<span>Join with code</span></button>
      </div>
      ${rooms.length ? rooms.map(room => `
        <div class="download-row">
          <span class="row-icon">${icon('users', { size: 18 })}</span>
          <div class="row-main">
            <div class="row-title">${escapeHtml(room.name || 'Watch party')}${room.hasPassword ? ` ${icon('lock', { size: 12 })}` : ''}</div>
            <div class="row-meta">${room.members?.length ?? 0} member(s) · host ${escapeHtml(room.host || '—')}</div>
          </div>
          <span class="room-code">${escapeHtml(room.code || '')}</span>
          <button class="btn btn-secondary btn-sm" data-room="${escapeHtml(room.id)}">${mine?.roomId === room.id ? 'Open' : 'Join'}</button>
        </div>`).join('') : '<div class="row-meta">No rooms are open right now.</div>'}
      <section class="section">
        <h2 class="section-title">How it works</h2>
        <p class="row-meta">Everyone joins the same room; the host's play/pause/seek is mirrored to guests. Vault nudges playback rate for small drift and seeks for big drift, so nothing drifts more than a couple of seconds.</p>
      </section>
    `;

    body.querySelector('#room-create').addEventListener('click', async () => {
      const name = await promptModal({ title: 'Create a watch party', label: 'Room name', value: memberName() ? `${memberName()}'s party` : 'Watch party', confirmLabel: 'Create' });
      if (!name) return;
      try {
        // Leaving any previous room first, so this device isn't in two.
        const previous = getSyncSession();
        if (previous) await api.leaveRoom(previous.roomId, previous.token).catch(() => {});
        const result = await api.createRoom({ name, hostName: memberName(), itemId: store.get('currentVideoId') || null });
        rememberRoom(result.room, result.member);
        toast.success(`Room created — code ${result.room.code}`);
        openRoom(result.room.id);
      } catch (err) {
        toast.error(err.message);
      }
    });
    body.querySelector('#room-join').addEventListener('click', async () => {
      const code = await promptModal({ title: 'Join a room', label: 'Room code', placeholder: 'ABC123', confirmLabel: 'Join' });
      if (!code) return;
      openRoom(code.trim().toUpperCase(), { join: true });
    });
    body.querySelectorAll('[data-room]').forEach(button => {
      button.addEventListener('click', () => openRoom(button.dataset.room, { join: true }));
    });
  }

  async function openRoom(idOrCode, { join = false } = {}) {
    stopRoomTimers();
    let session = getSyncSession();
    const isMine = session && (session.roomId === idOrCode || session.code === String(idOrCode).toUpperCase());
    try {
      if (!isMine || join) {
        const joined = await joinWithPrompt(idOrCode);
        if (!joined) return loadRooms();
        session = getSyncSession();
        if (joined.item) {
          window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: joined.item } }));
          toast.success(session.host ? 'You are the host' : 'Joined — playback follows the host');
        }
      }
    } catch (err) {
      toast.error(`Could not join: ${err.message}`);
      return loadRooms();
    }

    let room;
    try {
      room = await api.getRoom(session.roomId, session.token);
    } catch (err) {
      toast.error(err.message);
      clearSyncSession();
      return loadRooms();
    }

    body.innerHTML = `
      <div class="room-header" style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <span class="room-code">${escapeHtml(room.code || '')}</span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(room.name || 'Watch party')}</div>
          <div class="row-meta" id="room-members"></div>
        </div>
        <button class="btn btn-ghost btn-sm" id="room-leave">Leave</button>
      </div>
      <div id="room-item"></div>
      <section class="section">
        <h2 class="section-title">Chat</h2>
        <div class="syncplay-chat" id="chat-log"></div>
        <form id="chat-form" style="display:flex;gap:8px;margin-top:8px">
          <input class="form-input" id="chat-input" placeholder="Say something…" autocomplete="off" maxlength="600">
          <button class="btn btn-primary" type="submit" aria-label="Send">${icon('send', { size: 15 })}</button>
        </form>
      </section>
    `;

    const log = body.querySelector('#chat-log');
    let current = room;
    function paint(fresh) {
      current = fresh;
      const me = fresh.member?.id;
      body.querySelector('#room-members').innerHTML = (fresh.members || []).map(m => `<span class="syncplay-member">${icon('users', { size: 12 })} ${escapeHtml(m.name)}${m.host ? ' · host' : ''}${m.id === me ? ' (you)' : ''}</span>`).join(' ');
      body.querySelector('#room-item').innerHTML = fresh.item
        ? `<div class="health-item ok">${icon('play', { size: 16 })}<div class="row-main"><div class="row-title">Now playing: ${escapeHtml(fresh.item.title)}</div></div>
          <button class="btn btn-primary btn-sm" id="room-play">Watch</button></div>`
        : `<div class="row-meta">${fresh.member?.host ? 'Play something and everyone in the room follows.' : 'Waiting for the host to play something.'}</div>`;
      body.querySelector('#room-play')?.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: current.item } }));
      });
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.innerHTML = (fresh.chat || []).map(message => message.system
        ? `<div class="chat-line system">${escapeHtml(message.text)}</div>`
        : `<div class="chat-line"><span class="who">${escapeHtml(message.name)}:</span> ${escapeHtml(message.text)}</div>`).join('');
      if (atBottom) log.scrollTop = log.scrollHeight;
      // Host can change hands (the host left); keep the controller in step.
      const s = getSyncSession();
      if (s && fresh.member && s.host !== !!fresh.member.host) rememberRoom(fresh, { ...fresh.member, token: s.token });
    }
    paint(room);

    const refresh = async () => {
      const s = getSyncSession();
      if (!s) return;
      try {
        const fresh = await api.getRoom(s.roomId, s.token);
        if (!fresh.member) {
          // Dropped (timed out, or removed) — back to the room list.
          clearSyncSession();
          toast.info('You left the room');
          loadRooms();
          return;
        }
        paint(fresh);
      } catch (err) {
        if (err.status === 404) {
          clearSyncSession();
          toast.info('The room was closed');
          loadRooms();
        }
      }
    };
    // Refreshing also keeps this member "seen" by the server.
    chatTimer = setInterval(refresh, 5000);
    const onLive = (event) => { if (event.detail?.roomId === session.roomId) refresh(); };
    window.addEventListener('vault:syncplay-chat', onLive);
    window.addEventListener('vault:syncplay-members', onLive);
    offChat = () => {
      window.removeEventListener('vault:syncplay-chat', onLive);
      window.removeEventListener('vault:syncplay-members', onLive);
    };

    body.querySelector('#chat-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = body.querySelector('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await api.syncPlayChat(session.roomId, session.token, text);
        refresh();
      } catch (err) {
        toast.error(err.message);
        input.value = text;
      }
    });

    body.querySelector('#room-leave').addEventListener('click', async () => {
      stopRoomTimers();
      try {
        await api.leaveRoom(session.roomId, session.token);
      } catch { /* already gone */ }
      clearSyncSession();
      loadRooms();
    });
  }

  // (The old page listened for an event nothing sent, so its chat poll ran
  // forever after leaving the page.)
  onUnmount(stopRoomTimers);

  if (params.id) openRoom(params.id);
  else if (getSyncSession()) openRoom(getSyncSession().roomId);
  else await loadRooms();
}

export default { renderSyncPlay };
