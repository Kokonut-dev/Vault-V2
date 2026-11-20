#!/usr/bin/env node
/**
 * Copies what the desktop app ships — server/ and docs/ — into
 * desktop/stage/vault/ and installs the server's production packages there
 * for the platform being built, so the app never needs npm on the user's
 * computer. electron-builder then copies stage/vault into the app's
 * resources (see "extraResources" in desktop/package.json).
 *
 *   node scripts/stage.js                      this computer's platform/arch
 *   node scripts/stage.js --arch x64           e.g. an Intel Mac build on Apple silicon
 *   node scripts/stage.js --platform win32 --arch x64
 *
 * ffmpeg comes from ffmpeg-static (downloaded for the target by its install
 * script) and ffprobe from ffprobe-static (only the target's binary is kept).
 * There are no ffprobe-static builds for Linux/Windows on ARM; those builds
 * fall back to an ffmpeg installed on the system (utils/ffmpegBinaries.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const STAGE = path.join(__dirname, '..', 'stage', 'vault');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const platform = arg('platform', process.platform);
const arch = arg('arch', process.arch);

// Runtime state, secrets and things only a developer needs stay behind.
const SKIP_SERVER = new Set([
  'node_modules', 'test', 'data', 'cache', 'media', 'uploads', 'logs', 'bin', 'backups', 'certs',
  'config.json', 'config.json.tmp', '.env', '.transfer-staging', 'test-output.txt',
]);
const SKIP_DOCS = new Set(['CNAME']);

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(entry.name) || entry.name.startsWith('.transfer-failed-') || entry.name === '.DS_Store') continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest, new Set());
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

function run(cmd, args, opts) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (res.status !== 0) {
    console.error(`${cmd} failed (${res.status ?? res.error?.message})`);
    process.exit(1);
  }
}

console.log(`Staging Vault for ${platform}-${arch} in ${path.relative(process.cwd(), STAGE) || STAGE}`);
fs.rmSync(STAGE, { recursive: true, force: true });
copyDir(path.join(ROOT, 'server'), path.join(STAGE, 'server'), SKIP_SERVER);
copyDir(path.join(ROOT, 'docs'), path.join(STAGE, 'docs'), SKIP_DOCS);
for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
  if (fs.existsSync(path.join(ROOT, file))) fs.copyFileSync(path.join(ROOT, file), path.join(STAGE, file));
}

const serverStage = path.join(STAGE, 'server');
const env = {
  ...process.env,
  npm_config_platform: platform,
  npm_config_arch: arch,
  npm_config_target_arch: arch,
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};
// --omit=dev: no test/dev tools in the app. Optional packages (ffmpeg,
// torrents) are installed when their platform supports them.
run('npm', ['ci', '--omit=dev'], { cwd: serverStage, env });

// ffprobe-static ships every platform's binary (~250 MB); keep the target's.
const probeBin = path.join(serverStage, 'node_modules', 'ffprobe-static', 'bin');
if (fs.existsSync(probeBin)) {
  for (const plat of fs.readdirSync(probeBin)) {
    for (const a of fs.readdirSync(path.join(probeBin, plat))) {
      if (plat !== platform || a !== arch) fs.rmSync(path.join(probeBin, plat, a), { recursive: true, force: true });
    }
    if (!fs.readdirSync(path.join(probeBin, plat)).length) fs.rmSync(path.join(probeBin, plat), { recursive: true, force: true });
  }
}

// Native prebuilds for other platforms are dead weight too.
function prunePrebuilds(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'prebuilds') {
      for (const target of fs.readdirSync(full)) {
        // e.g. linux-x64, darwin-x64+arm64, win32-x64, android-arm64
        const [plat, archs = ''] = target.split(/-(.*)/s);
        const keep = plat === platform && archs.split('+').some(a => a === arch || a === 'universal');
        if (!keep) {
          fs.rmSync(path.join(full, target), { recursive: true, force: true });
        }
      }
    } else {
      prunePrebuilds(full);
    }
  }
}
prunePrebuilds(path.join(serverStage, 'node_modules'));
// Symlinked CLI shims aren't needed at runtime and trip up some packagers.
fs.rmSync(path.join(serverStage, 'node_modules', '.bin'), { recursive: true, force: true });

// Report what made it in.
let ffmpeg = null;
try { ffmpeg = require(path.join(serverStage, 'node_modules', 'ffmpeg-static')); } catch { /* optional */ }
const ffmpegOk = ffmpeg && fs.existsSync(ffmpeg);
const probeOk = fs.existsSync(path.join(probeBin, platform, arch));
console.log(`ffmpeg:  ${ffmpegOk ? path.relative(STAGE, ffmpeg) : 'not bundled — the app will use a system ffmpeg if there is one'}`);
console.log(`ffprobe: ${probeOk ? `bundled (${platform}-${arch})` : 'not bundled — the app will use a system ffprobe if there is one'}`);
if (process.env.VAULT_REQUIRE_FFMPEG === '1' && !(ffmpegOk && probeOk)) {
  console.error('VAULT_REQUIRE_FFMPEG=1 but ffmpeg/ffprobe are missing for this target');
  process.exit(1);
}
console.log('Staged.');
