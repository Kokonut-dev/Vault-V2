/**
 * Settings revamp routes (SR-5, SR-8, SR-9, SR-10): admin gate, write-only
 * secrets, field-level validation and the status codes the client relies on.
 *
 * The real config module writes server/config.json, so it is swapped for an
 * in-memory copy BEFORE any route is required (routes destructure
 * getConfig/saveConfig at require time). Profiles are stubbed the same way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');

const configModule = require('../config');
const memory = structuredClone(configModule.DEFAULT_CONFIG);
memory.auth = { ...memory.auth, username: 'admin', passwordHash: bcrypt.hashSync('right-password', 4), gridPattern: [0, 1, 2, 3, 4, 5, 6, 7] };
memory.livetv = { enabled: true, m3uUrl: 'http://iptv.example/get.php?username=bob&password=hunter2&type=m3u_plus', epgUrl: '', hdhrDiscover: false };
memory.notifications = {};
let saves = 0;
configModule.getConfig = () => memory;
configModule.saveConfig = (next) => { saves += 1; Object.assign(memory, next); return memory; };

const profiles = require('../services/profiles');
profiles.get = (id) => ({
  default: { id: 'default', isAdmin: true },
  kid: { id: 'kid', isAdmin: false },
}[id] || null);

function startApp() {
  const app = express();
  app.use(express.json());
  // Stand-in for authMiddleware: the test chooses the profile per request.
  app.use((req, _res, next) => { req.profileId = req.headers['x-profile'] || 'default'; next(); });
  app.use('/api/settings', require('../routes/settings'));
  app.use('/api/livetv', require('../routes/livetv'));
  app.use('/api/links', require('../routes/links'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function call(port, method, path, body, profile) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json', ...(profile ? { 'X-Profile': profile } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let ctx;
test.before(async () => { ctx = await startApp(); });
test.after(() => new Promise(r => ctx.server.close(r)));

// ---------------------------------------------------------------- admin gate

test('non-admin profiles get 403 on server-wide changes and link fetching', async () => {
  const cases = [
    ['PUT', '/api/livetv/settings', { enabled: false }],
    ['POST', '/api/livetv/test', {}],
    ['PUT', '/api/settings/notifications', { ntfyUrl: 'https://ntfy.sh/x' }],
    ['POST', '/api/settings/notifications/test', {}],
    ['POST', '/api/links/inspect', { url: 'http://127.0.0.1:1/' }],
    ['POST', '/api/links/import-playlist', { url: 'http://127.0.0.1:1/' }],
  ];
  for (const [method, path, body] of cases) {
    const r = await call(ctx.port, method, path, body, 'kid');
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.body.code, 'ADMIN_REQUIRED');
  }
  // Reads stay open and report whether editing is allowed.
  const read = await call(ctx.port, 'GET', '/api/livetv/settings', undefined, 'kid');
  assert.equal(read.status, 200);
  assert.equal(read.body.canEdit, false);
});

// ------------------------------------------------------------------- Live TV

test('Live TV settings never return the saved links, only redacted hints', async () => {
  const r = await call(ctx.port, 'GET', '/api/livetv/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.canEdit, true);
  assert.equal(r.body.m3u.configured, true);
  assert.ok(!r.raw.includes('hunter2'), 'password must not reach the browser');
  assert.match(r.body.m3u.hint, /password=•••/);
  assert.equal(r.body.epg.configured, false);
});

test('Live TV update: absent keeps, empty clears, bad values give field errors', async () => {
  const before = saves;
  const bad = await call(ctx.port, 'PUT', '/api/livetv/settings', { m3uUrl: 'ftp://x/list.m3u', epgUrl: 'relative/guide.xml' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.m3uUrl);
  assert.ok(bad.body.fields.epgUrl);
  assert.equal(saves, before, 'nothing is saved when any field is invalid');
  assert.match(memory.livetv.m3uUrl, /hunter2/, 'saved link untouched');

  const keep = await call(ctx.port, 'PUT', '/api/livetv/settings', { epgUrl: 'http://iptv.example/guide.xml.gz' });
  assert.equal(keep.status, 200);
  assert.match(memory.livetv.m3uUrl, /hunter2/, 'absent m3uUrl keeps the saved value');
  assert.equal(memory.livetv.epgUrl, 'http://iptv.example/guide.xml.gz');

  const local = await call(ctx.port, 'PUT', '/api/livetv/settings', { epgUrl: '/srv/iptv/guide.xml' });
  assert.equal(local.status, 200, 'absolute local paths are allowed');

  const clear = await call(ctx.port, 'PUT', '/api/livetv/settings', { epgUrl: '' });
  assert.equal(clear.status, 200);
  assert.equal(memory.livetv.epgUrl, '');
  assert.equal(clear.body.epg.configured, false);
});

// ------------------------------------------------------------- notifications

test('notification targets validate per field and come back redacted', async () => {
  const bad = await call(ctx.port, 'PUT', '/api/settings/notifications', {
    discordWebhook: 'https://example.com/not-discord',
    telegram: { botToken: 'nope', chatId: 'not a chat' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fields.discordWebhook);
  assert.ok(bad.body.fields['telegram.botToken']);
  assert.ok(bad.body.fields['telegram.chatId']);

  const good = await call(ctx.port, 'PUT', '/api/settings/notifications', {
    discordWebhook: 'https://discord.com/api/webhooks/123456/SECRETTOKEN',
    telegram: { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatId: '-1001234567890' },
  });
  assert.equal(good.status, 200);
  assert.ok(!good.raw.includes('SECRETTOKEN'));
  assert.ok(!good.raw.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  assert.equal(good.body.targets.discordWebhook.configured, true);
  assert.equal(good.body.targets.telegram.configured, true);
});

test('notification test reports each target separately', async () => {
  let received = null;
  const sink = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { received = { url: req.url, body, title: req.headers.title }; res.end('ok'); });
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const closedPort = closed.address().port;
  await new Promise(r => closed.close(r)); // nothing listens there now

  memory.notifications = {
    ntfyUrl: `http://127.0.0.1:${sink.address().port}/vault-alerts`,
    webhookUrl: `http://127.0.0.1:${closedPort}/hook`,
  };
  try {
    const r = await call(ctx.port, 'POST', '/api/settings/notifications/test', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.sent, 2);
    assert.equal(r.body.ok, 1);
    assert.deepEqual(r.body.results.ntfy, { ok: true });
    assert.equal(r.body.results.webhook.ok, false);
    assert.match(r.body.results.webhook.error, /refused/i);
    assert.equal(received.url, '/vault-alerts');
    assert.match(decodeURIComponent(received.title), /Vault test/);

    memory.notifications = {};
    const none = await call(ctx.port, 'POST', '/api/settings/notifications/test', {});
    assert.equal(none.body.sent, 0);
    assert.ok(none.body.message);
  } finally {
    await new Promise(r => sink.close(r));
  }
});

// --------------------------------------------------------------- credentials

test('a wrong current password is a 400 (a 401 would sign the user out)', async () => {
  const missing = await call(ctx.port, 'PUT', '/api/settings/credentials', { newUsername: 'someone' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'PASSWORD_REQUIRED');
  assert.ok(missing.body.fields.currentPassword);

  const wrong = await call(ctx.port, 'PUT', '/api/settings/credentials', { currentPassword: 'nope', newUsername: 'someone' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'WRONG_PASSWORD');
  assert.ok(wrong.body.fields.currentPassword);
  assert.equal(memory.auth.username, 'admin');

  const badGrid = await call(ctx.port, 'PUT', '/api/settings/credentials', { currentPassword: 'right-password', newGridPattern: [1, 1, 2, 3, 4, 5, 6, 7] });
  assert.equal(badGrid.status, 400);
});

// ---------------------------------------------------------- general settings

test('PUT /api/settings without a media block no longer crashes', async () => {
  const r = await call(ctx.port, 'PUT', '/api/settings', { cors: memory.cors });
  assert.notEqual(r.status, 500, r.raw);
  assert.equal(r.status, 200);
});

// --------------------------------------------------------------------- links

test('link inspector reports fetch problems against the url field', async () => {
  const empty = await call(ctx.port, 'POST', '/api/links/inspect', { url: '' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.field, 'url');

  const blocked = await call(ctx.port, 'POST', '/api/links/inspect', { url: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, 'BLOCKED_ADDRESS');
  assert.equal(blocked.body.field, 'url');
});

test('link inspector classifies and redacts a playlist that names its guide', async () => {
  const src = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
    res.end('#EXTM3U url-tvg="http://g.example/guide.xml?token=SECRET"\n#EXTINF:-1 tvg-id="a" group-title="News",Harbour News\nhttp://s/1.ts\n');
  });
  await new Promise(r => src.listen(0, '127.0.0.1', r));
  try {
    const r = await call(ctx.port, 'POST', '/api/links/inspect', { url: `http://127.0.0.1:${src.address().port}/get.php?username=u&password=p2` });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'm3u-live');
    assert.equal(r.body.summary.hasEpgUrl, true);
    assert.ok(!r.raw.includes('SECRET'));
    assert.ok(!r.raw.includes('p2'), r.body.displayUrl);
  } finally {
    await new Promise(r => src.close(r));
  }
});
