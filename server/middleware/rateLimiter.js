const rateLimit = require('express-rate-limit');
const { getConfig } = require('../config');
const logger = require('../utils/logger');

function createRateLimiters() {
  const config = getConfig();
  const rlConfig = config.security.rateLimit;

  const generalLimiter = rateLimit({
    windowMs: rlConfig.general.windowMs,
    max: rlConfig.general.max,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
    // Media streaming uses HTTP Range requests — a single video can fire dozens
    // of requests per minute while seeking/buffering. Counting them against the
    // general cap killed playback mid-stream with 429s. These endpoints are
    // already protected by auth middleware, so exempt them from the cap.
    skip: (req) => {
      const p = req.originalUrl || req.url || '';
      return p.includes('/media/') || p.includes('/transcode/');
    },
  });

  // Auth limiter: counts ONLY wrong credentials (bad password / bad grid).
  // express-rate-limit can't do this — it counts every request up front (or
  // every non-2xx response), which locked out real users whenever they let a
  // grid challenge expire, and previously even on successful logins.
  // Auth routes set `res.locals.countAsAuthFailure = true` exactly when the
  // password or grid is wrong; we count those after the response finishes.
  // (Floods of malformed requests are still capped by the general limiter,
  // and wrong credentials additionally trigger the authService brute-force
  // lock at maxAttempts.)
  function createAuthFailureLimiter() {
    const windowMs = rlConfig.auth.windowMs;
    const max = rlConfig.auth.max;
    const hits = new Map(); // ip -> { count, windowStart, lockedUntil }

    // Periodic cleanup so the map can't grow unbounded
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, rec] of hits) {
        const expired = (!rec.lockedUntil || rec.lockedUntil <= now) && now - rec.windowStart > windowMs;
        if (expired) hits.delete(key);
      }
    }, Math.min(windowMs, 60000));
    if (typeof timer.unref === 'function') timer.unref();

    return function authFailureLimiter(req, res, next) {
      const key = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      const now = Date.now();
      let rec = hits.get(key);

      if (rec && rec.lockedUntil) {
        if (rec.lockedUntil > now) {
          const remainingSec = Math.ceil((rec.lockedUntil - now) / 1000);
          res.setHeader('Retry-After', String(remainingSec));
          return res.status(429).json({
            error: `Too many failed login attempts. Try again in ${Math.max(1, Math.ceil(remainingSec / 60))} minute(s).`,
            code: 'AUTH_RATE_LIMITED',
          });
        }
        // Lock expired — fresh start
        hits.delete(key);
        rec = null;
      }

      res.on('finish', () => {
        if (!res.locals || !res.locals.countAsAuthFailure) return;
        const t = Date.now();
        let r = hits.get(key);
        if (!r || t - r.windowStart > windowMs) {
          r = { count: 0, windowStart: t, lockedUntil: null };
        }
        r.count += 1;
        if (r.count >= max && !r.lockedUntil) {
          r.lockedUntil = t + windowMs;
          logger.warn(`Auth rate limit: IP ${key} hit ${r.count} failed login attempts — blocked for ${Math.round(windowMs / 60000)} minutes`);
        }
        hits.set(key, r);
      });

      next();
    };
  }

  const authLimiter = createAuthFailureLimiter();

  const uploadLimiter = rateLimit({
    windowMs: rlConfig.upload.windowMs,
    max: rlConfig.upload.max,
    message: { error: 'Too many uploads, please try again later', code: 'UPLOAD_RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  return { generalLimiter, authLimiter, uploadLimiter };
}

module.exports = createRateLimiters;
