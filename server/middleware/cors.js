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
        // Allowed on purpose: Vault signs requests with an Authorization
        // header (never cookies), so another website can't borrow a visitor's
        // session — CORS isn't what protects the API. Users point the app at
        // their own tunnel/custom domains, which a fixed list would break.
        console.warn(`[CORS] Unlisted origin: ${origin}`);
        callback(null, true);
        // To be strict, use: callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range', 'X-Google-Token', 'X-SyncPlay-Member', 'X-Vault-Setup-Code'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type', 'Content-Disposition', 'X-Vault-Build'],
    maxAge: 86400,
  };

  return cors(corsOptions);
}

module.exports = createCorsMiddleware;
