/**
 * SyncPlay control in the video player — start or join a watch party for
 * what's playing without leaving the player, see the room code and leave.
 *
 * Before this, a watch party could only be set up from the SyncPlay page,
 * which never knew which video was playing (it read a `currentVideoId` that
 * nothing set), so the host had to start a room and then go back and replay.
 *
 * Playback sync itself stays in app-extras (initSyncPlayFollower); this only
 * manages the room membership (utils/syncplaySession.js).
 */
import { api } from '../api.js';
import { store } from '../store.js';
import { icon } from '../utils/icons.js';
import { escapeHtml } from '../utils/format.js';
import { toast } from './toast.js';
import { getSyncSession, rememberRoom, clearSyncSession } from '../utils/syncplaySession.js';
import { joinWithPrompt, memberName } from '../views/syncplay.js';
import { router } from '../router.js';

let currentItem = null;
let button = null;
let menu = null;

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    return false;
  }
}

function paintButton() {
  if (!button) return;
  const session = getSyncSession();
  button.classList.toggle('active', !!session);
  button.setAttribute('aria-pressed', session ? 'true' : 'false');
  const label = session
    ? `Watch party ${session.code || ''}${session.host ? ' (you are the host)' : ''}`.trim()
    : 'Watch together';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = `${icon('users', { size: 18 })}${session?.code ? `<span class="syncplay-code-badge">${escapeHtml(session.code)}</span>` : ''}`;
}

function closeMenu() {
  menu?.classList.remove('active');
  button?.setAttribute('aria-expanded', 'false');
}

function menuItem(action, iconName, label) {
  return `<button type="button" class="context-menu-item" role="menuitem" data-sync-action="${action}">${icon(iconName, { size: 15 })}<span>${escapeHtml(label)}</span></button>`;
}

async function renderMenu() {
  const session = getSyncSession();
  if (!session) {
    menu.innerHTML = `
      <div class="context-menu-label">Watch together</div>
      ${currentItem ? menuItem('start', 'play', 'Start a watch party with this video') : ''}
      ${menuItem('join', 'link', 'Join with a code…')}`;
    return;
  }
  menu.innerHTML = `
    <div class="context-menu-label">Watch party <strong>${escapeHtml(session.code || '')}</strong>${session.host ? ' · host' : ''}</div>
    <div class="context-menu-label" data-sync-members>…</div>
    ${menuItem('copy', 'copy', 'Copy invite code')}
    ${session.host && currentItem ? menuItem('share', 'play', 'Play this video for everyone') : ''}
    ${menuItem('open', 'users', 'Open room and chat')}
    ${menuItem('leave', 'log-out', 'Leave watch party')}`;
  try {
    const room = await api.getRoom(session.roomId, session.token);
    const count = room.members?.length ?? 0;
    const label = menu.querySelector('[data-sync-members]');
    if (label) label.textContent = `${count} ${count === 1 ? 'person' : 'people'}${room.item ? ` · ${room.item.title}` : ''}`;
  } catch (err) {
    if (err?.status === 404 || err?.code === 'NOT_A_MEMBER') {
      clearSyncSession();
      closeMenu();
      toast.info('The watch party has ended');
    }
  }
}

async function startParty() {
  if (!currentItem) return;
  const previous = getSyncSession();
  if (previous) await api.leaveRoom(previous.roomId, previous.token).catch(() => {});
  const name = memberName();
  const result = await api.createRoom({
    name: name ? `${name}'s party` : 'Watch party',
    hostName: name,
    itemId: currentItem.id,
  });
  rememberRoom(result.room, result.member);
  const copied = await copyCode(result.room.code);
  toast.success(`Watch party started — code ${result.room.code}${copied ? ' (copied)' : ''}. Others join from SyncPlay or the player.`);
}

async function joinParty() {
  const { promptModal } = await import('./modal.js');
  const code = await promptModal({ title: 'Join a watch party', label: 'Room code', placeholder: 'ABC123', confirmLabel: 'Join' });
  if (!code) return;
  const previous = getSyncSession();
  const wanted = code.trim().toUpperCase();
  if (previous && previous.code !== wanted) await api.leaveRoom(previous.roomId, previous.token).catch(() => {});
  const joined = await joinWithPrompt(wanted);
  if (!joined) return;
  const session = getSyncSession();
  if (joined.item && joined.item.id !== currentItem?.id) {
    window.dispatchEvent(new CustomEvent('vault:open-video', { detail: { item: joined.item } }));
  }
  toast.success(session?.host ? 'You are the host' : 'Joined — playback follows the host');
}

async function onAction(action) {
  const session = getSyncSession();
  closeMenu();
  try {
    if (action === 'start') await startParty();
    else if (action === 'join') await joinParty();
    else if (action === 'copy' && session) {
      toast[(await copyCode(session.code)) ? 'success' : 'info'](`Room code: ${session.code}`);
    } else if (action === 'share' && session && currentItem) {
      await api.syncPlayItem(session.roomId, session.token, currentItem.id);
      toast.success('Everyone in the room is now watching this');
    } else if (action === 'open') {
      router.navigate('/syncplay');
    } else if (action === 'leave' && session) {
      await api.leaveRoom(session.roomId, session.token).catch(() => {});
      clearSyncSession();
      toast.info('You left the watch party');
    }
  } catch (err) {
    toast.error(`Watch party: ${err.message}`);
  }
}

/** Add the button to the player controls (idempotent). */
export function buildSyncPlayButton() {
  const anchor = document.getElementById('video-captions');
  if (!anchor || document.getElementById('video-syncplay')) return;
  button = document.createElement('button');
  button.type = 'button';
  button.className = 'video-control-btn video-syncplay-btn';
  button.id = 'video-syncplay';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  anchor.parentNode.insertBefore(button, anchor);

  menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'video-syncplay-menu';
  menu.setAttribute('role', 'menu');
  document.body.appendChild(menu);

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (menu.classList.contains('active')) return closeMenu();
    const pending = renderMenu();
    const rect = button.getBoundingClientRect();
    menu.classList.add('active');
    menu.style.left = `${Math.max(8, rect.right - 260)}px`;
    menu.style.top = `${Math.max(8, rect.top - menu.offsetHeight - 8)}px`;
    button.setAttribute('aria-expanded', 'true');
    await pending;
  });
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    const action = event.target.closest('[data-sync-action]')?.dataset.syncAction;
    if (action) onAction(action);
  });
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  paintButton();
}

export function initSyncPlayControl() {
  window.addEventListener('vault:video-opened', (event) => {
    const item = event.detail?.item;
    // Live TV and external links can't be synced.
    currentItem = item?.id && !item.live && !item.external ? item : null;
    store.set('currentVideoId', currentItem?.id || null);
    buildSyncPlayButton();
  });
  window.addEventListener('vault:video-closed', () => {
    currentItem = null;
    store.set('currentVideoId', null);
    closeMenu();
  });
  window.addEventListener('vault:syncplay-session', paintButton);
  // The controls are in the page from the start.
  buildSyncPlayButton();
}

export default { initSyncPlayControl };
