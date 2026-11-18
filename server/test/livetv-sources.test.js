/**
 * Several Live TV channel lists.
 *
 * Before: Live TV took exactly one M3U link and one guide; adding a second
 * provider meant replacing the first. Now `livetv.sources[]` adds more lists
 * next to the original one, each with its own guide, on/off switch and
 * streams-at-once cap; channels are grouped by list and one list failing
 * doesn't hide the others. The original list's channel ids are unchanged so
 * favourites and recordings keep pointing at the right channel.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const express = require('express');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-livetv-sources-'));
const file = (name, text) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
};

const MAIN_M3U = file('main.m3u', `#EXTM3U
#EXTINF:-1 tvg-id="npo1.nl" group-title="NL",NPO 1
http://93.184.216.34/npo1.ts
#EXTINF:-1 tvg-id="npo2.nl" group-title="NL",NPO 2
http://93.184.216.34/npo2.ts
`);
const SPORT_M3U = file('sport.m3u', `#EXTM3U
#EXTINF:-1 tvg-id="espn.us" tvg-chno="2" group-title="Sport",ESPN
http://93.184.216.34/espn.ts
#EXTINF:-1 tvg-id="npo1.nl" tvg-chno="1" group-title="NL",NPO 1 HD
http://93.184.216.34/npo1hd.ts
`);
const MAIN_EPG = file('main.xml', `<?xml version="1.0"?><tv>
<programme start="20261118200000 +0000" stop="20261118210000 +0000" channel="npo1.nl"><title>Journaal</title></programme>
</tv>`);
const SPORT_EPG = file('sport.xml', `<?xml version="1.0"?><tv>
<programme start="20261118200000 +0000" stop="20261118210000 +0000" channel="npo1.nl"><title>Journaal</title></programme>
<programme start="20261118200000 +0000" stop="20261118230000 +0000" channel="espn.us"><title>Football</title></programme>
</tv>`);

// In-memory config: nothing touches server/config.json.
const configModule = require('../config');
let stored = structuredClone(configModule.DEFAULT_CONFIG);
stored.livetv = { ...stored.livetv, enabled: true, m3uUrl: MAIN_M3U, epgUrl: MAIN_EPG };
configModule.getConfig = () => stored;
configModule.saveConfig = (next) => { stored = structuredClone(next); };

const livetv = require('../services/livetv');
const restream = require('../services/restream');

test.after(() => fs.removeSync(dir));

test('old single-list configs keep working, with the same channel ids', async () => {
  const channels = await livetv.loadChannels({ fresh: true });
  assert.deepEqual(channels.map(c => c.id), livetv.parseM3U(fs.readFileSync(MAIN_M3U, 'utf8')).map(c => c.id));
  assert.match(channels[0].id, /^ch_0_/);
  assert.ok(channels.every(c => c.sourceId === 'main' && c.sourceName === 'Main list'));
  const settings = livetv.publicSettings();
  assert.deepEqual(settings.sources, []);
  assert.equal(settings.m3u.configured, true);
});

test('adding a second list: validation, channels grouped by list, links never echoed back', async () => {
  assert.throws(() => livetv.addSource({ m3uUrl: SPORT_M3U }), err => Boolean(err.fields?.name));
  assert.throws(() => livetv.addSource({ name: 'Sport' }), err => Boolean(err.fields?.m3uUrl));
  assert.throws(() => livetv.addSource({ name: 'Sport', m3uUrl: 'ftp://nope' }), err => Boolean(err.fields?.m3uUrl));

  const settings = livetv.addSource({ name: 'Sport', m3uUrl: SPORT_M3U, epgUrl: SPORT_EPG, maxStreams: 1 });
  assert.equal(settings.sources.length, 1);
  const [sport] = settings.sources;
  assert.match(sport.id, /^s[0-9a-f]{8}$/);
  assert.equal(sport.maxStreams, 1);
  assert.equal(sport.m3u.configured, true);
  assert.ok(!JSON.stringify(settings).includes(SPORT_M3U), 'the saved link is never sent back');

  const channels = await livetv.loadChannels({ fresh: true });
  assert.deepEqual(channels.map(c => c.name), ['NPO 1', 'NPO 2', 'NPO 1 HD', 'ESPN'], 'main list first; each list sorted by its own numbers');
  const extra = channels.filter(c => c.sourceId === sport.id);
  assert.ok(extra.every(c => c.id.startsWith(`ch_${sport.id}_`)), 'extra-list ids are namespaced');
  assert.equal(new Set(channels.map(c => c.id)).size, channels.length, 'no id collisions between lists');
  assert.equal(extra[0].sourceName, 'Sport');
  assert.equal(extra[0].sourceMaxStreams, 1);
  assert.deepEqual(livetv.getSourceStatus().map(s => [s.name, s.count, s.error]), [['Main list', 2, null], ['Sport', 2, null]]);
});

test('guides from every list are merged without duplicates', async () => {
  const epg = await livetv.getEpg(true);
  const titles = epg.programs.map(p => `${p.channel}:${p.title}`).sort();
  assert.deepEqual(titles, ['espn.us:Football', 'npo1.nl:Journaal']);
});

test('a list that fails to load is reported, the others still show', async () => {
  const [sport] = livetv.publicSettings().sources;
  livetv.updateSource(sport.id, { m3uUrl: path.join(dir, 'gone.m3u') });
  const channels = await livetv.loadChannels({ fresh: true });
  assert.deepEqual(channels.map(c => c.name), ['NPO 1', 'NPO 2']);
  const status = livetv.getSourceStatus().find(s => s.id === sport.id);
  assert.equal(status.count, 0);
  assert.ok(status.error, 'error is recorded for the Live TV page');
  livetv.updateSource(sport.id, { m3uUrl: SPORT_M3U });
});

test('switching a list off hides its channels and guide; removing deletes it', async () => {
  const [sport] = livetv.publicSettings().sources;
  livetv.updateSource(sport.id, { enabled: false });
  assert.deepEqual((await livetv.loadChannels({ fresh: true })).map(c => c.sourceId), ['main', 'main']);
  assert.deepEqual((await livetv.getEpg(true)).programs.map(p => p.channel), ['npo1.nl']);

  livetv.updateSource(sport.id, { enabled: true, name: '  Sport+ ' });
  assert.equal(livetv.publicSettings().sources[0].name, 'Sport+');
  assert.throws(() => livetv.updateSource('nope', { name: 'x' }), err => err.status === 404);

  livetv.removeSource(sport.id);
  assert.deepEqual(livetv.publicSettings().sources, []);
  assert.equal(stored.livetv.m3uUrl, MAIN_M3U, 'removing an extra list leaves the main one alone');
});

test('a list can be the only one (no main link) and Test/adopt-guide work per list', async () => {
  const settings = livetv.addSource({ name: 'Sport', m3uUrl: SPORT_M3U });
  const id = settings.sources[0].id;
  stored.livetv.m3uUrl = '';
  assert.deepEqual((await livetv.loadChannels({ fresh: true })).map(c => c.name), ['NPO 1 HD', 'ESPN']);

  const report = await livetv.testSources({ sourceId: id });
  assert.equal(report.m3u.ok, true);
  assert.equal(report.m3u.channels, 2);
  await assert.rejects(livetv.testSources({ sourceId: 'nope' }), err => err.status === 404);

  // The list names its own guide in the header → adopting saves it on *that* list.
  fs.writeFileSync(SPORT_M3U, fs.readFileSync(SPORT_M3U, 'utf8').replace('#EXTM3U', '#EXTM3U url-tvg="https://epg.example.com/sport.xml"'));
  const after = await livetv.adoptPlaylistGuide({ sourceId: id });
  assert.equal(after.sources[0].epg.configured, true);
  assert.equal(stored.livetv.sources[0].epgUrl, 'https://epg.example.com/sport.xml');
  assert.equal(stored.livetv.epgUrl, MAIN_EPG, 'main guide untouched');
  livetv.removeSource(id);
  stored.livetv.m3uUrl = MAIN_M3U;
});

test('HTTP: /sources is admin-only and /channels lists the per-list status', async (t) => {
  const router = require('../routes/livetv');
  const app = express();
  app.use(express.json());
  const profiles = require('../services/profiles');
  const originalGet = profiles.get;
  profiles.get = id => (id === 'owner' ? { id, isAdmin: true } : { id, isAdmin: false });
  t.after(() => { profiles.get = originalGet; });
  app.use((req, _res, next) => {
    req.profileId = req.get('x-admin') === '1' ? 'owner' : 'kid';
    next();
  });
  app.use('/api/livetv', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/livetv`;
  const json = { 'Content-Type': 'application/json' };

  const denied = await fetch(`${base}/sources`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'X', m3uUrl: SPORT_M3U }) });
  assert.equal(denied.status, 403);

  const bad = await fetch(`${base}/sources`, { method: 'POST', headers: { ...json, 'x-admin': '1' }, body: JSON.stringify({ m3uUrl: SPORT_M3U }) });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).fields.name);

  const created = await fetch(`${base}/sources`, { method: 'POST', headers: { ...json, 'x-admin': '1' }, body: JSON.stringify({ name: 'Sport', m3uUrl: SPORT_M3U, maxStreams: 2 }) });
  assert.equal(created.status, 201);
  const { sources } = await created.json();

  const list = await (await fetch(`${base}/channels?refresh=true`)).json();
  assert.deepEqual(list.sources.map(s => s.name), ['Main list', 'Sport']);
  assert.ok(list.channels.every(c => c.url === undefined && c.sourceMaxStreams === undefined), 'stream links and caps stay on the server');
  assert.ok(list.channels.some(c => c.sourceName === 'Sport'));

  const removed = await fetch(`${base}/sources/${sources[0].id}`, { method: 'DELETE', headers: { 'x-admin': '1' } });
  assert.equal(removed.status, 200);
  assert.deepEqual((await removed.json()).sources, []);
});

test('streams-at-once cap per list: a busy list refuses, another list still plays', async (t) => {
  const fakeSession = (id, sourceId, ageMs = 0) => ({
    id, key: `${id}:auto`, sourceId, dir: path.join(dir, id), label: id, viewers: 1, exited: false, lastAccess: Date.now() - ageMs,
  });
  restream._sessions.set('a', fakeSession('a', 'sA'));
  t.after(() => restream._sessions.clear());
  const originalSpawn = restream.deps.spawn;
  // ffmpeg isn't installed here; a channel that gets past the cap fails at the probe instead.
  restream.deps.spawn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => proc.emit('error', Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' })));
    return proc;
  };
  t.after(() => { restream.deps.spawn = originalSpawn; });

  const channel = (id, sourceId) => ({ id, name: id, url: 'http://93.184.216.34/live.ts', sourceId, sourceName: 'Provider A', sourceMaxStreams: 1 });
  await assert.rejects(restream.start(channel('c2', 'sA')), (err) => {
    assert.equal(err.code, 'SOURCE_BUSY');
    assert.equal(err.status, 503);
    assert.match(err.message, /“Provider A” allows 1 stream at once/);
    return true;
  });
  await assert.rejects(restream.start(channel('c3', 'sB')), err => err.code !== 'SOURCE_BUSY');

  // An idle session (no viewer for 15 s+) from the same list is closed to make room.
  restream._sessions.set('a', fakeSession('a', 'sA', 60_000));
  await assert.rejects(restream.start(channel('c4', 'sA')), err => err.code !== 'SOURCE_BUSY');
  assert.ok(!restream._sessions.has('a'), 'the idle stream was closed');
});

test('Live TV page groups channels by list in list order', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:4000/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CustomEvent = dom.window.CustomEvent;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  const { groupBySource } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'docs', 'js', 'views', 'livetv.js')).href);
  const groups = groupBySource([
    { id: '1', sourceId: 'hdhr', sourceName: 'HDHomeRun' },
    { id: '2', sourceId: 'sX', sourceName: 'Sport' },
    { id: '3', sourceId: 'main', sourceName: 'Main list' },
    { id: '4', sourceId: 'sX', sourceName: 'Sport' },
  ], [{ id: 'main', name: 'Main list' }, { id: 'sX', name: 'Sport' }, { id: 'hdhr', name: 'HDHomeRun' }]);
  assert.deepEqual(groups.map(g => [g.name, g.channels.map(c => c.id)]), [['Main list', ['3']], ['Sport', ['2', '4']], ['HDHomeRun', ['1']]]);
  // Older servers: no sourceId → one unnamed group.
  assert.deepEqual(groupBySource([{ id: 'a' }, { id: 'b' }]).map(g => g.channels.length), [2]);
  dom.window.close();
});
