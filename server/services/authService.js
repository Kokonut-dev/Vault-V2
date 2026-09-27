const fs = require('fs-extra');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');
const logger = require('../utils/logger');
const { writeJsonAtomic } = require('../utils/fileUtils');

const BRUTEFORCE_PATH = path.join(__dirname, '../data/bruteforce.json');
let attempts = new Map();

function loadAttempts() {
  try {
    if (fs.existsSync(BRUTEFORCE_PATH)) {
      const data = fs.readJsonSync(BRUTEFORCE_PATH);
      attempts = new Map(Object.entries(data));
      // Convert values to proper structure and clean expired
      const now = Date.now();
      for (const [ip, record] of attempts.entries()) {
        if (record.lockedUntil && record.lockedUntil < now) {
          attempts.delete(ip);
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

function isLocked(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return true;
  }
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    attempts.delete(ip);
    saveAttempts();
    return false;
  }
  return false;
}

function getLockoutTimeRemaining(ip) {
  const record = attempts.get(ip);
  if (!record || !record.lockedUntil) return 0;
  const remaining = record.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function recordFailedAttempt(ip) {
  const config = getConfig();
  const now = Date.now();
  let record = attempts.get(ip);

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
    logger.warn(`IP ${ip} locked out for ${config.auth.lockoutDurationMinutes} minutes after ${record.count} failed attempts`);
  }

  attempts.set(ip, record);
  saveAttempts();
}

function resetAttempts(ip) {
  if (attempts.has(ip)) {
    attempts.delete(ip);
    saveAttempts();
  }
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
  return jwt.sign({ username, step: 'grid' }, config.auth.jwtSecret, { expiresIn: '5m' });
}

function generateAccessToken(username) {
  const config = getConfig();
  return jwt.sign({ username }, config.auth.jwtSecret, { expiresIn: config.auth.sessionTimeout });
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
  getClientIp,
  isLocked,
  getLockoutTimeRemaining,
  recordFailedAttempt,
  resetAttempts,
  validateCredentials,
  validateGridPattern,
  generateChallengeToken,
  generateAccessToken,
  verifyToken,
};
