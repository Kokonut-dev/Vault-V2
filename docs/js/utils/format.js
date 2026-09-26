export function formatTime(seconds) {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
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

export function formatDuration(seconds) {
  if (!seconds) return '0:00';
  return formatTime(seconds);
}

export function truncate(str, len = 50) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.substring(0, len).trim() + '…';
}

export function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function parseYear(year) {
  if (!year) return null;
  const y = parseInt(year, 10);
  if (isNaN(y) || y < 1900 || y > 2100) return null;
  return y;
}

export function formatYear(year) {
  if (year === null || year === undefined || year === '') return '';
  if (typeof year === 'object' && year.year) return String(year.year);
  return String(year);
}

export function getFileExtension(filename) {
  if (!filename) return '';
  const parts = filename.split('.');
  return parts.length > 1 ? '.' + parts.pop().toLowerCase() : '';
}

export function formatBitrate(bitrate) {
  if (!bitrate) return 'Unknown';
  if (bitrate >= 1000000) return `${(bitrate / 1000000).toFixed(1)} Mbps`;
  if (bitrate >= 1000) return `${Math.round(bitrate / 1000)} kbps`;
  return `${bitrate} bps`;
}

export function formatResolution(width, height) {
  if (!width || !height) return 'Unknown';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '1440p';
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  return `${width}x${height}`;
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
