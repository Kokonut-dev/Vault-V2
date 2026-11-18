/**
 * Live TV on Linux: "The Vault server couldn't convert this stream."
 *
 * The Linux binaries from ffmpeg-static / ffprobe-static link glibc
 * statically. Opening MPEG-TS (every IPTV channel) makes ffmpeg iconv the DVB
 * service names, static glibc dlopen()s the *host's* gconv modules, and
 * ffmpeg segfaults with no output. macOS builds aren't affected, so the same
 * channel worked on a Mac. utils/ffmpegBinaries.js now points GCONV_PATH at
 * an empty directory for static Linux binaries; these tests pin that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { isStaticElf, guardStaticIconv } = require('../utils/ffmpegBinaries');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-elf-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Minimal 64-bit little-endian ELF with the given program-header types. */
function fakeElf(name, phTypes) {
  const phoff = 64;
  const phentsize = 56;
  const buf = Buffer.alloc(phoff + phentsize * phTypes.length);
  buf.writeUInt32BE(0x7f454c46, 0); // \x7fELF
  buf[4] = 2; // 64-bit
  buf[5] = 1; // little-endian
  buf[6] = 1;
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeBigUInt64LE(BigInt(phoff), 32);
  buf.writeUInt16LE(64, 52);
  buf.writeUInt16LE(phentsize, 54);
  buf.writeUInt16LE(phTypes.length, 56);
  phTypes.forEach((type, i) => buf.writeUInt32LE(type, phoff + i * phentsize));
  const file = path.join(tmp, name);
  fs.writeFileSync(file, buf, { mode: 0o755 });
  return file;
}

const PT_LOAD = 1;
const PT_INTERP = 3;
const PT_NOTE = 4;

test('isStaticElf: no PT_INTERP means static; dynamic and non-ELF files are not', () => {
  assert.equal(isStaticElf(fakeElf('static-ffmpeg', [PT_LOAD, PT_LOAD, PT_NOTE])), true);
  assert.equal(isStaticElf(fakeElf('distro-ffmpeg', [PT_LOAD, PT_INTERP, PT_LOAD])), false);
  const script = path.join(tmp, 'wrapper.sh');
  fs.writeFileSync(script, '#!/bin/sh\nexec ffmpeg "$@"\n');
  assert.equal(isStaticElf(script), false);
  assert.equal(isStaticElf(path.join(tmp, 'missing')), false);
  // The Node binary running this test is dynamically linked on every
  // mainstream platform build.
  if (process.platform === 'linux') assert.equal(isStaticElf(process.execPath), false);
});

test('guardStaticIconv: only static binaries on Linux, never over a user GCONV_PATH', () => {
  const staticBin = fakeElf('ffmpeg-static', [PT_LOAD]);
  const dynamicBin = fakeElf('ffmpeg-dynamic', [PT_INTERP, PT_LOAD]);

  const env = {};
  assert.equal(guardStaticIconv(staticBin, { platform: 'linux', env }), true);
  assert.ok(env.GCONV_PATH, 'GCONV_PATH set');
  assert.equal(fs.readdirSync(env.GCONV_PATH).length, 0, 'points at an empty directory');

  const distro = {};
  assert.equal(guardStaticIconv(dynamicBin, { platform: 'linux', env: distro }), false);
  assert.equal(distro.GCONV_PATH, undefined, 'distro ffmpeg keeps its charset modules');

  const mac = {};
  assert.equal(guardStaticIconv(staticBin, { platform: 'darwin', env: mac }), false);
  assert.equal(mac.GCONV_PATH, undefined);

  const custom = { GCONV_PATH: '/opt/my-gconv' };
  assert.equal(guardStaticIconv(staticBin, { platform: 'linux', env: custom }), false);
  assert.equal(custom.GCONV_PATH, '/opt/my-gconv');

  // Bare names are resolved through PATH, like spawn() does.
  const onPath = { PATH: tmp };
  const savedPath = process.env.PATH;
  process.env.PATH = tmp;
  try {
    assert.equal(guardStaticIconv('ffmpeg-static', { platform: 'linux', env: onPath }), true);
  } finally {
    process.env.PATH = savedPath;
  }
});

// Real-binary check, when a static Linux ffmpeg is around (FFMPEG_PATH or
// the bundled ffmpeg-static). Opens an MPEG-TS file — the exact case that
// segfaulted — through the same resolution path the server uses.
function realStaticFfmpeg() {
  if (process.platform !== 'linux') return null;
  let candidate = process.env.FFMPEG_PATH;
  if (!candidate) { try { candidate = require('ffmpeg-static'); } catch { return null; } }
  return candidate && fs.existsSync(candidate) && isStaticElf(candidate) ? candidate : null;
}

test('a static Linux ffmpeg opens MPEG-TS once the guard is applied', { skip: !realStaticFfmpeg() && 'no static Linux ffmpeg available' }, () => {
  const bin = realStaticFfmpeg();
  const ts = path.join(tmp, 'channel.ts');
  const make = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=1', '-c:v', 'mpeg2video', '-f', 'mpegts', ts], { timeout: 30000 });
  assert.equal(make.status, 0, String(make.stderr));

  const env = { ...process.env };
  delete env.GCONV_PATH;
  guardStaticIconv(bin, { platform: 'linux', env });
  const read = spawnSync(bin, ['-hide_banner', '-i', ts, '-f', 'null', '-'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(read.signal, null, `ffmpeg crashed: ${read.signal}`);
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stderr, /Video: mpeg2video/);
});
