export function sanitize(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  let s = str.trim();
  // Basic XSS prevention
  s = s.replace(/[<>]/g, '');
  if (s.length > maxLen) s = s.substring(0, maxLen);
  return s;
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function isValidGridPattern(pattern) {
  if (!Array.isArray(pattern) || pattern.length !== 8) return false;
  const seen = new Set();
  for (const idx of pattern) {
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx > 15) return false;
    if (seen.has(idx)) return false;
    seen.add(idx);
  }
  return true;
}

export function validateUploadFile(file, maxSizeMB = 10240) {
  const maxBytes = maxSizeMB * 1024 * 1024;
  if (file.size > maxBytes) {
    return { valid: false, error: `File too large. Max ${maxSizeMB}MB` };
  }
  // Check extension
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  const allowed = [
    '.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg',
    '.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.aiff', '.alac',
    '.srt', '.vtt', '.ass', '.ssa',
    '.jpg', '.jpeg', '.png', '.webp'
  ];
  if (!allowed.includes(ext)) {
    return { valid: false, error: `Unsupported file type: ${ext}` };
  }
  return { valid: true };
}
