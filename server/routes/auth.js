const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const { blacklistToken, isTokenBlacklisted } = require('../middleware/auth');
const { sanitizeString } = require('../utils/validators');
const logger = require('../utils/logger');

router.post('/login', (req, res) => {
  const ip = authService.getClientIp(req);

  if (authService.isLocked(ip)) {
    const remaining = authService.getLockoutTimeRemaining(ip);
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${Math.ceil(remaining / 60)} minutes.`,
      code: 'LOCKED_OUT',
      retryAfter: remaining,
    });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required', code: 'MISSING_CREDENTIALS' });
  }

  const cleanUsername = sanitizeString(username, 100);
  // Don't sanitize password with escape, just trim and limit
  const cleanPassword = typeof password === 'string' ? password.trim().substring(0, 128) : '';

  if (!authService.validateCredentials(cleanUsername, cleanPassword)) {
    authService.recordFailedAttempt(ip);
    // Marks this request for the auth rate limiter: ONLY wrong credentials
    // count toward the HTTP-layer limit (never successful logins, session
    // verifies, or expired challenge tokens).
    res.locals.countAsAuthFailure = true;
    logger.warn(`Failed login attempt for ${cleanUsername} from ${ip}`);
    return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  }

  // Success: generate challenge token
  authService.resetAttempts(ip);
  const challengeToken = authService.generateChallengeToken(cleanUsername);

  logger.info(`User ${cleanUsername} passed password check from ${ip}, grid challenge issued`);

  res.json({
    challengeToken,
    message: 'Password correct, grid challenge required',
    expiresIn: '5m',
  });
});

router.post('/grid', (req, res) => {
  const ip = authService.getClientIp(req);

  if (authService.isLocked(ip)) {
    const remaining = authService.getLockoutTimeRemaining(ip);
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${Math.ceil(remaining / 60)} minutes.`,
      code: 'LOCKED_OUT',
      retryAfter: remaining,
    });
  }

  const { challengeToken, pattern } = req.body;

  if (!challengeToken || !pattern) {
    return res.status(400).json({ error: 'Challenge token and pattern required', code: 'MISSING_DATA' });
  }

  // Verify challenge token
  const decoded = authService.verifyToken(challengeToken);
  if (!decoded || decoded.step !== 'grid') {
    // NOTE: not recorded as a brute-force attempt. An expired/invalid challenge
    // is not a wrong password or wrong grid — it just means the user waited
    // past the 5-minute challenge window and should log in again. A challenge
    // token can't be forged without the JWT secret, and WRONG patterns below
    // are still counted, so brute-force protection is unaffected.
    return res.status(401).json({ error: 'Invalid or expired challenge token. Please log in again.', code: 'INVALID_CHALLENGE' });
  }

  if (!Array.isArray(pattern) || pattern.length !== 8) {
    return res.status(400).json({ error: 'Pattern must be array of 8 numbers', code: 'INVALID_PATTERN' });
  }

  // Validate pattern values
  for (const val of pattern) {
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 15) {
      return res.status(400).json({ error: 'Pattern values must be integers 0-15', code: 'INVALID_PATTERN' });
    }
  }

  if (!authService.validateGridPattern(pattern)) {
    authService.recordFailedAttempt(ip);
    // Wrong pattern — counts toward the auth rate limit. (Expired/invalid
    // challenge tokens above deliberately do NOT.)
    res.locals.countAsAuthFailure = true;
    logger.warn(`Failed grid attempt for ${decoded.username} from ${ip}`);
    return res.status(401).json({ error: 'Invalid grid pattern', code: 'INVALID_GRID' });
  }

  // Success: generate access token
  authService.resetAttempts(ip);
  const token = authService.generateAccessToken(decoded.username);
  const verified = authService.verifyToken(token);

  logger.info(`User ${decoded.username} fully authenticated from ${ip}`);

  res.json({
    token,
    expiresAt: new Date(verified.exp * 1000).toISOString(),
    user: { username: decoded.username },
  });
});

router.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (token) {
    blacklistToken(token);
  }

  res.json({ message: 'Logged out successfully' });
});

router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }

  if (!token) {
    return res.status(401).json({ valid: false, error: 'No token' });
  }

  const decoded = authService.verifyToken(token);
  if (!decoded || decoded.step === 'grid') {
    return res.status(401).json({ valid: false, error: 'Invalid token' });
  }

  // Respect logout: blacklisted tokens must not pass session verification
  // (previously only authMiddleware checked the blacklist, so /verify kept
  // reporting a logged-out token as valid).
  if (isTokenBlacklisted(token)) {
    return res.status(401).json({ valid: false, error: 'Token revoked', code: 'TOKEN_REVOKED' });
  }

  res.json({
    valid: true,
    user: { username: decoded.username },
    expiresAt: new Date(decoded.exp * 1000).toISOString(),
  });
});

module.exports = router;
