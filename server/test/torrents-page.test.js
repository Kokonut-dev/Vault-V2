/**
 * The Torrents page in jsdom: turn on (acknowledgement required), add a
 * magnet, pick files (choices survive live refreshes), start, and the
 * admin-only message.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;

async function until(fn, ms = 4000, label = '') {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out ${label}`);
    await new Promise(r => setTimeout(r, 15));
  }
}

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', { url: 'http://localhost:4000/torrents', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document, localStorage: w.localStorage, CustomEvent: w.CustomEvent, HTMLElement: w.HTMLElement, Node: w.Node, MutationObserver: w.MutationObserver });
  globalThis.CSS = w.CSS || { escape: s => String(s) };
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  return dom;
}

const baseState = (over = {}) => ({
  settings: { enabled: false, acknowledged: false, maxActive: 3, downloadLimitKBs: 0, uploadLimitKBs: 0, seedRatio: 0, requireInterface: '', upnp: false, dht: true, ...over },
  engine: { installed: true, running: false, error: null },
  vpn: { required: false, interface: '', up: true },
  jobs: [],
});

test('turn on, add, pick files, start', async () => {
  const dom = setupDom();
  try {
    const { api } = await import(docs('api.js'));
    const { renderTorrents, describeJob, formatEta } = await import(docs('views', 'torrents.js'));
    let state = baseState();
    const calls = [];
    api.getTorrents = async () => structuredClone(state);
    api.getTorrentInterfaces = async () => ({ interfaces: [{ name: 'eth0', addresses: ['192.168.1.5'], likelyVpn: false }, { name: 'wg0', addresses: ['10.2.0.2'], likelyVpn: true }] });
    api.updateTorrentSettings = async (body) => {
      calls.push(['settings', body]);
      state.settings = { ...state.settings, ...body };
      return structuredClone(state);
    };
    api.addTorrent = async (source, type) => {
      calls.push(['add', source, type]);
      state.jobs = [{
        id: 'j1', name: 'Night of the Living Dead (1968)', status: 'ready', type: 'movie', suggestedType: 'movie',
        files: [
          { index: 0, path: 'NOTLD/Night.of.the.Living.Dead.1968.mp4', name: 'Night.of.the.Living.Dead.1968.mp4', length: 734003200, kind: 'video', selected: true },
          { index: 1, path: 'NOTLD/Night.of.the.Living.Dead.1968.srt', name: 'x.srt', length: 80000, kind: 'sidecar', selected: true },
          { index: 2, path: 'NOTLD/__ia_thumb.jpg', name: '__ia_thumb.jpg', length: 9000, kind: 'sidecar', selected: true },
        ],
      }];
      return { job: { id: 'j1', name: 'Fetching details…', status: 'metadata' } };
    };
    api.startTorrent = async (id, body) => {
      calls.push(['start', id, body]);
      Object.assign(state.jobs[0], { status: 'downloading', progress: 0.42, downloadedBytes: 308e6, selectedBytes: 734e6, downloadSpeed: 2.5e6, peers: 7, eta: 170 });
      return { job: state.jobs[0] };
    };

    const host = document.getElementById('host');
    await renderTorrents(host);
    assert.match(host.textContent, /Only download what you have the right to/);
    await until(() => host.querySelector('#tj-vpn option[value="wg0"]'), 2000, 'interfaces');
    assert.match(host.querySelector('#tj-vpn option[value="wg0"]').textContent, /looks like a VPN/);

    // Not acknowledged → inline error, nothing sent.
    host.querySelector('#tj-enable').click();
    assert.equal(calls.length, 0);
    assert.equal(host.querySelector('#tj-ack').getAttribute('aria-invalid'), 'true');

    host.querySelector('#tj-ack').checked = true;
    host.querySelector('#tj-vpn').value = 'wg0';
    host.querySelector('#tj-enable').click();
    await until(() => host.querySelector('#tj-add-form'), 2000, 'main view');
    assert.deepEqual(calls[0], ['settings', { enabled: true, acknowledged: true, requireInterface: 'wg0' }]);

    // Client-side check before anything is sent.
    host.querySelector('#tj-magnet').value = 'https://example.com/file.torrent';
    host.querySelector('#tj-add-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    assert.match(host.querySelector('#tj-add-error').textContent, /start with “magnet:\?”/);
    assert.equal(calls.length, 1);

    host.querySelector('#tj-magnet').value = 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056';
    host.querySelector('#tj-add-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await until(() => host.querySelector('[data-job="j1"] .tj-picker'), 2000, 'picker');
    assert.deepEqual(calls[1], ['add', 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056', 'auto']);
    const card = host.querySelector('[data-job="j1"]');
    assert.match(card.querySelector('[data-act="start"]').textContent, /Download 3 files \(700/);

    // Untick the thumbnail, then a live refresh arrives: the choice stays.
    const thumb = card.querySelector('[data-file="2"]');
    thumb.checked = false;
    thumb.dispatchEvent(new window.Event('change'));
    window.dispatchEvent(new window.CustomEvent('vault:torrents-changed'));
    await new Promise(r => setTimeout(r, 250));
    assert.equal(host.querySelector('[data-job="j1"]'), card, 'card not rebuilt');
    assert.equal(card.querySelector('[data-file="2"]').checked, false);
    assert.match(card.querySelector('[data-act="start"]').textContent, /Download 2 files/);

    card.querySelector('select').value = 'video';
    card.querySelector('[data-act="start"]').click();
    await until(() => host.querySelector('[data-job="j1"]')?.dataset.status === 'downloading', 2000, 'downloading');
    assert.deepEqual(calls[2], ['start', 'j1', { files: [0, 1], type: 'video' }]);
    const status = host.querySelector('[data-job="j1"] .tj-job-status').textContent;
    assert.match(status, /^42% · 294 MB of 700 MB · 2\.4 MB\/s · 7 peers · 3 min left$/);
    assert.equal(host.querySelector('[data-job="j1"] .tj-progress').getAttribute('aria-valuenow'), '42');
    assert.ok(host.querySelector('[data-job="j1"] [data-act="pause"]'));

    assert.equal(formatEta(30), 'less than a minute left');
    assert.equal(formatEta(3 * 3600 + 120), '3 h 2 min left');
    assert.match(describeJob({ status: 'waiting-vpn' }), /waiting for the VPN/);
  } finally {
    dom.window.close();
  }
});

test('non-admins get a clear message', async () => {
  const dom = setupDom();
  try {
    const { api } = await import(docs('api.js'));
    const { renderTorrents } = await import(docs('views', 'torrents.js'));
    api.getTorrents = async () => { throw Object.assign(new Error('Only an admin profile can change server settings'), { status: 403 }); };
    const host = document.getElementById('host');
    await renderTorrents(host);
    assert.match(host.textContent, /Only an admin profile can use torrents/);
  } finally {
    dom.window.close();
  }
});
