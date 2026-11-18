export function formatTime(seconds) {
  // Durations arrive in several shapes depending on source (ffprobe float,
  // numeric string from the SQLite index, "m:ss"/"h:mm:ss" strings, or
  // missing entirely). Normalise them all; unknown length is "—", not 0:00.
  if (typeof seconds === 'string' && seconds.includes(':')) {
    const parts = seconds.split(':').map(Number);
    if (parts.some(isNaN)) return '—';
    seconds = parts.reduce((sum, p) => sum * 60 + p, 0);
  }
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0:00';
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Track/runtime lengths: like formatTime, but a missing/zero length is unknown. */
export function formatDuration(seconds) {
  if (typeof seconds === 'string' && seconds.includes(':')) return formatTime(seconds) === '0:00' ? '—' : formatTime(seconds);
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? formatTime(value) : '—';
}

/** Numeric seconds for summing runtimes, whatever shape the value arrived in. */
export function durationSeconds(seconds) {
  if (typeof seconds === 'string' && seconds.includes(':')) {
    const parts = seconds.split(':').map(Number);
    return parts.some(isNaN) ? 0 : parts.reduce((sum, p) => sum * 60 + p, 0);
  }
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatDate(dateString) {
  if (!dateString) return 'Unknown';
  const date = new Date(dateString);
  if (isNaN(date)) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export function formatRelativeTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  if (diffDay < 30) return `${Math.floor(diffDay / 7)}w ago`;
  return formatDate(dateString);
}

export function truncate(str, len = 50) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len).trim() + '…';
}

export function formatYear(year) {
  if (year === null || year === undefined || year === '') return '';
  if (typeof year === 'object' && year.year) return String(year.year);
  return String(year);
}

export function escapeHtml(str) {
  if (!str) return '';
  if (typeof str !== 'string') str = String(str);
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function escapeAttr(str) {
  if (!str) return '';
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "1 track", "11 tracks" — instead of "track(s)". */
export function plural(count, singular, pluralForm = `${singular}s`) {
  const n = Number(count) || 0;
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

/**
 * Total running time in words, for album/artist/playlist summaries:
 * "45 sec", "3 min 29 sec", "52 min", "1 hr 12 min". Empty when unknown, so
 * callers can drop the piece instead of printing "0:00".
 */
export function formatTotalDuration(seconds) {
  const total = Math.round(durationSeconds(seconds));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h} hr ${m} min` : `${h} hr`;
  if (m) return m < 10 && s ? `${m} min ${s} sec` : `${m} min`;
  return `${s} sec`;
}
