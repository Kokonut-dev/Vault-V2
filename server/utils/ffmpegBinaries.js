/**
 * The one place that decides which ffmpeg / ffprobe binaries Vault runs.
 *
 * Order: FFMPEG_PATH / FFPROBE_PATH → the bundled ffmpeg-static /
 * ffprobe-static binary *if the file actually exists* → `ffmpeg` / `ffprobe`
 * on PATH.
 *
 * Why this matters: the bundled packages export a path string even when the
 * binary was never downloaded (npm install --ignore-scripts, a failed
 * postinstall, ARM boards, Docker images that apt-install ffmpeg instead).
 * fluent-ffmpeg's binary path is process-global, so a single module calling
 * setFfmpegPath(<missing file>) broke audio conversion, video transcoding
 * and thumbnails for the whole server ("spawn …/ffmpeg-static/ffmpeg ENOENT").
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function existing(candidate) {
  try {
    return candidate && fs.existsSync(path.resolve(candidate)) ? candidate : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Static Linux builds vs. the system's iconv modules
// ---------------------------------------------------------------------------
// The Linux binaries shipped by ffmpeg-static / ffprobe-static (and the
// popular johnvansickle.com builds) link glibc *statically*. When ffmpeg
// reads MPEG-TS — i.e. basically every IPTV / M3U channel — it converts the
// DVB service names with iconv, and static glibc then dlopen()s the *host's*
// gconv modules (/usr/lib/x86_64-linux-gnu/gconv/…). Those were built
// against a different glibc, so ffmpeg segfaults before printing anything:
//
//   ffmpeg[1234]: segfault at 270e0 … in ffmpeg-linux-x86_64 …
//
// Vault only saw "ffmpeg exited" with an empty stderr and showed "The Vault
// server couldn't convert this stream." macOS / Windows builds aren't
// static-glibc, which is why the same channel worked on a Mac.
//
// Pointing GCONV_PATH at an empty directory makes iconv_open() fail cleanly
// instead; ffmpeg then just keeps the raw channel name and plays the stream.
// fluent-ffmpeg spawns with the inherited environment, so this has to be set
// on process.env. We only do it on Linux, only when the resolved binary is
// really static (no ELF interpreter), and never over a user-set GCONV_PATH.

const staticCache = new Map();

/** Resolve a bare command name ("ffmpeg") through $PATH. */
function resolveOnPath(bin) {
  if (!bin) return null;
  if (bin.includes('/') || bin.includes(path.sep)) return existing(bin) ? path.resolve(bin) : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * True when `file` is an ELF executable without a PT_INTERP program header,
 * i.e. a statically linked binary. Anything unreadable / non-ELF → false.
 */
function isStaticElf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    if (fs.readSync(fd, head, 0, 64, 0) < 52) return false;
    if (head.readUInt32BE(0) !== 0x7f454c46) return false; // "\x7fELF"
    const is64 = head[4] === 2;
    const le = head[5] === 1;
    const u16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const phoff = is64 ? Number(le ? head.readBigUInt64LE(32) : head.readBigUInt64BE(32)) : u32(head, 28);
    const phentsize = u16(head, is64 ? 54 : 42);
    const phnum = u16(head, is64 ? 56 : 44);
    if (!phoff || !phentsize || !phnum || phnum > 512) return false;
    const table = Buffer.alloc(phentsize * phnum);
    if (fs.readSync(fd, table, 0, table.length, phoff) < table.length) return false;
    for (let i = 0; i < phnum; i++) {
      if (u32(table, i * phentsize) === 3) return false; // PT_INTERP → dynamically linked
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function isStaticBinary(bin) {
  const file = resolveOnPath(bin);
  if (!file) return false;
  if (!staticCache.has(file)) staticCache.set(file, isStaticElf(file));
  return staticCache.get(file);
}

let gconvGuarded = false;
/**
 * Apply the GCONV_PATH workaround for `bin` if needed. Idempotent and cheap
 * after the first call. Returns true when the workaround is active.
 */
function guardStaticIconv(bin, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return false;
  if (env === process.env && gconvGuarded) return true;
  if (env.GCONV_PATH) return false; // the user's own setting wins
  if (!isStaticBinary(bin)) return false;
  const empty = path.join(os.tmpdir(), 'vault-empty-gconv');
  try { fs.mkdirSync(empty, { recursive: true }); } catch { /* a missing dir works too */ }
  env.GCONV_PATH = empty;
  if (env === process.env) gconvGuarded = true;
  return true;
}

function ffmpegBinary() {
  let bin;
  if (process.env.FFMPEG_PATH) bin = process.env.FFMPEG_PATH;
  else {
    let bundled = null;
    try { bundled = require('ffmpeg-static'); } catch { /* not installed */ }
    bin = existing(bundled) || 'ffmpeg';
  }
  guardStaticIconv(bin);
  return bin;
}

function ffprobeBinary() {
  let bin;
  if (process.env.FFPROBE_PATH) bin = process.env.FFPROBE_PATH;
  else {
    let bundled = null;
    try { bundled = require('ffprobe-static').path; } catch { /* not installed */ }
    bin = existing(bundled) || 'ffprobe';
  }
  guardStaticIconv(bin);
  return bin;
}

/** Load fluent-ffmpeg pointed at the right binaries (null if not installed). */
function fluentFfmpeg() {
  let ffmpeg;
  try { ffmpeg = require('fluent-ffmpeg'); } catch { return null; }
  ffmpeg.setFfmpegPath(ffmpegBinary());
  ffmpeg.setFfprobePath(ffprobeBinary());
  return ffmpeg;
}

module.exports = { ffmpegBinary, ffprobeBinary, fluentFfmpeg, isStaticElf, guardStaticIconv };
