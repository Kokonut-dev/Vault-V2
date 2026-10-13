/**
 * Regression tests for "Too many requests when attempting login".
 *
 * PR #13 exempted /api/auth/* from the general limiter and stopped the
 * auth limiter counting successes, but a *correct* password could still
 * be rejected with 429:
 *
 *   4 wrong passwords → correct password → 4 wrong grids →
 *   correct password → 2 wrong grids → correct password got 429.
 *
 * Two defects combined: (1) neither lockout system restored budget on
 * success — failures from both steps just accumulated within the
 * window; (2) password and second-factor failures shared one counter
 * in the persistent brute-force store while the in-memory limiter
 * reset on a different schedule, so the two systems disagreed about
 * when a user was locked.
 *
 * The fix budgets each stage separately in BOTH systems: a correct
 * password clears only the password budget, a completed login clears
 * both. These tests pin that behaviour (and that real brute force is
 * still locked out per stage).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const createRateLimiters = require('../middleware/rateLimiter');
const { isGeneralExempt, authStageFor } = createRateLimiters._internals;
const authService = require('../services/authService');
const { getConfig } = require('../config');

const AUTH_MAX = getConfig().security.rateLimit.auth.max;
const BRUTE_MAX = getConfig().auth.maxAttempts;

// ---------- unit: general-limiter exemptions & stage routing ----------

test('general limiter exempts everything called while signing in', () => {
  for (const url of [
    '/api/auth/login',
    '/api/auth/grid',
    '/api/auth/second-factor',
    '/api/auth/verify?x=1',
    '/api/auth',
    '/api/setup/status',
    '/api/setup/complete',
    '/api/health',
    '/api/health?x=1',
    '/api/events',
    '/api/events/public',
    '/api/media/cover/abc?token=secret',
    '/api/transcode/hls/abc/master.m3u8',
  ]) {
    assert.equal(isGeneralExempt({ originalUrl: url }), true, url);
  }
  for (const url of ['/api/library', '/api/library/stats', '/api/playlists', '/api/settings']) {
    assert.equal(isGeneralExempt({ originalUrl: url }), false, url);
  }
});

test('auth stage is derived from the credential endpoint', () => {
  assert.equal(authStageFor({ originalUrl: '/api/auth/login' }), 'password');
  assert.equal(authStageFor({ originalUrl: '/api/auth/grid' }), 'second');
  assert.equal(authStageFor({ originalUrl: '/api/auth/second-factor' }), 'second');
});

// ---------- unit: staged brute-force store (services/authService) ----------

test('brute-force store budgets password and second-factor failures separately', () => {
  const ip = '198.51.100.23'; // TEST-NET-2 — never a real client
  authService.resetAttempts(ip);
  try {
    for (let i = 0; i < BRUTE_MAX - 1; i++) authService.recordFailedAttempt(ip, 'password');
    assert.equal(authService.isLocked(ip, 'password'), false, 'below threshold');
    assert.equal(authService.isLocked(ip, 'second'), false);

    authService.recordFailedAttempt(ip, 'password');
    assert.equal(authService.isLocked(ip, 'password'), true, 'password stage locks at threshold');
    assert.equal(authService.isLocked(ip, 'second'), false, 'grid stage is NOT locked by password failures');
    assert.ok(authService.getLockoutTimeRemaining(ip, 'password') > 0);

    // A correct password clears only its own stage.
    authService.resetAttempts(ip, 'password');
    assert.equal(authService.isLocked(ip, 'password'), false);

    for (let i = 0; i < BRUTE_MAX; i++) authService.recordFailedAttempt(ip, 'second');
    assert.equal(authService.isLocked(ip, 'second'), true, 'second stage locks at threshold');
    assert.equal(authService.isLocked(ip, 'password'), false, 'password stage is NOT locked by grid failures');

    // A completed login clears every stage.
    authService.resetAttempts(ip);
    assert.equal(authService.isLocked(ip, 'second'), false);
    assert.equal(authService.isLocked(ip), false);
  } finally {
    authService.resetAttempts(ip);
  }
});

// ---------- unit: legacy config migration (PR #13's missing half) ----------

test('legacy general rate-limit default (200) is migrated, custom values kept', () => {
  const { migrateLegacyRateLimits } = require('../config')._internals;

  const legacy = { security: { rateLimit: { general: { windowMs: 900000, max: 200 } } } };
  migrateLegacyRateLimits(legacy, legacy);
  assert.equal(legacy.security.rateLimit.general.max, 2000);

  const custom = { security: { rateLimit: { general: { windowMs: 900000, max: 500 } } } };
  migrateLegacyRateLimits(custom, custom);
  assert.equal(custom.security.rateLimit.general.max, 500, 'deliberate custom value untouched');

  const bare = {};
  migrateLegacyRateLimits(bare, bare); // must not throw
});

// ---------- integration: staged auth-failure limiter over HTTP ----------

function makeApp() {
  const { generalLimiter, authLimiter, authFloodLimiter } = createRateLimiters();
  const app = express();
  app.use(express.json());
  app.use('/api/', generalLimiter);
  // Same mounting as server/index.js.
  for (const p of ['/api/auth/login', '/api/auth/grid', '/api/auth/second-factor']) {
    app.use(p, authFloodLimiter);
    app.use(p, authLimiter);
  }
  // Stub handlers that mimic routes/auth.js's res.locals contract.
  app.post('/api/auth/login', (req, res) => {
    if (req.body && req.body.password === 'correct') {
      res.locals.resetAuthFailures = 'password';
      return res.json({ ok: true, step: 'grid' });
    }
    res.locals.countAsAuthFailure = true;
    return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  });
  const secondFactor = (req, res) => {
    if (req.body && req.body.pattern === 'correct') {
      res.locals.resetAuthFailures = 'all';
      return res.json({ ok: true, token: 'token' });
    }
    res.locals.countAsAuthFailure = true;
    return res.status(401).json({ error: 'Invalid grid pattern', code: 'INVALID_GRID' });
  };
  app.post('/api/auth/grid', secondFactor);
  app.post('/api/auth/second-factor', secondFactor);
  app.get('/api/library/stats', (req, res) => res.json({ ok: true }));

  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          // Let the server's res 'finish' listeners run before the next call.
          setTimeout(() => resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          }), 5);
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('correct password is NOT 429 after failures interleaved with successes (reported bug)', async () => {
  const { server, port } = await makeApp();
  try {
    // 4 wrong passwords, then the correct one (old code: budget 4/10 spent, never restored)
    for (let i = 0; i < 4; i++) assert.equal((await post(port, '/api/auth/login', { password: 'wrong' })).status, 401);
    assert.equal((await post(port, '/api/auth/login', { password: 'correct' })).status, 200);
    // 4 wrong grids, back to password (correct), 2 more wrong grids:
    // cumulative failures are now 10 — exactly where the old limiter locked.
    for (let i = 0; i < 4; i++) assert.equal((await post(port, '/api/auth/grid', { pattern: 'wrong' })).status, 401);
    assert.equal((await post(port, '/api/auth/login', { password: 'correct' })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await post(port, '/api/auth/grid', { pattern: 'wrong' })).status, 401);

    const login = await post(port, '/api/auth/login', { password: 'correct' });
    assert.equal(login.status, 200, `correct password must not be rate-limited, got ${login.status} ${JSON.stringify(login.body)}`);
    const grid = await post(port, '/api/auth/grid', { pattern: 'correct' });
    assert.equal(grid.status, 200, 'correct grid completes the login');
  } finally {
    server.close();
  }
});

test('persistent wrong grids lock the grid step, not the password step', async () => {
  const { server, port } = await makeApp();
  try {
    for (let i = 0; i < AUTH_MAX; i++) {
      assert.equal((await post(port, '/api/auth/grid', { pattern: 'wrong' })).status, 401);
    }
    const blocked = await post(port, '/api/auth/grid', { pattern: 'correct' });
    assert.equal(blocked.status, 429, 'grid step locks at the threshold even for the right pattern');
    assert.equal(blocked.body.code, 'AUTH_RATE_LIMITED');
    assert.ok(Number(blocked.headers['retry-after']) > 0, 'Retry-After header is sent');

    const login = await post(port, '/api/auth/login', { password: 'correct' });
    assert.equal(login.status, 200, 'password step stays usable while the grid step is locked');
  } finally {
    server.close();
  }
});

test('persistent wrong passwords lock the password step (brute force still stopped)', async () => {
  const { server, port } = await makeApp();
  try {
    for (let i = 0; i < AUTH_MAX; i++) {
      assert.equal((await post(port, '/api/auth/login', { password: 'wrong' })).status, 401);
    }
    const blocked = await post(port, '/api/auth/login', { password: 'correct' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'AUTH_RATE_LIMITED');
  } finally {
    server.close();
  }
});

test('second-factor endpoint is failure-limited like grid (was mounted nowhere)', async () => {
  const { server, port } = await makeApp();
  try {
    for (let i = 0; i < AUTH_MAX; i++) {
      assert.equal((await post(port, '/api/auth/second-factor', { pattern: 'wrong' })).status, 401);
    }
    const blocked = await post(port, '/api/auth/second-factor', { pattern: 'correct' });
    assert.equal(blocked.status, 429, 'second-factor failures share the second-stage budget');
  } finally {
    server.close();
  }
});
