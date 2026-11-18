'use strict';
// FLACs written to a stream carry "0 total samples" in STREAMINFO; music-metadata
// then reports no duration (tags still parse), so those tracks showed "—" and
// artist totals 0:00. flacDuration reads the length from the frames instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { flacDuration, _internal } = require('../utils/flacDuration');

// ---- a minimal, valid FLAC encoder (VERBATIM subframes) -------------------
function utf8Number(n) {
  if (n < 0x80) return [n];
  let k = 1;                                   // continuation bytes; holds 6 + 5k bits
  while (n >= 2 ** (6 + 5 * k)) k++;
  const bytes = [((0xff00 >> (k + 1)) & 0xff) | Math.floor(n / 2 ** (6 * k))];
  for (let i = k - 1; i >= 0; i--) bytes.push(0x80 | (Math.floor(n / 2 ** (6 * i)) & 0x3f));
  return bytes;
}
function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
function encodeFlac({ sampleRate = 44100, blockSize = 1152, samples, writeTotal }) {
  const si = Buffer.alloc(34);
  si.writeUInt16BE(blockSize, 0); si.writeUInt16BE(blockSize, 2);
  // sample rate (20) | channels-1 (3) | bps-1 (5) | total samples (36)
  const total = writeTotal ? samples.length : 0;
  si[10] = (sampleRate >> 12) & 0xff; si[11] = (sampleRate >> 4) & 0xff;
  si[12] = ((sampleRate & 0x0f) << 4) | (0 << 1) | (15 >> 4);
  si[13] = ((15 & 0x0f) << 4) | Math.floor(total / 2 ** 32);
  si.writeUInt32BE(total % 2 ** 32, 14);
  const parts = [Buffer.from('fLaC'), Buffer.from([0x80, 0, 0, 34]), si];
  for (let f = 0, start = 0; start < samples.length; f++, start += blockSize) {
    const n = Math.min(blockSize, samples.length - start);
    const head = [0xff, 0xf8, (7 << 4) | 9, (0 << 4) | (4 << 1), ...utf8Number(f), (n - 1) >> 8, (n - 1) & 0xff];
    head.push(_internal.crc8(Buffer.from(head), 0, head.length));
    const body = Buffer.alloc(1 + n * 2);
    body[0] = 0x02; // VERBATIM subframe
    for (let i = 0; i < n; i++) body.writeInt16BE(samples[start + i], 1 + i * 2);
    const frame = Buffer.concat([Buffer.from(head), body]);
    const c = Buffer.alloc(2); c.writeUInt16BE(crc16(frame));
    parts.push(frame, c);
  }
  return Buffer.concat(parts);
}
function noisySamples(count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.round(Math.sin(i / 20) * 8000 + (Math.random() - 0.5) * 2000);
  // Plant fake frame-sync bytes (FF F8 …) inside the audio, as real data does.
  for (let i = 100; i < count; i += 997) { out[i] = -8; out[i + 1] = 0x7900; }
  return out;
}
// ---------------------------------------------------------------------------

test('flacDuration: exact length when STREAMINFO says 0 samples', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-flac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const count of [44100 * 3 + 517, 1152 * 200, 300]) {   // short last frame, exact multiple, single frame
    const samples = noisySamples(count);
    const streamed = path.join(dir, `s${count}.flac`);
    fs.writeFileSync(streamed, encodeFlac({ samples, writeTotal: false }));
    const normal = path.join(dir, `n${count}.flac`);
    fs.writeFileSync(normal, encodeFlac({ samples, writeTotal: true }));
    if (count >= 1152 * 2) {
      assert.equal(flacDuration(streamed), count / 44100, `streamed ${count}`);
    }
    assert.equal(flacDuration(normal), count / 44100, `header ${count}`);
  }
});

test('flacDuration: non-FLAC or garbage returns 0, never throws', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-flac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const junk = path.join(dir, 'junk.flac');
  fs.writeFileSync(junk, Buffer.from('not a flac file at all'));
  assert.equal(flacDuration(junk), 0);
  assert.equal(flacDuration(path.join(dir, 'missing.flac')), 0);
});

test('extractAudioMetadata fills in the duration of a streamed FLAC', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-flac-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Krobak - Little Victories - 02 Last Days of Summer.flac');
  const count = 44100 * 4 + 99;
  fs.writeFileSync(file, encodeFlac({ samples: noisySamples(count), writeTotal: false }));
  const meta = await require('../services/metadata').extractAudioMetadata(file);
  assert.ok(Math.abs(meta.duration - count / 44100) < 1e-9, `got ${meta.duration}`);
});
