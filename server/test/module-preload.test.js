/**
 * Start-up is one parallel wave of module downloads, not one round trip per
 * import level (scripts/build-preload.js):
 *   - index.html lists main.js's whole static import graph as modulepreloads,
 *   - js/utils/preloadGraph.js lists what a signed-in start loads next,
 *   - the server points those URLs (and main.js) at the build-pinned copies,
 *     the same module-map entries the import map resolves to.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const clientBuild = require('../utils/clientBuild');
const preload = require('../../scripts/build-preload');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');

test("index.html's modulepreload list is main.js's static import graph, up to date", () => {
  assert.equal(preload.render(html), html, 'stale — run: node scripts/build-preload.js');
  const { document } = new JSDOM(html).window;
  const hrefs = [...document.querySelectorAll('link[rel="modulepreload"]')].map(l => l.getAttribute('href'));
  const graph = preload.staticGraph().map(f => './' + path.relative(DOCS, f).split(path.sep).join('/'));
  assert.deepEqual(hrefs, graph);
  for (const must of ['./js/api.js', './js/router.js', './js/components/termsGate.js', './js/utils/preloadGraph.js']) {
    assert.ok(hrefs.includes(must), `${must} is preloaded`);
  }
  assert.ok(!hrefs.includes('./js/main.js'), 'main.js is the module script itself');
  assert.ok(!hrefs.includes('./js/onboarding.js'), 'lazy modules stay lazy');
  for (const href of hrefs) assert.ok(fs.existsSync(path.join(DOCS, href)), `${href} exists`);
  // The hints come before the module script.
  assert.ok(html.indexOf('rel="modulepreload"') < html.indexOf('type="module"'));
});

test('preloadGraph.js is up to date and lists the signed-in start without repeats', async () => {
  assert.equal(fs.readFileSync(preload.GRAPH_FILE, 'utf8'), preload.graphModule(), 'stale — run: node scripts/build-preload.js');
  const { HOME_MODULES, APP_MODULES } = await import(preload.GRAPH_FILE);
  assert.equal(HOME_MODULES[0], './views/home.js');
  for (const m of ['./components/audioPlayer.js', './app-extras.js', './components/shortcutsPanel.js']) assert.ok(APP_MODULES.includes(m), m);
  const all = [...HOME_MODULES, ...APP_MODULES];
  assert.equal(new Set(all).size, all.length, 'each module once');
  const inIndex = new Set(preload.staticGraph().map(f => './' + path.relative(path.join(DOCS, 'js'), f).split(path.sep).join('/')));
  for (const m of all) {
    assert.ok(!inIndex.has(m), `${m} is already preloaded by index.html`);
    assert.ok(fs.existsSync(path.join(DOCS, 'js', m)), `${m} exists`);
  }
});

test('the server points the preloads and main.js at the build-pinned URLs', () => {
  const pinned = clientBuild.pinModuleUrls(html, 'abc123');
  const { document } = new JSDOM(pinned).window;
  const hrefs = [...document.querySelectorAll('link[rel="modulepreload"]')].map(l => l.getAttribute('href'));
  assert.ok(hrefs.length > 10);
  for (const href of hrefs) assert.match(href, /^\/b\/abc123\/js\/[\w/.-]+\.js$/);
  assert.equal(document.querySelector('script[type="module"]').getAttribute('src'), '/b/abc123/js/main.js');
  // Classic scripts, styles and fonts are left alone.
  assert.equal(document.querySelector('script:not([type])').getAttribute('src'), './js/boot-head.js');
  assert.equal(document.querySelector('link[rel="stylesheet"]').getAttribute('href'), './css/vault.css');
});
