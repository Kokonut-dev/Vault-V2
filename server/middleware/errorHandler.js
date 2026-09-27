const logger = require('../utils/logger');

function debugEnabled() {
  const v = process.env.VAULT_DEBUG;
  return v === '1' || v === 'true' || v === 'yes';
}

function errorHandler(err, req, res, next) {
  // Full detail always goes to the server log...
  logger.error('[Error]', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large', code: 'FILE_TOO_LARGE' });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
  }

  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? 'Internal server error' : err.message || 'Unknown error';

  // ...but stack traces are only returned to the client when explicitly
  // opted in via VAULT_DEBUG=1. NODE_ENV is never set by this project, so the
  // old `NODE_ENV !== 'production'` check leaked stack traces to every caller
  // by default (F-7).
  res.status(status).json({
    error: message,
    code: err.code || 'INTERNAL_ERROR',
    ...(debugEnabled() && { stack: err.stack }),
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path: req.path });
}

module.exports = { errorHandler, notFoundHandler, debugEnabled };
