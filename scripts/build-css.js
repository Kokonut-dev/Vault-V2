#!/usr/bin/env node
/**
 * Vault CSS build — concatenates the stylesheet cascade into ONE file
 * (docs/css/vault.css), minified with clean-css.
 *
 * Why: the app ships 13 render-blocking <link> tags. One HTTP request instead
 * of 13 (critical on mobile/high-RTT) while preserving EXACT cascade order —
 * source files remain the editing surface, this file is generated.
 *
 * Kept out of the bundle on purpose:
 *   - onboarding.css  → loaded async (and referenced by CI checks in index.html)
 *   - fonts/*         → no @font-face sources exist (dead stylesheets)
 *
 * Usage:  node scripts/build-css.js          (from repo root, or via
 *         `npm run build:css` from server/)
 *
 * The script self-validates: every source sheet must contribute a marker
 * string to the output, braces must balance, and no @font-face may appear.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createRequire } = require('module');

const REPO_ROOT = path.join(__dirname, '..');
const CSS_DIR = path.join(REPO_ROOT, 'docs', 'css');
const OUT_FILE = path.join(CSS_DIR, 'vault.css');

// Exact cascade order from docs/index.html (do not reorder without checking
// specificity interplay between sheets).
const SHEETS = [
  'reset.css',
  'variables.css',
  'themes.css',
  'glass.css',
  'grain.css',
  'layout.css',
  'components.css',
  'player.css',
  'search.css',
  'eq.css',
  'animations.css',
  'accessibility.css',
];

// One marker string per sheet (verified unique across sources) — proves the
// sheet survived concatenation + minification.
const MARKERS = {
  'reset.css': 'box-sizing',
  'variables.css': '--font-sans:',
  'themes.css': 'themeFade',
  'glass.css': 'glass-island',
  'grain.css': 'grainShift',
  'layout.css': 'detail-layout',
  'components.css': 'skeletonShimmer',
  'player.css': 'countdownSpin',
  'search.css': 'search-modal-backdrop',
  'eq.css': 'eq-panel',
  'animations.css': 'pageEnter',
  'accessibility.css': 'skip-link',
};

function loadCleanCss() {
  try {
    // Resolve from server/node_modules — the build tool lives there as a
    // devDependency; scripts/ itself has no package.json.
    const serverRequire = createRequire(path.join(REPO_ROOT, 'server', 'package.json'));
    return serverRequire('clean-css');
  } catch (err) {
    console.error('[build-css] clean-css not found — run `npm install` in server/ first.');
    console.error(`[build-css] (${err.message})`);
    process.exit(1);
  }
}

function build({ quiet = false } = {}) {
  const parts = [];
  let rawBytes = 0;

  for (const name of SHEETS) {
    const filePath = path.join(CSS_DIR, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing source sheet: ${filePath}`);
    }
    const src = fs.readFileSync(filePath, 'utf8').trim();
    parts.push(`/* ===== ${name} ===== */\n${src}`);
    rawBytes += Buffer.byteLength(src);
  }

  const concatenated = parts.join('\n\n') + '\n';

  const CleanCSS = loadCleanCss();
  const result = new CleanCSS({
    level: 1, // safe: whitespace/comment cleanup, no selector restructuring
    sourceMap: false,
    returnPromise: false,
  }).minify(concatenated);

  if (result.errors && result.errors.length) {
    throw new Error(`clean-css errors:\n  - ${result.errors.join('\n  - ')}`);
  }

  const banner =
    '/*! Vault stylesheet — GENERATED FILE, do not edit. ' +
    `Sources: docs/css/{${SHEETS.join(',')}} — rebuild: npm run build:css */\n`;
  const minified = banner + result.styles;

  // ---- self-validation ----
  const problems = [];
  const open = (minified.match(/\{/g) || []).length;
  const close = (minified.match(/\}/g) || []).length;
  if (open !== close) problems.push(`unbalanced braces: ${open} open vs ${close} close`);
  if (/@font-face/i.test(minified)) problems.push('@font-face leaked into bundle (fonts are excluded)');
  for (const [sheet, marker] of Object.entries(MARKERS)) {
    if (!minified.includes(marker.replace(/\s+/g, ''))) {
      // markers contain no spaces; still guard against minifier whitespace
      if (!minified.includes(marker)) problems.push(`marker for ${sheet} missing: ${marker}`);
    }
  }
  if (problems.length) {
    throw new Error(`bundle validation failed:\n  - ${problems.join('\n  - ')}`);
  }

  fs.writeFileSync(OUT_FILE, minified);

  const gz = zlib.gzipSync(minified, { level: 9 }).length;
  if (!quiet) {
    console.log(
      `[build-css] ${SHEETS.length} sheets → ${path.relative(REPO_ROOT, OUT_FILE)}`
    );
    console.log(
      `[build-css] raw: ${rawBytes.toLocaleString()} B → minified: ${Buffer.byteLength(
        minified
      ).toLocaleString()} B → gzip: ${gz.toLocaleString()} B`
    );
    if (result.warnings && result.warnings.length) {
      for (const w of result.warnings) console.warn(`[build-css] warning: ${w}`);
    }
  }

  return { outFile: OUT_FILE, rawBytes, minifiedBytes: Buffer.byteLength(minified), gzipBytes: gz, sheets: SHEETS };
}

if (require.main === module) {
  try {
    build();
  } catch (err) {
    console.error(`[build-css] FAILED: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { build, SHEETS, MARKERS };
