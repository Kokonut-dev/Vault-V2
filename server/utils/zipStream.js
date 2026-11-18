/**
 * Streaming ZIP writer + reader — no dependencies, no size limit.
 *
 * Writer: files are *stored* (media is already compressed; deflating a
 * 40 GB film would only burn CPU) and streamed straight from disk, so a
 * whole library can be downloaded without ever being held in memory or
 * written to a temporary file. Every byte of the archive is known up front
 * (`layout()`), which lets the HTTP response send a real Content-Length —
 * the browser shows a progress bar and time remaining.
 *
 *  - ZIP64 records are added only where needed (files ≥ 4 GiB, archives
 *    past 4 GiB or with ≥ 65 535 entries), so small exports stay plain ZIP.
 *  - CRC-32 is computed while streaming and written in a data descriptor
 *    (general-purpose flag bit 3), like Go's and Python's zip writers do.
 *  - Names are UTF-8 (flag bit 11) and keep the original folder structure.
 *
 * Reader: parses the central directory (ZIP64 aware), streams entries out
 * (stored or deflated — so an archive re-zipped by Finder or Explorer still
 * imports) and verifies each entry's CRC-32.
 */
const fs = require('fs');
const zlib = require('zlib');
const { Transform } = require('stream');

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0008 | 0x0800; // data descriptor + UTF-8 names

// ---------------------------------------------------------------------------
// CRC-32 (zlib.crc32 on Node ≥ 20.15/22.2, table fallback otherwise)
// ---------------------------------------------------------------------------
let TABLE = null;
function crc32(buffer, previous = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer, previous);
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let crc = (previous ^ MAX32) >>> 0;
  for (let i = 0; i < buffer.length; i++) crc = TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ MAX32) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

function writeU64(buf, value, offset) {
  buf.writeBigUInt64LE(BigInt(value), offset);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------
/**
 * @param {Array<{name:string,size:number,mtime?:Date,path?:string,data?:Buffer}>} entries
 * @returns {{ entries: object[], totalBytes: number, centralOffset: number, centralSize: number, zip64End: boolean }}
 */
function layout(entries) {
  let offset = 0;
  const planned = entries.map((entry) => {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    if (nameBuf.length > MAX16) throw new Error(`File name too long for a zip: ${entry.name.slice(0, 80)}…`);
    const size = entry.data ? entry.data.length : Number(entry.size || 0);
    const zip64 = size >= MAX32;
    const localExtra = zip64 ? 20 : 0;
    const item = { ...entry, size, nameBuf, zip64, localExtra, offset };
    offset += 30 + nameBuf.length + localExtra + size + (zip64 ? 24 : 16);
    return item;
  });
  const centralOffset = offset;
  let centralSize = 0;
  for (const item of planned) {
    item.cenSize64 = item.size >= MAX32;
    item.cenOffset64 = item.offset >= MAX32;
    item.cenExtra = item.cenSize64 || item.cenOffset64 ? 4 + (item.cenSize64 ? 16 : 0) + (item.cenOffset64 ? 8 : 0) : 0;
    centralSize += 46 + item.nameBuf.length + item.cenExtra;
  }
  const zip64End = planned.length >= MAX16 || centralOffset >= MAX32 || centralSize >= MAX32;
  const totalBytes = centralOffset + centralSize + (zip64End ? 56 + 20 : 0) + 22;
  return { entries: planned, totalBytes, centralOffset, centralSize, zip64End };
}

function localHeader(item) {
  const buf = Buffer.alloc(30 + item.nameBuf.length + item.localExtra);
  const { time, date } = dosDateTime(item.mtime);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(item.zip64 ? 45 : 20, 4);
  buf.writeUInt16LE(FLAGS, 6);
  buf.writeUInt16LE(0, 8); // stored
  buf.writeUInt16LE(time, 10);
  buf.writeUInt16LE(date, 12);
  buf.writeUInt32LE(0, 14); // CRC + sizes follow in the data descriptor
  buf.writeUInt32LE(item.zip64 ? MAX32 : 0, 18);
  buf.writeUInt32LE(item.zip64 ? MAX32 : 0, 22);
  buf.writeUInt16LE(item.nameBuf.length, 26);
  buf.writeUInt16LE(item.localExtra, 28);
  item.nameBuf.copy(buf, 30);
  if (item.zip64) {
    const at = 30 + item.nameBuf.length;
    buf.writeUInt16LE(0x0001, at);
    buf.writeUInt16LE(16, at + 2);
    // sizes are zero here; the real ones are in the descriptor
  }
  return buf;
}

function descriptor(item, crc) {
  const buf = Buffer.alloc(item.zip64 ? 24 : 16);
  buf.writeUInt32LE(SIG_DESCRIPTOR, 0);
  buf.writeUInt32LE(crc, 4);
  if (item.zip64) {
    writeU64(buf, item.size, 8);
    writeU64(buf, item.size, 16);
  } else {
    buf.writeUInt32LE(item.size, 8);
    buf.writeUInt32LE(item.size, 12);
  }
  return buf;
}

function centralHeader(item) {
  const buf = Buffer.alloc(46 + item.nameBuf.length + item.cenExtra);
  const { time, date } = dosDateTime(item.mtime);
  const needs64 = item.zip64 || item.cenOffset64;
  buf.writeUInt32LE(SIG_CENTRAL, 0);
  buf.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, spec 4.5
  buf.writeUInt16LE(needs64 ? 45 : 20, 6);
  buf.writeUInt16LE(FLAGS, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(time, 12);
  buf.writeUInt16LE(date, 14);
  buf.writeUInt32LE(item.crc >>> 0, 16);
  buf.writeUInt32LE(item.cenSize64 ? MAX32 : item.size, 20);
  buf.writeUInt32LE(item.cenSize64 ? MAX32 : item.size, 24);
  buf.writeUInt16LE(item.nameBuf.length, 28);
  buf.writeUInt16LE(item.cenExtra, 30);
  buf.writeUInt16LE(0, 32); // comment
  buf.writeUInt16LE(0, 34); // disk
  buf.writeUInt16LE(0, 36); // internal attributes
  buf.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  buf.writeUInt32LE(item.cenOffset64 ? MAX32 : item.offset, 42);
  item.nameBuf.copy(buf, 46);
  if (item.cenExtra) {
    let at = 46 + item.nameBuf.length;
    buf.writeUInt16LE(0x0001, at);
    buf.writeUInt16LE(item.cenExtra - 4, at + 2);
    at += 4;
    if (item.cenSize64) {
      writeU64(buf, item.size, at); at += 8;
      writeU64(buf, item.size, at); at += 8;
    }
    if (item.cenOffset64) writeU64(buf, item.offset, at);
  }
  return buf;
}

function endRecords(plan) {
  const count = plan.entries.length;
  const parts = [];
  if (plan.zip64End) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(SIG_ZIP64_END, 0);
    writeU64(z, 44, 4);
    z.writeUInt16LE((3 << 8) | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    writeU64(z, count, 24);
    writeU64(z, count, 32);
    writeU64(z, plan.centralSize, 40);
    writeU64(z, plan.centralOffset, 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
    loc.writeUInt32LE(0, 4);
    writeU64(loc, plan.centralOffset + plan.centralSize, 8);
    loc.writeUInt32LE(1, 16);
    parts.push(z, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(Math.min(count, MAX16), 8);
  end.writeUInt16LE(Math.min(count, MAX16), 10);
  end.writeUInt32LE(Math.min(plan.centralSize, MAX32), 12);
  end.writeUInt32LE(plan.zip64End ? MAX32 : plan.centralOffset, 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * Stream a planned archive into `out` (an http.ServerResponse or a file
 * stream), honouring back-pressure. Rejects if the output closes early, a
 * file vanished or changed size mid-way (the archive would be corrupt), or
 * `signal` aborts.
 */
async function writeZip(plan, out, { signal, onProgress } = {}) {
  let written = 0;
  let closed = false;
  const onClose = () => { closed = true; };
  out.on('close', onClose);
  const write = (chunk) => new Promise((resolve, reject) => {
    if (closed || out.destroyed) return reject(new Error('The download was cancelled'));
    if (signal?.aborted) return reject(new Error('Cancelled'));
    written += chunk.length;
    if (out.write(chunk)) return resolve();
    const done = (err) => { out.off('drain', ok); out.off('close', gone); if (err) reject(err); else resolve(); };
    const ok = () => done();
    const gone = () => done(new Error('The download was cancelled'));
    out.once('drain', ok);
    out.once('close', gone);
  });
  let lastReport = 0;
  const report = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (force || now - lastReport > 500) { lastReport = now; onProgress(written, plan.totalBytes); }
  };

  try {
    for (const item of plan.entries) {
      await write(localHeader(item));
      let crc = 0;
      if (item.data) {
        crc = crc32(item.data);
        if (item.data.length) await write(item.data);
      } else if (item.size > 0) {
        let seen = 0;
        const stream = fs.createReadStream(item.path, { start: 0, end: item.size - 1, highWaterMark: 1024 * 1024 });
        try {
          for await (const chunk of stream) {
            seen += chunk.length;
            crc = crc32(chunk, crc);
            await write(chunk);
            report(false);
          }
        } finally {
          stream.destroy();
        }
        if (seen !== item.size) throw new Error(`${item.name} changed while it was being copied (expected ${item.size} bytes, got ${seen})`);
      }
      item.crc = crc;
      await write(descriptor(item, crc));
      report(false);
    }
    for (const item of plan.entries) await write(centralHeader(item));
    await write(endRecords(plan));
    report(true);
  } finally {
    out.off('close', onClose);
  }
  if (written !== plan.totalBytes) throw new Error(`Archive size mismatch (${written} ≠ ${plan.totalBytes})`);
  return written;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------
async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    // eslint-disable-next-line no-await-in-loop
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (!bytesRead) break;
    done += bytesRead;
  }
  return done === length ? buf : buf.subarray(0, done);
}

function dosToDate(time, date) {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

/** List the entries of a zip file: [{ name, size, compressedSize, method, crc, offset, mtime }]. */
async function listZip(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 22) throw new Error('This file is not a zip archive');
    const tailLength = Math.min(size, 22 + MAX16 + 20);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let endAt = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_END) { endAt = i; break; }
    }
    if (endAt < 0) throw new Error('This file is not a zip archive, or it is incomplete (was the download finished?)');
    let count = tail.readUInt16LE(endAt + 10);
    let cdSize = tail.readUInt32LE(endAt + 12);
    let cdOffset = tail.readUInt32LE(endAt + 16);
    if (count === MAX16 || cdSize === MAX32 || cdOffset === MAX32) {
      const locAt = endAt - 20;
      if (locAt < 0 || tail.readUInt32LE(locAt) !== SIG_ZIP64_LOCATOR) throw new Error('Damaged zip: ZIP64 locator missing');
      const z64Offset = Number(tail.readBigUInt64LE(locAt + 8));
      const z = await readAt(handle, z64Offset, 56);
      if (z.readUInt32LE(0) !== SIG_ZIP64_END) throw new Error('Damaged zip: ZIP64 end record missing');
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size) throw new Error('This zip is incomplete — the download or copy didn’t finish');
    const cd = await readAt(handle, cdOffset, cdSize);
    const entries = [];
    let at = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > cd.length || cd.readUInt32LE(at) !== SIG_CENTRAL) throw new Error('Damaged zip: bad central directory');
      const flags = cd.readUInt16LE(at + 8);
      const method = cd.readUInt16LE(at + 10);
      const time = cd.readUInt16LE(at + 12);
      const date = cd.readUInt16LE(at + 14);
      const crc = cd.readUInt32LE(at + 16);
      let compressedSize = cd.readUInt32LE(at + 20);
      let uncompressedSize = cd.readUInt32LE(at + 24);
      const nameLength = cd.readUInt16LE(at + 28);
      const extraLength = cd.readUInt16LE(at + 30);
      const commentLength = cd.readUInt16LE(at + 32);
      let offset = cd.readUInt32LE(at + 42);
      const name = cd.toString(flags & 0x0800 ? 'utf8' : 'latin1', at + 46, at + 46 + nameLength);
      let e = at + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let p = e + 4;
          if (uncompressedSize === MAX32) { uncompressedSize = Number(cd.readBigUInt64LE(p)); p += 8; }
          if (compressedSize === MAX32) { compressedSize = Number(cd.readBigUInt64LE(p)); p += 8; }
          if (offset === MAX32) { offset = Number(cd.readBigUInt64LE(p)); }
        }
        e += 4 + len;
      }
      entries.push({ name, size: uncompressedSize, compressedSize, method, crc, offset, mtime: dosToDate(time, date), directory: name.endsWith('/') });
      at = extraEnd + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

class CrcCheck extends Transform {
  constructor(expected, size, name) {
    super();
    this.expected = expected >>> 0;
    this.size = size;
    this.name = name;
    this.crc = 0;
    this.seen = 0;
  }

  _transform(chunk, _enc, cb) {
    this.crc = crc32(chunk, this.crc);
    this.seen += chunk.length;
    cb(null, chunk);
  }

  _flush(cb) {
    if (this.seen !== this.size) return cb(new Error(`${this.name} is damaged in the zip (size ${this.seen} ≠ ${this.size})`));
    if ((this.crc >>> 0) !== this.expected) return cb(new Error(`${this.name} is damaged in the zip (checksum mismatch)`));
    cb();
  }
}

/** A readable stream of one entry's (decompressed, CRC-checked) contents. */
async function openEntry(file, entry) {
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses an unsupported compression method (${entry.method})`);
  const handle = await fs.promises.open(file, 'r');
  let header;
  try {
    header = await readAt(handle, entry.offset, 30);
  } finally {
    await handle.close();
  }
  if (header.length < 30 || header.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Damaged zip: ${entry.name} has no local header`);
  const dataStart = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const check = new CrcCheck(entry.crc, entry.size, entry.name);
  if (!entry.compressedSize) {
    check.end();
    return check;
  }
  const raw = fs.createReadStream(file, { start: dataStart, end: dataStart + entry.compressedSize - 1, highWaterMark: 1024 * 1024 });
  const source = entry.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
  raw.on('error', err => check.destroy(err));
  if (source !== raw) source.on('error', err => check.destroy(err));
  return source.pipe(check);
}

async function readEntry(file, entry) {
  const stream = await openEntry(file, entry);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = { layout, writeZip, listZip, openEntry, readEntry, crc32, MAX32 };
