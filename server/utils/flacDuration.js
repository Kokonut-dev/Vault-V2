'use strict';
/**
 * Exact duration for FLAC files whose STREAMINFO says "total samples: 0".
 *
 * Encoders that write to a pipe/stream (ffmpeg `-f flac pipe:`, some rippers
 * and taggers) can't go back and fill in the sample count, so the header says
 * 0. music-metadata then reports no duration at all — tags still read fine —
 * and those tracks showed "—" everywhere and 0:00 artist totals.
 *
 * Every FLAC frame header carries its position (frame number for fixed-size
 * blocks, sample number for variable-size), so the total is
 *   last frame's first sample + last frame's block size.
 * We scan the file tail for frame headers, verify each with its CRC-8, and
 * require two consecutive frames to agree before trusting the result, which
 * rules out sync patterns that happen to appear inside audio data.
 */
const fs = require('fs');

const TAIL_BYTES = 512 * 1024;   // last frame + its predecessor fit easily

function crc8(buf, start, end) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** STREAMINFO fields we need, or null if this isn't a FLAC file. */
function readStreamInfo(fd, size) {
  const head = Buffer.alloc(Math.min(size, 64 * 1024));
  fs.readSync(fd, head, 0, head.length, 0);
  let off = 0;
  // ID3v2 tags sometimes precede the FLAC marker.
  if (head.toString('latin1', 0, 3) === 'ID3' && head.length >= 10) {
    off = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f));
    if (off + 42 > head.length) {
      const again = Buffer.alloc(42);
      fs.readSync(fd, again, 0, 42, off);
      return parseStreamInfo(again, 0);
    }
  }
  return parseStreamInfo(head, off);
}

function parseStreamInfo(buf, off) {
  if (buf.toString('latin1', off, off + 4) !== 'fLaC') return null;
  const block = off + 4;
  if ((buf[block] & 0x7f) !== 0) return null;          // first block must be STREAMINFO
  const si = block + 4;
  const minBlock = buf.readUInt16BE(si);
  const maxBlock = buf.readUInt16BE(si + 2);
  const sampleRate = (buf[si + 10] << 12) | (buf[si + 11] << 4) | (buf[si + 12] >> 4);
  const totalSamples = (buf[si + 13] & 0x0f) * 2 ** 32 + buf.readUInt32BE(si + 14);
  return { minBlock, maxBlock, sampleRate, totalSamples };
}

const RATE_CODES = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];

/** Parse a frame header at `i`; returns { number, variable, blockSize } or null. */
function parseFrameHeader(buf, i, info) {
  if (buf[i] !== 0xff || (buf[i + 1] & 0xfe) !== 0xf8) return null;
  const variable = buf[i + 1] & 0x01;
  const bsCode = buf[i + 2] >> 4;
  const srCode = buf[i + 2] & 0x0f;
  const chan = buf[i + 3] >> 4;
  const ssCode = (buf[i + 3] >> 1) & 0x07;
  if (bsCode === 0 || srCode === 15 || chan > 10 || ssCode === 3 || (buf[i + 3] & 1)) return null;
  if (srCode !== 0 && srCode < 12 && RATE_CODES[srCode] !== info.sampleRate) return null;

  // UTF-8-style coded frame/sample number (1–7 bytes).
  let p = i + 4;
  const first = buf[p++];
  if (first === undefined) return null;
  let n; let extra;
  if (first < 0x80) { n = first; extra = 0; }
  else if ((first & 0xe0) === 0xc0) { n = first & 0x1f; extra = 1; }
  else if ((first & 0xf0) === 0xe0) { n = first & 0x0f; extra = 2; }
  else if ((first & 0xf8) === 0xf0) { n = first & 0x07; extra = 3; }
  else if ((first & 0xfc) === 0xf8) { n = first & 0x03; extra = 4; }
  else if ((first & 0xfe) === 0xfc) { n = first & 0x01; extra = 5; }
  else if (first === 0xfe) { n = 0; extra = 6; }
  else return null;
  for (let k = 0; k < extra; k++) {
    const c = buf[p++];
    if (c === undefined || (c & 0xc0) !== 0x80) return null;
    n = n * 64 + (c & 0x3f);
  }

  let blockSize;
  if (bsCode === 1) blockSize = 192;
  else if (bsCode <= 5) blockSize = 576 * 2 ** (bsCode - 2);
  else if (bsCode === 6) { if (p >= buf.length) return null; blockSize = buf[p++] + 1; }
  else if (bsCode === 7) { if (p + 1 >= buf.length) return null; blockSize = buf.readUInt16BE(p) + 1; p += 2; }
  else blockSize = 256 * 2 ** (bsCode - 8);
  if (srCode === 12) p += 1; else if (srCode === 13 || srCode === 14) p += 2;
  if (p >= buf.length || crc8(buf, i, p) !== buf[p]) return null;
  if (info.maxBlock && blockSize > info.maxBlock) return null;
  return { number: n, variable: Boolean(variable), blockSize };
}

/**
 * Duration in seconds, or 0 when it can't be determined. Fast: reads the
 * header and at most the last 512 KB.
 */
function flacDuration(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const { size } = fs.fstatSync(fd);
    const info = readStreamInfo(fd, size);
    if (!info || !info.sampleRate) return 0;
    if (info.totalSamples > 0) return info.totalSamples / info.sampleRate;

    const len = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(len);
    fs.readSync(fd, tail, 0, len, size - len);

    // Walk backwards collecting valid headers; accept the last one once the
    // header before it is its direct predecessor.
    let later = null;
    for (let i = len - 6; i >= 0; i--) {
      if (tail[i] !== 0xff) continue;
      const h = parseFrameHeader(tail, i, info);
      if (!h) continue;
      if (later && later.variable === h.variable) {
        const consecutive = h.variable
          ? later.number === h.number + h.blockSize
          : later.number === h.number + 1;
        if (consecutive) {
          const start = later.variable ? later.number : later.number * h.blockSize; // fixed size = a full frame's
          // The final frame may be shorter; its own header states its size.
          return (start + later.blockSize) / info.sampleRate;
        }
      }
      later = h;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

module.exports = { flacDuration, _internal: { crc8, parseStreamInfo, parseFrameHeader } };
