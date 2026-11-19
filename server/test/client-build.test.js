/**
 * The browser must run ONE build of the web client. After a server update,
 * lazily imported views used to come from the HTTP cache (1h fresh plus a
 * week of stale-while-revalidate), so an old Server page talked to the new
 * API and showed "0", "0 B" and "Unknown". index.html now pins every module
 * to a build-specific URL through an import map.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const clientBuild = require('../utils/clientBuild');

const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-docs-'));
fs.mkdirSync(path.join(docs, 'js', 'views'), { recursive: true });
fs.mkdirSync(path.join(docs, 'fonts'));
fs.writeFileSync(path.join(docs, 'index.html'), '<!DOCTYPE html>\n<html><head>\n<meta charset="utf-8"><script type="module">import "./js/app.js";</script></head><body></body></html>');
fs.writeFileSync(path.join(docs, 'js', 'app.js'), 'export const v = 1;');
fs.writeFileSync(path.join(docs, 'js', 'views', 'system.js'), 'export const view = 1;');
fs.writeFileSync(path.join(docs, 'fonts', 'a.woff2'), 'font');

let server;
let port;
test.before(async () => {
  const app = express();
  clientBuild.mountClient(app, docs);
  app.use((req, res) => clientBuild.sendIndex(docs, req, res, () => res.status(500).end())); // SPA fallback
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
});
test.after(() => {
  fs.rmSync(docs, { recursive: true, force: true });
  return new Promise(r => server.close(r));
});

function get(urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

const importMap = (html) => JSON.parse(/<script type="importmap">([^<]*)<\/script>/.exec(html)[1]);

test('index.html pins modules to the current build, ahead of any module script', async () => {
  const id = clientBuild.buildId(docs, { force: true });
  assert.match(id, /^[0-9a-f]{12}$/);
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-cache');
  assert.deepEqual(importMap(res.body), { imports: { '/js/': `/b/${id}/js/` } });
  assert.ok(res.body.indexOf('type="importmap"') < res.body.indexOf('type="module"'), 'import map must come first');
  assert.match(res.body, new RegExp(`window.__VAULT_BUILD__="${id}"`));
  // Reloads get a 304.
  assert.equal((await get('/', { 'If-None-Match': res.headers.etag })).status, 304);

  // SPA routes get the same map; nested routes also map their own ./js/.
  assert.deepEqual(importMap((await get('/system')).body), { imports: { '/js/': `/b/${id}/js/` } });
  assert.deepEqual(importMap((await get('/movie/abc')).body), { imports: { '/js/': `/b/${id}/js/`, '/movie/js/': `/b/${id}/js/` } });
});

test('cache headers: pinned current build is immutable, everything else revalidates', async () => {
  const id = clientBuild.buildId(docs, { force: true });
  const pinned = await get(`/b/${id}/js/views/system.js`);
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body, 'export const view = 1;');
  assert.equal(pinned.headers['cache-control'], 'public, max-age=31536000, immutable');

  const older = await get('/b/0123456789ab/js/views/system.js');
  assert.equal(older.status, 200);
  assert.equal(older.headers['cache-control'], 'no-cache');

  const missing = await get(`/b/${id}/js/nope.js`);
  assert.equal(missing.status, 404);
  assert.ok(!/<html/i.test(missing.body), 'never HTML for a module');

  assert.equal((await get('/js/views/system.js')).headers['cache-control'], 'no-cache');
  assert.match((await get('/fonts/a.woff2')).headers['cache-control'], /max-age=3600/);
});

test('editing a client file changes the build id (and so every module URL)', async () => {
  const before = clientBuild.buildId(docs, { force: true });
  fs.writeFileSync(path.join(docs, 'js', 'views', 'system.js'), 'export const view = 2; // new release');
  const after = clientBuild.buildId(docs, { force: true });
  assert.notEqual(after, before);
  assert.deepEqual(importMap((await get('/')).body).imports['/js/'], `/b/${after}/js/`);
  // A tab that asks for the previous build still gets a working file.
  assert.equal((await get(`/b/${before}/js/views/system.js`)).status, 200);
});

test('helpers', () => {
  assert.equal(clientBuild.documentDir('/'), '/');
  assert.equal(clientBuild.documentDir('/system'), '/');
  assert.equal(clientBuild.documentDir('/movie/abc'), '/movie/');
  assert.equal(clientBuild.documentDir('/a/b/c'), '/a/b/');
  const html = clientBuild.injectBuild('<html><head lang="x"><title>t</title></head></html>', { id: 'abc', requestPath: '/' });
  assert.match(html, /^<html><head lang="x"><script type="importmap">/);
  assert.ok(clientBuild.isCodeFile('a.js') && clientBuild.isCodeFile('b.css') && !clientBuild.isCodeFile('c.woff2'));
});
