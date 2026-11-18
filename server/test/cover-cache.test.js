'use strict';
// Cover responses must be cache-friendly: missing artwork is remembered for a
// while, and real artwork revalidates with a cheap 304 instead of a re-download.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const express = require('express');

test('cover route: cacheable 404 and ETag/304 for real artwork', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-cover-'));
  const art = path.join(dir, 'cover.png');
  await fs.writeFile(art, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  const library = require('../services/library');
  const original = library.getById;
  const items = {
    withArt: { id: 'withArt', type: 'music', coverArtPath: art },
    noArt: { id: 'noArt', type: 'music' },
  };
  library.getById = (id) => items[id] || null;

  const app = express();
  app.use('/api/media', require('../routes/media'));
  const server = app.listen(0);
  t.after(async () => { library.getById = original; server.close(); await fs.remove(dir); });
  const base = `http://127.0.0.1:${server.address().port}/api/media/cover`;

  const missing = await fetch(`${base}/noArt`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('cache-control') || '', /max-age=\d+/);

  const first = await fetch(`${base}/withArt`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/png');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'sends an ETag');
  await first.arrayBuffer();

  // Node's fetch adds `Cache-Control: no-cache` to conditional requests (which
  // forces a full response), so revalidate the way a browser does, via http.
  const status = await new Promise((resolve, reject) => {
    require('node:http').get(`${base}/withArt`, { headers: { 'If-None-Match': etag } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 304, 'revalidation is a 304, not a re-download');
});
