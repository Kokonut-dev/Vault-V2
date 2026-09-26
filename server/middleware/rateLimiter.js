const rateLimit = require('express-rate-limit');
const { getConfig } = require('../config');

function createRateLimiters() {
  const config = getConfig();
  const rlConfig = config.security.rateLimit;

  const generalLimiter = rateLimit({
    windowMs: rlConfig.general.windowMs,
    max: rlConfig.general.max,
    message: { error: 'Too many requests, please try again later', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const authLimiter = rateLimit({
    windowMs: rlConfig.auth.windowMs,
    max: rlConfig.auth.max,
    message: { error: 'Too many login attempts, please try again later', code: 'AUTH_RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false,
  });

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
