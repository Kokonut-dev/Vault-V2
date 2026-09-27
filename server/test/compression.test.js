/**
 * Tests for the zero-dependency compression middleware.
 * Run: npm test   (node --test test/)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const createCompression = require('../middleware/compression');
const { pickEncoding } = require('../middleware/compression')._internals;

// ---------- unit: Accept-Encoding negotiation ----------

test('pickEncoding prefers brotli when offered', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
});

test('pickEncoding falls back to gzip', () => {
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
});

test('pickEncoding honours q-values', () => {
  assert.equal(pickEncoding('gzip;q=0.5, br;q=0.9'), 'br');
  assert.equal(pickEncoding('br;q=0.1, gzip'), 'gzip');
});

test('pickEncoding returns null for identity-only / absent', () => {
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
  assert.equal(pickEncoding('gzip;q=0'), null);
});

test('pickEncoding handles wildcard with identity rejected', () => {
  assert.equal(pickEncoding('*;q=1, identity;q=0'), 'gzip');
});

// ---------- integration harness ----------

function makeServer(handler, opts) {
  const server = http.createServer((req, res) => {
    createCompression(opts)(req, res, () => handler(req, res));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, port: server.address().port });
  }));
}

function request(port, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method, headers },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const bigJson = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({
    id: i,
    title: `Item ${i}`,
    path: `/library/media/item-${i}.mkv`,
    desc: 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod',
  })),
});
const smallJson = JSON.stringify({ ok: true, token: 'abc' });

test('compresses large JSON with gzip and preserves the body', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(bigJson);
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers.vary, 'Accept-Encoding');
    assert.equal(res.headers['content-length'], undefined, 'Content-Length must be removed when encoding');
    assert.equal(zlib.gunzipSync(body).toString(), bigJson);
    assert.ok(body.length < Buffer.byteLength(bigJson), 'compressed body should be smaller');
  } finally {
    server.close();
  }
});

test('uses brotli when the client prefers it', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(bigJson);
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'br, gzip' });
    assert.equal(res.headers['content-encoding'], 'br');
    assert.equal(zlib.brotliDecompressSync(body).toString(), bigJson);
  } finally {
    server.close();
  }
});

test('small payloads stay raw with Content-Length intact', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', Buffer.byteLength(smallJson));
    res.end(smallJson);
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip, br' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['content-length'], String(Buffer.byteLength(smallJson)));
    assert.equal(body.toString(), smallJson);
  } finally {
    server.close();
  }
});

test('video content streams untouched (no buffering, no encoding)', async () => {
  const video = Buffer.alloc(256 * 1024, 7); // way above threshold
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', video.length);
    // write in chunks to prove passthrough
    res.write(video.subarray(0, 1024));
    res.end(video.subarray(1024));
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip, br, deflate' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['content-length'], String(video.length));
    assert.equal(body.length, video.length);
    assert.ok(body.equals(video));
  } finally {
    server.close();
  }
});

test('SSE responses are never touched', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.write('data: hello\n\n');
    res.end();
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(body.toString(), 'data: hello\n\n');
  } finally {
    server.close();
  }
});

test('Range requests bypass the middleware entirely', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Range', 'bytes 0-9/100');
    res.statusCode = 206;
    res.end(bigJson);
  });
  try {
    const { res } = await request(port, {
      'accept-encoding': 'gzip',
      range: 'bytes=0-9',
    });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers.vary, undefined, 'bypassed requests must not gain Vary');
  } finally {
    server.close();
  }
});

test('clients that do not advertise encodings get raw bytes', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(bigJson);
  });
  try {
    const { res, body } = await request(port, {});
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(body.toString(), bigJson);
  } finally {
    server.close();
  }
});

test('HEAD requests bypass the middleware', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(bigJson);
  });
  try {
    const { res } = await request(port, { 'accept-encoding': 'gzip' }, 'HEAD');
    assert.equal(res.headers['content-encoding'], undefined);
  } finally {
    server.close();
  }
});

test('svg images compress', async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="10" height="10"/>'.repeat(100)}</svg>`;
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end(svg);
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(body).toString(), svg);
  } finally {
    server.close();
  }
});

test('already-encoded responses pass through untouched', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Encoding', 'gzip'); // e.g. static file pre-compressed
    res.end(bigJson);
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(body.toString(), bigJson); // passed through, not double-encoded
  } finally {
    server.close();
  }
});

test('streamed writes below threshold then end() stay raw when Content-Length is small', async () => {
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', smallJson.length);
    res.write(smallJson.slice(0, 10));
    res.end(smallJson.slice(10));
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['content-length'], String(smallJson.length));
    assert.equal(body.toString(), smallJson);
  } finally {
    server.close();
  }
});

test('chunked streams without Content-Length compress once they cross the threshold', async () => {
  const chunk = Buffer.from('{"pad":"' + 'x'.repeat(600) + '","i":');
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.write(chunk); // 600ish < threshold
    res.write(chunk); // crosses 1024 → commit to gzip
    res.write(Buffer.from('1}'));
    res.end();
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip');
    const decoded = zlib.gunzipSync(body).toString();
    assert.equal(decoded, chunk.toString() + chunk.toString() + '1}');
  } finally {
    server.close();
  }
});

test('source streams that pause on backpressure resume on drain (regression: express.static hang)', async () => {
  // Mimic send/express.static: pause the file stream when res.write() returns
  // false, resume on 'drain'. Without the drain bridge in the middleware this
  // deadlocks after the first 64KB chunk of larger files.
  const big = Buffer.concat(Array.from({ length: 12 }, () => Buffer.from('a'.repeat(6000)))); // 72KB
  const { server, port } = await makeServer((req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Content-Length', big.length);
    let offset = 0;
    let paused = false;

    function pump() {
      while (!paused && offset < big.length) {
        const chunk = big.subarray(offset, offset + 8192);
        offset += chunk.length;
        if (!res.write(chunk)) {
          paused = true;
          res.once('drain', () => {
            paused = false;
            pump();
          });
        }
      }
      if (offset >= big.length && !paused) res.end();
    }
    pump();
  });
  try {
    const { res, body } = await request(port, { 'accept-encoding': 'gzip' }, 'GET');
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.ok(zlib.gunzipSync(body).equals(big), 'full body must arrive intact');
  } finally {
    server.close();
  }
});
