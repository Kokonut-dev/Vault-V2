/**
 * "Forgot password?" — account recovery by email.
 *
 *   1. request(): someone enters their username or email. If it matches an
 *      account, Vault makes a one-time link (valid 30 minutes) and emails it
 *      to the address on file. The answer is the same whether or not
 *      anything matched, so nobody can find out which accounts exist.
 *      Until mail is set up (or when an account has no email), the link is
 *      shown in the server window instead, so the person at the server can
 *      always recover (and pass a link on).
 *   2. check(): the link opens Vault, which asks the server what it's for.
 *   3. reset(): a new password and a new 8-square grid. Every device of
 *      that account is signed out. An authenticator app (if the owner turned
 *      one on) is still required: email alone doesn't skip it.
 *
 * Only a SHA-256 hash of each token is stored (data/recovery.json), so the
 * file can't be used to reset anything.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createJsonStore } = require('../utils/jsonStore');
const { getConfig, saveConfig } = require('../config');
const { isValidGridPattern } = require('../utils/validators');
const logger = require('../utils/logger');

const store = createJsonStore('recovery.json', { tokens: [] });

const TOKEN_TTL_MS = 30 * 60 * 1000;
const PER_ACCOUNT_LIMIT = 3; // links per account …
const PER_ACCOUNT_WINDOW_MS = 30 * 60 * 1000; // … per 30 minutes
const OWNER = 'owner';

class RecoveryError extends Error {
  constructor(message, code, status = 400, field = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function tokens() {
  const d = store.get();
  if (!Array.isArray(d.tokens)) d.tokens = [];
  const now = Date.now();
  // Drop anything older than a day (expired or used).
  const kept = d.tokens.filter(t => now - Date.parse(t.createdAt) < 24 * 60 * 60 * 1000);
  if (kept.length !== d.tokens.length) {
    d.tokens = kept;
    store.set(d);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Who is this for?
// ---------------------------------------------------------------------------
function accountsService() {
  return require('./accounts');
}

/** { target: 'owner' | accountId, username, email } or null. */
function findTarget(identifier) {
  const raw = typeof identifier === 'string' ? identifier.trim().slice(0, 254) : '';
  if (!raw) return null;
  const key = raw.toLowerCase();
  const config = getConfig();
  const accounts = accountsService();
  const ownerEmail = accounts.normalizeEmail(config.auth.email || '');
  if (key === String(config.auth.username || '').toLowerCase() || (ownerEmail && key === ownerEmail)) {
    return { target: OWNER, username: config.auth.username, email: config.auth.email || null };
  }
  const account = accounts.findByUsername(raw) || accounts.findByEmail(raw);
  if (account) return { target: account.id, username: account.username, email: account.email || null };
  return null;
}

function describeTarget(target) {
  if (target === OWNER) {
    const config = getConfig();
    return { target: OWNER, username: config.auth.username, email: config.auth.email || null, owner: true };
  }
  const account = accountsService().get(target);
  if (!account) return null;
  return { target: account.id, username: account.username, email: account.email || null, owner: false };
}

// ---------------------------------------------------------------------------
// Where the link points
// ---------------------------------------------------------------------------
function originOf(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Addresses of this server itself (this computer, the local network, the Anywhere tunnel). */
function serverOrigins() {
  const out = new Set();
  const config = getConfig();
  const port = config.server?.port || 4000;
  const scheme = config.server?.https?.enabled ? 'https' : 'http';
  for (const host of ['localhost', '127.0.0.1']) out.add(`${scheme}://${host}:${port}`);
  try {
    const remote = require('./remoteAccess');
    const info = remote.lanInfo();
    for (const a of info.addresses || []) if (a.url) out.add(originOf(a.url));
    if (info.mdns?.url) out.add(originOf(info.mdns.url));
    const tunnel = remote.currentUrl?.();
    if (tunnel) out.add(originOf(tunnel));
  } catch { /* LAN details are optional */ }
  out.delete(null);
  return out;
}

/** Web-app addresses a link may point to: the server's own and the ones in the CORS list. */
function appOrigins() {
  const out = serverOrigins();
  for (const entry of getConfig().cors?.origins || []) {
    if (typeof entry === 'string' && !entry.includes('*')) {
      const o = originOf(entry);
      if (o) out.add(o);
    }
  }
  return out;
}

function cleanPath(pathname) {
  const p = String(pathname || '/');
  if (!p.startsWith('/') || p.startsWith('//') || p.length > 200 || /[\s"'<>\\]/.test(p)) return '/';
  return p.replace(/[^/]*\.html$/, '');
}

/**
 * The link in the email. `appUrl` is the address of the Vault web app the
 * request came from and `serverUrl` the server it talks to. Neither is
 * trusted: an attacker must not be able to make Vault email someone a link
 * to the attacker's site. Only this server's own addresses and the web-app
 * addresses in its CORS list are used.
 */
function buildLink(token, { appUrl, serverUrl } = {}) {
  const apps = appOrigins();
  const servers = serverOrigins();
  let base;
  const appOrigin = originOf(appUrl);
  if (appOrigin && apps.has(appOrigin)) {
    base = `${appOrigin}${cleanPath(new URL(appUrl).pathname)}`;
  } else {
    const tunnel = (() => { try { return require('./remoteAccess').currentUrl?.(); } catch { return null; } })();
    const fallback = originOf(tunnel) || [...servers][0];
    base = `${fallback}/`;
  }
  const params = new URLSearchParams({ reset: token });
  const server = originOf(serverUrl);
  if (server && servers.has(server) && server !== originOf(base)) params.set('server', server);
  // In the #fragment: never sent to any server, so it can't end up in logs.
  return `${base}#${params.toString()}`;
}

// ---------------------------------------------------------------------------
// 1. Request
// ---------------------------------------------------------------------------
function announce(lines) {
  logger.info('──────────────────────────────────────────────────────────');
  for (const line of lines) logger.info(`  ${line}`);
  logger.info('──────────────────────────────────────────────────────────');
}

/**
 * Make and deliver a recovery link. Resolves once the link has been sent or
 * shown in the server window; callers should not await it before answering
 * (the answer must not depend on whether the account exists).
 */
async function request({ identifier, appUrl, serverUrl, ip = 'unknown' }) {
  const found = findTarget(identifier);
  if (!found) {
    logger.info(`[Recovery] Reset requested from ${ip} for an unknown account`);
    return { delivered: false, reason: 'UNKNOWN' };
  }

  const d = tokens();
  const now = Date.now();
  const recent = d.tokens.filter(t => t.target === found.target && now - Date.parse(t.createdAt) < PER_ACCOUNT_WINDOW_MS);
  if (recent.length >= PER_ACCOUNT_LIMIT) {
    logger.warn(`[Recovery] Too many reset requests for ${found.username} (from ${ip}); not sending another link yet`);
    return { delivered: false, reason: 'THROTTLED' };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  // A new link replaces older unused ones.
  for (const t of d.tokens) if (t.target === found.target && !t.usedAt) t.usedAt = t.usedAt || 'replaced';
  d.tokens.push({
    hash: hash(token),
    target: found.target,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    usedAt: null,
    ip,
  });
  store.set(d);
  if (typeof store.saveNow === 'function') await store.saveNow();

  const link = buildLink(token, { appUrl, serverUrl });
  const mailer = require('./mailer');
  if (found.email && mailer.configured()) {
    const result = await mailer.send({
      to: found.email,
      subject: 'Reset your Vault password',
      text: [
        `Hi ${found.username},`,
        '',
        'Someone (hopefully you) asked to reset the password and grid pattern for your Vault account.',
        `Your username is: ${found.username}`,
        '',
        'Open this link within 30 minutes to choose a new password and a new 8-square grid:',
        link,
        '',
        'The link works once. Afterwards every device signed in to your account is signed out.',
        '',
        "If you didn't ask for this, you can ignore this email: nothing changes until the link is used.",
      ].join('\n'),
    });
    if (result.delivered) {
      logger.info(`[Recovery] Reset link emailed to ${accountsService().maskEmail(found.email)} for ${found.username} (requested from ${ip})`);
      return { delivered: true };
    }
    announce([
      `Password reset for "${found.username}": the email could not be sent`,
      `(${result.error || result.reason}). Open this link within 30 minutes:`,
      link,
    ]);
    return { delivered: false, reason: 'SEND_FAILED', shown: true };
  }

  announce([
    `Password reset requested for "${found.username}" (from ${ip}).`,
    found.email
      ? 'Email isn’t set up on this server yet (Settings → Accounts & email), so here is the link.'
      : 'This account has no email address, so here is the link.',
    'Open it within 30 minutes (it works once):',
    link,
  ]);
  return { delivered: false, reason: found.email ? 'NOT_CONFIGURED' : 'NO_EMAIL', shown: true };
}

// ---------------------------------------------------------------------------
// 2. Check
// ---------------------------------------------------------------------------
function findValid(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
    throw new RecoveryError('This reset link isn’t valid. Ask for a new one.', 'RESET_INVALID', 400);
  }
  const d = tokens();
  const record = d.tokens.find(t => t.hash === hash(token));
  if (!record) throw new RecoveryError('This reset link isn’t valid. Ask for a new one.', 'RESET_INVALID', 400);
  if (record.usedAt) throw new RecoveryError('This reset link has already been used. Ask for a new one if you still need it.', 'RESET_USED', 410);
  if (Date.parse(record.expiresAt) < Date.now()) throw new RecoveryError('This reset link has expired. Ask for a new one.', 'RESET_EXPIRED', 410);
  const target = describeTarget(record.target);
  if (!target) throw new RecoveryError('This account no longer exists.', 'RESET_INVALID', 400);
  return { d, record, target };
}

function check(token) {
  const { record, target } = findValid(token);
  const config = getConfig();
  return {
    valid: true,
    username: target.username,
    owner: target.owner,
    // The owner's authenticator app is still needed after an email reset.
    totpRequired: Boolean(target.owner && config.auth.totp?.enabled),
    expiresAt: record.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// 3. Reset
// ---------------------------------------------------------------------------
async function reset({ token, password, confirmPassword, gridPattern, gridOrderMatters, totpCode, recoveryCode, ip = 'unknown' }) {
  const { d, record, target } = findValid(token);
  const accounts = accountsService();

  if (typeof password !== 'string' || password.length < accounts.MIN_PASSWORD) {
    throw new RecoveryError(`Use a password of at least ${accounts.MIN_PASSWORD} characters`, 'WEAK_PASSWORD', 400, 'password');
  }
  if (password.length > 128) throw new RecoveryError('Passwords can be at most 128 characters', 'INVALID_PASSWORD', 400, 'password');
  if (confirmPassword !== undefined && confirmPassword !== password) {
    throw new RecoveryError('The two passwords don’t match', 'PASSWORD_MISMATCH', 400, 'confirmPassword');
  }
  if (!isValidGridPattern(gridPattern)) {
    throw new RecoveryError('Choose 8 different squares for your new grid', 'INVALID_GRID', 400, 'gridPattern');
  }

  const sessions = require('./sessions');
  let signedOut = 0;
  if (target.owner) {
    const authService = require('./authService');
    const config = getConfig();
    if (config.auth.totp?.enabled) {
      if (authService.isLocked(ip, 'second')) {
        throw new RecoveryError('Too many wrong codes. Try again later.', 'LOCKED_OUT', 429, 'totpCode');
      }
      const ok = (totpCode && authService.verifyTotpCode(String(totpCode)))
        || (recoveryCode && authService.consumeRecoveryCode(String(recoveryCode)));
      if (!ok) {
        authService.recordFailedAttempt(ip, 'second');
        const missing = !totpCode && !recoveryCode;
        throw new RecoveryError(
          missing ? 'Enter the code from your authenticator app (or a recovery code)' : 'That code isn’t right',
          missing ? 'TOTP_REQUIRED' : 'INVALID_TOTP', 400, 'totpCode',
        );
      }
    }
    config.auth.passwordHash = bcrypt.hashSync(password, 10);
    config.auth.gridPattern = gridPattern.slice();
    if (gridOrderMatters !== undefined) config.auth.gridOrderMatters = !!gridOrderMatters;
    saveConfig(config);
    signedOut = sessions.revokeAccount(null);
  } else {
    accounts.setCredentials(target.target, { password, gridPattern, gridOrderMatters: gridOrderMatters === undefined ? undefined : !!gridOrderMatters });
    signedOut = sessions.revokeAccount(target.target);
  }

  // Used up, and every other link for this account with it.
  const now = new Date().toISOString();
  record.usedAt = now;
  for (const t of d.tokens) if (t.target === record.target && !t.usedAt) t.usedAt = now;
  store.set(d);
  if (typeof store.saveNow === 'function') await store.saveNow();

  logger.info(`[Recovery] Password and grid reset for ${target.username} from ${ip}; ${signedOut} device(s) signed out`);

  if (target.email) {
    // Fire and forget: a mail problem must not undo a finished reset.
    require('./mailer').send({
      to: target.email,
      subject: 'Your Vault password was changed',
      text: [
        `Hi ${target.username},`,
        '',
        `The password and grid pattern for your Vault account were just changed with a reset link (from ${ip}).`,
        'All devices that were signed in have been signed out.',
        '',
        "If this wasn't you, tell the server's owner straight away.",
      ].join('\n'),
    }).catch(() => {});
  }
  return { username: target.username, owner: target.owner, signedOut };
}

/** Throw away every link for an account (deleted, or credentials changed elsewhere). */
function forget(target) {
  const d = tokens();
  const before = d.tokens.length;
  d.tokens = d.tokens.filter(t => t.target !== target);
  if (d.tokens.length !== before) store.set(d);
}

module.exports = {
  request,
  check,
  reset,
  forget,
  findTarget,
  buildLink,
  appOrigins,
  serverOrigins,
  RecoveryError,
  OWNER,
  TOKEN_TTL_MS,
  PER_ACCOUNT_LIMIT,
  _store: store,
};
