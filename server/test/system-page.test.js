/**
 * The Server page (/system) in jsdom, fed the response shapes the real
 * /api/system routes send: the health cards show real numbers, Cancel in a
 * confirm dialog really cancels, logs filter, backups delete only after
 * confirming, services render agents/capabilities, and non-admins get a
 * clear message instead of broken buttons.
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
  const dom = new JSDOM('<!doctype html><html><body><main id="host"></main></body></html>', { url: 'http://localhost:4000/system', pretendToBeVisual: true });
  const w = dom.window;
  Object.assign(globalThis, { window: w, document: w.document, localStorage: w.localStorage, CustomEvent: w.CustomEvent, HTMLElement: w.HTMLElement, Node: w.Node, MutationObserver: w.MutationObserver });
  globalThis.CSS = w.CSS || { escape: s => String(s) };
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
  w.matchMedia = globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  return dom;
}

const GB = 1024 ** 3;

const healthReport = (over = {}) => ({
  generatedAt: new Date().toISOString(),
  totals: { items: 1234, missing: 2, duplicates: 1, missingArtwork: 0, unplayable: 0, trash: 3, orphanSidecars: 0 },
  missing: [{ id: 'a', title: 'Gone Movie', path: '/media/movies/gone.mkv' }, { id: 'b', title: 'Lost Song', path: '/media/music/lost.mp3' }],
  duplicates: [{ title: 'Twice', size: 1000, items: [{ id: 'c' }, { id: 'd' }], likelyDuplicate: true }],
  missingArtwork: [],
  unplayable: [],
  unknownCodecs: [],
  orphanSidecars: [],
  trash: [],
  deep: false,
  lastScan: { at: new Date(Date.now() - 2 * 3600e3).toISOString(), status: 'done', scanned: 1236, removed: 2, elapsed: 4.2 },
  scanning: false,
  index: { storage: 'json', sqliteAvailable: true, sqliteRows: 1234, dbBytes: 1, lastSync: null },
  ...over,
});

const diskReport = () => ({
  cache: { bytes: 50 * 1024 ** 2, files: 10, transcoded: 0, thumbnails: 0, covers: 0 },
  data: { bytes: 1000, files: 3 },
  trash: { bytes: 0, count: 0 },
  media: { bytes: 300 * GB, items: 1234 },
  host: {},
  volumes: [
    { labels: ['movies', 'music', 'Vault data'], path: '/media/movies', total: 1000 * GB, free: 400 * GB, used: 600 * GB },
    { labels: ['podcasts'], path: '/mnt/usb/podcasts', total: 100 * GB, free: 95 * GB, used: 5 * GB },
  ],
});

function stubApi(api, { admin = true } = {}) {
  const calls = [];
  api.getProfiles = async () => ({ profiles: [{ id: 'default', name: 'Owner', isAdmin: true }, { id: 'kid', name: 'Kid', isAdmin: false }], activeProfileId: admin ? 'default' : 'kid' });
  api.getLibraryHealth = async (deep) => { calls.push(['health', deep]); return healthReport({ deep: !!deep }); };
  api.getDisk = async () => diskReport();
  api.pruneMissing = async () => { calls.push(['prune']); return { removed: 2 }; };
  api.rebuildIndex = async () => { calls.push(['rebuild']); return { synced: 1234, sqliteAvailable: true }; };
  api.clearCaches = async () => { calls.push(['clear']); return { cleared: { transcoded: 3, thumbnails: 0 } }; };
  api.getJobs = async () => ({ jobs: [{ id: 'scan_1', kind: 'scan', label: 'Scanning library', total: 200, done: 50, status: 'running', startedAt: new Date().toISOString(), meta: {} }], clients: 2 });
  api.startBackgroundScan = async () => { calls.push(['scan']); return {}; };
  api.getLogs = async (limit) => ({ lines: [
    { at: '2026-11-18T10:00:00.000Z', level: 'info', line: 'Server started' },
    { at: '2026-11-18T10:01:00.000Z', level: 'warn', line: 'Slow disk' },
    { at: '2026-11-18T10:02:00.000Z', level: 'error', line: 'Transcode failed for x.mkv' },
  ].slice(0, limit) });
  api.getBackups = async () => ({ backups: [{ name: 'vault-backup-2026-11-18.zip', bytes: 2048, createdAt: '2026-11-18T09:00:00.000Z' }] });
  api.deleteBackup = async (name) => { calls.push(['delete-backup', name]); return {}; };
  api.restoreBackup = async (name) => { calls.push(['restore', name]); return {}; };
  api.getCapabilities = async () => ({ ffmpeg: true, version: 'ffmpeg version 7.1', hardware: [{ key: 'vaapi', label: 'VA-API' }], unusable: [], ffprobe: false, ffprobeVersion: null });
  api.getScrobbles = async () => ({ scrobbles: [{ title: 'Song A', artist: 'Band', playedAt: new Date().toISOString(), submitted: { lastfm: true, listenbrainz: false } }] });
  api.getAgents = async () => ({ providers: {
    tmdb: { enabled: false, requiresKey: true, switchedOn: false, hasKey: false },
    musicbrainz: { enabled: true, requiresKey: false, switchedOn: true, hasKey: false },
    nfo: { enabled: true, requiresKey: false, switchedOn: true, hasKey: false },
  } });
  api.setAgent = async (provider, body) => { calls.push(['agent', provider, body]); return {}; };
  api.getSubsonic = async () => {
    if (!admin) throw Object.assign(new Error('Only an admin profile can change server settings'), { status: 403, code: 'ADMIN_REQUIRED' });
    return { enabled: false, username: null };
  };
  api.setSubsonicPassword = async (password) => { calls.push(['subsonic', password]); return {}; };
  api.testNotifications = async () => { calls.push(['notify']); return { sent: 2, ok: 1, results: { ntfy: { ok: true }, discord: { ok: false, error: 'HTTP 401' } } }; };
  return calls;
}

const dialog = () => document.querySelector('.modal-backdrop');
const clickDialog = (which) => dialog().querySelector(`[id$="-${which}"]`).click();

test('health cards show the real report, and Cancel cancels', async () => {
  const dom = setupDom();
  try {
    const { api } = await import(docs('api.js'));
    const { renderSystem } = await import(docs('views', 'system.js'));
    const calls = stubApi(api);
    const host = document.getElementById('host');
    await renderSystem(host);

    const card = name => host.querySelector(`[data-stat="${name}"]`).textContent.replace(/\s+/g, ' ');
    assert.match(card('library'), /1,234/);
    assert.match(card('library'), /2 missing files/);
    assert.match(card('disk'), /400 GB/);
    assert.match(card('disk'), /600 GB used of 1000 GB/);
    assert.match(card('scan'), /2h ago/);
    assert.match(card('scan'), /1,236 files checked, 2 removed in 4\.2s/);
    assert.match(card('database'), /JSON files/);
    assert.match(card('database'), /1,234 rows in the search index/);
    // A second filesystem gets its own storage row.
    assert.match(host.textContent, /podcasts/);
    assert.match(host.textContent, /95 GB free of 100 GB/);

    const missing = host.querySelector('[data-check="Missing files"]');
    assert.ok(missing.classList.contains('error'));
    assert.match(missing.textContent, /2 library entries point at files that no longer exist/);
    assert.match(missing.textContent, /Gone Movie/);
    assert.ok(host.querySelector('[data-check="Duplicates"]').classList.contains('warn'));
    assert.ok(host.querySelector('[data-check="Artwork"]').classList.contains('ok'));
    // Tab icons sit next to their labels (label wrapped for the flex layout).
    assert.equal(host.querySelector('[data-tab="health"] span').textContent, 'Health');

    // Cancel must not prune (confirmDialog resolves an object, which used to
    // be treated as "yes").
    host.querySelector('#health-prune').click();
    await until(dialog, 2000, 'prune dialog');
    clickDialog('cancel');
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!calls.some(c => c[0] === 'prune'), 'cancel must not prune');

    host.querySelector('#health-prune').click();
    await until(dialog, 2000, 'prune dialog again');
    assert.match(dialog().textContent, /Remove entries/);
    clickDialog('ok');
    await until(() => calls.some(c => c[0] === 'prune'), 2000, 'pruned');

    // Deep check renders the deep report (sidecar check becomes real).
    await until(() => !host.querySelector('#health-prune')?.disabled, 2000, 'buttons back');
    host.querySelector('#health-deep').click();
    await until(() => calls.some(c => c[0] === 'health' && c[1] === true), 2000, 'deep fetch');
    await until(() => /No leftover subtitle or artwork files/.test(host.textContent), 2000, 'deep report');

    host.querySelector('#health-rebuild').click();
    await until(() => calls.some(c => c[0] === 'rebuild'), 2000, 'rebuild');
  } finally {
    dom.window.close();
  }
});

test('jobs, logs and backups', async () => {
  const dom = setupDom();
  try {
    const { api } = await import(docs('api.js'));
    const { renderSystem } = await import(docs('views', 'system.js'));
    const calls = stubApi(api);
    const host = document.getElementById('host');
    await renderSystem(host);

    host.querySelector('[data-tab="jobs"]').click();
    await until(() => host.querySelector('[data-job="scan_1"]'), 2000, 'job row');
    const job = host.querySelector('[data-job="scan_1"]');
    assert.match(job.textContent, /Scanning library/);
    assert.match(job.textContent, /50 of 200/);
    assert.equal(job.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '25');
    assert.ok(host.querySelector('#jobs-scan').disabled, 'no second scan while one runs');
    assert.match(host.textContent, /2 live connections/);
    assert.equal(host.querySelector('[data-tab="jobs"]').getAttribute('aria-selected'), 'true');

    host.querySelector('[data-tab="logs"]').click();
    await until(() => host.querySelectorAll('.log-row').length === 3, 2000, 'log rows');
    // Newest first.
    assert.match(host.querySelector('.log-row').textContent, /Transcode failed/);
    const level = host.querySelector('#logs-level');
    level.value = 'warn';
    level.dispatchEvent(new window.Event('change'));
    assert.equal(host.querySelectorAll('.log-row').length, 2);
    const search = host.querySelector('#logs-search');
    search.value = 'slow';
    search.dispatchEvent(new window.Event('input'));
    assert.equal(host.querySelectorAll('.log-row').length, 1);
    assert.match(host.querySelector('#logs-count').textContent, /Showing 1 of the last 3 lines/);

    host.querySelector('[data-tab="backups"]').click();
    await until(() => host.querySelector('[data-delete]'), 2000, 'backup row');
    assert.match(host.textContent, /2 KB/);
    host.querySelector('[data-delete]').click();
    await until(dialog, 2000, 'delete dialog');
    clickDialog('cancel');
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!calls.some(c => c[0] === 'delete-backup'), 'cancel must not delete');
    await until(() => !host.querySelector('[data-delete]').disabled, 2000, 'button re-enabled');
    host.querySelector('[data-delete]').click();
    await until(dialog, 2000, 'delete dialog again');
    clickDialog('ok');
    await until(() => calls.some(c => c[0] === 'delete-backup'), 2000, 'deleted');
    assert.deepEqual(calls.find(c => c[0] === 'delete-backup'), ['delete-backup', 'vault-backup-2026-11-18.zip']);

    host.querySelector('[data-restore]').click();
    await until(dialog, 2000, 'restore dialog');
    clickDialog('cancel');
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!calls.some(c => c[0] === 'restore'), 'cancel must not restore');
  } finally {
    dom.window.close();
  }
});

test('services: capabilities, agents, subsonic, notifications', async () => {
  const dom = setupDom();
  try {
    const { api } = await import(docs('api.js'));
    const { renderSystem } = await import(docs('views', 'system.js'));
    const calls = stubApi(api);
    const host = document.getElementById('host');
    await renderSystem(host);

    host.querySelector('[data-tab="services"]').click();
    await until(() => host.querySelector('[data-agent-row="tmdb"]'), 2000, 'services');
    assert.match(host.querySelector('[data-service="ffmpeg"]').textContent, /ffmpeg version 7\.1 · hardware: VA-API/);
    assert.ok(host.querySelector('[data-service="ffprobe"]').classList.contains('warn'));
    assert.match(host.querySelector('[data-agent-row="tmdb"]').textContent, /Off · no API key/);
    assert.match(host.querySelector('[data-agent-row="musicbrainz"]').textContent, /Active/);
    assert.match(host.textContent, /Song A — Band · just now · sent to Last\.fm/);

    // Adding a TMDb key goes through the app's modal, not window.prompt.
    host.querySelector('[data-agent-key="tmdb"]').click();
    await until(dialog, 2000, 'key modal');
    dialog().querySelector('input').value = '  0123456789abcdef  ';
    dialog().querySelector('[data-confirm]').click();
    await until(() => calls.some(c => c[0] === 'agent'), 2000, 'agent saved');
    assert.deepEqual(calls.find(c => c[0] === 'agent'), ['agent', 'tmdb', { apiKey: '0123456789abcdef', enabled: true }]);

    await until(() => host.querySelector('[data-agent-toggle="musicbrainz"]'), 2000, 'rerendered');
    const toggle = host.querySelector('[data-agent-toggle="musicbrainz"]');
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change'));
    await until(() => calls.some(c => c[0] === 'agent' && c[1] === 'musicbrainz'), 2000, 'toggle');
    assert.deepEqual(calls.at(-1), ['agent', 'musicbrainz', { enabled: false }]);

    // Subsonic: too-short passwords are refused inside the modal.
    await until(() => host.querySelector('#subsonic-set'), 2000, 'subsonic');
    host.querySelector('#subsonic-set').click();
    await until(dialog, 2000, 'subsonic modal');
    assert.equal(dialog().querySelector('input').type, 'password');
    dialog().querySelector('input').value = 'abc';
    dialog().querySelector('[data-confirm]').click();
    assert.match(dialog().textContent, /at least 6 characters/);
    dialog().querySelector('input').value = 'long-enough';
    dialog().querySelector('[data-confirm]').click();
    await until(() => calls.some(c => c[0] === 'subsonic'), 2000, 'subsonic saved');
    assert.deepEqual(calls.find(c => c[0] === 'subsonic'), ['subsonic', 'long-enough']);

    // A partly failing notification test says which target failed.
    const { toast } = await import(docs('components', 'toast.js'));
    const errors = [];
    toast.error = (message) => { errors.push(message); };
    await until(() => host.querySelector('#notify-test'), 2000, 'notify button');
    host.querySelector('#notify-test').click();
    await until(() => errors.length, 2000, 'notify result');
    assert.match(errors[0], /1 of 2 targets worked\. Failed: discord \(HTTP 401\)/);
  } finally {
    dom.window.close();
  }
});

test('non-admins see the report but get a clear message instead of admin controls', async () => {
  const dom = setupDom();
  try {
    const { api } = await import(docs('api.js'));
    const { renderSystem } = await import(docs('views', 'system.js'));
    const calls = stubApi(api, { admin: false });
    api.getLogs = async () => { calls.push(['logs']); return { lines: [] }; };
    const host = document.getElementById('host');
    await renderSystem(host);

    assert.match(host.querySelector('[data-stat="library"]').textContent, /1,234/);
    assert.equal(host.querySelector('#health-prune'), null);
    assert.match(host.textContent, /Only an admin profile can see and change this/);

    host.querySelector('[data-tab="logs"]').click();
    await until(() => /Only an admin profile/.test(host.querySelector('#system-body').textContent), 2000, 'logs note');
    assert.ok(!calls.some(c => c[0] === 'logs'), 'no doomed request');

    host.querySelector('[data-tab="services"]').click();
    await until(() => host.querySelector('[data-service="subsonic"]'), 2000, 'services');
    assert.match(host.querySelector('[data-service="subsonic"]').textContent, /Only an admin profile can see or change Subsonic access/);
    assert.equal(host.querySelector('#notify-test'), null);
    assert.equal(host.querySelector('[data-agent-toggle]'), null);
  } finally {
    dom.window.close();
  }
});

test('no caller treats confirmDialog’s result as a boolean', () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..', '..', 'docs', 'js');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && entry.name !== 'confirmDialog.js') {
        const src = fs.readFileSync(full, 'utf8');
        // `const ok = await confirmDialog(...)` / `if (!await confirmDialog(...))`
        // are always truthy: it resolves to { confirmed, checked }.
        const pattern = /(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*await\s+confirmDialog\()|(?:!\s*\(?\s*await\s+confirmDialog\()/g;
        if (pattern.test(src)) offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
