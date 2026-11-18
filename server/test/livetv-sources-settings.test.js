/**
 * Settings → Live TV → "More channel lists", driven in jsdom against the real
 * module: add a list (with inline validation), switch it off, remove it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const docs = (...p) => pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', ...p)).href;

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 15));
  }
}

test('add, validate, switch off and remove an extra channel list', async () => {
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', { url: 'http://localhost:4000/settings', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document, localStorage: w.localStorage, CustomEvent: w.CustomEvent, HTMLElement: w.HTMLElement, Node: w.Node, CSS: w.CSS || { escape: s => String(s).replace(/"/g, '\\"') }, MutationObserver: w.MutationObserver });
  if (!w.CSS) w.CSS = globalThis.CSS;
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

  try {
    const { api } = await import(docs('api.js'));
    const { liveTvSection } = await import(docs('views', 'settings', 'server.js'));

    let state = { enabled: true, hdhrDiscover: false, m3u: { configured: true, hint: 'provider.example/…' }, epg: { configured: false, hint: '' }, mainName: '', mainMaxStreams: 0, sources: [], canEdit: true };
    const calls = [];
    api.addLiveTvSource = async (body) => {
      calls.push(['add', body]);
      if (!body.m3uUrl.startsWith('http')) throw Object.assign(new Error('Some fields need fixing'), { fields: { m3uUrl: 'Use an http(s) link' } });
      state = { ...state, sources: [{ id: 's1', name: body.name, enabled: true, maxStreams: body.maxStreams, m3u: { configured: true, hint: 'sport.example/…' }, epg: { configured: false, hint: '' } }] };
      return state;
    };
    api.updateLiveTvSource = async (id, body) => {
      calls.push(['update', id, body]);
      state = { ...state, sources: state.sources.map(s => (s.id === id ? { ...s, ...body } : s)) };
      return state;
    };
    api.removeLiveTvSource = async (id) => {
      calls.push(['remove', id]);
      state = { ...state, sources: [] };
      return state;
    };

    const ctx = {
      liveTv: async () => state,
      setLiveTv: (next) => { state = next; },
      onLiveTvRerender: () => {},
      select: () => {},
    };
    const node = liveTvSection(ctx);
    document.getElementById('host').append(node);
    await until(() => node.querySelector('#ltv-add-source'));
    assert.match(node.textContent, /No other lists yet/);
    assert.ok(node.querySelector('#ltv-main-name'), 'main list can be named');
    assert.equal(node.querySelector('#ltv-main-max').value, '0');

    node.querySelector('#ltv-add-source').click();
    const form = node.querySelector('.ltv-source-form');
    assert.ok(form);
    // Name missing → inline error, nothing sent.
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    assert.equal(calls.length, 0);
    assert.equal(form.querySelector('#ltv-src-name').getAttribute('aria-invalid'), 'true');

    form.querySelector('#ltv-src-name').value = 'Sport';
    form.querySelector('#ltv-src-m3u').value = 'https://sport.example/get.php?type=m3u_plus';
    form.querySelector('#ltv-src-max').value = '2';
    form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => node.querySelector('[data-source-id="s1"]'));
    assert.deepEqual(calls[0], ['add', { name: 'Sport', maxStreams: 2, m3uUrl: 'https://sport.example/get.php?type=m3u_plus' }]);
    assert.ok(node.querySelector('.ltv-source-editor').hidden, 'editor closes after saving');
    assert.match(node.querySelector('[data-source-id="s1"]').textContent, /Sport[\s\S]*2 streams at once/);

    const toggle = node.querySelector('[data-source-id="s1"] [data-toggle]');
    toggle.checked = false;
    toggle.dispatchEvent(new w.Event('change'));
    await until(() => node.querySelector('[data-source-id="s1"]')?.classList.contains('is-off'));
    assert.deepEqual(calls[1], ['update', 's1', { enabled: false }]);

    node.querySelector('[data-source-id="s1"] [data-remove]').click();
    await until(() => document.querySelector('.modal .btn-danger'));
    assert.match(document.querySelector('.modal').textContent, /Remove “Sport”\?/);
    document.querySelector('.modal .btn-danger').click();
    await until(() => calls.some(c => c[0] === 'remove'));
    await until(() => /No other lists yet/.test(node.textContent));
  } finally {
    w.close();
  }
});
