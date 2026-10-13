const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');
const fs = require('fs-extra');
const path = require('path');
const sessions = require('../services/sessions');

const BLACKLIST_PATH = path.join(__dirname, '../data/token-blacklist.json');
let blacklist = new Set();

function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_PATH)) {
      const data = fs.readJsonSync(BLACKLIST_PATH);
      blacklist = new Set(data);
      // Clean expired tokens
      const now = Date.now();
      for (const tokenData of blacklist) {
        try {
          if (typeof tokenData === 'string') continue; // old format
          if (tokenData.exp && tokenData.exp * 1000 < now) {
            blacklist.delete(tokenData);
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[Auth] Failed to load blacklist:', err.message);
  }
}

function saveBlacklist() {
  try {
    fs.ensureDirSync(path.dirname(BLACKLIST_PATH));
    fs.writeJsonSync(BLACKLIST_PATH, Array.from(blacklist));
  } catch (err) {
    console.warn('[Auth] Failed to save blacklist:', err.message);
  }
}

loadBlacklist();

function authMiddleware(req, res, next) {
  // Allow health check without auth
  if (req.path === '/api/health') return next();

  const authHeader = req.headers.authorization;
  let token = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    // Allow token via query for media streaming (video/audio tags can't set headers)
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }

  // Check blacklist
  if (blacklist.has(token)) {
    return res.status(401).json({ error: 'Token revoked', code: 'TOKEN_REVOKED' });
  }

  try {
    const config = getConfig();
    const decoded = jwt.verify(token, config.auth.jwtSecret);

    // Challenge tokens must never authorise API calls.
    if (decoded.step && decoded.step !== undefined) {
      return res.status(401).json({ error: 'Grid challenge required', code: 'GRID_REQUIRED' });
    }

    // Per-device sessions: a revoked session invalidates its tokens even though
    // the JWT itself is still cryptographically valid.
    if (decoded.sid && !sessions.isValid(decoded.sid)) {
      return res.status(401).json({ error: 'Session revoked', code: 'TOKEN_REVOKED' });
    }
    if (decoded.sid) sessions.touch(decoded.sid);

    req.user = decoded;
    req.token = token;
    req.profileId = decoded.profileId || 'default';
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
}

function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);
  else if (req.query && req.query.token) token = req.query.token;

  if (!token) {
    req.user = null;
    return next();
  }

  if (blacklist.has(token)) {
    req.user = null;
    return next();
  }

  try {
    const config = getConfig();
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    if (decoded.step) {
      req.user = null;
      return next();
    }
    if (decoded.sid && !sessions.isValid(decoded.sid)) {
      req.user = null;
      return next();
    }
    req.user = decoded;
    req.token = token;
    req.profileId = decoded.profileId || 'default';
  } catch {
    req.user = null;
  }
  next();
}

function blacklistToken(token) {
  try {
    const config = getConfig();
    const decoded = jwt.decode(token);
    const exp = decoded ? decoded.exp : Math.floor(Date.now() / 1000) + 86400;
    // Store with expiry for cleanup
    blacklist.add(token);
    saveBlacklist();

    // Auto-remove after expiry
    const ttl = exp * 1000 - Date.now();
    if (ttl > 0 && ttl < 24 * 60 * 60 * 1000) {
      setTimeout(() => {
        blacklist.delete(token);
        saveBlacklist();
      }, ttl);
    }
  } catch (err) {
    console.warn('[Auth] Failed to blacklist token:', err.message);
  }
}

function isTokenBlacklisted(token) {
  return blacklist.has(token);
}

module.exports = { authMiddleware, optionalAuthMiddleware, blacklistToken, isTokenBlacklisted };
