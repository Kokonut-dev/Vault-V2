const fs = require('fs-extra');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const { writeJsonAtomic } = require('../utils/fileUtils');

const BRUTEFORCE_PATH = path.join(__dirname, '../data/bruteforce.json');
let attempts = new Map();

// Brute-force tracking is split by *stage*: password failures and
// second-factor (grid/TOTP/recovery) failures get separate budgets.
// Before this split both stages shared one counter, while a correct
// password reset the whole thing — so failures from the two steps were
// summed inconsistently by the two independent lockout systems (this
// store and middleware/rateLimiter) and a user who alternated "typo'd
// password, got it right, fumbled the grid, got the password right
// again…" accumulated failures until a *correct* password was rejected
// with 429. Now: a correct password clears only the password budget, a
// completed login clears every budget, and neither step's failures can
// lock the other step. (A password holder also can't reset the grid
// budget by re-submitting the password, so grid guessing stays capped.)
const STAGES = ['password', 'second', 'setup'];

function stageKey(ip, stage) {
  return `${ip}|${stage}`;
}

function normalizeStage(stage) {
  return STAGES.includes(stage) ? stage : 'password';
}

function loadAttempts() {
  try {
    if (fs.existsSync(BRUTEFORCE_PATH)) {
      const data = fs.readJsonSync(BRUTEFORCE_PATH);
      attempts = new Map(Object.entries(data));
      // Convert values to proper structure and clean expired
      const now = Date.now();
      for (const [key, record] of [...attempts.entries()]) {
        if (record.lockedUntil && record.lockedUntil < now) {
          attempts.delete(key);
          continue;
        }
        // Migrate pre-stage records (key was the bare IP): the lock/count
        // applied to every stage then, so carry it into both login stages
        // rather than silently forgiving an active lockout on upgrade.
        const isStaged = STAGES.some(stage => key.endsWith(`|${stage}`));
        if (!isStaged) {
          attempts.delete(key);
          for (const stage of ['password', 'second']) {
            attempts.set(stageKey(key, stage), { ...record });
          }
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load bruteforce data:', err.message);
    attempts = new Map();
  }
}

function saveAttempts() {
  // F-15: async + atomic; libraryService.flush() awaits all file chains on
  // shutdown, so failed-attempt records still survive restarts.
  try {
    const obj = Object.fromEntries(attempts);
    return writeJsonAtomic(BRUTEFORCE_PATH, obj).catch(err => {
      logger.warn('Failed to save bruteforce data:', err.message);
    });
  } catch (err) {
    logger.warn('Failed to save bruteforce data:', err.message);
    return Promise.resolve();
  }
}

loadAttempts();

function getClientIp(req) {
  return req.ip || req.connection.remoteAddress || 'unknown';
}

function isLocked(ip, stage) {
  const keys = stage
    ? [stageKey(ip, normalizeStage(stage))]
    : STAGES.map(s => stageKey(ip, s));
  let locked = false;
  for (const key of keys) {
    const record = attempts.get(key);
    if (!record) continue;
    if (record.lockedUntil && record.lockedUntil > Date.now()) {
      locked = true;
    } else if (record.lockedUntil && record.lockedUntil <= Date.now()) {
      attempts.delete(key);
      saveAttempts();
    }
  }
  return locked;
}

function getLockoutTimeRemaining(ip, stage) {
  const keys = stage
    ? [stageKey(ip, normalizeStage(stage))]
    : STAGES.map(s => stageKey(ip, s));
  let longest = 0;
  for (const key of keys) {
    const record = attempts.get(key);
    if (!record || !record.lockedUntil) continue;
    longest = Math.max(longest, record.lockedUntil - Date.now());
  }
  return longest > 0 ? Math.ceil(longest / 1000) : 0;
}

function recordFailedAttempt(ip, stage = 'password') {
  const config = getConfig();
  const now = Date.now();
  const key = stageKey(ip, normalizeStage(stage));
  let record = attempts.get(key);

  if (!record) {
    record = { count: 1, firstAttempt: now, lockedUntil: null };
  } else {
    // If first attempt was more than lockout window ago, reset
    const windowMs = config.auth.lockoutDurationMinutes * 60 * 1000;
    if (now - record.firstAttempt > windowMs) {
      record = { count: 1, firstAttempt: now, lockedUntil: null };
    } else {
      record.count += 1;
    }
  }

  if (record.count >= config.auth.maxAttempts) {
    record.lockedUntil = now + config.auth.lockoutDurationMinutes * 60 * 1000;
    logger.warn(`IP ${ip} locked out (${normalizeStage(stage)} stage) for ${config.auth.lockoutDurationMinutes} minutes after ${record.count} failed attempts`);
  }

  attempts.set(key, record);
  saveAttempts();
}

// resetAttempts(ip, 'password'|'second'|'setup') clears one stage;
// resetAttempts(ip) clears every stage for the IP (completed login / setup).
function resetAttempts(ip, stage) {
  let changed = false;
  if (stage) {
    changed = attempts.delete(stageKey(ip, normalizeStage(stage)));
  } else {
    for (const s of STAGES) {
      if (attempts.delete(stageKey(ip, s))) changed = true;
    }
    if (attempts.delete(ip)) changed = true; // legacy bare-IP key, if any
  }
  if (changed) saveAttempts();
}

function validateCredentials(username, password) {
  const config = getConfig();
  if (username !== config.auth.username) return false;
  if (!config.auth.passwordHash) return false;
  try {
    return bcrypt.compareSync(password, config.auth.passwordHash);
  } catch {
    return false;
  }
}

function validateGridPattern(pattern) {
  const config = getConfig();
  const expected = config.auth.gridPattern;
  if (!Array.isArray(pattern) || pattern.length !== 8) return false;
  if (!Array.isArray(expected) || expected.length !== 8) return false;

  if (config.auth.gridOrderMatters) {
    return pattern.every((val, idx) => val === expected[idx]);
  } else {
    const sortedPattern = [...pattern].sort((a, b) => a - b);
    const sortedExpected = [...expected].sort((a, b) => a - b);
    return sortedPattern.every((val, idx) => val === sortedExpected[idx]);
  }
}

function generateChallengeToken(username) {
  const config = getConfig();
  // The second factor can be the grid, TOTP, or a recovery code.
  const step = config.auth.totp?.enabled ? 'second-factor' : 'grid';
  return jwt.sign({ username, step }, config.auth.jwtSecret, { expiresIn: '5m' });
}

function generateAccessToken(username, extra = {}) {
  const config = getConfig();
  const ttl = extra.remember ? '30d' : config.auth.sessionTimeout;
  return jwt.sign(
    { username, ...extra },
    config.auth.jwtSecret,
    { expiresIn: ttl }
  );
}

/** Short-lived token embedded in media URLs (basic ?token= streaming). */
function generateMediaToken(username, ttl = '12h') {
  const config = getConfig();
  return jwt.sign({ username, scope: 'media' }, config.auth.jwtSecret, { expiresIn: ttl });
}

// --- Optional TOTP second factor -------------------------------------------
const totp = require('../utils/totp');

function isTotpEnabled() {
  return !!getConfig().auth.totp?.enabled;
}

function totpStatus() {
  const config = getConfig();
  return {
    enabled: !!config.auth.totp?.enabled,
    configured: !!config.auth.totp?.secret,
    recoveryCodesLeft: (config.auth.totp?.recoveryHashes || []).length,
  };
}

function setupTotp() {
  const config = getConfig();
  const secret = totp.generateSecret();
  config.auth.totp = { ...(config.auth.totp || {}), enabled: false, secret, recoveryHashes: [] };
  // Persist immediately so the secret survives a restart mid-setup.
  const { saveConfig } = require('../config');
  saveConfig(config);
  return { secret, otpauthUrl: totp.otpauthUrl(secret, config.auth.username) };
}

function verifyTotpCode(code) {
  const config = getConfig();
  return totp.verify(config.auth.totp?.secret, code);
}

function enableTotp(code) {
  const config = getConfig();
  if (!config.auth.totp?.secret) return { ok: false, error: 'Run setup first' };
  if (!totp.verify(config.auth.totp.secret, code)) return { ok: false, error: 'Invalid code' };
  const bcrypt = require('bcryptjs');
  const codes = totp.generateRecoveryCodes();
  config.auth.totp.enabled = true;
  config.auth.totp.recoveryHashes = codes.map(c => bcrypt.hashSync(c, 10));
  const { saveConfig } = require('../config');
  saveConfig(config);
  return { ok: true, recoveryCodes: codes };
}

function disableTotp(password) {
  const config = getConfig();
  if (!validateCredentials(config.auth.username, password)) return { ok: false, error: 'Invalid password' };
  config.auth.totp = { enabled: false, secret: null, recoveryHashes: [] };
  const { saveConfig } = require('../config');
  saveConfig(config);
  return { ok: true };
}

function regenerateRecoveryCodes(code) {
  const config = getConfig();
  if (!totp.verify(config.auth.totp?.secret, code)) return { ok: false, error: 'Invalid code' };
  const bcrypt = require('bcryptjs');
  const codes = totp.generateRecoveryCodes();
  config.auth.totp.recoveryHashes = codes.map(c => bcrypt.hashSync(c, 10));
  const { saveConfig } = require('../config');
  saveConfig(config);
  return { ok: true, recoveryCodes: codes };
}

function consumeRecoveryCode(input) {
  const config = getConfig();
  const bcrypt = require('bcryptjs');
  const clean = String(input || '').trim().toLowerCase();
  const hashes = config.auth.totp?.recoveryHashes || [];
  for (let i = 0; i < hashes.length; i++) {
    if (bcrypt.compareSync(clean, hashes[i])) {
      hashes.splice(i, 1);
      const { saveConfig } = require('../config');
      saveConfig(config);
      return true;
    }
  }
  return false;
}

function verifyToken(token) {
  const config = getConfig();
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch {
    return null;
  }
}

module.exports = {
  _internals: { attempts, stageKey, STAGES },
  getClientIp,
  isLocked,
  getLockoutTimeRemaining,
  recordFailedAttempt,
  resetAttempts,
  validateCredentials,
  validateGridPattern,
  generateChallengeToken,
  generateAccessToken,
  generateMediaToken,
  verifyToken,
  isTotpEnabled,
  totpStatus,
  setupTotp,
  enableTotp,
  disableTotp,
  verifyTotpCode,
  regenerateRecoveryCodes,
  consumeRecoveryCode,
};
