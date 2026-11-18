const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authService = require('../services/authService');
const profiles = require('../services/profiles');
const sessions = require('../services/sessions');
const { blacklistToken, isTokenBlacklisted, authMiddleware } = require('../middleware/auth');
const { sanitizeString } = require('../utils/validators');
const logger = require('../utils/logger');

// One-time pairing codes for QR / "type this on your TV" login.
const pairingCodes = new Map(); // code -> { token, expiresAt, approved, used, grant?, sessionId? }

function lockoutResponse(res, ip, stage) {
  const remaining = authService.getLockoutTimeRemaining(ip, stage);
  res.setHeader('Retry-After', String(Math.max(remaining, 1)));
  return res.status(429).json({
    error: `Too many failed attempts. Try again in ${Math.ceil(remaining / 60)} minutes.`,
    code: 'LOCKED_OUT',
    retryAfter: remaining,
  });
}

function validateSecondFactor(challengeToken, body) {
  const { pattern, code, recoveryCode } = body;

  if (pattern) {
    if (!Array.isArray(pattern) || pattern.length !== 8) {
      return { ok: false, status: 400, error: 'Pattern must be array of 8 numbers', code: 'INVALID_PATTERN' };
    }
    for (const val of pattern) {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 15) {
        return { ok: false, status: 400, error: 'Pattern values must be integers 0-15', code: 'INVALID_PATTERN' };
      }
    }
    if (!authService.validateGridPattern(pattern)) {
      return { ok: false, status: 401, error: 'Invalid grid pattern', code: 'INVALID_GRID' };
    }
    return { ok: true, method: 'grid' };
  }

  if (code) {
    if (!authService.verifyTotpCode(code)) {
      return { ok: false, status: 401, error: 'Invalid authenticator code', code: 'INVALID_TOTP' };
    }
    return { ok: true, method: 'totp' };
  }

  if (recoveryCode) {
    if (!authService.consumeRecoveryCode(recoveryCode)) {
      return { ok: false, status: 401, error: 'Invalid recovery code', code: 'INVALID_RECOVERY' };
    }
    return { ok: true, method: 'recovery' };
  }

  return { ok: false, status: 400, error: 'Second factor required', code: 'MISSING_SECOND_FACTOR' };
}

// ---------------------------------------------------------------------------
// Step 1 — password
// ---------------------------------------------------------------------------
router.post('/login', (req, res) => {
  const ip = authService.getClientIp(req);

  if (authService.isLocked(ip, 'password')) return lockoutResponse(res, ip, 'password');

  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required', code: 'MISSING_CREDENTIALS' });
  }

  const cleanUsername = sanitizeString(username, 100);
  const cleanPassword = typeof password === 'string' ? password.trim().substring(0, 128) : '';

  if (!authService.validateCredentials(cleanUsername, cleanPassword)) {
    authService.recordFailedAttempt(ip, 'password');
    res.locals.countAsAuthFailure = true;
    logger.warn(`Failed login attempt for ${cleanUsername} from ${ip}`);
    return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  }

  // Correct password restores the *password* budget only — the second
  // factor keeps its own budget, so grid guessing can't be reset by
  // re-submitting a (possibly stolen) password.
  authService.resetAttempts(ip, 'password');
  res.locals.resetAuthFailures = 'password';
  const challengeToken = authService.generateChallengeToken(cleanUsername);
  const totpEnabled = authService.isTotpEnabled();

  logger.info(`User ${cleanUsername} passed password check from ${ip}, second factor issued`);

  res.json({
    challengeToken,
    // `grid` keeps the original client flow working; `second-factor` lets the
    // client offer TOTP when it is enabled.
    step: totpEnabled ? 'second-factor' : 'grid',
    totpEnabled,
    profiles: profiles.listPublic(),
    message: 'Password correct, second factor required',
    expiresIn: '5m',
  });
});

// ---------------------------------------------------------------------------
// Step 2 — grid pattern, TOTP or recovery code
// ---------------------------------------------------------------------------
function completeLogin(req, res, decoded) {
  const ip = authService.getClientIp(req);
  const { profileId, profilePin, remember } = req.body;

  let resolvedProfile = profileId || decoded.profileId || 'default';
  const profile = profiles.get(resolvedProfile);
  if (!profile) resolvedProfile = profiles.getDefault().id;

  if (profileId && profiles.hasPin(profileId)) {
    if (!profiles.checkPin(profileId, profilePin)) {
      authService.recordFailedAttempt(ip, 'second');
      res.locals.countAsAuthFailure = true;
      return res.status(401).json({ error: 'Profile PIN required', code: 'PROFILE_PIN_REQUIRED' });
    }
  }

  // Fully authenticated — restore both stages' budgets.
  authService.resetAttempts(ip);
  res.locals.resetAuthFailures = 'all';

  const session = sessions.create({
    username: decoded.username,
    profileId: resolvedProfile,
    req,
    remember: !!remember,
    label: req.body.deviceLabel || null,
  });

  const token = authService.generateAccessToken(decoded.username, {
    sid: session.id,
    profileId: resolvedProfile,
    remember: !!remember,
  });
  const verified = authService.verifyToken(token);

  logger.info(`User ${decoded.username} fully authenticated from ${ip} (profile ${resolvedProfile})`);

  res.json({
    token,
    expiresAt: new Date(verified.exp * 1000).toISOString(),
    user: { username: decoded.username },
    profile: profiles.toPublic(profile),
    sessionId: session.id,
  });
}

router.post('/grid', (req, res) => {
  const ip = authService.getClientIp(req);
  if (authService.isLocked(ip, 'second')) return lockoutResponse(res, ip, 'second');

  const { challengeToken, pattern } = req.body;
  if (!challengeToken || !pattern) {
    return res.status(400).json({ error: 'Challenge token and pattern required', code: 'MISSING_DATA' });
  }

  const decoded = authService.verifyToken(challengeToken);
  if (!decoded || !decoded.step) {
    return res.status(401).json({ error: 'Invalid or expired challenge token. Please log in again.', code: 'INVALID_CHALLENGE' });
  }

  const result = validateSecondFactor(challengeToken, { pattern });
  if (!result.ok) {
    authService.recordFailedAttempt(ip, 'second');
    res.locals.countAsAuthFailure = true;
    logger.warn(`Failed ${result.code} for ${decoded.username} from ${ip}`);
    return res.status(result.status).json({ error: result.error, code: result.code });
  }

  return completeLogin(req, res, decoded);
});

// Generic second-factor endpoint (grid | TOTP | recovery code).
router.post('/second-factor', (req, res) => {
  const ip = authService.getClientIp(req);
  if (authService.isLocked(ip, 'second')) return lockoutResponse(res, ip, 'second');

  const { challengeToken } = req.body;
  const decoded = authService.verifyToken(challengeToken);
  if (!decoded || !decoded.step) {
    return res.status(401).json({ error: 'Invalid or expired challenge token. Please log in again.', code: 'INVALID_CHALLENGE' });
  }

  const result = validateSecondFactor(challengeToken, req.body);
  if (!result.ok) {
    authService.recordFailedAttempt(ip, 'second');
    res.locals.countAsAuthFailure = true;
    logger.warn(`Failed ${result.code} for ${decoded.username} from ${ip}`);
    return res.status(result.status).json({ error: result.error, code: result.code });
  }

  return completeLogin(req, res, decoded);
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (token) {
    const decoded = authService.verifyToken(token);
    if (decoded?.sid) sessions.revoke(decoded.sid);
    blacklistToken(token);
  }

  res.json({ message: 'Logged out successfully' });
});

// Extend a session without re-authenticating (used by "keep me signed in").
router.post('/refresh', authMiddleware, (req, res) => {
  const decoded = req.user || {};
  const token = authService.generateAccessToken(decoded.username, {
    sid: decoded.sid,
    profileId: decoded.profileId || 'default',
    remember: !!decoded.remember,
  });
  const verified = authService.verifyToken(token);
  res.json({ token, expiresAt: new Date(verified.exp * 1000).toISOString() });
});

router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (!token) return res.status(401).json({ valid: false, error: 'No token' });

  const decoded = authService.verifyToken(token);
  if (!decoded || decoded.step) return res.status(401).json({ valid: false, error: 'Invalid token' });

  if (isTokenBlacklisted(token)) {
    return res.status(401).json({ valid: false, error: 'Token revoked', code: 'TOKEN_REVOKED' });
  }
  if (decoded.sid && !sessions.isValid(decoded.sid)) {
    return res.status(401).json({ valid: false, error: 'Session revoked', code: 'TOKEN_REVOKED' });
  }

  res.json({
    valid: true,
    user: { username: decoded.username },
    profile: profiles.toPublic(profiles.get(decoded.profileId || 'default')),
    expiresAt: new Date(decoded.exp * 1000).toISOString(),
  });
});

// Short-lived token for media URLs (so the long-lived session token does not
// have to appear in query strings / access logs).
router.get('/media-token', authMiddleware, (req, res) => {
  const token = authService.generateMediaToken(req.user.username, '12h');
  res.json({ token, expiresIn: 12 * 60 * 60 });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
router.get('/sessions', authMiddleware, (req, res) => {
  const current = req.user?.sid;
  res.json({
    sessions: sessions.list().map(s => ({ ...s, current: s.id === current })),
    total: sessions.list().length,
  });
});

router.delete('/sessions/:id', authMiddleware, (req, res) => {
  const ok = sessions.revoke(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Session not found' });
  res.json({ message: 'Device signed out', id: req.params.id });
});

router.post('/sessions/revoke-others', authMiddleware, (req, res) => {
  const removed = sessions.revokeOthers(req.user?.sid);
  res.json({ message: `Signed out ${removed} other device(s)`, removed });
});

// ---------------------------------------------------------------------------
// TOTP management
// ---------------------------------------------------------------------------
router.get('/totp', authMiddleware, (req, res) => res.json(authService.totpStatus()));

router.post('/totp/setup', authMiddleware, (req, res) => {
  res.json(authService.setupTotp());
});

router.post('/totp/enable', authMiddleware, (req, res) => {
  const result = authService.enableTotp(req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  logger.info('TOTP second factor enabled');
  res.json({ message: 'Two-factor authentication enabled', recoveryCodes: result.recoveryCodes });
});

router.post('/totp/disable', authMiddleware, (req, res) => {
  const result = authService.disableTotp(req.body.password);
  // 400 (not 401): a wrong password here must not end the session client-side.
  if (!result.ok) return res.status(400).json({ error: result.error, code: 'WRONG_PASSWORD' });
  res.json({ message: 'Two-factor authentication disabled' });
});

router.post('/totp/recovery-codes', authMiddleware, (req, res) => {
  const result = authService.regenerateRecoveryCodes(req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ recoveryCodes: result.recoveryCodes });
});

// ---------------------------------------------------------------------------
// QR / quick-connect pairing (TV & phone)
// ---------------------------------------------------------------------------
// A signed-in device creating a code pre-approves it for its own account, so
// the QR it shows signs the other device straight in (scan → done). Without
// a token this stays the TV flow: the TV shows the code, a phone approves it.
router.post('/pair', (req, res, next) => (req.headers.authorization ? authMiddleware(req, res, next) : next()), (req, res) => {
  const code = String(crypto.randomInt(100000, 1000000));
  const token = crypto.randomBytes(18).toString('base64url');
  const entry = { token, expiresAt: Date.now() + 5 * 60 * 1000, used: false, approved: false };
  if (req.user) {
    // The session is created when the code is redeemed (by the new device's
    // request), so unused QR codes never leave stray sessions behind.
    entry.approved = true;
    entry.grant = {
      username: req.user.username,
      profileId: req.user.profileId || 'default',
      label: String(req.body?.deviceLabel || 'Device added with a QR code').slice(0, 80),
    };
  }
  pairingCodes.set(code, entry);

  // Clean up expired codes
  for (const [key, value] of pairingCodes) {
    if (value.expiresAt < Date.now()) pairingCodes.delete(key);
  }

  const base = (req.body?.baseUrl || '').replace(/\/$/, '');
  res.json({
    code,
    token,
    approved: entry.approved,
    expiresIn: 300,
    url: base ? `${base}/?pair=${token}` : null,
    loginUrl: base ? `${base}/login` : null,
  });
});

// Pairing codes are 6 digits and (when made on a signed-in device) redeem
// straight into a session, so guessing must stay hopeless: 10 wrong codes per
// IP per 10 minutes, and at most 60 wrong codes server-wide per 5 minutes
// (≈0.007% odds against a live code) before redemption pauses for everyone.
const pairMisses = new Map(); // ip -> { count, since }
let globalMisses = { count: 0, since: Date.now() };
const PAIR_IP_LIMIT = 10;
const PAIR_IP_WINDOW = 10 * 60 * 1000;
const PAIR_GLOBAL_LIMIT = 60;
const PAIR_GLOBAL_WINDOW = 5 * 60 * 1000;

function pairThrottled(req, res) {
  const now = Date.now();
  if (now - globalMisses.since > PAIR_GLOBAL_WINDOW) globalMisses = { count: 0, since: now };
  const rec = pairMisses.get(req.ip);
  if (rec && now - rec.since > PAIR_IP_WINDOW) pairMisses.delete(req.ip);
  const ipCount = pairMisses.get(req.ip)?.count || 0;
  if (ipCount >= PAIR_IP_LIMIT || globalMisses.count >= PAIR_GLOBAL_LIMIT) {
    res.setHeader('Retry-After', '300');
    res.status(429).json({ error: 'Too many wrong codes — wait a few minutes, then make a new code', code: 'RATE_LIMITED' });
    return true;
  }
  return false;
}

function pairMiss(req) {
  const now = Date.now();
  const rec = pairMisses.get(req.ip) || { count: 0, since: now };
  rec.count += 1;
  pairMisses.set(req.ip, rec);
  globalMisses.count += 1;
  if (pairMisses.size > 5000) pairMisses.clear(); // bounded memory
}

// Approved entries carry either a session (approved from a phone) or a grant
// (created pre-approved by a signed-in device) that becomes one on redeem.
function sessionForEntry(entry, req) {
  if (entry.grant && !entry.sessionId) {
    entry.sessionId = sessions.create({ ...entry.grant, req }).id;
  }
  return entry.sessionId ? sessions.get(entry.sessionId) : null;
}

// Polled by the device waiting to be signed in (TV shows the code).
router.get('/pair/:code', (req, res) => {
  if (pairThrottled(req, res)) return;
  const entry = pairingCodes.get(req.params.code);
  if (!entry || entry.expiresAt < Date.now() || entry.used) {
    if (!entry) pairMiss(req);
    return res.status(404).json({ error: 'Pairing code expired', code: 'PAIR_EXPIRED' });
  }
  if (!entry.approved) return res.json({ status: 'pending' });
  const session = sessionForEntry(entry, req);
  if (!session) return res.status(404).json({ error: 'Pairing session gone', code: 'PAIR_EXPIRED' });
  entry.used = true;
  const token = authService.generateAccessToken(session.username, {
    sid: session.id,
    profileId: session.profileId,
  });
  res.json({ status: 'approved', token, profile: profiles.toPublic(profiles.get(session.profileId)) });
});

// The device showing a code asks (without redeeming it) whether it was used.
router.get('/pair/:code/state', authMiddleware, (req, res) => {
  const entry = pairingCodes.get(req.params.code);
  if (!entry) return res.json({ status: 'expired' });
  if (entry.used) return res.json({ status: 'used' });
  if (entry.expiresAt < Date.now()) return res.json({ status: 'expired' });
  res.json({ status: entry.approved ? 'waiting' : 'pending', expiresIn: Math.round((entry.expiresAt - Date.now()) / 1000) });
});

// Approved from a phone that is already signed in.
router.post('/pair/approve', authMiddleware, (req, res) => {
  const { code, token } = req.body;
  let entry = code ? pairingCodes.get(String(code)) : null;
  if (!entry && token) {
    for (const value of pairingCodes.values()) {
      if (value.token === token) entry = value;
    }
  }
  if (!entry || entry.expiresAt < Date.now() || entry.used) {
    return res.status(404).json({ error: 'Pairing code expired', code: 'PAIR_EXPIRED' });
  }
  const session = sessions.create({
    username: req.user.username,
    // The new device gets the approver's own profile. Taking it from the body
    // let a restricted (e.g. kids) profile pair a device as someone else.
    profileId: req.user.profileId || 'default',
    req,
    label: (typeof req.body.deviceLabel === 'string' && req.body.deviceLabel.trim().slice(0, 60)) || 'Paired device',
  });
  entry.approved = true;
  entry.sessionId = session.id;
  res.json({ message: 'Device paired', sessionId: session.id });
});

// Exchange a pairing link (?pair=<token>) for a session — used by the QR URL.
router.post('/pair/exchange', (req, res) => {
  if (pairThrottled(req, res)) return;
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  let match = null;
  for (const [code, value] of pairingCodes) {
    if (value.token === token) match = { code, value };
  }
  if (!match || match.value.expiresAt < Date.now() || match.value.used) {
    if (!match) pairMiss(req);
    return res.status(404).json({ error: 'Pairing link expired', code: 'PAIR_EXPIRED' });
  }
  if (!match.value.approved) {
    return res.status(202).json({ status: 'pending' });
  }
  match.value.used = true;
  const session = sessionForEntry(match.value, req);
  if (!session) return res.status(404).json({ error: 'Pairing session gone', code: 'PAIR_EXPIRED' });
  const accessToken = authService.generateAccessToken(session.username, {
    sid: session.id,
    profileId: session.profileId,
  });
  res.json({ token: accessToken, profile: profiles.toPublic(profiles.get(session.profileId)) });
});

router._resetPairingForTests = () => { pairingCodes.clear(); pairMisses.clear(); globalMisses = { count: 0, since: Date.now() }; };
module.exports = router;
