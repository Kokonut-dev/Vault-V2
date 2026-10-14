/**
 * Browser API-client regressions that are easiest to exercise in jsdom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const API_URL = pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', 'api.js')).href;

test('concurrent identical library refreshes share a request instead of aborting one another', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://kokonut-dev.github.io/Vault-V2/',
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.CustomEvent = dom.window.CustomEvent;
  window.VAULT_CONFIG = {
    apiBaseUrl: 'https://vault.example.test',
    basePath: '/Vault-V2',
  };

  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let fetchCalls = 0;
  globalThis.fetch = async (_url, options = {}) => {
    fetchCalls += 1;
    // Pin the old failure mode: the first request listened to this signal and
    // the second same-path GET aborted it. No internal abort should happen now.
    let aborted = false;
    options.signal?.addEventListener('abort', () => { aborted = true; });
    await gate;
    if (aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return new Response(JSON.stringify({ items: [{ id: 'track-1' }], totalPages: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { api } = await import(`${API_URL}?concurrency=${Date.now()}`);
  const first = api.getLibrary({ page: 1, limit: 1000 });
  const second = api.getLibrary({ page: 1, limit: 1000 });

  assert.equal(fetchCalls, 1, 'identical in-flight GETs were sent twice');
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.items, [{ id: 'track-1' }]);
  assert.deepEqual(b.items, [{ id: 'track-1' }]);

  dom.window.close();
});
