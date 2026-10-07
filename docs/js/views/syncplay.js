/**
 * SyncPlay — watch together with friends (host/guest sync + chat).
 * Server: /api/syncplay (short codes, drift correction, 12 h TTL rooms).
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { toast } from '../components/toast.js';
import { promptModal } from '../components/modal.js';

let chatTimer = null;

function memberName() {
  return store.get('user')?.username || store.get('profileId') || 'Guest';
}

export async function renderSyncPlay(container, params = {}) {
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
    let rooms = [];
    try {
      rooms = (await api.getRooms()).rooms || [];
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="empty-state-message">${escapeHtml(err.message)}</div></div>`;
      return;
    }

    body.innerHTML = `
      <div class="page-actions" style="display:flex;gap:8px;margin-bottom:16px">
        <button class="btn btn-primary" id="room-create">${icon('plus', { size: 15 })}<span>Create room</span></button>
        <button class="btn btn-secondary" id="room-join">${icon('link', { size: 15 })}<span>Join with code</span></button>
      </div>
      ${rooms.length ? rooms.map(room => `
        <div class="download-row">
          <span class="row-icon">${icon('users', { size: 18 })}</span>
          <div class="row-main">
            <div class="row-title">${escapeHtml(room.name || 'Watch party')}</div>
            <div class="row-meta">${room.members?.length ?? 0} member(s) · host ${escapeHtml(room.host || '—')}${room.item ? ` · watching ${escapeHtml(room.item.title || '')}` : ''}</div>
          </div>
          <span class="room-code">${escapeHtml(room.code || '')}</span>
          <button class="btn btn-secondary btn-sm" data-room="${room.id}">Open</button>
        </div>`).join('') : '<div class="row-meta">No rooms are open right now.</div>'}
      <section class="section">
        <h2 class="section-title">How it works</h2>
        <p class="row-meta">Everyone joins the same room; the host's play/pause/seek is mirrored to guests. Vault nudges playback rate for small drift and seeks for big drift, so nothing drifts more than a couple of seconds.</p>
      </section>
    `;

    body.querySelector('#room-create').addEventListener('click', async () => {
      const name = await promptModal({ title: 'Create a watch party', label: 'Room name', value: `${memberName()}'s party`, confirmLabel: 'Create' });
      if (!name) return;
      try {
        const room = await api.createRoom({ name, itemId: store.get('currentVideoId') || null });
        toast.success(`Room created — code ${room.code}`);
        openRoom(room.id);
      } catch (err) {
        toast.error(err.message);
      }
    });
    body.querySelector('#room-join').addEventListener('click', async () => {
      const code = await promptModal({ title: 'Join a room', label: 'Room code', placeholder: 'ABC123', confirmLabel: 'Join' });
      if (!code) return;
      try {
        const room = await api.joinRoom(code.toUpperCase(), { name: memberName(), guest: true });
        window.dispatchEvent(new CustomEvent('vault:syncplay-joined', { detail: { roomId: room.id, memberId: room.memberId } }));
        if (room.item) window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: room.item } }));
        toast.success('Joined — playback follows the host');
      } catch (err) {
        toast.error(`Could not join: ${err.message}`);
      }
    });
    body.querySelectorAll('[data-room]').forEach(button => {
      button.addEventListener('click', () => openRoom(button.dataset.room));
    });
  }

  async function openRoom(roomId) {
    clearInterval(chatTimer);
    let room;
    try {
      room = await api.getRoom(roomId);
    } catch (err) {
      toast.error(err.message);
      return;
    }
    const members = room.members || [];

    body.innerHTML = `
      <div class="room-header" style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <span class="room-code">${escapeHtml(room.code || '')}</span>
        <div class="row-main">
          <div class="row-title">${escapeHtml(room.name || 'Watch party')}</div>
          <div class="row-meta">${members.map(m => `<span class="syncplay-member">${icon('users', { size: 12 })} ${escapeHtml(m.name)}${m.host ? ' · host' : ''}</span>`).join(' ')}</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="room-leave">Leave</button>
      </div>
      ${room.item ? `<div class="health-item ok">${icon('play', { size: 16 })}<div class="row-main"><div class="row-title">Now playing: ${escapeHtml(room.item.title)}</div></div>
        <button class="btn btn-primary btn-sm" id="room-play">Watch</button></div>` : ''}
      <section class="section">
        <h2 class="section-title">Chat</h2>
        <div class="syncplay-chat" id="chat-log"></div>
        <form id="chat-form" style="display:flex;gap:8px;margin-top:8px">
          <input class="form-input" id="chat-input" placeholder="Say something…" autocomplete="off">
          <button class="btn btn-primary" type="submit">${icon('send', { size: 15 })}</button>
        </form>
      </section>
    `;

    const log = body.querySelector('#chat-log');
    function paintChat(messages = []) {
      log.innerHTML = messages.map(message => message.system
        ? `<div class="chat-line system">${escapeHtml(message.text)}</div>`
        : `<div class="chat-line"><span class="who">${escapeHtml(message.name)}:</span> ${escapeHtml(message.text)}</div>`).join('');
      log.scrollTop = log.scrollHeight;
    }
    paintChat(room.chat || []);

    const refreshChat = async () => {
      try {
        const fresh = await api.getRoom(roomId);
        paintChat(fresh.chat || []);
      } catch { /* room closed */ }
    };
    chatTimer = setInterval(refreshChat, 4000);

    body.querySelector('#chat-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = body.querySelector('#chat-input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        await api.syncPlayChat(roomId, room.memberId, text);
        refreshChat();
      } catch (err) {
        toast.error(err.message);
      }
    });

    body.querySelector('#room-play')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: room.item } }));
    });

    body.querySelector('#room-leave').addEventListener('click', async () => {
      clearInterval(chatTimer);
      try {
        await api.leaveRoom(roomId, room.memberId);
      } catch { /* already gone */ }
      window.dispatchEvent(new CustomEvent('vault:syncplay-left', { detail: { roomId } }));
      loadRooms();
    });
  }

  window.addEventListener('vault:hashchange-cleanup', () => clearInterval(chatTimer));

  if (params.id) openRoom(params.id);
  else await loadRooms();
}

export default { renderSyncPlay };
