const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');
const fs = require('fs-extra');
const path = require('path');
const sessions = require('../services/sessions');

// Media tokens (GET /api/auth/media-token) only unlock media reads (GET/HEAD
// under these paths), never the rest of the API. They are the only tokens
// accepted in a URL (`?token=`): <video>, <img>, <track> and EventSource
// can't send an Authorization header. A full sign-in token in a URL would
// leak through browser history, proxies, screenshots and copied links, so it
// is refused. Full tokens travel in the Authorization header only.
const MEDIA_SCOPE_BASES = ['/api/media', '/api/transcode', '/api/comics', '/api/playlists', '/api/livetv/stream', '/api/events'];

/** The request path including the mount point (`app.use` strips it from req.path). */
function fullPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}`;
}

/** May a media-scope token be used for this request? */
function mediaScopeAllows(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = fullPath(req);
  return MEDIA_SCOPE_BASES.some(base => p === base || p.startsWith(`${base}/`));
}

/**
 * Which profile a token acts as. The session record wins over the token:
 * switching profile re-binds the session, so an older token from the same
 * device can't keep using the previous (possibly unrestricted) profile.
 * Returns null when that profile no longer exists.
 */
function resolveProfileId(decoded) {
  let profileId = decoded.profileId || 'default';
  if (decoded.sid) {
    const session = sessions.get(decoded.sid);
    if (session?.profileId) profileId = session.profileId;
  }
  // Lazy: services/profiles pulls in config and the JSON store.
  const profiles = require('../services/profiles');
  return profiles.get(profileId) ? profileId : null;
}

const BLACKLIST_PATH = path.join(require('../utils/dataDir').DATA_DIR, 'token-blacklist.json');
let blacklist = new Set();

function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_PATH)) {
      const data = fs.readJsonSync(BLACKLIST_PATH);
      blacklist = new Set(Array.isArray(data) ? data.filter(t => typeof t === 'string') : []);
      // Expired tokens are rejected anyway; keeping them only grew the file
      // (and every lookup) forever — the old cleanup skipped every entry.
      if (pruneBlacklist()) saveBlacklist();
    }
  } catch (err) {
    console.warn('[Auth] Failed to load blacklist:', err.message);
  }
}

/** Drop tokens whose own expiry has passed. Returns how many were dropped. */
function pruneBlacklist(now = Date.now()) {
  let dropped = 0;
  for (const token of blacklist) {
    const exp = jwt.decode(token)?.exp;
    if (!exp || exp * 1000 < now) {
      blacklist.delete(token);
      dropped++;
    }
  }
  return dropped;
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

  // Until first-time setup is done, signed-in requests only work from this
  // computer (see services/setupGuard.js). This also covers any token that
  // was issued with the factory login before setup.
  if (!require('../services/setupGuard').allowSignIn(req, res)) return;

  const authHeader = req.headers.authorization;
  let token = null;
  let fromQuery = false;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && typeof req.query.token === 'string' && req.query.token) {
    // Media URLs only (video/audio/img tags and EventSource can't set
    // headers), and only with a media-scope token. Checked below.
    token = req.query.token;
    fromQuery = true;
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

    // Every token Vault issues belongs to a device session. One without a
    // session can't be signed out or revoked, so it is never accepted (it is
    // either from a very old version — sign in again — or forged).
    if (!decoded.sid) {
      return res.status(401).json({ error: 'Please sign in again', code: 'TOKEN_REVOKED' });
    }
    // Per-device sessions: a revoked session invalidates its tokens even though
    // the JWT itself is still cryptographically valid.
    if (!sessions.isValid(decoded.sid)) {
      return res.status(401).json({ error: 'Session revoked', code: 'TOKEN_REVOKED' });
    }
    sessions.touch(decoded.sid);

    if (fromQuery && decoded.scope !== 'media') {
      return res.status(401).json({ error: 'Sign-in tokens are not accepted in links. Reload Vault to get a media link.', code: 'QUERY_TOKEN_NOT_ALLOWED' });
    }
    if (decoded.scope === 'media' && !mediaScopeAllows(req)) {
      return res.status(401).json({ error: 'This token only plays media', code: 'INVALID_TOKEN' });
    }

    const profileId = resolveProfileId(decoded);
    if (!profileId) {
      return res.status(401).json({ error: 'This profile was deleted', code: 'PROFILE_REMOVED' });
    }

    // Terms of Use: until this profile has accepted the current version, it
    // can only read and accept them (or switch profile). Covers every app,
    // TV and media link, not just the web client (services/terms.js).
    const terms = require('../services/terms');
    let termsOk;
    try {
      termsOk = terms.gateAllows(req.method, fullPath(req)) || terms.isAccepted(profileId);
    } catch (err) {
      // Fail closed, but don't report a server fault as a bad sign-in (a 401
      // would sign the device out).
      console.warn('[Auth] Terms of Use check failed:', err.message);
      return res.status(503).json({ error: 'Vault could not check the Terms of Use. Try again in a moment.', code: 'TERMS_CHECK_FAILED' });
    }
    if (!termsOk) return res.status(403).json(terms.requiredBody());

    req.user = { ...decoded, profileId };
    req.token = token;
    req.profileId = profileId;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
}

function optionalAuthMiddleware(req, res, next) {
  // Before setup, other devices are never treated as signed in.
  if (!require('../utils/clientAddress').isLocalRequest(req) && require('../services/setupGuard').pending()) {
    req.user = null;
    return next();
  }
  // Header only: URL tokens are media-scope, which never counts as signed in here.
  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);

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
    if (!decoded.sid || !sessions.isValid(decoded.sid)) {
      req.user = null;
      return next();
    }
    const profileId = resolveProfileId(decoded);
    if (!profileId || decoded.scope === 'media') {
      req.user = null;
      return next();
    }
    req.user = { ...decoded, profileId };
    req.token = token;
    req.profileId = profileId;
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
    pruneBlacklist();
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

module.exports = { authMiddleware, optionalAuthMiddleware, blacklistToken, isTokenBlacklisted, resolveProfileId };
