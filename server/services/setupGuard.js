/**
 * First-run protection: the "setup code".
 *
 * Until an admin account exists, whoever completes setup (or imports a
 * transfer package) owns the server. Vault listens on the home network by
 * default, so without this anyone on the same Wi-Fi could reach a fresh
 * server first and claim it.
 *
 * Rule: setup from *this computer* (a direct loopback request) just works.
 * Setup from any other device — another computer, a phone, Docker's bridge,
 * or anything arriving through a tunnel/proxy — must also send the setup
 * code that the server prints in its own window (and writes to
 * <data>/setup-code.txt, readable only by the account running Vault).
 * Wrong codes count towards the normal per-IP setup lockout.
 */
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { DATA_DIR } = require('../utils/dataDir');
const { isLocalRequest } = require('../utils/clientAddress');
const logger = require('../utils/logger');

const CODE_FILE = path.join(DATA_DIR, 'setup-code.txt');
// No 0/O, 1/I/L: easy to read off a terminal and type on a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
let current = null;

function generate() {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function normalize(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The current setup code, created on first use. */
function code() {
  if (!current) {
    current = generate();
    try {
      fs.ensureDirSync(DATA_DIR);
      fs.writeFileSync(CODE_FILE, `${current}\n`, { mode: 0o600 });
    } catch (err) {
      logger.warn(`[Setup] Couldn't write ${CODE_FILE}: ${err.message}`);
    }
  }
  return current;
}

/** Print the code in the server window (called at startup while setup is pending). */
function announce(log = logger) {
  const value = code();
  log.info('──────────────────────────────────────────────────────────');
  log.info(`  First-time setup code: ${value}`);
  log.info('  Only needed when you set Vault up from another device.');
  log.info(`  (Also saved in ${CODE_FILE})`);
  log.info('──────────────────────────────────────────────────────────');
  return value;
}

function provided(req) {
  return req.headers?.['x-vault-setup-code'] || req.body?.setupCode || '';
}

/** Does this request need the code? (Only remote requests do.) */
function required(req) {
  return !isLocalRequest(req);
}

/** Constant-time check of the code this request carries. */
function matches(req) {
  const given = Buffer.from(normalize(provided(req)));
  const expected = Buffer.from(normalize(code()));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Gate for setup-mode requests. Sends the error response and returns false
 * when the request may not continue.
 */
function allow(req, res) {
  if (!required(req)) return true;
  const authService = require('./authService');
  const ip = authService.getClientIp(req);
  if (authService.isLocked(ip, 'setup')) {
    const remaining = authService.getLockoutTimeRemaining(ip, 'setup');
    res.setHeader('Retry-After', String(Math.max(remaining, 1)));
    res.status(429).json({ error: `Too many wrong setup codes. Try again in ${Math.ceil(remaining / 60)} minutes.`, code: 'LOCKED_OUT', retryAfter: remaining });
    return false;
  }
  if (matches(req)) return true;
  if (provided(req)) {
    authService.recordFailedAttempt(ip, 'setup');
    logger.warn(`[Setup] Wrong setup code from ${ip}`);
  }
  res.status(403).json({
    error: provided(req)
      ? 'That setup code is wrong. Copy it again from the Vault server window.'
      : 'Enter the setup code shown in the Vault server window to set it up from this device.',
    code: 'SETUP_CODE_REQUIRED',
  });
  return false;
}

/** Setup finished: the code is no longer valid or needed. */
function clear() {
  current = null;
  try { fs.removeSync(CODE_FILE); } catch { /* already gone */ }
}

module.exports = { code, announce, required, matches, allow, clear, normalize, CODE_FILE };
