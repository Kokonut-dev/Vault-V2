/**
 * Comics / manga reader support: a minimal ZIP reader (CBZ) plus passthrough for
 * PDF and EPUB, which the browser can render natively.
 *
 * Only the ZIP features CBZ files actually use are implemented: stored (0) and
 * deflate (8) entries, read on demand from the central directory. Nothing is
 * extracted to disk, so a 1 GB archive costs almost no memory per page.
 */
const fs = require('fs-extra');
// `fs-extra` promisifies callbacks, but its `open()` resolves to a raw fd — the
// ZIP reader needs a real FileHandle, so those two calls use fs/promises.
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'];
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

/** Natural sort so page 2 comes before page 10. */
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

async function readCentralDirectory(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const tailSize = Math.min(stat.size, 66000);
    const tail = Buffer.alloc(Number(tailSize));
    await handle.read(tail, 0, tailSize, Number(stat.size) - tailSize);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

    const entryCount = tail.readUInt16LE(eocd + 10);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cdSize = tail.readUInt32LE(eocd + 12);

    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);

    const entries = [];
    let offset = 0;
    for (let i = 0; i < entryCount && offset + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(offset) !== CEN_SIG) break;
      const method = cd.readUInt16LE(offset + 10);
      const compressedSize = cd.readUInt32LE(offset + 20);
      const uncompressedSize = cd.readUInt32LE(offset + 24);
      const nameLength = cd.readUInt16LE(offset + 28);
      const extraLength = cd.readUInt16LE(offset + 30);
      const commentLength = cd.readUInt16LE(offset + 32);
      const localOffset = cd.readUInt32LE(offset + 42);
      const name = cd.slice(offset + 46, offset + 46 + nameLength).toString('utf8');
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function readEntry(filePath, entry) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localOffset);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;

    const size = entry.compressedSize || entry.uncompressedSize;
    const data = Buffer.alloc(size);
    await handle.read(data, 0, size, dataStart);

    if (entry.method === 0) return data;
    if (entry.method === 8) return await inflateRaw(data);
    throw new Error(`Unsupported ZIP compression method ${entry.method}`);
  } finally {
    await handle.close();
  }
}

/** Sorted list of page images inside a CBZ. */
async function listPages(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.cbz') return [];
  const entries = await readCentralDirectory(filePath);
  return entries
    .filter(e => !e.name.endsWith('/') && IMAGE_EXT.includes(path.extname(e.name).toLowerCase()))
    .filter(e => !e.name.split('/').some(part => part.startsWith('__MACOSX') || part.startsWith('.')))
    .map(e => ({ name: e.name, method: e.method, compressedSize: e.compressedSize, uncompressedSize: e.uncompressedSize, localOffset: e.localOffset }))
    .sort((a, b) => naturalCompare(a.name, b.name));
}

/** Extract one page by index. */
async function getPage(filePath, index) {
  const pages = await listPages(filePath);
  const page = pages[index];
  if (!page) return null;
  const data = await readEntry(filePath, page);
  return { data, name: page.name, mime: mimeFor(page.name) };
}

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.avif') return 'image/avif';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

/** Page count for any supported comic format. */
async function getPageCount(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.cbz') return (await listPages(filePath)).length;
    if (ext === '.pdf') {
      // Cheap heuristic: count page objects without a PDF library.
      const buffer = await fs.readFile(filePath);
      const text = buffer.toString('latin1');
      const count = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
      return count || 0;
    }
  } catch {
    return 0;
  }
  return 0;
}

module.exports = { listPages, getPage, getPageCount, mimeFor, naturalCompare, readCentralDirectory, readEntry };
