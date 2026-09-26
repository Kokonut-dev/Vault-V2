const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const EXAMPLE_PATH = path.join(__dirname, 'config.example.json');

const DEFAULT_CONFIG = {
  server: {
    port: parseInt(process.env.VAULT_PORT || '4000', 10),
    host: process.env.VAULT_HOST || '0.0.0.0',
    https: {
      enabled: false,
      keyPath: './certs/key.pem',
      certPath: './certs/cert.pem'
    }
  },
  auth: {
    username: process.env.VAULT_USERNAME || 'admin',
    passwordHash: null,
    jwtSecret: process.env.VAULT_JWT_SECRET || crypto.randomBytes(64).toString('hex'),
    sessionTimeout: process.env.VAULT_SESSION_TIMEOUT || '24h',
    gridPattern: [0, 1, 4, 5, 8, 9, 12, 13],
    gridOrderMatters: false,
    maxAttempts: 5,
    lockoutDurationMinutes: 15
  },
  media: {
    paths: {
      movies: path.join(__dirname, 'media/movies'),
      music: path.join(__dirname, 'media/music'),
      videos: path.join(__dirname, 'media/videos')
    },
    supportedExtensions: {
      video: ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg'],
      audio: ['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.wma', '.aiff', '.alac'],
      subtitle: ['.srt', '.vtt', '.ass', '.ssa']
    },
    maxUploadSizeMB: 10240,
    thumbnail: {
      enabled: true,
      width: 320,
      height: 180
    },
    transcoding: {
      enabled: true,
      cacheDir: path.join(__dirname, 'cache/transcoded'),
      cacheMaxSizeMB: 5120,
      videoCodec: 'libx264',
      audioCodec: 'aac'
    }
  },
  cors: {
    origins: [
      'https://kokonut-dev.github.io',
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://localhost:8080',
      'http://localhost:4000'
    ]
  },
  security: {
    rateLimit: {
      general: { windowMs: 15 * 60 * 1000, max: 200 },
      auth: { windowMs: 15 * 60 * 1000, max: 10 },
      upload: { windowMs: 15 * 60 * 1000, max: 30 }
    }
  },
  onboarding: {
    completedAt: null,
    version: '2.0.0',
    enablement: true,
  }
};

let config = null;

function loadConfig() {
  if (config) return config;

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileConfig = fs.readJsonSync(CONFIG_PATH);
      config = mergeDeep(DEFAULT_CONFIG, fileConfig);
      console.log('[Config] Loaded from config.json');
    } else {
      console.log('[Config] No config.json found, using defaults + env. Run npm run setup to create one.');
      config = DEFAULT_CONFIG;
      // Generate a default password hash for admin/admin if none exists (for first run)
      if (!config.auth.passwordHash) {
        const bcrypt = require('bcryptjs');
        const defaultPass = 'admin';
        config.auth.passwordHash = bcrypt.hashSync(defaultPass, 10);
        console.log('[Config] Using default credentials admin/admin — CHANGE IMMEDIATELY via setup script!');
      }
    }
  } catch (err) {
    console.error('[Config] Failed to load config, using defaults:', err.message);
    config = DEFAULT_CONFIG;
  }

  // Resolve relative media paths
  for (const key of Object.keys(config.media.paths)) {
    if (!path.isAbsolute(config.media.paths[key])) {
      config.media.paths[key] = path.resolve(__dirname, config.media.paths[key]);
    }
  }

  if (!path.isAbsolute(config.media.transcoding.cacheDir)) {
    config.media.transcoding.cacheDir = path.resolve(__dirname, config.media.transcoding.cacheDir);
  }

  return config;
}

function mergeDeep(target, source) {
  const output = { ...target };
  if (isObject(target) && isObject(source)) {
    Object.keys(source).forEach(key => {
      if (isObject(source[key])) {
        if (!(key in target)) Object.assign(output, { [key]: source[key] });
        else output[key] = mergeDeep(target[key], source[key]);
      } else {
        Object.assign(output, { [key]: source[key] });
      }
    });
  }
  return output;
}

function isObject(item) {
  return item && typeof item === 'object' && !Array.isArray(item);
}

function saveConfig(newConfig) {
  const toSave = {
    server: newConfig.server,
    auth: {
      username: newConfig.auth.username,
      passwordHash: newConfig.auth.passwordHash,
      jwtSecret: newConfig.auth.jwtSecret,
      sessionTimeout: newConfig.auth.sessionTimeout,
      gridPattern: newConfig.auth.gridPattern,
      gridOrderMatters: newConfig.auth.gridOrderMatters,
      maxAttempts: newConfig.auth.maxAttempts,
      lockoutDurationMinutes: newConfig.auth.lockoutDurationMinutes
    },
    media: {
      paths: newConfig.media.paths,
      maxUploadSizeMB: newConfig.media.maxUploadSizeMB
    },
    cors: newConfig.cors,
    security: newConfig.security,
    onboarding: newConfig.onboarding || {
      completedAt: new Date().toISOString(),
      version: '2.0.0',
      enablement: true,
    }
  };
  // Ensure enablement is true when onboarding exists
  if (toSave.onboarding) {
    toSave.onboarding.enablement = true;
  }
  fs.writeJsonSync(CONFIG_PATH, toSave, { spaces: 2 });
  config = null; // force reload
  return loadConfig();
}

function getConfig() {
  if (!config) loadConfig();
  return config;
}

module.exports = { loadConfig, getConfig, saveConfig, CONFIG_PATH, DEFAULT_CONFIG };
