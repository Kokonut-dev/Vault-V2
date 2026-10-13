/**
 * PWA shell regression tests.
 *
 * The v3 worker served shell files cache-first forever. That let a newly
 * deployed detail.js run beside an old api.js, so album/playlist reordering
 * failed with "... is not a function" until site data was manually cleared.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', '..', 'docs', 'sw.js');
const ORIGIN = 'https://kokonut-dev.github.io';
const CURRENT_CACHE = 'vault-v2-shell-v4';

function keyFor(request) {
  const raw = typeof request === 'string' ? request : request.url;
  return new URL(raw, ORIGIN).href;
}

class MemoryCache {
  constructor(network) {
    this.network = network;
    this.entries = new Map();
  }

  async match(request) {
    const response = this.entries.get(keyFor(request));
    return response ? response.clone() : undefined;
  }

  async put(request, response) {
    this.entries.set(keyFor(request), response.clone());
  }

  async addAll(requests) {
    const fetched = await Promise.all(requests.map(request => this.network(request)));
    await Promise.all(fetched.map((response, index) => this.put(requests[index], response)));
  }
}

function createHarness() {
  const handlers = {};
  const stores = new Map();
  let network = async () => new Response('network', { status: 200 });

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new MemoryCache(request => network(request)));
      return stores.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
    async match(request) {
      for (const cache of stores.values()) {
        const response = await cache.match(request);
        if (response) return response;
      }
      return undefined;
    },
  };

  const self = {
    location: { origin: ORIGIN },
    clients: { claim() {} },
    skipWaiting() {},
    addEventListener(type, handler) {
      handlers[type] = handler;
    },
  };

  const context = {
    self,
    caches,
    Request,
    Response,
    URL,
    console: { log() {}, warn() {} },
    fetch: request => network(request),
  };
  vm.runInNewContext(fs.readFileSync(SW_PATH, 'utf8'), context, { filename: SW_PATH });

  return {
    handlers,
    stores,
    caches,
    setNetwork(fn) { network = fn; },
    async dispatchFetch(url) {
      let responsePromise;
      handlers.fetch({
        request: new Request(url),
        respondWith(value) { responsePromise = Promise.resolve(value); },
      });
      assert.ok(responsePromise, `worker did not handle ${url}`);
      return responsePromise;
    },
    async dispatchActivate() {
      let work;
      handlers.activate({ waitUntil(value) { work = Promise.resolve(value); } });
      await work;
    },
  };
}

test('shell assets use the deployed module and refresh the cached copy', async () => {
  const harness = createHarness();
  const requestUrl = `${ORIGIN}/Vault-V2/js/api.js`;
  const shell = await harness.caches.open(CURRENT_CACHE);
  await shell.put(requestUrl, new Response('old api client'));
  let requestCacheMode = null;
  harness.setNetwork(async request => {
    requestCacheMode = request.cache;
    return new Response('new api client', { status: 200 });
  });

  const response = await harness.dispatchFetch(requestUrl);
  assert.equal(await response.text(), 'new api client', 'a stale shell response won over the network');
  assert.equal(requestCacheMode, 'no-cache', 'shell fetch did not revalidate the browser HTTP cache');
  assert.equal(await (await shell.match(requestUrl)).text(), 'new api client', 'fresh response was not cached');
});

test('a failed deployment response falls back to the last good shell', async () => {
  const harness = createHarness();
  const requestUrl = `${ORIGIN}/Vault-V2/js/api.js`;
  const shell = await harness.caches.open(CURRENT_CACHE);
  await shell.put(requestUrl, new Response('last good api client'));
  harness.setNetwork(async () => new Response('temporary 503', { status: 503 }));

  const response = await harness.dispatchFetch(requestUrl);
  assert.equal(await response.text(), 'last good api client');
});

test('shell assets still work offline from the last successful cache', async () => {
  const harness = createHarness();
  const requestUrl = `${ORIGIN}/Vault-V2/js/api.js`;
  const shell = await harness.caches.open(CURRENT_CACHE);
  await shell.put(requestUrl, new Response('offline api client'));
  harness.setNetwork(async () => { throw new Error('offline'); });

  const response = await harness.dispatchFetch(requestUrl);
  assert.equal(await response.text(), 'offline api client');
});

test('activation removes old Vault shells without deleting offline media', async () => {
  const harness = createHarness();
  await harness.caches.open('vault-v2-shell-v3');
  await harness.caches.open(CURRENT_CACHE);
  await harness.caches.open('vault-offline');
  await harness.caches.open('some-other-app');

  await harness.dispatchActivate();
  const names = await harness.caches.keys();
  assert.equal(names.includes('vault-v2-shell-v3'), false, 'old shell survived activation');
  assert.equal(names.includes(CURRENT_CACHE), true, 'current shell was deleted');
  assert.equal(names.includes('vault-offline'), true, 'downloaded media cache was deleted');
  assert.equal(names.includes('some-other-app'), true, 'an unrelated cache was deleted');
});
