#!/usr/bin/env node
/**
 * Vault Setup Script
 * Interactive setup for server config
 */

const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(q) {
  return new Promise(resolve => rl.question(q, resolve));
}

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║         VAULT SETUP WIZARD           ║
║  Self-Hosted Personal Media Server   ║
╚══════════════════════════════════════╝
`);

  const configPath = path.join(__dirname, '../server/config.json');
  let existingConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      existingConfig = fs.readJsonSync(configPath);
      console.log('Found existing config.json — values will be used as defaults.\n');
    } catch {}
  }

  // Username
  const defaultUser = existingConfig.auth?.username || 'admin';
  let username = await question(`Username [${defaultUser}]: `);
  username = username.trim() || defaultUser;

  // Password
  let password = await question('Password (min 4 chars, will be hashed): ');
  while (!password || password.length < 4) {
    if (!password && existingConfig.auth?.passwordHash) {
      console.log('Keeping existing password hash');
      password = null;
      break;
    }
    console.log('Password must be at least 4 characters');
    password = await question('Password: ');
  }

  let passwordHash = existingConfig.auth?.passwordHash;
  if (password) {
    passwordHash = bcrypt.hashSync(password, 10);
    console.log('Password hashed ✓');
  }

  // Grid pattern
  console.log(`
Grid Challenge Setup:
You need to choose 8 squares out of 16 (0-15) in a 4x4 grid:

  0  1  2  3
  4  5  6  7
  8  9 10 11
 12 13 14 15

Example: 0,1,4,5,8,9,12,13 (left two columns)
`);
  const defaultGrid = existingConfig.auth?.gridPattern?.join(',') || '0,1,4,5,8,9,12,13';
  let gridInput = await question(`Grid pattern (8 numbers 0-15 comma-separated) [${defaultGrid}]: `);
  gridInput = gridInput.trim() || defaultGrid;

  let gridPattern;
  try {
    gridPattern = gridInput.split(',').map(s => parseInt(s.trim(), 10));
    if (gridPattern.length !== 8 || new Set(gridPattern).size !== 8 || gridPattern.some(n => isNaN(n) || n < 0 || n > 15)) {
      throw new Error('Invalid');
    }
  } catch {
    console.log('Invalid grid pattern, using default');
    gridPattern = [0, 1, 4, 5, 8, 9, 12, 13];
  }
  console.log(`Grid pattern set: [${gridPattern.join(', ')}] ✓`);

  // Media paths
  console.log('\nMedia Paths (absolute or relative to server/ folder):');
  const defaultMovies = existingConfig.media?.paths?.movies || './media/movies';
  const defaultMusic = existingConfig.media?.paths?.music || './media/music';
  const defaultVideos = existingConfig.media?.paths?.videos || './media/videos';

  let moviesPath = await question(`Movies path [${defaultMovies}]: `);
  moviesPath = moviesPath.trim() || defaultMovies;

  let musicPath = await question(`Music path [${defaultMusic}]: `);
  musicPath = musicPath.trim() || defaultMusic;

  let videosPath = await question(`Videos path [${defaultVideos}]: `);
  videosPath = videosPath.trim() || defaultVideos;

  // Port
  const defaultPort = existingConfig.server?.port || 4000;
  let portInput = await question(`Server port [${defaultPort}]: `);
  let port = parseInt(portInput.trim(), 10) || defaultPort;

  // JWT Secret
  let jwtSecret = existingConfig.auth?.jwtSecret;
  if (!jwtSecret) {
    jwtSecret = crypto.randomBytes(64).toString('hex');
    console.log('Generated JWT secret ✓');
  }

  // Build config
  const config = {
    server: {
      port,
      host: existingConfig.server?.host || '0.0.0.0',
      https: existingConfig.server?.https || { enabled: false, keyPath: './certs/key.pem', certPath: './certs/cert.pem' }
    },
    auth: {
      username,
      passwordHash,
      jwtSecret,
      sessionTimeout: existingConfig.auth?.sessionTimeout || '24h',
      gridPattern,
      gridOrderMatters: existingConfig.auth?.gridOrderMatters || false,
      maxAttempts: existingConfig.auth?.maxAttempts || 5,
      lockoutDurationMinutes: existingConfig.auth?.lockoutDurationMinutes || 15
    },
    media: {
      paths: {
        movies: moviesPath,
        music: musicPath,
        videos: videosPath
      },
      maxUploadSizeMB: existingConfig.media?.maxUploadSizeMB || 10240
    },
    cors: existingConfig.cors || {
      origins: [
        'https://kokonut-dev.github.io',
        'http://localhost:3000',
        'http://localhost:5173',
        'http://127.0.0.1:3000',
        'http://localhost:8080'
      ]
    },
    security: existingConfig.security || {
      rateLimit: {
        general: { windowMs: 900000, max: 200 },
        auth: { windowMs: 900000, max: 10 },
        upload: { windowMs: 900000, max: 30 }
      }
    }
  };

  fs.writeJsonSync(configPath, config, { spaces: 2 });
  console.log(`\n✓ Config saved to ${configPath}`);

  // Create media dirs
  const serverDir = path.join(__dirname, '../server');
  for (const p of Object.values(config.media.paths)) {
    const fullPath = path.isAbsolute(p) ? p : path.resolve(serverDir, p);
    fs.ensureDirSync(fullPath);
    console.log(`✓ Ensured media dir: ${fullPath}`);
  }

  // Create data/cache dirs
  fs.ensureDirSync(path.join(serverDir, 'data'));
  fs.ensureDirSync(path.join(serverDir, 'cache/thumbnails'));
  fs.ensureDirSync(path.join(serverDir, 'cache/covers'));
  fs.ensureDirSync(path.join(serverDir, 'cache/transcoded'));

  console.log(`
╔══════════════════════════════════════╗
║         SETUP COMPLETE ✓             ║
╚══════════════════════════════════════╝

Next steps:
1. cd server && npm install
2. npm start — to run the server
3. Open frontend: https://kokonut-dev.github.io/Vault-V2/
   (or run frontend locally: npx serve ../docs)

Credentials:
  Username: ${username}
  Grid pattern: [${gridPattern.join(', ')}]

SECURITY: Keep your grid pattern secret!
`);

  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err);
  rl.close();
  process.exit(1);
});
