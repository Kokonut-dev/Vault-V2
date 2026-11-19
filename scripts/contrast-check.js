#!/usr/bin/env node
/**
 * WCAG contrast checker for Vault's theme tokens (zero dependencies).
 *
 * Parses docs/css/variables.css, composites every rgba() token over the
 * surface it sits on, and asserts, for each of the six themes:
 *
 *   Text — WCAG 2.2 SC 1.4.6 (AAA, 7:1), on EVERY surface text is set on
 *   (--bg-primary/secondary and --surface-sunken/base/raised/elevated/overlay),
 *   not just the page background:
 *     --text-primary / --text-secondary / --text-tertiary
 *     --accent-text, --error, --success, --warning, --info
 *   Labels on accent fills — --on-accent vs --accent-solid and
 *   --btn-accent-end (the hover fill), AAA 7:1.
 *   Non-text — SC 1.4.11 (3:1) on every surface: --border-control (inputs,
 *   checkboxes), --focus-ring, and --accent (progress bars, selection marks).
 *
 * Usage:  node scripts/contrast-check.js     (exit 1 on any FAIL)
 *         npm run check:contrast             (same, from the repo root)
 * Also runs inside `npm test` (server/test/contrast.test.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VARIABLES = path.join(__dirname, '..', 'docs', 'css', 'variables.css');
const THEMES = ['dark', 'light', 'warm', 'cold', 'midnight', 'white'];
const AAA = 7.0;

function parseThemeTokens(css) {
  const tokens = {};
  // Shared root tokens first, then theme blocks override.
  const blockRe = /(?:\[data-theme="(\w+)"\]|:root)\s*\{([^}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const theme = m[1] || '*';
    const body = m[2];
    const kvRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let kv;
    const target = tokens[theme] || (tokens[theme] = {});
    while ((kv = kvRe.exec(body)) !== null) {
      target[kv[1]] = kv[2].trim();
    }
  }
  return tokens;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  if (h.length === 3) return [...h].map(c => parseInt(c + c, 16));
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function oklchToRgb(L, C, H) {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const gamma = x => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const clamp = x => Math.min(255, Math.max(0, Math.round(gamma(x) * 255)));
  return [clamp(rLin), clamp(gLin), clamp(bLin)];
}

/** Resolve a CSS color (hex / rgb / rgba / oklch) to opaque [r,g,b] over `bg`. */
function resolveColor(value, bg) {
  const v = value.trim();
  if (v.startsWith('#')) return hexToRgb(v);
  const oklchM = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (oklchM) {
    let L = parseFloat(oklchM[1]);
    if (oklchM[1].endsWith('%')) L = L / 100;
    const C = parseFloat(oklchM[2]);
    const H = parseFloat(oklchM[3]);
    let a = 1;
    if (oklchM[4] !== undefined) {
      a = parseFloat(oklchM[4]);
      if (oklchM[4].endsWith('%')) a = a / 100;
    }
    const c = oklchToRgb(L, C, H);
    if (a >= 1) return c;
    return c.map((ch, i) => ch * a + bg[i] * (1 - a));
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)\s*(?:[,/]\s*([\d.]+))?\s*\)$/.exec(v);
  if (!m) throw new Error(`Cannot parse color: ${value}`);
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  const c = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  if (a >= 1) return c;
  // composite source-over background
  return c.map((ch, i) => ch * a + bg[i] * (1 - a));
}

function luminance([r, g, b]) {
  const lin = [r, g, b].map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NON_TEXT = 3.0;

/** Surfaces that body text is set on. Hover/active are transient and skipped. */
const SURFACES = [
  '--bg-primary', '--bg-secondary', '--surface-sunken', '--surface-base',
  '--surface-raised', '--surface-elevated', '--surface-overlay',
];
const TEXT_TOKENS = [
  '--text-primary', '--text-secondary', '--text-tertiary',
  '--accent-text', '--error', '--success', '--warning', '--info',
];
const NON_TEXT_TOKENS = ['--border-control', '--focus-ring', '--accent'];

/** Run every check; returns [{ theme, label, value, ratio, min, ok }]. */
function runChecks(css = fs.readFileSync(VARIABLES, 'utf8')) {
  const all = parseThemeTokens(css);
  const rows = [];

  for (const theme of THEMES) {
    const shared = all['*'] || {};
    const own = all[theme] || {};
    const get = name => own[name] !== undefined ? own[name] : shared[name];
    const page = resolveColor(get('--bg-primary'), [255, 255, 255]);
    const surfaces = SURFACES
      .filter(name => get(name))
      .map(name => ({ name, rgb: resolveColor(get(name), page) }));

    // Worst case across surfaces, so one row per token keeps the report short.
    const worst = (value, min, label) => {
      let lowest = null;
      for (const s of surfaces) {
        const r = ratio(resolveColor(value, s.rgb), s.rgb);
        if (!lowest || r < lowest.ratio) lowest = { ratio: r, on: s.name };
      }
      rows.push({ theme, label: `${label} (worst: ${lowest.on})`, value, ratio: lowest.ratio, min, ok: lowest.ratio >= min });
    };

    for (const token of TEXT_TOKENS) {
      const value = get(token) || (token === '--accent-text' ? get('--accent') : null);
      if (value) worst(value, AAA, `${token} text`);
    }

    const onAccent = get('--on-accent') || '#FFFFFF';
    const fills = [
      ['--accent-solid', get('--accent-solid') || get('--accent')],
      ['--btn-accent-end', get('--btn-accent-end') || get('--accent-hover')],
    ];
    for (const [name, fill] of fills) {
      if (!fill) continue;
      const r = ratio(resolveColor(onAccent, [0, 0, 0]), resolveColor(fill, [0, 0, 0]));
      rows.push({ theme, label: `--on-accent on ${name}`, value: `${onAccent} on ${fill}`, ratio: r, min: AAA, ok: r >= AAA });
    }

    for (const token of NON_TEXT_TOKENS) {
      if (get(token)) worst(get(token), AA_NON_TEXT, `${token} non-text`);
    }
  }
  return rows;
}

function main() {
  const rows = runChecks();
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('theme', 8)} ${pad('check', 50)} ${pad('value', 22)} ${pad('ratio', 8)} ${pad('min', 4)} verdict`);
  console.log('-'.repeat(104));
  for (const row of rows) {
    console.log(
      `${pad(row.theme, 8)} ${pad(row.label, 50)} ${pad(row.value, 22)} ${pad(row.ratio.toFixed(2) + ':1', 8)} ${pad(row.min, 4)} ${row.ok ? 'PASS' : 'FAIL'}`
    );
  }
  const failed = rows.filter(r => !r.ok);
  console.log('-'.repeat(104));
  if (failed.length) {
    console.log(`${failed.length} FAIL / ${rows.length} checks — text must reach ${AAA}:1 (WCAG AAA), UI parts ${AA_NON_TEXT}:1`);
    process.exit(1);
  }
  console.log(`All ${rows.length} checks PASS — text ≥ ${AAA.toFixed(1)}:1 on every surface (WCAG AAA), UI parts ≥ ${AA_NON_TEXT.toFixed(1)}:1`);
}

module.exports = { runChecks, parseThemeTokens, resolveColor, ratio, THEMES, AAA, AA_NON_TEXT };

if (require.main === module) main();
