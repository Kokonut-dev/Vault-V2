/**
 * Theme palette guards (3.0 colour refresh).
 *
 * 1. WCAG: every theme passes scripts/contrast-check.js — text tokens reach
 *    AAA 7:1 on every surface they sit on, labels on accent fills reach 7:1,
 *    and controls/focus rings/accent marks reach 3:1 (SC 1.4.11).
 * 2. The theme picker's swatches (THEME_META in docs/js/themes.js) show the
 *    real colours from docs/css/variables.css, so the picker never lies.
 * 3. No neon leftovers: the per-theme "accent-glow" overrides and Tailwind
 *    default status literals are gone from the source stylesheets.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const contrast = require(path.join(root, 'scripts', 'contrast-check.js'));
const variablesCss = fs.readFileSync(path.join(root, 'docs', 'css', 'variables.css'), 'utf8');

test('every theme token pair meets its WCAG contrast target', () => {
  const rows = contrast.runChecks(variablesCss);
  assert.ok(rows.length >= 6 * 13, `expected checks for all six themes, got ${rows.length}`);
  const failed = rows.filter(r => !r.ok).map(r => `${r.theme} ${r.label} ${r.value} ${r.ratio.toFixed(2)}:1 < ${r.min}:1`);
  assert.deepEqual(failed, []);
});

/** THEME_META entries, read from source (importing themes.js needs a DOM + store). */
function readThemeMeta() {
  const src = fs.readFileSync(path.join(root, 'docs', 'js', 'themes.js'), 'utf8');
  const re = /\{\s*id:\s*'(\w+)',\s*name:\s*'([^']+)',\s*mode:\s*'(\w+)',\s*colors:\s*\[([^\]]+)\]\s*\}/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ id: m[1], name: m[2], mode: m[3], colors: m[4].split(',').map(c => c.trim().replace(/'/g, '')) });
  }
  return out;
}

test('theme picker swatches match the theme tokens', () => {
  const THEME_META = readThemeMeta();
  const tokens = contrast.parseThemeTokens(variablesCss);
  assert.deepEqual(THEME_META.map(t => t.id).sort(), [...contrast.THEMES].sort());
  for (const meta of THEME_META) {
    const t = tokens[meta.id];
    const [bg, raised, accent] = meta.colors.map(c => c.toUpperCase());
    assert.equal(bg, t['--bg-primary'].toUpperCase(), `${meta.id} background swatch`);
    assert.ok(
      [t['--surface-elevated'], t['--bg-tertiary'], t['--surface-base']].map(v => v.toUpperCase()).includes(raised),
      `${meta.id} surface swatch ${raised} is a real surface token`
    );
    assert.equal(accent, t['--accent-solid'].toUpperCase(), `${meta.id} accent swatch`);
  }
});

test('no neon glows or framework-default status colours in the source sheets', () => {
  const cssDir = path.join(root, 'docs', 'css');
  const offenders = [];
  for (const file of fs.readdirSync(cssDir)) {
    if (!file.endsWith('.css') || file === 'vault.css') continue;
    const src = fs.readFileSync(path.join(cssDir, file), 'utf8');
    if (/\[data-theme="\w+"\]\s*\.accent-glow/.test(src)) offenders.push(`${file}: per-theme .accent-glow override`);
    // Tailwind red-500 / green-500 / amber-500 / cyan-400 / emerald-500 literals.
    if (/rgba?\(\s*(239,\s*68,\s*68|34,\s*197,\s*94|245,\s*158,\s*11|34,\s*211,\s*238|16,\s*185,\s*129)\b/.test(src)) {
      offenders.push(`${file}: hard-coded framework default colour — use var(--error|--success|--warning)`);
    }
    // Blurred coloured shadows ("glow") built from the accent.
    if (/box-shadow:(?:[^;]*,)?\s*0 0 [1-9]\d*px var\(--accent-muted\)/.test(src)) offenders.push(`${file}: accent glow shadow`);
  }
  assert.deepEqual(offenders, []);
});
