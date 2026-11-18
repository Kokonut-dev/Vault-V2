/**
 * Folder uploads: turn a drop or a folder pick into a list of
 * { file, path } entries, sort them into library types, and cut them into
 * upload batches. No DOM here (except reading DataTransfer entries), so it's
 * testable on its own; views/upload.js does the UI.
 *
 * `path` is the file's path relative to what was dropped, including the
 * dropped folder itself: "Homogenic/01 Hunter.flac". The server recreates
 * those folders inside the library (POST /api/upload/:type?keepFolders=1),
 * which is where the scanner reads album / show / season and cover art from.
 */

// Mirrors media.supportedExtensions in server/config.js (defaults).
export const EXTENSIONS = {
  video: ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg'],
  audio: ['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wma', '.aiff', '.aif', '.alac'],
  subtitle: ['.srt', '.vtt', '.ass', '.ssa'],
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'],
};

export const TYPE_LABELS = { movie: 'Movies & Series', music: 'Music', video: 'Videos' };

/** Per request: the server takes 50 files; keep a request to a sane size. */
export const BATCH_MAX_FILES = 50;
export const BATCH_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB

export function extOf(name) {
  const base = String(name || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

export function kindOf(name) {
  const ext = extOf(name);
  if (EXTENSIONS.video.includes(ext)) return 'video';
  if (EXTENSIONS.audio.includes(ext)) return 'audio';
  if (EXTENSIONS.subtitle.includes(ext)) return 'subtitle';
  if (EXTENSIONS.image.includes(ext)) return 'image';
  return null;
}

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const topOf = (p) => (p.includes('/') ? p.slice(0, p.indexOf('/')) : '');

// Junk every OS leaves in folders; never worth listing as "skipped".
const SILENT_SKIP = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*|__MACOSX(\/.*)?)$/i;

const EPISODE = /\bS\d{1,2}\s?E\d{1,3}\b|\b\d{1,2}x\d{2}\b|\bseason[ ._-]?\d+|\bepisode[ ._-]?\d+/i;
const MOVIE_YEAR = /[([ ._-](19[3-9]\d|20[0-4]\d)[)\] ._-]/;
const MOVIEISH = /\b(movies?|films?|series|shows?|tv|season)\b/i;

/**
 * Which library a video belongs to: episodes and "Title (2019)" style names
 * go to Movies & Series, everything else (clips, home videos) to Videos.
 */
export function videoTypeFor(path) {
  const p = ` ${path} `;
  if (EPISODE.test(p) || MOVIE_YEAR.test(p) || MOVIEISH.test(path)) return 'movie';
  return 'video';
}

/** Normalise a relative path: forward slashes, no leading "/" or "./". */
export function cleanPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/\/{2,}/g, '/');
}

// ---------------------------------------------------------------------------
// Collecting
// ---------------------------------------------------------------------------

/** From <input type=file webkitdirectory> (or a plain multi-file input). */
export function entriesFromFileList(fileList) {
  return Array.from(fileList || []).map(file => ({
    file,
    path: cleanPath(file.webkitRelativePath || file.name),
  }));
}

function readAllEntries(reader) {
  // readEntries() returns at most ~100 entries per call; keep calling until
  // it returns an empty batch, or big folders get silently truncated.
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

const fileOf = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    try {
      out.push({ file: await fileOf(entry), path: cleanPath(`${prefix}${entry.name}`) });
    } catch { /* unreadable (permissions) — skip */ }
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop
      await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/**
 * From a drop. Folders only come through DataTransferItem.webkitGetAsEntry()
 * (dataTransfer.files lists a dropped folder as one useless 0-byte "file").
 * The entries must be taken synchronously, before the first await.
 */
export async function entriesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const roots = items
    .filter(item => item.kind === 'file')
    .map(item => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null));
  if (!roots.length || roots.some(r => !r)) return entriesFromFileList(dataTransfer?.files);
  const out = [];
  for (const root of roots) {
    // eslint-disable-next-line no-await-in-loop
    await walkEntry(root, '', out);
  }
  return out;
}

export function hasFolders(entries) {
  return entries.some(e => e.path.includes('/'));
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Sort entries into groups (one per dropped folder, plus one for loose
 * files) and give each group a library type.
 *
 * mode: 'auto' guesses per group (audio → Music; video → Movies & Series or
 * Videos); 'movie' | 'music' | 'video' forces that type for everything.
 *
 * Returns { groups, skipped, ignored } where each group is
 * { key, label, type, auto, files: [{ file, path, kind }], media, sidecars, bytes }.
 * `skipped` are files Vault can't use (listed for the person); `ignored`
 * counts OS junk (.DS_Store…) that isn't worth mentioning.
 */
export function planUpload(entries, mode = 'auto') {
  const byKey = new Map();
  const skipped = [];
  let ignored = 0;

  for (const entry of entries) {
    const path = cleanPath(entry.path || entry.file?.name);
    if (SILENT_SKIP.test(path)) { ignored++; continue; }
    const kind = kindOf(path);
    if (!kind) { skipped.push({ path, size: entry.file?.size || 0 }); continue; }
    const key = topOf(path) || '';
    if (!byKey.has(key)) byKey.set(key, { key, label: key || 'Loose files', files: [] });
    byKey.get(key).files.push({ file: entry.file, path, kind });
  }

  const groups = [];
  for (const group of byKey.values()) {
    const audio = group.files.filter(f => f.kind === 'audio').length;
    const video = group.files.filter(f => f.kind === 'video');
    const media = audio + video.length;
    if (!media) {
      // Only covers/subtitles, nothing to attach them to.
      skipped.push(...group.files.map(f => ({ path: f.path, size: f.file?.size || 0 })));
      continue;
    }
    // Which kind dominates: by bytes first (a movie dwarfs its soundtrack
    // folder; an album's one music video doesn't outweigh 12 FLACs), then by
    // count; a tie goes to video.
    const audioBytes = group.files.filter(f => f.kind === 'audio').reduce((n, f) => n + (f.file?.size || 0), 0);
    const videoBytes = video.reduce((n, f) => n + (f.file?.size || 0), 0);
    const audioWins = audioBytes !== videoBytes ? audioBytes > videoBytes : audio > video.length;
    let type;
    if (mode !== 'auto') type = mode;
    else if (audioWins) type = 'music';
    else type = video.filter(f => videoTypeFor(f.path) === 'movie').length * 2 >= video.length ? 'movie' : 'video';
    groups.push({
      ...group,
      type,
      auto: mode === 'auto',
      media,
      sidecars: group.files.length - media,
      bytes: group.files.reduce((n, f) => n + (f.file?.size || 0), 0),
    });
  }
  groups.sort((a, b) => (a.key === '') - (b.key === '') || a.label.localeCompare(b.label));
  return { groups, skipped, ignored };
}

/**
 * The library a single file in a group goes to. A soundtrack .mp3 inside a
 * movie folder still belongs in Music; covers and subtitles follow the media
 * in their own folder so they land next to it.
 */
export function typeForFile(f, group) {
  const fits = (kind, type) => (kind === 'audio' ? type === 'music' : type !== 'music');
  if (f.kind === 'audio' || f.kind === 'video') {
    if (fits(f.kind, group.type)) return group.type;
    return f.kind === 'audio' ? 'music' : videoTypeFor(f.path);
  }
  const dir = dirOf(f.path);
  const sibling = group.files.find(o => (o.kind === 'audio' || o.kind === 'video') && dirOf(o.path) === dir);
  return sibling ? typeForFile(sibling, group) : group.type;
}

/**
 * Cut groups into upload requests. Files of one folder stay together where
 * possible (so a folder's cover and subtitles arrive with its media), sidecars
 * go first within a folder, and a batch never mixes library types.
 * Returns [{ type, files: [{ file, path, kind }], bytes }].
 */
export function batchesFor(groups, { maxFiles = BATCH_MAX_FILES, maxBytes = BATCH_MAX_BYTES, skip = new Set() } = {}) {
  const buckets = new Map(); // `${type}\n${dir}` → files
  for (const group of groups) {
    for (const f of group.files) {
      if (skip.has(f.path)) continue;
      const type = typeForFile(f, group);
      const key = `${type}\n${dirOf(f.path)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(f);
    }
  }
  const batches = [];
  let current = null;
  const flush = () => { if (current?.files.length) batches.push(current); current = null; };
  for (const [key, files] of buckets) {
    const type = key.split('\n')[0];
    // A folder of only covers/subtitles (everything else already uploaded)
    // has nothing to attach to now; leave it.
    if (!files.some(f => f.kind === 'audio' || f.kind === 'video')) continue;
    files.sort((a, b) => (a.kind === 'audio' || a.kind === 'video') - (b.kind === 'audio' || b.kind === 'video'));
    for (const f of files) {
      const size = f.file?.size || 0;
      if (current && (current.type !== type || current.files.length >= maxFiles || (current.bytes + size > maxBytes && current.files.length))) flush();
      if (!current) current = { type, files: [], bytes: 0 };
      current.files.push(f);
      current.bytes += size;
    }
    // Start the next folder in a fresh request when this one is nearly full,
    // so folders aren't split needlessly.
    if (current && current.files.length > maxFiles * 0.6) flush();
  }
  flush();
  return batches;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
