/**
 * Tests for fileUtils additions (Stage 3):
 *  - writeJsonAtomic: async, crash-safe, serialized per file (F-15)
 *  - sendFileWithRange: 200 / 206 / 416 semantics (F-16)
 * Run: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('fs-extra');
const path = require('path');
const os = require('node:os');

const { writeJsonAtomic, flushWrites, sendFileWithRange } = require('../utils/fileUtils');

// ---------- writeJsonAtomic ----------

test('writeJsonAtomic writes compact valid JSON and replaces existing files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-write-'));
  const file = path.join(dir, 'data.json');
  try {
    await writeJsonAtomic(file, { a: 1, list: [1, 2, 3] });
    const raw = await fs.readFile(file, 'utf8');
    assert.deepEqual(JSON.parse(raw), { a: 1, list: [1, 2, 3] });
    assert.ok(!raw.trimEnd().includes('\n'), 'compact output: no pretty-printing');
    assert.ok(!raw.includes('  '), 'no spaces:2 indentation');

    await writeJsonAtomic(file, { b: 2 });
    assert.deepEqual(await fs.readJson(file), { b: 2 });
    assert.ok(!(await fs.pathExists(`${file}.tmp`)), 'temp file is gone after rename');
  } finally {
    await fs.remove(dir);
  }
});

test('writeJsonAtomic serializes concurrent writes to the same file (last wins intact)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-write-'));
  const file = path.join(dir, 'data.json');
  try {
    const payloads = Array.from({ length: 10 }, (_, i) => ({ seq: i, blob: 'x'.repeat(i * 100) }));
    await Promise.all(payloads.map(p => writeJsonAtomic(file, p)));
    const final = await fs.readJson(file); // must parse — no interleaved writes
    assert.equal(final.seq, 9);
    await flushWrites();
  } finally {
    await fs.remove(dir);
  }
});

test('writeJsonAtomic failure does not break the per-file chain', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-write-'));
  const file = path.join(dir, 'data.json');
  try {
    const circular = {};
    circular.self = circular;
    await assert.rejects(writeJsonAtomic(file, circular)); // JSON.stringify throws
    // Chain still works for a good write afterwards
    await writeJsonAtomic(file, { ok: true });
    assert.deepEqual(await fs.readJson(file), { ok: true });
  } finally {
    await fs.remove(dir);
  }
});

// ---------- sendFileWithRange ----------

function serveFile(filePath) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      // sendFileWithRange is written against Express responses — shim the
      // two Express-only helpers it touches on a raw ServerResponse.
      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (obj) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(obj));
        return res;
      };
      sendFileWithRange(req, res, filePath);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close();
}

function get(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('sendFileWithRange serves full file with Accept-Ranges when no Range header', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-range-'));
  const file = path.join(dir, 'clip.mp4');
  const data = Buffer.alloc(5000, 3);
  await fs.writeFile(file, data);
  const server = await serveFile(file);
  try {
    const { res, body } = await get(server.address().port);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.headers['content-length'], '5000');
    assert.ok(body.equals(data));
  } finally {
    closeServer(server);
    await fs.remove(dir);
  }
});

test('sendFileWithRange honours Range → 206 with correct slice (transcode-cache seeking, F-16)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-range-'));
  const file = path.join(dir, 'clip.mp4');
  const data = Buffer.alloc(5000, 7);
  await fs.writeFile(file, data);
  const server = await serveFile(file);
  try {
    const { res, body } = await get(server.address().port, { range: 'bytes=1000-1999' });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], 'bytes 1000-1999/5000');
    assert.equal(res.headers['content-length'], '1000');
    assert.ok(body.equals(data.subarray(1000, 2000)));

    // Open-ended range
    const open = await get(server.address().port, { range: 'bytes=4000-' });
    assert.equal(open.res.statusCode, 206);
    assert.equal(open.res.headers['content-range'], 'bytes 4000-4999/5000');
    assert.equal(open.body.length, 1000);
  } finally {
    closeServer(server);
    await fs.remove(dir);
  }
});

test('sendFileWithRange rejects unsatisfiable ranges with 416', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-range-'));
  const file = path.join(dir, 'clip.mp4');
  await fs.writeFile(file, Buffer.alloc(100, 1));
  const server = await serveFile(file);
  try {
    const { res } = await get(server.address().port, { range: 'bytes=500-600' });
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['content-range'], 'bytes */100');
  } finally {
    closeServer(server);
    await fs.remove(dir);
  }
});
