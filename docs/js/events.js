/**
 * Live server events over Server-Sent Events.
 *
 * The server has exposed `/api/events` since 2.0, but the client never opened
 * it (audit finding F-22), so every library change needed a manual reload.
 * This module keeps one EventSource alive, fans events out as DOM custom
 * events, and drives the store + toasts for the common cases.
 */
import { api } from './api.js';
import { store } from './store.js';
import { toast } from './components/toast.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let source = null;
let attempt = 0;
let stopped = false;
let reconnectTimer = null;
let lastEventAt = 0;

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// A folder import or a big copy into a watched folder fires one
// `library:changed` per file. Each used to show its own toast AND refetch the
// whole library (up to 1000 items) — 50 tracks meant 50 toasts and 50 full
// downloads. Now additions are announced once per burst and the refetch is
// debounced; the per-event DOM event still fires immediately.
const BURST_MS = 1200;
let refreshTimer = null;
let addedTitles = new Map(); // id → title (the watcher and an import can both report a file)
let addedTimer = null;

function scheduleLibraryRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    api.getLibrary({ limit: 1000 }).then(result => {
      store.setLibrary(result.items || []);
    }).catch(() => {});
  }, 400);
}

// Items an import already reported (it shows its own summary). The watcher
// sees the same file a couple of seconds later; stay quiet for it too.
const quietIds = new Map(); // id → expiry
function isQuiet(id, quiet) {
  const now = Date.now();
  for (const [key, until] of quietIds) if (until < now) quietIds.delete(key);
  if (quiet && id) quietIds.set(id, now + 60000);
  return Boolean(quiet || (id && quietIds.has(id)));
}

function announceAdded(title, id) {
  addedTitles.set(id || title, title);
  clearTimeout(addedTimer);
  addedTimer = setTimeout(() => {
    const titles = [...addedTitles.values()];
    addedTitles = new Map();
    if (titles.length === 1) toast.info(`"${titles[0]}" was added to the library`, 'Library updated');
    else toast.info(`${titles.length} items were added, including "${titles[0]}"`, 'Library updated');
  }, BURST_MS);
}

function handle(event, data) {
  lastEventAt = Date.now();
  switch (event) {
    case 'library:changed': {
      emit('vault:library-changed', data);
      const { reason, title, id, quiet } = data || {};
      if (reason === 'add' && title && !isQuiet(id, quiet)) announceAdded(title, id);
      else if (reason === 'artwork' && title) toast.info(`New artwork for "${title}"`);
      // Refresh in place; views listen for the event and re-render themselves.
      scheduleLibraryRefresh();
      break;
    }
    case 'import:progress':
      emit('vault:import-progress', data);
      break;
    case 'remote:changed':
      emit('vault:remote-changed', data);
      break;
    case 'job:start':
      emit('vault:job-start', data);
      break;
    case 'job:progress':
      emit('vault:job-progress', data);
      break;
    case 'job:finished':
      emit('vault:job-finished', data);
      if (data?.status === 'error') toast.error(`${data.name || 'Job'} failed${data.error ? `: ${data.error}` : ''}`);
      else if (data?.status === 'cancelled') toast.info(`${data.name || 'Job'} cancelled`);
      else if (data?.name && data.imported != null) {
        const files = `${data.imported} file${data.imported === 1 ? '' : 's'}`;
        if (data.failed) toast.info(`${data.name}: ${files} added, ${data.failed} failed`);
        else toast.success(`${data.name}: ${files} added`);
      } else if (data?.name) toast.success(`${data.name} finished`);
      break;
    case 'watchlist:changed':
      emit('vault:watchlist-changed', data);
      break;
    case 'collection:changed':
      emit('vault:collections-changed', data);
      break;
    case 'markers:changed':
      emit('vault:markers-changed', data);
      break;
    case 'profile:changed':
      emit('vault:profiles-changed', data);
      break;
    case 'podcast:changed':
      emit('vault:podcasts-changed', data);
      break;
    case 'playback:started':
    case 'playback:stopped':
      emit(`vault:${event.replace(':', '-')}`, data);
      break;
    case 'syncplay:state': {
      // Guests follow the host's position; the drift correction itself lives
      // in app-extras (syncplay controller) so the client stays decoupled.
      emit('vault:syncplay-state', data);
      break;
    }
    case 'syncplay:members':
    case 'syncplay:item':
    case 'syncplay:chat':
      emit(`vault:${event.replace(':', '-')}`, data);
      break;
    case 'recording:changed':
    case 'recording:finished':
      emit('vault:recordings-changed', data);
      if (event === 'recording:finished') toast.success('Recording finished');
      break;
    case 'scan:progress':
      emit('vault:scan-progress', data);
      break;
    case 'scan:complete':
      emit('vault:scan-complete', data);
      toast.success(`Scan complete — ${data?.found ?? 0} files, ${data?.added ?? 0} new`);
      break;
    default:
      emit('vault:server-event', { event, data });
  }
}

export function connect() {
  if (source || stopped) return source;
  if (!api.getToken()) return null;

  try {
    source = new EventSource(api.getEventsUrl());
  } catch {
    scheduleReconnect();
    return null;
  }

  source.addEventListener('open', () => {
    attempt = 0;
    if (lastEventAt) toast.success('Live updates reconnected');
  });

  source.addEventListener('message', (message) => {
    // Unnamed messages carry {event, data} envelopes from the server bus.
    try {
      const payload = JSON.parse(message.data);
      if (payload?.event) handle(payload.event, payload.data);
    } catch { /* keepalive comment or malformed frame */ }
  });

  // Named events (the server may also send `event: library:changed`).
  const NAMED = [
    'library:changed', 'job:start', 'job:progress', 'job:finished', 'watchlist:changed',
    'collection:changed', 'markers:changed', 'profile:changed', 'podcast:changed',
    'playback:started', 'playback:stopped', 'syncplay:state', 'syncplay:members',
    'syncplay:item', 'syncplay:chat', 'recording:changed', 'recording:finished',
    'scan:progress', 'scan:complete', 'import:progress', 'remote:changed',
  ];
  for (const name of NAMED) {
    source.addEventListener(name, (message) => {
      try {
        handle(name, JSON.parse(message.data));
      } catch {
        handle(name, {});
      }
    });
  }

  source.addEventListener('error', () => {
    // EventSource auto-reconnects, but a 401 (expired token) needs a full
    // restart with the fresh token — close and retry with backoff.
    if (source && source.readyState === EventSource.CLOSED) {
      source.close();
      source = null;
      scheduleReconnect();
    }
  });

  return source;
}

export function disconnect() {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (source) {
    source.close();
    source = null;
  }
}

export function reconnect() {
  disconnect();
  stopped = false;
  attempt = 0;
  return connect();
}

export function liveStatus() {
  return {
    connected: !!source && source.readyState === EventSource.OPEN,
    readyState: source?.readyState ?? 2,
    lastEventAt,
  };
}

export function initLiveEvents() {
  connect();
  // The token changes on login/logout/refresh — restart the stream so the new
  // token is used instead of hammering the endpoint with a stale one.
  window.addEventListener('vault:token-changed', () => reconnect());
  window.addEventListener('vault:logout', () => disconnect());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !liveStatus().connected) reconnect();
  });
  return { connect, disconnect, reconnect, liveStatus };
}
