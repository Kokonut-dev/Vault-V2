/**
 * Torrents, end to end with the real engine on loopback.
 *
 * A local WebTorrent seeder shares a small "season" folder (with a sample
 * clip and an .exe mixed in); Vault adds its magnet link, lists the files with
 * sensible ones preselected, downloads into a hidden staging folder, then
 * moves the chosen files into the right library keeping the folder layout and
 * indexes them. Also covered: the off-by-default + acknowledgement gate, the
 * VPN guard, removal, and the HTTP route's input checks.
 *
 * No internet, DHT or trackers: peers are connected directly over 127.0.0.1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('fs-extra');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-torrents-'));
const media = { movies: path.join(root, 'movies'), music: path.join(root, 'music'), videos: path.join(root, 'videos') };
Object.values(media).forEach(p => fs.ensureDirSync(p));

const configModule = require('../config');
let stored = structuredClone(configModule.DEFAULT_CONFIG);
stored.media.paths = media;
configModule.getConfig = () => stored;
configModule.saveConfig = (next) => { stored = structuredClone(next); };

const events = require('../services/events');
const finished = [];
const realJobFinish = events.jobFinish;
events.jobFinish = (id, status, meta = {}) => {
  finished.push({ id, status, ...meta });
  return realJobFinish(id, status, meta);
};

const torrent = require('../services/torrent');
const LOCAL = { dht: false, tracker: false, lsd: false, natUpnp: false, natPmp: false, utp: false };
torrent.deps.clientOptions = LOCAL;
torrent.deps.stateFile = path.join(root, 'data', 'torrents.json');
torrent.deps.torrentDir = path.join(root, 'data', 'torrents');
const scanned = [];
torrent.deps.scanFile = async (p) => { scanned.push(p); return { id: `item${scanned.length}` }; };
let interfaces = { lo: [{ address: '127.0.0.1', internal: true }], eth0: [{ address: '192.168.1.5', internal: false }] };
torrent.deps.networkInterfaces = () => interfaces;

let seeder;
let seedPort;
// Connect every torrent Vault adds straight to the local seeder.
torrent.deps.onTorrent = (t) => t.once('infoHash', () => t.addPeer(`127.0.0.1:${seedPort}`));

test.after(async () => {
  await torrent.shutdown();
  await new Promise(r => (seeder ? seeder.destroy(r) : r()));
  fs.removeSync(root);
});

async function until(fn, ms = 20000, label = 'condition') {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}; jobs: ${JSON.stringify(torrent.list().map(j => [j.name, j.status, j.error]))}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

test('magnet parsing and library guess', () => {
  const hex = 'c9e15763f722f23e98a29decdfae341b98d53056';
  assert.equal(torrent.parseMagnet(`magnet:?xt=urn:btih:${hex}&dn=Cosmos`).infoHash, hex);
  assert.equal(torrent.parseMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}`).name, '');
  // Base32 form of the same hash.
  assert.equal(torrent.parseMagnet('magnet:?xt=urn:btih:ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW').infoHash, hex);
  for (const bad of ['', 'https://example.com/x.torrent', 'magnet:?dn=nohash', `magnet:?xt=urn:btih:${'z'.repeat(40)}`]) {
    assert.throws(() => torrent.parseMagnet(bad), err => err.status === 400 && Boolean(err.fields?.magnet), bad);
  }
  const f = (p, length) => ({ path: p, name: path.basename(p), length });
  assert.equal(torrent.guessType([f('A/01.flac', 30e6), f('A/02.flac', 30e6), f('A/video.mp4', 20e6)]), 'music');
  assert.equal(torrent.guessType([f('Show/Show.S01E01.mkv', 1e9), f('Show/Show.S01E02.mkv', 1e9)]), 'movie');
  assert.equal(torrent.guessType([f('Arrival (2016)/Arrival.2016.1080p.mkv', 4e9)]), 'movie');
  assert.equal(torrent.guessType([f('Clips/holiday.mp4', 1e8)]), 'video');
});

test('off by default; turning on needs the acknowledgement', async () => {
  assert.equal(torrent.settings().enabled, false);
  await assert.rejects(torrent.add({ magnet: 'magnet:?xt=urn:btih:c9e15763f722f23e98a29decdfae341b98d53056' }), err => err.code === 'TORRENTS_OFF');
  assert.throws(() => torrent.updateSettings({ enabled: true }), err => Boolean(err.fields?.acknowledged));
  assert.equal(torrent.updateSettings({ enabled: true, acknowledged: true }).enabled, true);
  assert.equal(stored.torrent.acknowledged, true, 'saved to config');
});

test('magnet → pick files → downloads into the right library with folders kept', async () => {
  // The "release" a friend would share.
  const src = path.join(root, 'seed', 'Severance S01');
  const episode = crypto.randomBytes(300 * 1024);
  fs.outputFileSync(path.join(src, 'Severance.S01E01.1080p.mkv'), episode);
  fs.outputFileSync(path.join(src, 'Severance.S01E01.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  fs.outputFileSync(path.join(src, 'Sample', 'severance.sample.mkv'), crypto.randomBytes(20 * 1024));
  fs.outputFileSync(path.join(src, 'Free Codecs.exe'), 'MZ');

  const { default: WebTorrent } = await import('webtorrent');
  seeder = new WebTorrent(LOCAL);
  const seeded = await new Promise((resolve, reject) => {
    seeder.on('error', reject);
    seeder.seed(src, { announce: [] }, resolve);
  });
  seedPort = seeder.torrentPort;

  const added = await torrent.add({ magnet: seeded.magnetURI, type: 'auto' });
  assert.equal(added.status, 'metadata');
  assert.equal(added.magnet, undefined, 'the magnet link is not echoed back');
  await until(() => torrent.list()[0]?.status === 'ready', 20000, 'file list');

  const job = torrent.list()[0];
  assert.equal(job.name, 'Severance S01');
  assert.equal(job.type, 'movie', 'auto-sorted to Movies & Series');
  const picked = Object.fromEntries(job.files.map(f => [path.basename(f.path), f.selected]));
  assert.deepEqual(picked, {
    'Severance.S01E01.1080p.mkv': true,
    'Severance.S01E01.en.srt': true,
    'severance.sample.mkv': false,
    'Free Codecs.exe': false,
  });
  // Duplicate magnet is refused.
  await assert.rejects(torrent.add({ magnet: seeded.magnetURI }), err => err.code === 'DUPLICATE');

  // Even if asked, an .exe is never downloaded.
  const exe = job.files.find(f => f.name.endsWith('.exe')).index;
  const chosen = job.files.filter(f => f.selected).map(f => f.index).concat(exe);
  const started = await torrent.start(job.id, { files: chosen });
  assert.ok(['downloading', 'moving', 'done'].includes(started.status));
  await until(() => torrent.list()[0]?.status === 'done', 30000, 'download');

  const show = path.join(media.movies, 'Severance S01');
  assert.ok(fs.readFileSync(path.join(show, 'Severance.S01E01.1080p.mkv')).equals(episode), 'identical bytes');
  assert.ok(fs.existsSync(path.join(show, 'Severance.S01E01.en.srt')), 'subtitle next to the episode');
  assert.ok(!fs.existsSync(path.join(show, 'Free Codecs.exe')));
  assert.ok(!fs.existsSync(path.join(show, 'Sample')));
  assert.deepEqual(scanned.map(p => path.basename(p)), ['Severance.S01E01.1080p.mkv'], 'only media is indexed');
  const done = torrent.list()[0];
  assert.deepEqual(done.library, ['item1']);
  assert.ok(!fs.existsSync(path.join(media.videos, torrent.STAGING_DIR, done.id)), 'staging cleaned up');
  assert.ok(finished.some(f => f.status === 'done' && f.imported === 1));

  // State survives a restart (saved to disk).
  await new Promise(r => setTimeout(r, 700));
  const saved = fs.readJsonSync(torrent.deps.stateFile);
  assert.equal(saved.jobs[0].status, 'done');

  // Removing a finished torrent keeps the library files.
  await torrent.remove(done.id);
  assert.equal(torrent.list().length, 0);
  assert.ok(fs.existsSync(path.join(show, 'Severance.S01E01.1080p.mkv')));
});

test('sharing after download: files reach the library right away (hard link) and "Stop sharing" cleans up', async () => {
  torrent.updateSettings({ seedRatio: 2 });
  const src = path.join(root, 'seed', 'Mixtape');
  const track = crypto.randomBytes(64 * 1024);
  fs.outputFileSync(path.join(src, '01 Intro.mp3'), track);
  fs.outputFileSync(path.join(src, '02 Outro.mp3'), crypto.randomBytes(64 * 1024));
  const seeded = await new Promise(resolve => seeder.seed(src, { announce: [] }, resolve));

  const job = await torrent.add({ magnet: seeded.magnetURI, type: 'auto' });
  await until(() => torrent.list().find(j => j.id === job.id)?.status === 'ready', 20000, 'file list');
  assert.equal(torrent.list().find(j => j.id === job.id).type, 'music');
  await torrent.start(job.id, {});
  await until(() => torrent.list().find(j => j.id === job.id)?.status === 'seeding', 30000, 'seeding');

  const inLibrary = path.join(media.music, 'Mixtape', '01 Intro.mp3');
  const staged = path.join(media.videos, torrent.STAGING_DIR, job.id, 'Mixtape', '01 Intro.mp3');
  assert.ok(fs.readFileSync(inLibrary).equals(track));
  assert.equal(fs.statSync(inLibrary).ino, fs.statSync(staged).ino, 'hard link: no second copy on disk');

  const stopped = await torrent.pause(job.id);
  assert.equal(stopped.status, 'done');
  assert.ok(!fs.existsSync(staged), 'staging removed');
  assert.ok(fs.readFileSync(inLibrary).equals(track), 'library copy untouched');
  await torrent.remove(job.id);
  torrent.updateSettings({ seedRatio: 0 });
});

test('scanner skips the staging folder', () => {
  const { isIgnored } = require('../utils/ignoreRules');
  assert.equal(isIgnored('.vault-downloads', [], '.vault-downloads'), true);
});

test('VPN guard: nothing starts without the interface; dropping it pauses, its return resumes', async () => {
  torrent.updateSettings({ requireInterface: 'wg0' });
  const magnet = `magnet:?xt=urn:btih:${crypto.randomBytes(20).toString('hex')}&dn=Nobody+seeds+this`;
  await assert.rejects(torrent.add({ magnet }), err => err.code === 'VPN_DOWN' && /wg0/.test(err.message));
  assert.equal(torrent.vpnStatus().up, false);

  interfaces = { ...interfaces, wg0: [{ address: '10.2.0.2', internal: false }] };
  const job = await torrent.add({ magnet });
  assert.equal(job.status, 'metadata');

  interfaces = { lo: interfaces.lo, eth0: interfaces.eth0 };
  torrent.checkVpn();
  assert.equal(torrent.list()[0].status, 'waiting-vpn');
  assert.equal((await torrent.status()).engine.running, false, 'engine stopped, every connection dropped');

  interfaces = { ...interfaces, wg0: [{ address: '10.2.0.2', internal: false }] };
  torrent.checkVpn();
  await until(() => torrent.list()[0].status === 'metadata', 5000, 'resume after VPN is back');
  assert.ok(torrent.listInterfaces().find(i => i.name === 'wg0').likelyVpn);

  await torrent.remove(job.id);
  torrent.updateSettings({ requireInterface: '' });
});

test('HTTP: input checks and status', async (t) => {
  const app = express();
  app.use(express.json());
  app.use('/api/torrents', require('../routes/torrents'));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/torrents`;

  const status = await (await fetch(base)).json();
  assert.equal(status.settings.enabled, true);
  assert.equal(status.engine.installed, true);
  assert.deepEqual(status.vpn, { required: false, interface: '', up: true });

  const bad = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ magnet: 'http://nope' }) });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).fields.magnet);

  const fd = new FormData();
  fd.append('torrent', new Blob(['not a torrent']), 'x.torrent');
  const badFile = await fetch(base, { method: 'POST', body: fd });
  assert.equal(badFile.status, 400);
  assert.match((await badFile.json()).error, /doesn’t look like a \.torrent/);

  const settings = await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxActive: 99, seedRatio: 1.25, requireInterface: 'bad name!' }) });
  assert.equal(settings.status, 400);
  assert.ok((await settings.json()).fields.requireInterface);
  const ok = await (await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxActive: 99, seedRatio: 1.25 }) })).json();
  assert.equal(ok.settings.maxActive, 10, 'clamped');
  assert.equal(ok.settings.seedRatio, 1.3);

  const off = await (await fetch(`${base}/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).json();
  assert.equal(off.settings.enabled, false);
  assert.equal(off.engine.running, false);
});
