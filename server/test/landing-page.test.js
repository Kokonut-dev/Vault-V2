/**
 * The public landing page (docs/landing.html) and the first-visit redirect
 * to it in docs/index.html.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const DOCS = path.join(__dirname, '..', '..', 'docs');
const landingHtml = fs.readFileSync(path.join(DOCS, 'landing.html'), 'utf8');
/**
 * The page with its local scripts inlined, so jsdom can run them (the real
 * page loads them as files: the CSP forbids inline scripts).
 */
const withLocalScripts = (html) => html.replace(/<script src="\.\/([^"]+)"><\/script>/g,
  (_, ref) => `<script>${fs.readFileSync(path.join(DOCS, ref), 'utf8')}</script>`);
const indexHtml = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');

test('landing page: local assets exist, images have alt text, headings are in order', () => {
  const { document } = new JSDOM(landingHtml).window;
  const refs = [...document.querySelectorAll('[src], link[href]')]
    .map(el => el.getAttribute('src') || el.getAttribute('href'))
    .filter(ref => !/^(https?:|data:|#)/.test(ref));
  assert.ok(refs.length >= 6);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(DOCS, ref.replace(/^\.\//, ''))), `missing asset ${ref}`);
  }
  for (const img of document.querySelectorAll('img')) {
    assert.ok(img.hasAttribute('alt'), `${img.getAttribute('src')} needs alt text`);
    assert.ok(img.getAttribute('width') && img.getAttribute('height'), `${img.getAttribute('src')} needs a size (no layout shift)`);
  }
  assert.equal(document.querySelectorAll('h1').length, 1);
  assert.ok(document.querySelector('a.skip[href="#main"]') && document.getElementById('main'));
  // Every in-page link points at a real section.
  for (const a of document.querySelectorAll('a[href^="#"]')) {
    assert.ok(document.getElementById(a.getAttribute('href').slice(1)), `broken anchor ${a.getAttribute('href')}`);
  }
  assert.ok(document.querySelector('a[href="https://github.com/Kokonut-dev/Vault-V2"]'));
  assert.ok(document.querySelector('a[href="./?app=1"]'), 'an "Open Vault" link back into the app');
});

test('landing page: install steps match the README', () => {
  const { document } = new JSDOM(landingHtml).window;
  const node = document.getElementById('panel-node').textContent;
  const docker = document.getElementById('panel-docker').textContent;
  for (const line of ['git clone https://github.com/Kokonut-dev/Vault-V2.git', 'cd Vault-V2', 'npm install', 'npm start']) {
    assert.ok(node.includes(line), `Node steps should include "${line}"`);
    assert.ok(readme.includes(line), `README should still include "${line}"`);
  }
  assert.ok(docker.includes('docker compose up -d --build') && readme.includes('docker compose up -d --build'));
  assert.match(landingHtml, /Node\.js 20 or newer/);
  assert.match(readme, /Node\.js 20 or newer/);
});

test('landing page: theme picker applies and remembers a theme; install tabs switch', () => {
  const dom = new JSDOM(withLocalScripts(landingHtml), { runScripts: 'dangerously', url: 'https://kokonut-dev.github.io/Vault-V2/landing.html' });
  const { document, localStorage } = dom.window;
  assert.equal(localStorage.getItem('vault_seen_landing'), '1', 'seen once, the app stops redirecting here');
  const buttons = [...document.querySelectorAll('#theme-picker button')];
  assert.deepEqual(buttons.map(b => b.dataset.theme), ['dark', 'cold', 'midnight', 'white', 'light', 'warm']);
  buttons.find(b => b.dataset.theme === 'warm').click();
  assert.equal(document.documentElement.getAttribute('data-theme'), 'warm');
  assert.equal(localStorage.getItem('vault_theme'), 'warm');
  assert.deepEqual(buttons.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.theme), ['warm']);

  document.getElementById('tab-docker').click();
  assert.equal(document.getElementById('panel-docker').hidden, false);
  assert.equal(document.getElementById('panel-node').hidden, true);
  assert.equal(document.getElementById('tab-docker').getAttribute('aria-selected'), 'true');
  document.getElementById('tab-docker').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(document.getElementById('panel-node').hidden, false);
  dom.window.close();
});

// The redirect runs from js/boot-head.js, the first script in index.html's <head>.
const redirectSource = (() => {
  const { document } = new JSDOM(indexHtml).window;
  const first = document.head.querySelector('script');
  assert.equal(first?.getAttribute('src'), './js/boot-head.js', 'index.html loads the first-visit redirect first');
  const source = fs.readFileSync(path.join(DOCS, 'js', 'boot-head.js'), 'utf8');
  assert.ok(source.includes("location.replace('landing.html')"));
  return source;
})();

function runRedirect({ url, local = {}, session = {} }) {
  const u = new URL(url);
  let replaced = null;
  const store = (data) => ({ getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } });
  const localStorage = store({ ...local });
  vm.runInNewContext(redirectSource, {
    location: { hostname: u.hostname, pathname: u.pathname, search: u.search, replace: (to) => { replaced = to; } },
    localStorage,
    sessionStorage: store({ ...session }),
  });
  return { replaced, localStorage };
}

test('index.html: only a first visit to the hosted app goes to the landing page', () => {
  const pages = 'https://kokonut-dev.github.io/Vault-V2/';
  assert.equal(runRedirect({ url: pages }).replaced, 'landing.html');
  assert.equal(runRedirect({ url: `${pages}index.html` }).replaced, 'landing.html');
  assert.equal(runRedirect({ url: pages, local: { vault_seen_landing: '1' } }).replaced, null, 'shown once');
  assert.equal(runRedirect({ url: pages, local: { vault_token: 't' } }).replaced, null, 'signed in');
  assert.equal(runRedirect({ url: pages, local: { vault_api_url: 'http://192.168.1.2:4000' } }).replaced, null, 'server already chosen');
  assert.equal(runRedirect({ url: `${pages}?pair=abc` }).replaced, null, 'pairing link');
  assert.equal(runRedirect({ url: `${pages}movies` }).replaced, null, 'deep link');
  assert.equal(runRedirect({ url: pages, session: { vault_redirect: '/movies' } }).replaced, null, '404.html deep-link hand-off');
  assert.equal(runRedirect({ url: 'http://localhost:4000/' }).replaced, null, 'never on a self-hosted server');
  const opened = runRedirect({ url: `${pages}?app=1` });
  assert.equal(opened.replaced, null);
  assert.equal(opened.localStorage.getItem('vault_seen_landing'), '1', '"Open Vault" from the landing page sticks');
});

test('index.html: the sign-in screen links to the landing page', () => {
  const { document } = new JSDOM(indexHtml).window;
  assert.ok(document.querySelector('#auth-gate a[href="landing.html"]'));
});
