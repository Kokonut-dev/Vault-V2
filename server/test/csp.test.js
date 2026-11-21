/**
 * Content-Security-Policy: no inline script anywhere.
 *
 *   - The web client (docs/) has no inline <script>, no inline event handler
 *     attribute (onclick=…, also inside view templates), no inline <style>
 *     and no eval-like calls, so the policy can forbid all of them.
 *   - The header the server sends has no 'unsafe-inline' (or 'unsafe-eval')
 *     for scripts; the only inline scripts in index.html are the two the
 *     server injects, allowed by their exact SHA-256 hash.
 *   - docs/index.html's <meta> policy (GitHub Pages copy) matches the header.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { JSDOM } = require('jsdom');

const { CSP_DIRECTIVES } = require('../utils/csp');
const clientBuild = require('../utils/clientBuild');

const DOCS = path.join(__dirname, '..', '..', 'docs');

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (ext.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (f) => path.relative(DOCS, f);

/** "a b; c d" → { a: ['b'], c: ['d'] } */
function parsePolicy(policy) {
  const map = {};
  for (const part of String(policy).split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map[name.toLowerCase()] = sources;
  }
  return map;
}

test('the web client has no inline scripts, handlers or styles', () => {
  for (const file of walk(DOCS, /\.html$/)) {
    const { document } = new JSDOM(fs.readFileSync(file, 'utf8')).window;
    for (const script of document.querySelectorAll('script')) {
      assert.ok(script.hasAttribute('src') || script.textContent.trim() === '', `${rel(file)}: inline <script>`);
    }
    assert.equal(document.querySelectorAll('style').length, 0, `${rel(file)}: inline <style>`);
    for (const el of document.querySelectorAll('*')) {
      for (const attr of el.attributes) {
        assert.ok(!/^on[a-z]+$/i.test(attr.name), `${rel(file)}: inline handler ${attr.name} on <${el.tagName.toLowerCase()}>`);
        if (attr.name === 'href' || attr.name === 'src') assert.ok(!/^\s*javascript:/i.test(attr.value), `${rel(file)}: javascript: URL`);
      }
    }
  }
  for (const file of walk(path.join(DOCS, 'js'), /\.js$/)) {
    const code = fs.readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // comments may mention the old patterns
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(code), `${rel(file)}: inline event handler in markup`);
    assert.ok(!/<style[\s>]/i.test(code), `${rel(file)}: inline <style> in markup`);
    assert.ok(!/\beval\s*\(|new\s+Function\s*\(|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/.test(code), `${rel(file)}: eval-like call`);
    // Browsers enforcing style-src-elem refuse every inline <style> (even an
    // empty one): runtime CSS must use constructable stylesheets. A <style>
    // is only acceptable as the fallback for browsers that predate both.
    if (/createElement\(\s*['"]style['"]\s*\)/.test(code)) {
      assert.ok(/adoptedStyleSheets/.test(code) && /new CSSStyleSheet\(/.test(code),
        `${rel(file)}: runtime CSS must go into a constructable stylesheet (adoptedStyleSheets)`);
    }
  }
});

let server;
let base;
test.before(async () => {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES } }));
  clientBuild.mountClient(app, DOCS);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));

test('the server forbids inline scripts and allows only its own injected tags, by hash', async () => {
  for (const url of ['/', '/index.html']) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200);
    const policy = parsePolicy(res.headers.get('content-security-policy'));
    const scriptSrc = policy['script-src'];
    assert.ok(scriptSrc.includes("'self'"));
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", '*', 'http:', 'https:', 'data:']) {
      assert.ok(!scriptSrc.includes(unsafe), `script-src must not contain ${unsafe}`);
    }
    assert.deepEqual(policy['script-src-attr'], ["'none'"], 'no inline event handlers');
    assert.ok(!policy['style-src-elem'].includes("'unsafe-inline'"), 'no inline <style>');
    assert.deepEqual(policy['object-src'], ["'none'"]);
    assert.deepEqual(policy['frame-ancestors'], ["'none'"]);

    // Every inline script in the page is allowed by its exact hash, and those
    // are only the server's import map and build id.
    const html = await res.text();
    const { document } = new JSDOM(html).window;
    // The <meta> copy (for GitHub Pages) is dropped: the header is the policy,
    // and a second copy without the hashes would fight it.
    assert.equal(document.querySelector('meta[http-equiv="Content-Security-Policy"]'), null);
    const inline = [...document.querySelectorAll('script:not([src])')];
    assert.equal(inline.length, 2, 'only the injected import map and build id');
    assert.equal(inline[0].getAttribute('type'), 'importmap');
    assert.match(inline[1].textContent, /^window\.__VAULT_BUILD__=/);
    const hashes = scriptSrc.filter(s => s.startsWith("'sha256-"));
    assert.equal(hashes.length, 2);
    for (const script of inline) {
      const hash = `'sha256-${crypto.createHash('sha256').update(script.textContent, 'utf8').digest('base64')}'`;
      assert.ok(hashes.includes(hash), `hash for ${script.textContent.slice(0, 40)}`);
    }
  }

  // Other pages get the same policy with no inline allowances at all.
  const landing = await fetch(`${base}/landing.html`);
  assert.equal(landing.status, 200);
  const landingPolicy = parsePolicy(landing.headers.get('content-security-policy'));
  assert.deepEqual(landingPolicy['script-src'], ["'self'", 'https://accounts.google.com']);
});

test("index.html's <meta> policy matches the server's header", async () => {
  const { document } = new JSDOM(fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8')).window;
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  assert.ok(meta, 'the GitHub Pages copy has a policy too');
  const fromMeta = parsePolicy(meta.getAttribute('content'));
  const header = parsePolicy((await fetch(`${base}/landing.html`)).headers.get('content-security-policy'));
  delete header['frame-ancestors']; // not allowed in <meta>; the server sends it
  assert.deepEqual(fromMeta, header);
});
