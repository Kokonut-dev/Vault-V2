const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const authService = require('../services/authService');
const profiles = require('../services/profiles');
const sessions = require('../services/sessions');
const accounts = require('../services/accounts');
const recovery = require('../services/recovery');
const { blacklistToken, isTokenBlacklisted, authMiddleware, resolveIdentity } = require('../middleware/auth');
const { sanitizeString } = require('../utils/validators');
const logger = require('../utils/logger');

// Before first-time setup, nothing here is reachable from other devices: the
// factory login would otherwise let anyone on the network skip the setup code.
router.use(require('../services/setupGuard').signInGuard);

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

function validateSecondFactor(decoded, body) {
  const { pattern, code, recoveryCode } = body;

  // Accounts made with "Create a new account" sign in with their own grid
  // (the authenticator app is the owner's only).
  if (decoded.accountId) {
    const account = accounts.get(decoded.accountId);
    if (!account) return { ok: false, status: 401, error: 'Invalid or expired challenge token. Please log in again.', code: 'INVALID_CHALLENGE' };
    if (!Array.isArray(pattern) || pattern.length !== 8 || !pattern.every(v => Number.isInteger(v) && v >= 0 && v <= 15)) {
      return { ok: false, status: 400, error: 'Pattern must be array of 8 numbers 0-15', code: 'INVALID_PATTERN' };
    }
    if (!accounts.verifyGrid(account, pattern)) return { ok: false, status: 401, error: 'Invalid grid pattern', code: 'INVALID_GRID' };
    return { ok: true, method: 'grid' };
  }

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

  // The owner's account first; otherwise an account made with "Create a new
  // account" (its password is checked untrimmed, as it was chosen).
  const isOwner = authService.validateCredentials(cleanUsername, cleanPassword);
  const account = isOwner ? null : accounts.verifyLogin(String(username).trim(), typeof password === 'string' ? password : '');
  if (!isOwner && !account) {
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
  const challengeToken = account
    ? authService.generateChallengeToken(account.username, { accountId: account.id })
    : authService.generateChallengeToken(cleanUsername);
  const totpEnabled = !account && authService.isTotpEnabled();

  logger.info(`User ${account ? account.username : cleanUsername} passed password check from ${ip}, second factor issued`);

  res.json({
    challengeToken,
    // `grid` keeps the original client flow working; `second-factor` lets the
    // client offer TOTP when it is enabled.
    step: totpEnabled ? 'second-factor' : 'grid',
    totpEnabled,
    // An account only ever sees (and lands on) its own profile.
    profiles: account ? [profiles.toPublic(profiles.get(account.profileId))].filter(Boolean) : profiles.listHousehold().map(profiles.toPublic),
    message: 'Password correct, second factor required',
    expiresIn: '5m',
  });
});

// ---------------------------------------------------------------------------
// Step 2 — grid pattern, TOTP or recovery code
// ---------------------------------------------------------------------------
/**
 * Which profile a login lands on. An explicitly requested profile (the one
 * this device used last) wins. Without one, the first profile is used — unless
 * it has a PIN, in which case the first profile without a PIN is, so signing
 * in never bypasses a PIN. Only when every profile has a PIN is one needed.
 */
function resolveLoginProfile(req, decoded) {
  if (decoded.accountId) {
    const account = accounts.get(decoded.accountId);
    const own = account ? profiles.get(account.profileId) : null;
    if (own) return { profile: own, explicit: true };
  }
  // The owner signs in to the household's profiles only: an account made
  // with sign-up has its own password, so it isn't the owner's to open.
  const household = (id) => {
    const p = id ? profiles.get(id) : null;
    return p && !p.accountId ? p : null;
  };
  const requested = household(req.body?.profileId || null);
  if (requested) return { profile: requested, explicit: true };
  const fromChallenge = household(decoded.profileId);
  if (fromChallenge) return { profile: fromChallenge, explicit: true };
  // Without an explicit choice the owner lands on one of their own
  // profiles, never on the profile of an account made with sign-up.
  const all = profiles.list().filter(p => !p.accountId);
  const first = all[0];
  if (!first.pinHash) return { profile: first, explicit: false };
  return { profile: all.find(p => !p.pinHash) || first, explicit: false };
}

/**
 * Called before the second factor is checked: a missing PIN is reported
 * straight away (the password step already listed which profiles have one),
 * but a PIN is only *checked* after the second factor, so the PIN can't be
 * guessed with just the password.
 */
function profilePinMissing(req, res, decoded) {
  const { profile } = resolveLoginProfile(req, decoded);
  if (profile.pinHash && !req.body?.profilePin) {
    res.status(403).json({
      error: `Enter the PIN for ${profile.name}`,
      code: 'PROFILE_PIN_REQUIRED',
      profile: profiles.toPublic(profile),
    });
    return true;
  }
  return false;
}

function completeLogin(req, res, decoded) {
  const ip = authService.getClientIp(req);
  const { profilePin, remember } = req.body;

  const { profile } = resolveLoginProfile(req, decoded);
  const resolvedProfile = profile.id;

  const pinCheck = profile.pinHash ? profiles.verifyPin(profile.id, profilePin) : { ok: true };
  if (!pinCheck.ok) {
    authService.recordFailedAttempt(ip, 'second');
    res.locals.countAsAuthFailure = true;
    // 403, like /api/profiles/:id/switch — the client must stay on the
    // sign-in screen and ask again, not treat it as an expired session.
    // 429 once that profile is locked after too many wrong PINs.
    const { status, body } = profiles.pinFailure({ ...pinCheck, wrong: true });
    return res.status(status).json({ ...body, profile: profiles.toPublic(profile) });
  }

  // Fully authenticated — restore both stages' budgets.
  authService.resetAttempts(ip);
  res.locals.resetAuthFailures = 'all';

  const accountId = decoded.accountId || null;
  const session = sessions.create({
    username: decoded.username,
    profileId: resolvedProfile,
    accountId,
    req,
    remember: !!remember,
    label: req.body.deviceLabel || null,
  });
  if (accountId) accounts.touchLogin(accountId);

  const token = authService.generateAccessToken(decoded.username, {
    sid: session.id,
    profileId: resolvedProfile,
    remember: !!remember,
    ...(accountId ? { accountId } : {}),
  });
  const verified = authService.verifyToken(token);

  logger.info(`User ${decoded.username} fully authenticated from ${ip} (profile ${resolvedProfile})`);

  res.json({
    token,
    expiresAt: new Date(verified.exp * 1000).toISOString(),
    user: { username: decoded.username, owner: !accountId },
    profile: profiles.toPublic(profile),
    profileCount: accountId ? 1 : profiles.listHousehold().length,
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

  if (profilePinMissing(req, res, decoded)) return undefined;

  const result = validateSecondFactor(decoded, { pattern });
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

  if (profilePinMissing(req, res, decoded)) return undefined;

  const result = validateSecondFactor(decoded, req.body);
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
    profileId: req.profileId || decoded.profileId || 'default',
    remember: !!decoded.remember,
    ...(req.accountId ? { accountId: req.accountId } : {}),
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
  if (!decoded.sid || !sessions.isValid(decoded.sid) || decoded.scope === 'media') {
    return res.status(401).json({ valid: false, error: 'Session revoked', code: 'TOKEN_REVOKED' });
  }

  // The session (not the token) says which profile this device is on, so a
  // reload after a profile switch still shows the profile that was picked.
  const identity = resolveIdentity(decoded);
  if (identity.error === 'ACCOUNT_REMOVED') {
    return res.status(401).json({ valid: false, error: 'Account removed', code: 'ACCOUNT_REMOVED' });
  }
  const profileId = identity.profileId;
  if (!profileId) {
    return res.status(401).json({ valid: false, error: 'Profile removed', code: 'PROFILE_REMOVED' });
  }
  const account = identity.accountId ? accounts.get(identity.accountId) : null;

  res.json({
    valid: true,
    user: { username: account ? account.username : decoded.username, owner: !account },
    profile: profiles.toPublic(profiles.get(profileId)),
    expiresAt: new Date(decoded.exp * 1000).toISOString(),
  });
});

// Short-lived token for media URLs (so the long-lived session token does not
// have to appear in query strings / access logs).
router.get('/media-token', authMiddleware, (req, res) => {
  // Bound to the same session and profile, so a Kids profile's media URLs
  // stay inside its age limit.
  const token = authService.generateMediaToken(req.user.username, '12h', { sid: req.user.sid, profileId: req.profileId });
  res.json({ token, expiresIn: 12 * 60 * 60 });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
/**
 * Devices: the owner sees every device on the server (with the account each
 * belongs to); an account made with sign-up sees only its own.
 */
function visibleSessions(req) {
  const all = sessions.list();
  if (req.accountId) return all.filter(s => s.accountId === req.accountId);
  return all;
}

router.get('/sessions', authMiddleware, (req, res) => {
  const current = req.user?.sid;
  const list = visibleSessions(req);
  res.json({
    sessions: list.map(s => ({
      ...s,
      current: s.id === current,
      account: s.accountId ? (accounts.get(s.accountId)?.username || 'Deleted account') : null,
    })),
    total: list.length,
  });
});

router.delete('/sessions/:id', authMiddleware, (req, res) => {
  const target = visibleSessions(req).find(s => s.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Session not found' });
  sessions.revoke(req.params.id);
  res.json({ message: 'Device signed out', id: req.params.id });
});

// Your own other devices (an account's, or the owner's) — not other people's.
router.post('/sessions/revoke-others', authMiddleware, (req, res) => {
  const removed = sessions.revokeOthers(req.user?.sid, req.accountId || null);
  res.json({ message: `Signed out ${removed} other device(s)`, removed });
});

// ---------------------------------------------------------------------------
// "Create a new account" and "Forgot password?"
// ---------------------------------------------------------------------------
// Small per-address budgets on top of the global auth limiters: making
// accounts and asking for reset links are cheap to spam otherwise.
const budgets = new Map();
/** Seconds to wait when `ip` has used up `max` per window, else 0. `record` spends one. */
function overBudget(kind, ip, max, windowMs, { record = true } = {}) {
  const key = `${kind}|${ip}`;
  const now = Date.now();
  const hits = (budgets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) {
    budgets.set(key, hits);
    return Math.ceil((windowMs - (now - hits[0])) / 1000);
  }
  if (record) hits.push(now);
  budgets.set(key, hits);
  if (budgets.size > 10000) budgets.clear(); // bounded memory
  return 0;
}
const REGISTER_MAX = 5;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

function sendAccountError(res, err, fallback) {
  if (err instanceof accounts.AccountError || err instanceof recovery.RecoveryError || err instanceof profiles.ProfileError) {
    const status = err.status || 400;
    const body = { error: err.message, code: err.code };
    if (err.field) body.fields = { [err.field]: err.message };
    return res.status(status).json(body);
  }
  logger.error(`[Auth] ${fallback}: ${err.message}`);
  return res.status(500).json({ error: fallback });
}

function setupPending() {
  try {
    return require('../services/setupGuard').pending();
  } catch {
    return true;
  }
}

// Open sign-up: anyone who can reach the server makes an account and is
// signed in straight away (the owner can turn this off in Settings).
router.post('/register', async (req, res) => {
  const ip = authService.getClientIp(req);
  if (setupPending()) return res.status(409).json({ error: 'Finish setting up Vault first', code: 'SETUP_REQUIRED' });
  if (!accounts.signupEnabled()) {
    return res.status(403).json({ error: 'Creating new accounts is turned off on this server. Ask its owner.', code: 'SIGNUP_DISABLED' });
  }
  const body = req.body || {};
  if (body.confirmPassword !== undefined && body.confirmPassword !== body.password) {
    return res.status(400).json({ error: 'The two passwords don’t match', code: 'PASSWORD_MISMATCH', fields: { confirmPassword: 'The two passwords don’t match' } });
  }
  // Only accounts actually made count (a typo in the form doesn't).
  const wait = overBudget('register', ip, REGISTER_MAX, REGISTER_WINDOW_MS, { record: false });
  if (wait) {
    return res.status(429).json({ error: `Too many new accounts from this address. Try again in ${Math.ceil(wait / 60)} minutes.`, code: 'LOCKED_OUT', retryAfter: wait });
  }
  let account;
  try {
    account = accounts.create({
      username: body.username,
      email: body.email,
      password: body.password,
      gridPattern: body.gridPattern,
      gridOrderMatters: !!body.gridOrderMatters,
    });
    await accounts.flush();
  } catch (err) {
    return sendAccountError(res, err, 'Could not create the account');
  }
  overBudget('register', ip, REGISTER_MAX, REGISTER_WINDOW_MS);
  logger.info(`[Auth] New account "${account.username}" created from ${ip}`);
  try {
    require('../services/events').broadcast('profile:changed', { id: account.profileId, action: 'account-created' });
  } catch { /* nobody listening */ }
  // Signed in straight away, exactly as after password + grid.
  const decoded = { username: account.username, accountId: account.id };
  return completeLogin(req, res, decoded);
});

// Step 1: ask for a link. Always the same answer (and roughly the same
// time), whether or not the account exists or has an email address.
router.post('/recover', (req, res) => {
  const ip = authService.getClientIp(req);
  if (setupPending()) return res.status(409).json({ error: 'Finish setting up Vault first', code: 'SETUP_REQUIRED' });
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier : '';
  if (!identifier.trim()) {
    return res.status(400).json({ error: 'Enter your username or email address', code: 'MISSING_DATA', fields: { identifier: 'Enter your username or email address' } });
  }
  const wait = overBudget('recover', ip, 5, 15 * 60 * 1000);
  if (wait) {
    return res.status(429).json({ error: `Too many reset requests. Try again in ${Math.ceil(wait / 60)} minutes.`, code: 'LOCKED_OUT', retryAfter: wait });
  }
  // Not awaited: how long sending takes must not tell anything away.
  recovery.request({
    identifier,
    appUrl: typeof req.body?.appUrl === 'string' ? req.body.appUrl.slice(0, 300) : null,
    serverUrl: typeof req.body?.serverUrl === 'string' ? req.body.serverUrl.slice(0, 300) : null,
    ip,
  }).catch(err => logger.error(`[Recovery] ${err.message}`));
  res.json({
    message: 'If that matches an account, a reset link is on its way to the email address on file.',
  });
});

// Step 2: what is this link for?
router.post('/recover/check', (req, res) => {
  try {
    res.json(recovery.check(req.body?.token));
  } catch (err) {
    if (err instanceof recovery.RecoveryError) res.locals.countAsAuthFailure = true;
    sendAccountError(res, err, 'Could not check the reset link');
  }
});

// Step 3: new password + grid. Signs out every device of the account.
router.post('/recover/reset', async (req, res) => {
  const ip = authService.getClientIp(req);
  try {
    const body = req.body || {};
    const result = await recovery.reset({
      token: body.token,
      password: body.password,
      confirmPassword: body.confirmPassword,
      gridPattern: body.gridPattern,
      gridOrderMatters: body.gridOrderMatters,
      totpCode: body.totpCode,
      recoveryCode: body.recoveryCode,
      ip,
    });
    res.json({ message: 'Your password and grid have been changed. Sign in with them now.', ...result });
  } catch (err) {
    if (err instanceof recovery.RecoveryError && ['RESET_INVALID', 'INVALID_TOTP'].includes(err.code)) res.locals.countAsAuthFailure = true;
    sendAccountError(res, err, 'Could not reset the password');
  }
});

// ---------------------------------------------------------------------------
// TOTP management
// ---------------------------------------------------------------------------
// The authenticator app protects the owner's account only.
function ownerOnly(req, res, next) {
  if (!req.accountId) return next();
  return res.status(403).json({ error: 'Only the server owner’s account can use an authenticator app', code: 'OWNER_ONLY' });
}

router.get('/totp', authMiddleware, ownerOnly, (req, res) => res.json(authService.totpStatus()));

router.post('/totp/setup', authMiddleware, ownerOnly, (req, res) => {
  res.json(authService.setupTotp());
});

router.post('/totp/enable', authMiddleware, ownerOnly, (req, res) => {
  const result = authService.enableTotp(req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  logger.info('TOTP second factor enabled');
  res.json({ message: 'Two-factor authentication enabled', recoveryCodes: result.recoveryCodes });
});

router.post('/totp/disable', authMiddleware, ownerOnly, (req, res) => {
  const result = authService.disableTotp(req.body.password);
  // 400 (not 401): a wrong password here must not end the session client-side.
  if (!result.ok) return res.status(400).json({ error: result.error, code: 'WRONG_PASSWORD' });
  res.json({ message: 'Two-factor authentication disabled' });
});

router.post('/totp/recovery-codes', authMiddleware, ownerOnly, (req, res) => {
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
// Codes made WITHOUT signing in (a TV asking to be approved) are capped:
// otherwise anyone could fill the 6-digit space with waiting codes, so that
// a signed-in person approving a mistyped code would let a stranger in.
const PENDING_PER_IP = 3;
const PENDING_TOTAL = 20;
const PAIR_TTL_MS = 5 * 60 * 1000;

function prunePairing() {
  const now = Date.now();
  for (const [key, value] of pairingCodes) {
    if (value.expiresAt < now) pairingCodes.delete(key);
  }
}

/** 'this computer' | 'your network' | 'internet' for an IP address. */
function networkOf(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (!a) return 'unknown';
  if (a === '::1' || a.startsWith('127.')) return 'this computer';
  if (/^(10\.|192\.168\.|169\.254\.)/.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^f[cd]/i.test(a) || /^fe80:/i.test(a)) return 'your network';
  return 'internet';
}

/** Only an http(s) address of this server goes into the QR — never javascript: etc. */
function safeBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) return '';
  try {
    const url = new URL(raw.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

router.post('/pair', (req, res, next) => (req.headers.authorization ? authMiddleware(req, res, next) : next()), (req, res) => {
  prunePairing();
  if (!req.user) {
    const waiting = [...pairingCodes.values()].filter(v => !v.approved && !v.used);
    const fromIp = waiting.filter(v => v.ip === req.ip).length;
    if (fromIp >= PENDING_PER_IP || waiting.length >= PENDING_TOTAL) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Too many devices are waiting to be approved — try again in a few minutes', code: 'RATE_LIMITED' });
    }
  }
  let code;
  do { code = String(crypto.randomInt(100000, 1000000)); } while (pairingCodes.has(code));
  const token = crypto.randomBytes(18).toString('base64url');
  const entry = { token, expiresAt: Date.now() + PAIR_TTL_MS, used: false, approved: false, ip: req.ip };
  if (req.user) {
    // The session is created when the code is redeemed (by the new device's
    // request), so unused QR codes never leave stray sessions behind.
    entry.approved = true;
    entry.grant = {
      username: req.user.username,
      profileId: req.user.profileId || 'default',
      accountId: req.accountId || null,
      label: String(req.body?.deviceLabel || 'Device added with a QR code').slice(0, 80),
    };
  }
  pairingCodes.set(code, entry);

  const base = safeBaseUrl(req.body?.baseUrl);
  res.json({
    code,
    token,
    approved: entry.approved,
    expiresIn: PAIR_TTL_MS / 1000,
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
  res.json({
    status: entry.approved ? 'waiting' : 'pending',
    expiresIn: Math.round((entry.expiresAt - Date.now()) / 1000),
    // Shown before approving, so a code someone else sent you stands out.
    requester: entry.approved ? null : { ip: entry.ip || null, network: networkOf(entry.ip) },
  });
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
    accountId: req.accountId || null,
    req,
    label: (typeof req.body.deviceLabel === 'string' && req.body.deviceLabel.trim().slice(0, 60)) || 'Paired device',
  });
  entry.approved = true;
  entry.sessionId = session.id;
  logger.info(`[Auth] Pairing code approved by ${req.user.username} for a device at ${entry.ip || 'an unknown address'}`);
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

router._resetPairingForTests = () => { pairingCodes.clear(); pairMisses.clear(); globalMisses = { count: 0, since: Date.now() }; budgets.clear(); };
module.exports = router;
