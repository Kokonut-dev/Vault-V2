#!/usr/bin/env node
/**
 * Zero-dependency import checker for the ES-module front end.
 *
 * `syntax-check.js` proves every file parses; it cannot see a broken import
 * path or an import of an export that does not exist — both of which only
 * fail at runtime, in the browser, often on a page a test never touches.
 *
 * This script walks `docs/js/**` and verifies, for every RELATIVE import:
 *   1. the target file exists (with .js / .mjs resolution),
 *   2. every named binding is actually exported by the target,
 *   3. a default import has a default export behind it.
 *
 *   node scripts/import-check.js          (or: npm run check:imports)
 *
 * Exits non-zero on the first problem class it finds so it can gate CI.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const JS_ROOT = path.join(REPO_ROOT, 'docs', 'js');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function resolveTarget(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  let hasDefault = false;

  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\b/.test(src)) hasDefault = true;
  return { names, hasDefault };
}

const IMPORT_RE = /import\s+([^'";]+?)\s+from\s+['"](\.[^'"]+)['"]/g;
const DYNAMIC_RE = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function main() {
  if (!fs.existsSync(JS_ROOT)) {
    console.error(`[import-check] ${JS_ROOT} not found — run from the repo root.`);
    process.exit(1);
  }

  const files = walk(JS_ROOT);
  const problems = [];
  let checked = 0;

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO_ROOT, file);

    for (const m of src.matchAll(DYNAMIC_RE)) {
      checked += 1;
      if (!resolveTarget(file, m[1])) {
        problems.push(`${rel}: dynamic import target missing → ${m[1]}`);
      }
    }

    for (const m of src.matchAll(IMPORT_RE)) {
      const clause = m[1].trim();
      const target = resolveTarget(file, m[2]);
      if (!target) {
        problems.push(`${rel}: import target missing → ${m[2]}`);
        continue;
      }
      const { names, hasDefault } = exportsOf(target);
      const braced = clause.match(/\{([^}]*)\}/);
      if (braced) {
        for (const part of braced[1].split(',')) {
          const raw = part.trim();
          if (!raw) continue;
          const name = raw.split(/\s+as\s+/)[0].trim();
          checked += 1;
          if (!names.has(name)) {
            problems.push(`${rel}: "${name}" is not exported by ${m[2]}`);
          }
        }
      }
      const defaultBinding = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
      if (defaultBinding) {
        checked += 1;
        if (!hasDefault) problems.push(`${rel}: no default export in ${m[2]}`);
      }
    }
  }

  if (problems.length) {
    console.error(`[import-check] ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`[import-check] ${checked} imports across ${files.length} files OK`);
}

main();
