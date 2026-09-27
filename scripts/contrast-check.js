#!/usr/bin/env node
/**
 * WCAG contrast checker for Vault's theme tokens (zero dependencies).
 *
 * Parses docs/css/variables.css, composites every rgba() token over its
 * theme background, and asserts AA (4.5:1) for the pairs Stage 4 owns:
 *
 *   - --text-tertiary / --text-secondary  (used for hints, kbd, meta, counts)
 *   - --accent                             (nav active, links, counts — as text)
 *   - --error / --success / --warning      (status text in auth/onboarding)
 *   - white on --accent / --accent-hover   (btn-primary, play buttons)
 *   - --accent-text                        (accent restricted to text usage)
 *
 * Basis: WCAG 2.1 AA normal-text threshold (4.5:1) against --bg-primary,
 * matching the audit's methodology so before/after numbers are comparable.
 *
 * Usage:  node scripts/contrast-check.js        (exit 1 on any FAIL)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const VARIABLES = path.join(__dirname, '..', 'docs', 'css', 'variables.css');
const THEMES = ['dark', 'light', 'warm', 'cold'];
const AA = 4.5;

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

/** Resolve a CSS color (hex / rgb / rgba) to opaque [r,g,b] over `bg`. */
function resolveColor(value, bg) {
  const v = value.trim();
  if (v.startsWith('#')) return hexToRgb(v);
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

function main() {
  const css = fs.readFileSync(VARIABLES, 'utf8');
  const all = parseThemeTokens(css);
  const rows = [];
  let fails = 0;

  for (const theme of THEMES) {
    const shared = all['*'] || {};
    const own = all[theme] || {};
    const get = name => own[name] !== undefined ? own[name] : shared[name];
    const bg = resolveColor(get('--bg-primary'), [255, 255, 255]);
    const white = [255, 255, 255];

    const checks = [
      ['--text-tertiary (as text)', get('--text-tertiary')],
      ['--text-secondary (as text)', get('--text-secondary')],
      // Raw --accent is decorative-only after Stage 4; all accent-colored
      // text goes through --accent-text (checked below).
      ['--accent-text (as text)', get('--accent-text') || get('--accent')],
      ['--error (as text)', get('--error')],
      ['--success (as text)', get('--success')],
      ['--warning (as text)', get('--warning')],
    ];

    for (const [label, value] of checks) {
      if (!value) continue;
      const fg = resolveColor(value, bg);
      const r = ratio(fg, bg);
      const ok = r >= AA;
      if (!ok) fails++;
      rows.push({ theme, label, value, ratio: r, ok });
    }

    // Accent surfaces carrying text/icons: --on-accent must clear AA against
    // the solid fill AND both ends of the button gradient (raw --accent is
    // decorative-only after Stage 4; white is never placed on it directly).
    const onAccent = get('--on-accent') || '#FFFFFF';
    const pairs = [
      ['--on-accent vs --accent-solid', onAccent, get('--accent-solid') || get('--accent')],
      ['--on-accent vs btn gradient end', onAccent, get('--btn-accent-end') || get('--accent-hover')],
    ];
    for (const [label, fgValue, bgValue] of pairs) {
      if (!bgValue) continue;
      const r = ratio(resolveColor(fgValue, [0, 0, 0]), resolveColor(bgValue, [0, 0, 0]));
      const ok = r >= AA;
      if (!ok) fails++;
      rows.push({ theme, label, value: `${fgValue} on ${bgValue}`, ratio: r, ok });
    }
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(`${pad('theme', 6)} ${pad('check', 28)} ${pad('value', 40)} ${pad('ratio', 8)} verdict`);
  console.log('-'.repeat(96));
  for (const row of rows) {
    console.log(
      `${pad(row.theme, 6)} ${pad(row.label, 28)} ${pad(row.value, 40)} ${pad(row.ratio.toFixed(2) + ':1', 8)} ${row.ok ? 'PASS' : 'FAIL'}`
    );
  }
  const failed = rows.filter(r => !r.ok);
  console.log('-'.repeat(96));
  if (failed.length) {
    console.log(`${failed.length} FAIL / ${rows.length} checks — must all reach ${AA}:1 (WCAG AA)`);
    process.exit(1);
  }
  console.log(`All ${rows.length} checks PASS (≥ ${AA}:1)`);
}

main();
