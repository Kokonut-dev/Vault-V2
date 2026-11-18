/**
 * "Move to another server" in the browser: the real modules in jsdom against
 * a fake /api — the settings section measures the library, the download link
 * is absolute (works on another device), and an import that fails explains
 * itself next to the right field.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><main id="view-container"></main></body></html>', {
  url: 'https://kokonut-dev.github.io/Vault-V2/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`) };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.VAULT_CONFIG = { apiBaseUrl: 'https://vault.example.test', basePath: '/Vault-V2' };
localStorage.setItem('vault_token', 'test-token');

const calls = [];
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, options = {}) => {
  const u = new URL(url);
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({ method: options.method || 'GET', path: u.pathname, query: u.search, body });
  if (u.pathname === '/api/transfer') {
    return json(200, { setupMode: false, job: null, defaults: { mediaDir: '/Users/sam/Vault/media', exportDir: '/Users/sam/Desktop' }, pendingImport: false });
  }
  if (u.pathname === '/api/transfer/summary') {
    const media = u.searchParams.get('media') === '1';
    return json(200, {
      includesMedia: media,
      zipBytes: media ? 5 * 1024 ** 3 : 2 * 1024 ** 2,
      counts: { libraryItems: 321, mediaFiles: media ? 300 : 0 },
      roots: [{ label: 'Movies', files: 120, bytes: 4 * 1024 ** 3 }, { label: 'Music', files: 180, bytes: 1024 ** 3 }],
    });
  }
  if (u.pathname === '/api/transfer/export-link') {
    return json(200, { url: '/api/transfer/download/abc123abc123abc123abc123', fileName: 'Vault transfer - 2026-11-18.zip', expiresAt: Date.now() + 7200000 });
  }
  if (u.pathname === '/api/transfer/inspect') {
    return json(400, { error: 'There’s no file or folder at /Users/sam/old.zip', code: 'NOT_FOUND', field: 'source' });
  }
  return json(404, { error: 'Not found' });
};

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));

test('settings section measures the library on first view and offers an absolute download link', async () => {
  const { transferSection } = await import(docs('views', 'settings', 'transfer.js'));
  const node = transferSection();
  node.hidden = true;
  document.body.append(node);
  await tick();
  assert.equal(calls.filter(c => c.path === '/api/transfer/summary').length, 0, 'nothing measured while hidden');

  node.hidden = false;
  await tick(60);
  const summary = node.querySelector('#tx-summary').textContent;
  assert.match(summary, /5(\.0)? GB/);
  assert.match(summary, /321 library items/);
  assert.match(summary, /Movies \(120 files/);

  // Switching to settings-only re-measures without media.
  const settingsOnly = node.querySelector('input[name="tx-what"][value="data"]');
  settingsOnly.checked = true;
  settingsOnly.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(40);
  assert.ok(calls.some(c => c.path === '/api/transfer/summary' && c.query === '?media=0'));
  assert.match(node.querySelector('#tx-summary').textContent, /No media files/);

  // Copy link → absolute URL on the server, so it opens on the new computer.
  node.querySelector('#tx-copy-link').click();
  await tick(40);
  const field = node.querySelector('#tx-report input');
  assert.equal(field.value, 'https://vault.example.test/api/transfer/download/abc123abc123abc123abc123');
  const linkCall = calls.find(c => c.path === '/api/transfer/export-link');
  assert.deepEqual(linkCall.body, { media: false });
  assert.match(node.querySelector('#tx-report').textContent, /2 hours/);
  node.remove();
});

test('import explains a missing package next to the path field', async () => {
  const { mountImport } = await import(docs('components', 'transferPanel.js'));
  const box = document.createElement('div');
  document.body.append(box);
  mountImport(box, { setupMode: true });
  await tick(40);
  const mediaDir = box.querySelector('#tr-media-dir');
  assert.equal(mediaDir.value, '/Users/sam/Vault/media', 'defaults to this server’s media folder');
  const pathMode = box.querySelector('input[name="tr-source"][value="path"]');
  pathMode.checked = true;
  pathMode.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(box.querySelector('[data-pane="path"]').hidden, false);
  const source = box.querySelector('#tr-path');
  source.value = '/Users/sam/old.zip';
  box.querySelector('#tr-check').click();
  await tick(40);
  assert.equal(source.getAttribute('aria-invalid'), 'true');
  assert.match(box.querySelector('#tr-path-error').textContent, /no file or folder at \/Users\/sam\/old\.zip/);
  source.value = '/Users/sam/old2.zip';
  source.dispatchEvent(new window.Event('input'));
  assert.equal(source.hasAttribute('aria-invalid'), false, 'typing clears the error');
  box.remove();
});
