/**
 * "Fit inside the screen" regressions:
 *   - deep links (/movie/<id>) must get real CSS/JS, not index.html,
 *   - the guards in css/responsive.css must survive the bundle build,
 *   - tab-strip scroll hints mark only strips that actually overflow.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { resolveNestedAsset } = require('../utils/spaAssets');

const DOCS = path.join(__dirname, '..', '..', 'docs');

test('nested routes resolve their relative assets instead of getting index.html', () => {
  assert.equal(resolveNestedAsset(DOCS, '/movie/abc/css/vault.css'), path.join(DOCS, 'css', 'vault.css'));
  assert.equal(resolveNestedAsset(DOCS, '/movie/css/vault.css'), path.join(DOCS, 'css', 'vault.css'));
  assert.equal(resolveNestedAsset(DOCS, '/album/x/js/api.js'), path.join(DOCS, 'js', 'api.js'));
  assert.equal(resolveNestedAsset(DOCS, '/show/key/favicon.svg'), path.join(DOCS, 'favicon.svg'));
  // Page routes fall through to index.html …
  assert.equal(resolveNestedAsset(DOCS, '/movies'), null);
  assert.equal(resolveNestedAsset(DOCS, '/movie/4c70fafa'), null);
  assert.equal(resolveNestedAsset(DOCS, '/artist/will.i.am'), null);
  // … missing assets are a clean 404, never HTML.
  assert.equal(resolveNestedAsset(DOCS, '/movie/js/nope.js'), false);
  // No escaping the docs folder.
  assert.equal(resolveNestedAsset(DOCS, '/movie/../../server/config.json'), false);
  assert.equal(resolveNestedAsset(DOCS, '/movie/..%2f..%2fserver%2fpackage.json'), false);
  assert.equal(resolveNestedAsset(DOCS, '/x/%E0%A4%A.css'), false);
});

test('the fit-to-screen guards are in the shipped bundle, last in the cascade', () => {
  const bundle = fs.readFileSync(path.join(DOCS, 'css', 'vault.css'), 'utf8');
  assert.ok(bundle.includes('--fit-guard'), 'responsive.css missing from vault.css (run node scripts/build-css.js)');
  const guardAt = bundle.indexOf('--fit-guard');
  assert.ok(guardAt > bundle.indexOf('settings-rail'), 'responsive.css must come after settings.css');
  const tail = bundle.slice(guardAt);
  // .main may shrink below its content's min width (the 320px overflow).
  assert.match(tail, /[},][^{}]*(^|,)\.main(,[^{}]*)?\{min-width:0/);
  // Bottom tab bar sits under the drawer dimmer and every overlay.
  assert.match(tail, /\.bottom-nav\{z-index:calc\(var\(--z-sidebar\) - 2\)/);
  // Phones: the dock floats above the tab bar instead of under it.
  assert.match(tail, /\.mini-player\{[^}]*bottom:calc\(var\(--bottom-nav-space\) \+ 8px\)/);
  // Video controls wrap instead of running off-screen.
  assert.match(tail, /\.video-controls-right\{flex-wrap:wrap/);
  // Hidden menus can't swallow taps.
  assert.match(tail, /\.context-menu:not\(\.active\)\{pointer-events:none/);
});

test('no grid track demands more than a phone is wide', () => {
  for (const file of fs.readdirSync(path.join(DOCS, 'css'))) {
    if (file === 'vault.css' || !file.endsWith('.css')) continue;
    const css = fs.readFileSync(path.join(DOCS, 'css', file), 'utf8');
    for (const m of css.matchAll(/minmax\((\d+)px/g)) {
      assert.ok(Number(m[1]) < 280, `${file}: minmax(${m[1]}px, …) overflows a 320px screen — use minmax(min(${m[1]}px, 100%), …)`);
    }
  }
});

test('scroll hints mark only strips that overflow, and which side has more', async () => {
  const { updateHint } = await import(pathToFileURL(path.join(DOCS, 'js', 'utils', 'scrollHints.js')).href);
  const strip = (scrollWidth, clientWidth, scrollLeft) => ({ scrollWidth, clientWidth, scrollLeft, dataset: {} });
  const fits = strip(300, 300, 0);
  assert.equal(updateHint(fits), '');
  assert.equal(fits.dataset.scrollHint, undefined);
  const start = strip(500, 300, 0);
  assert.equal(updateHint(start), 'end');
  assert.equal(start.dataset.scrollHint, 'end');
  assert.equal(updateHint(strip(500, 300, 100)), 'both');
  assert.equal(updateHint(strip(500, 300, 200)), 'start');
  // Growing the viewport until it fits clears the hint.
  start.clientWidth = 520;
  assert.equal(updateHint(start), '');
  assert.equal(start.dataset.scrollHint, undefined);
});
