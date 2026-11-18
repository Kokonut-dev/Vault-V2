/**
 * Admin rights on profiles. The server-settings gate (requireAdmin) is only
 * as strong as the rules for who can become an admin:
 *   - there is always at least one admin (self-healing, last-admin guards);
 *   - only admins can grant admin, change rating limits, or add/remove
 *     profiles, and a non-admin can't promote itself;
 *   - a wrong profile PIN is a 403, because a 401 signs the client out.
 *
 * The profile store and config are swapped for in-memory fakes before
 * anything requires them, so these tests never touch server/data or
 * config.json.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const express = require('express');

// ---- in-memory jsonStore -------------------------------------------------
const stores = new Map();
const jsonStorePath = require.resolve('../utils/jsonStore');
require.cache[jsonStorePath] = {
  id: jsonStorePath,
  filename: jsonStorePath,
  loaded: true,
  exports: {
    DATA_DIR: path.join(__dirname, 'nonexistent'),
    createJsonStore(fileName, defaultValue) {
      if (!stores.has(fileName)) stores.set(fileName, structuredClone(defaultValue));
      return {
        get: () => stores.get(fileName),
        set: (value) => { stores.set(fileName, value); },
        flush: async () => {},
      };
    },
  },
};

const configModule = require('../config');
const memoryConfig = structuredClone(configModule.DEFAULT_CONFIG);
memoryConfig.auth = { ...memoryConfig.auth, username: 'owner' };
configModule.getConfig = () => memoryConfig;
configModule.saveConfig = (next) => Object.assign(memoryConfig, next);

const profiles = require('../services/profiles');

function seed(list) {
  stores.set('profiles.json', { profiles: structuredClone(list), activeProfileId: list[0]?.id || 'default' });
}
const P = (id, extra = {}) => ({ id, name: id, color: '#000', avatar: null, pinHash: null, isAdmin: false, kids: false, maxRating: null, ...extra });

function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.profileId = req.headers['x-profile'] || 'default';
    req.user = { username: 'owner', sid: null, remember: false };
    next();
  });
  app.use('/api/profiles', require('../routes/profiles'));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function call(port, method, url, body, profile) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: url,
      headers: { 'Content-Type': 'application/json', 'X-Profile': profile || 'default' },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

let ctx;
test.before(async () => { ctx = await startApp(); });
test.after(() => new Promise(r => ctx.server.close(r)));

// ------------------------------------------------------------ self-healing

test('a fresh install makes the first (owner) profile an admin', () => {
  stores.delete('profiles.json');
  stores.set('profiles.json', { profiles: [], activeProfileId: 'default' });
  const list = profiles.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'default');
  assert.equal(list[0].isAdmin, true);
});

test('with no admin left (owner deleted, or legacy data) the oldest profile is promoted', () => {
  seed([P('p_kid', { kids: true }), P('p_partner')]);
  assert.equal(profiles.get('p_kid').isAdmin, true, 'first profile is promoted');
  assert.equal(profiles.get('p_partner').isAdmin, false);

  seed([P('p_other'), P('default')]);
  assert.equal(profiles.get('default').isAdmin, true, 'the original default profile is preferred');
  assert.equal(profiles.get('p_other').isAdmin, false);

  seed([P('default', { isAdmin: true }), P('p_other')]);
  assert.equal(profiles.get('p_other').isAdmin, false, 'nothing changes when an admin exists');
});

// ------------------------------------------------------------- escalation

test('a non-admin profile cannot make itself (or anyone) an admin', async () => {
  seed([P('default', { isAdmin: true }), P('p_kid', { kids: true, maxRating: 7 })]);

  const self = await call(ctx.port, 'PUT', '/api/profiles/p_kid', { isAdmin: true }, 'p_kid');
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'ADMIN_REQUIRED');
  assert.equal(profiles.get('p_kid').isAdmin, false);

  const unlimit = await call(ctx.port, 'PUT', '/api/profiles/p_kid', { kids: false, maxRating: null }, 'p_kid');
  assert.equal(unlimit.status, 403, 'kids profiles cannot lift their own rating limit');
  assert.equal(profiles.get('p_kid').kids, true);

  const other = await call(ctx.port, 'PUT', '/api/profiles/default', { name: 'pwned' }, 'p_kid');
  assert.equal(other.status, 403);

  const rename = await call(ctx.port, 'PUT', '/api/profiles/p_kid', { name: 'Robin', color: '#123456' }, 'p_kid');
  assert.equal(rename.status, 200, 'renaming your own profile is still fine');
  assert.equal(profiles.get('p_kid').name, 'Robin');

  assert.equal((await call(ctx.port, 'POST', '/api/profiles', { name: 'Sneaky' }, 'p_kid')).status, 403);
  assert.equal((await call(ctx.port, 'DELETE', '/api/profiles/default', undefined, 'p_kid')).status, 403);
});

test('an admin can grant and remove admin rights', async () => {
  seed([P('default', { isAdmin: true }), P('p_partner')]);

  const grant = await call(ctx.port, 'PUT', '/api/profiles/p_partner', { isAdmin: true });
  assert.equal(grant.status, 200);
  assert.equal(grant.body.isAdmin, true);

  const created = await call(ctx.port, 'POST', '/api/profiles', { name: 'Guest', isAdmin: true });
  assert.equal(created.status, 200);
  assert.equal(created.body.isAdmin, false, 'new profiles start without admin rights');

  const revoke = await call(ctx.port, 'PUT', '/api/profiles/default', { isAdmin: false }, 'p_partner');
  assert.equal(revoke.status, 200);
  assert.equal(profiles.get('default').isAdmin, false);
});

// ------------------------------------------------------------- last admin

test('the last admin cannot be demoted or deleted, and you cannot delete the profile in use', async () => {
  seed([P('default', { isAdmin: true }), P('p_partner')]);

  const demote = await call(ctx.port, 'PUT', '/api/profiles/default', { isAdmin: false });
  assert.equal(demote.status, 400);
  assert.equal(demote.body.code, 'LAST_ADMIN');
  assert.equal(profiles.get('default').isAdmin, true);

  const inUse = await call(ctx.port, 'DELETE', '/api/profiles/default');
  assert.equal(inUse.status, 400);
  assert.equal(inUse.body.code, 'PROFILE_IN_USE');

  // Promote the partner, switch to them, then the original can go.
  profiles.update('p_partner', { isAdmin: true });
  const del = await call(ctx.port, 'DELETE', '/api/profiles/default', undefined, 'p_partner');
  assert.equal(del.status, 200);
  assert.throws(() => profiles.update('p_partner', { isAdmin: false }), /at least one admin/);
  assert.throws(() => profiles.remove('p_partner'), /only admin|At least one profile/);
});

// -------------------------------------------------------------------- PIN

test('a wrong profile PIN is a 403, never a 401', async () => {
  seed([P('default', { isAdmin: true }), P('p_pin')]);
  profiles.update('p_pin', { pin: '1234' });

  const missing = await call(ctx.port, 'POST', '/api/profiles/p_pin/switch', {});
  assert.equal(missing.status, 403);
  assert.equal(missing.body.code, 'PROFILE_PIN_REQUIRED');

  const wrong = await call(ctx.port, 'POST', '/api/profiles/p_pin/switch', { pin: '0000' });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body.error, /PIN/);
});
