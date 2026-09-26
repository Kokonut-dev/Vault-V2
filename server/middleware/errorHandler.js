function errorHandler(err, req, res, next) {
  console.error('[Error]', err);

  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large', code: 'FILE_TOO_LARGE' });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
  }

  const status = err.status || err.statusCode || 500;
  const message = status === 500 ? 'Internal server error' : err.message || 'Unknown error';

  res.status(status).json({
    error: message,
    code: err.code || 'INTERNAL_ERROR',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', path: req.path });
}

module.exports = { errorHandler, notFoundHandler };
