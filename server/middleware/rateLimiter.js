const rateLimit = require('express-rate-limit');
const { getConfig } = require('../config');
const logger = require('../utils/logger');

// Paths that must never consume (or be blocked by) the general budget:
// everything the browser calls *while trying to sign in*. The previous
// fix (PR #13) already exempted auth/setup/health based on a prefix
// check against the raw URL; this keeps that intent but matches on the
// query-stripped path, also covers `/api/auth` without a trailing
// segment, and exempts the SSE event streams — a long-lived
// `/api/events` connection (and its reconnects after a token change)
// is not a burst of API calls, and counting it could 429 a user who
// then gets bounced to the login screen.
function isGeneralExempt(req) {
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  if (p === '/api/auth' || p.startsWith('/api/auth/')) return true;
  if (p === '/api/setup' || p.startsWith('/api/setup/')) return true;
  if (p === '/api/health') return true;
  if (p === '/api/events' || p.startsWith('/api/events/')) return true;
  // Media streaming uses HTTP Range requests — a single video can fire
  // dozens of requests per minute while seeking/buffering. Counting
  // them against the general cap killed playback mid-stream with 429s.
  // These endpoints are already protected by auth middleware.
  return p.includes('/media/') || p.includes('/transcode/');
}

// Which credential stage a request belongs to. Password failures and
// second-factor failures are budgeted separately (mirrors the staged
// brute-force store in services/authService): one step's failures must
// never lock the other step, and proving one factor must not reset the
// other factor's budget.
function authStageFor(req) {
  const p = String(req.originalUrl || req.url || '').split('?')[0];
  if (p.endsWith('/grid') || p.endsWith('/second-factor')) return 'second';
  return 'password';
}

function createRateLimiters() {
  const config = getConfig();
  const rlConfig = config.security.rateLimit;

  const generalLimiter = rateLimit({
    windowMs: rlConfig.general.windowMs,
    max: rlConfig.general.max,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: isGeneralExempt,
  });

  // Coarse flood ceiling for the credential endpoints. They are exempt
  // from the general limiter (so general traffic can never lock anyone
  // out of signing in), but "exempt" must not mean "unbounded": this
  // caps raw POST volume per IP far above anything a human at a login
  // form can produce (the failure limiters below lock at 5–10 wrong
  // credentials), purely to bound bcrypt/JSON-parsing floods.
  const authFloodLimiter = rateLimit({
    windowMs: rlConfig.auth.windowMs,
    max: Math.max((rlConfig.auth.max || 10) * 30, 300),
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Auth limiter: counts ONLY wrong credentials (bad password / bad grid).
  // express-rate-limit can't do this — it counts every request up front (or
  // every non-2xx response), which locked out real users whenever they let a
  // grid challenge expire, and previously even on successful logins.
  // Auth routes set `res.locals.countAsAuthFailure = true` exactly when the
  // password or grid is wrong; we count those after the response finishes.
  //
  // Successes restore budget — the bug PR #13 missed. Routes set
  // `res.locals.resetAuthFailures` on success ('password' after a correct
  // password, 'all' after a completed login); the matching bucket(s) are
  // cleared here. Before this, successes merely didn't increment, so
  // failures from both steps accumulated across intervening successes
  // (4 bad passwords → correct password → 4 bad grids → correct password
  // → 2 bad grids) until a request with *correct* credentials got 429.
  function createAuthFailureLimiter() {
    const windowMs = rlConfig.auth.windowMs;
    const max = rlConfig.auth.max;
    const hits = new Map(); // `${ip}|${stage}` -> { count, windowStart, lockedUntil }

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
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
      const stage = authStageFor(req);
      const key = `${ip}|${stage}`;
      const now = Date.now();
      const rec = hits.get(key);

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
      }

      res.on('finish', () => {
        if (!res.locals) return;
        if (res.locals.countAsAuthFailure) {
          const t = Date.now();
          let r = hits.get(key);
          if (!r || t - r.windowStart > windowMs) {
            r = { count: 0, windowStart: t, lockedUntil: null };
          }
          r.count += 1;
          if (r.count >= max && !r.lockedUntil) {
            r.lockedUntil = t + windowMs;
            logger.warn(`Auth rate limit: IP ${ip} hit ${r.count} failed ${stage} attempts — blocked for ${Math.round(windowMs / 60000)} minutes`);
          }
          hits.set(key, r);
          return;
        }
        // A proved credential restores that stage's budget; only a
        // *completed* login (both factors) restores both.
        if (res.locals.resetAuthFailures === 'all') {
          hits.delete(`${ip}|password`);
          hits.delete(`${ip}|second`);
        } else if (res.locals.resetAuthFailures) {
          hits.delete(`${ip}|${res.locals.resetAuthFailures}`);
        }
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

  return { generalLimiter, authLimiter, authFloodLimiter, uploadLimiter };
}

module.exports = createRateLimiters;
module.exports._internals = { isGeneralExempt, authStageFor };
