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

function handle(event, data) {
  lastEventAt = Date.now();
  switch (event) {
    case 'library:changed': {
      emit('vault:library-changed', data);
      const { reason, title } = data || {};
      if (reason === 'add' && title) toast.info(`"${title}" was added to the library`, 'Library updated');
      else if (reason === 'artwork' && title) toast.info(`New artwork for "${title}"`);
      // Refresh in place; views listen for the event and re-render themselves.
      api.getLibrary({ limit: 1000 }).then(result => {
        store.setLibrary(result.items || []);
      }).catch(() => {});
      break;
    }
    case 'job:start':
      emit('vault:job-start', data);
      break;
    case 'job:progress':
      emit('vault:job-progress', data);
      break;
    case 'job:finished':
      emit('vault:job-finished', data);
      if (data?.status === 'error') toast.error(`${data.name || 'Job'} failed${data.error ? `: ${data.error}` : ''}`);
      else if (data?.name) toast.success(`${data.name} finished`);
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
    'scan:progress', 'scan:complete',
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
