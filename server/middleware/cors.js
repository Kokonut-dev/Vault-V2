const cors = require('cors');
const { getConfig } = require('../config');

function createCorsMiddleware() {
  const config = getConfig();
  const allowedOrigins = config.cors.origins || [];

  const corsOptions = {
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);

      // Check if origin is in allowed list or matches wildcard pattern
      const isAllowed = allowedOrigins.some(allowed => {
        if (allowed.includes('*')) {
          // Support wildcard like http://127.0.0.1:*
          const pattern = allowed.replace(/\*/g, '.*');
          const regex = new RegExp(`^${pattern}$`);
          return regex.test(origin);
        }
        return allowed === origin;
      });

      // Also allow any localhost/127.0.0.1 for dev convenience
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

      // Allow GitHub Pages origins
      const isGitHubPages = /^https:\/\/.*\.github\.io$/.test(origin);

      if (isAllowed || isLocalhost || isGitHubPages) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Blocked origin: ${origin}`);
        callback(null, true); // For self-hosted personal use, be permissive but log
        // To be strict, use: callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type'],
    maxAge: 86400,
  };

  return cors(corsOptions);
}

module.exports = createCorsMiddleware;
