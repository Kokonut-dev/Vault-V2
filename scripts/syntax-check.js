#!/usr/bin/env node
/**
 * Zero-dependency syntax check ("lint") for every JS file in the repo.
 *
 * Deliberately NOT ESLint: the dependency weight isn't justified for this
 * repo yet, and a ruleset would flood a legacy vanilla codebase with
 * style-level noise. This catches the class of bugs that actually break
 * deploys — syntax errors — with no dependencies at all.
 *
 *   node scripts/syntax-check.js          (or: npm run lint from server/)
 *
 * docs/ files are ES modules, server/ files are CommonJS — each file is
 * checked with the matching parser goal.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'cache', 'data', 'media', 'uploads',
  'dist', 'build', 'coverage', '.next', '.venv', 'vendor',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function checkFile(file) {
  const rel = path.relative(REPO_ROOT, file);
  const source = fs.readFileSync(file, 'utf8');
  // docs/ has no package.json → treat as ESM when it contains import/export;
  // server/ and scripts/ assume CommonJS.
  const looksEsm = /^\s*(import\s|export\s|export\s*\{|import\s*\{)/m.test(source);
  const isServer = rel.startsWith('server' + path.sep);
  const useEsm = looksEsm && !isServer;

  if (useEsm) {
    const res = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: source,
      encoding: 'utf8',
    });
    if (res.status !== 0) return res.stderr ? res.stderr.trim() : 'parse failed';
    return null;
  }
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) return (res.stderr || 'parse failed').trim();
  return null;
}

const files = walk(REPO_ROOT).sort();
let failed = 0;
for (const file of files) {
  const err = checkFile(file);
  if (err) {
    failed++;
    console.error(`FAIL ${path.relative(REPO_ROOT, file)}\n${err}\n`);
  }
}

if (failed) {
  console.error(`syntax-check: ${failed}/${files.length} file(s) failed`);
  process.exit(1);
}
console.log(`syntax-check: ${files.length} files OK`);
