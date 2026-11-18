/**
 * Link features (Settings revamp SR-5/6/7): the SSRF-safe fetcher, the
 * link classifier/redactor, playlist matching and the Live TV M3U parser.
 * Everything runs against throwaway HTTP servers on 127.0.0.1 — no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');

const { safeFetchText, validateUrl, blockedReason, SafeFetchError } = require('../utils/safeFetch');
const links = require('../services/links');
const { parseM3U } = require('../services/livetv');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(r)) });
    });
  });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof SafeFetchError, `expected SafeFetchError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code, err.message);
    return true;
  });
}

// ---------------------------------------------------------------- validation

test('validateUrl accepts http(s) and rejects other schemes and junk', () => {
  assert.equal(validateUrl(' https://example.com/list.m3u ').hostname, 'example.com');
  assert.throws(() => validateUrl('ftp://example.com/a.m3u'), { code: 'BAD_SCHEME' });
  assert.throws(() => validateUrl('file:///etc/passwd'), { code: 'BAD_SCHEME' });
  assert.throws(() => validateUrl('javascript:alert(1)'), { code: 'BAD_SCHEME' });
  assert.throws(() => validateUrl('not a link'), { code: 'INVALID_URL' });
  assert.throws(() => validateUrl(''), { code: 'INVALID_URL' });
  assert.throws(() => validateUrl('http://metadata.google.internal/'), { code: 'BLOCKED_ADDRESS' });
});

test('blockedReason blocks metadata/link-local in every spelling, allows LAN by default', () => {
  for (const ip of [
    '169.254.169.254',         // cloud metadata
    '::ffff:169.254.169.254',  // IPv4-mapped
    '::ffff:a9fe:a9fe',        // mapped, hex form (how Node normalises it)
    '64:ff9b::a9fe:a9fe',      // NAT64
    '0.0.0.0',
    'fe80::1',                 // IPv6 link-local
    'ff02::1',                 // multicast
    'fd00:ec2::254',           // AWS IPv6 metadata
    '224.0.0.1',
  ]) {
    assert.ok(blockedReason(ip), `${ip} should be blocked`);
  }
  // Home IPTV middleware (Threadfin, xTeVe, tvheadend) lives on the LAN.
  for (const ip of ['192.168.1.20', '10.0.0.5', '127.0.0.1', '::1', '8.8.8.8']) {
    assert.equal(blockedReason(ip), null, `${ip} should be allowed by default`);
  }
  assert.ok(blockedReason('192.168.1.20', { allowPrivate: false }));
  assert.ok(blockedReason('::1', { allowPrivate: false }));
});

test('URL parser normalisation cannot smuggle the metadata address past the guard', async () => {
  // Decimal and hex hosts both normalise to 169.254.169.254 in WHATWG URL.
  for (const url of ['http://2852039166/', 'http://0xA9FEA9FE/', 'http://[::ffff:169.254.169.254]/']) {
    await rejectsWith(safeFetchText(url, { timeoutMs: 2000 }), 'BLOCKED_ADDRESS');
  }
});

// ------------------------------------------------------------------ fetching

test('safeFetchText fetches text, follows safe redirects and re-checks unsafe ones', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/list.m3u') { res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' }); return res.end('#EXTM3U\n'); }
    if (req.url === '/hop') { res.writeHead(302, { Location: '/list.m3u' }); return res.end(); }
    if (req.url === '/evil') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url === '/evil-mapped') { res.writeHead(301, { Location: 'http://[::ffff:a9fe:a9fe]/' }); return res.end(); }
    if (req.url === '/scheme') { res.writeHead(302, { Location: 'file:///etc/passwd' }); return res.end(); }
    if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    if (req.url === '/missing') { res.writeHead(404); return res.end('nope'); }
    res.writeHead(500); res.end();
  });
  try {
    const direct = await safeFetchText(`${srv.base}/list.m3u`);
    assert.equal(direct.text, '#EXTM3U\n');
    assert.match(direct.contentType, /mpegurl/);

    const hopped = await safeFetchText(`${srv.base}/hop`);
    assert.equal(hopped.text, '#EXTM3U\n');
    assert.equal(hopped.finalUrl, `${srv.base}/list.m3u`);

    await rejectsWith(safeFetchText(`${srv.base}/evil`), 'BLOCKED_ADDRESS');
    await rejectsWith(safeFetchText(`${srv.base}/evil-mapped`), 'BLOCKED_ADDRESS');
    await rejectsWith(safeFetchText(`${srv.base}/scheme`), 'BAD_SCHEME');
    await rejectsWith(safeFetchText(`${srv.base}/loop`), 'TOO_MANY_REDIRECTS');
    await rejectsWith(safeFetchText(`${srv.base}/missing`), 'HTTP_STATUS');
  } finally {
    await srv.close();
  }
});

test('safeFetchText enforces the byte cap (or truncates when asked) and inflates gzip', async () => {
  const big = 'x'.repeat(64 * 1024);
  const guide = '<?xml version="1.0"?><tv><channel id="a"/></tv>';
  const srv = await serve((req, res) => {
    if (req.url === '/big') { res.writeHead(200); return res.end(big); }
    if (req.url === '/guide.xml.gz') { res.writeHead(200, { 'Content-Type': 'application/gzip' }); return res.end(zlib.gzipSync(guide)); }
    if (req.url === '/encoded') { res.writeHead(200, { 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(guide)); }
    res.writeHead(404); res.end();
  });
  try {
    await rejectsWith(safeFetchText(`${srv.base}/big`, { maxBytes: 4096 }), 'TOO_LARGE');
    const cut = await safeFetchText(`${srv.base}/big`, { maxBytes: 4096, truncate: true });
    assert.equal(cut.truncated, true);
    assert.ok(cut.text.length <= 4096);

    assert.equal((await safeFetchText(`${srv.base}/guide.xml.gz`)).text, guide);
    assert.equal((await safeFetchText(`${srv.base}/encoded`)).text, guide);
  } finally {
    await srv.close();
  }
});

test('safeFetchText gives up on a server that never answers', async () => {
  const srv = await serve(() => { /* hang */ });
  try {
    await rejectsWith(safeFetchText(`${srv.base}/slow`, { timeoutMs: 1200 }), 'TIMEOUT');
  } finally {
    srv.close(); // don't await: the hung socket keeps close() pending
  }
});

// ------------------------------------------------------------ links service

test('redactUrl hides credentials, tokens and webhook secrets', () => {
  assert.equal(
    links.redactUrl('http://u:p@h.tv/get.php?username=bob&password=hunter2&type=m3u_plus'),
    'http://u:•••@h.tv/get.php?username=bob&password=•••&type=m3u_plus',
  );
  assert.equal(links.redactUrl('https://discord.com/api/webhooks/123456/SECRETTOKEN'), 'https://discord.com/api/webhooks/123456/•••');
  assert.equal(links.redactUrl('https://api.telegram.org/bot123:ABC/sendMessage'), 'https://api.telegram.org/bot•••/sendMessage');
  assert.deepEqual(links.describeSecret('http://h/x?token=abc'), { configured: true, hint: 'http://h/x?token=•••' });
  assert.equal(links.describeSecret('').configured, false);
});

test('classify recognises each kind of link and offers the right next steps', () => {
  const live = links.classify('#EXTM3U url-tvg="http://g/guide.xml"\n#EXTINF:-1 tvg-id="a" group-title="News, UK",Harbour News\nhttp://s/1.ts\n');
  assert.equal(live.kind, 'm3u-live');
  assert.equal(live.summary.channels, 1);
  assert.equal(live.summary.epgUrl, 'http://g/guide.xml');
  assert.deepEqual(live.summary.sample, ['Harbour News']);
  assert.ok(live.actions.includes('livetv-source'));
  assert.ok(live.actions.includes('livetv-guide-from-playlist'));

  const audio = links.classify('#EXTM3U\n#EXTINF:200,Artist - Song\n/music/a.mp3\n');
  assert.equal(audio.kind, 'm3u-audio');
  assert.equal(audio.actions[0], 'import-playlist');

  assert.equal(links.classify('<?xml version="1.0"?><tv><channel id="a"></channel><programme channel="a"></programme></tv>').kind, 'xmltv');
  assert.equal(links.classify('<rss><channel><title>P</title><item><enclosure url="http://x/a.mp3" type="audio/mpeg"/></item></channel></rss>').kind, 'podcast');

  const login = links.classify('<!doctype html><html><body>login</body></html>', { contentType: 'text/html' });
  assert.equal(login.kind, 'html');
  assert.deepEqual(login.actions, []);
  assert.ok(login.hint);

  assert.equal(links.classify('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n').kind, 'hls-stream');
  assert.equal(links.classify('hello').kind, 'unknown');
});

test('guideMatch counts channels whose tvg-id appears in the guide', () => {
  const m = links.guideMatch(
    '#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nhttp://1\n#EXTINF:-1 tvg-id="z",Z\nhttp://2\n',
    '<tv><channel id="a"/><programme channel="a"/></tv>',
  );
  assert.equal(m.channels, 2);
  assert.equal(m.matched, 1);
  assert.deepEqual(m.unmatchedSample, ['Z']);
});

test('matchEntries maps playlist lines onto library items and counts web links', () => {
  const library = [
    { id: 'a', path: '/media/music/Wren Calloway/Sunday Late.mp3' },
    { id: 'b', path: 'C:\\Music\\Kettle Song.flac' },
  ];
  const r = links.matchEntries([
    '#EXTM3U',
    '#EXTINF:200,Wren Calloway - Sunday Late',
    '/media/music/Wren Calloway/Sunday Late.mp3',   // exact path
    'Music/Kettle%20Song.flac',                     // encoded relative path, other OS
    'https://radio.example/stream',                 // web stream
    '/elsewhere/unknown.mp3',
  ], library);
  assert.deepEqual(r.matched, ['a', 'b']);
  assert.equal(r.considered, 4);
  assert.equal(r.missed, 2);
  assert.equal(r.remote, 1);
});

test('extinfName keeps commas in names and ignores commas inside attributes', () => {
  assert.equal(links.extinfName('#EXTINF:-1 group-title="News, UK" tvg-id="a",Harbour News'), 'Harbour News');
  assert.equal(links.extinfName('#EXTINF:-1,Plain, Name'), 'Plain, Name');
  assert.equal(links.extinfName('#EXTINF:-1 tvg-id="a"'), '');
});

test('Live TV parseM3U reads tvg-chno and attribute values with commas', () => {
  const channels = parseM3U([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="a.uk" tvg-chno="101" tvg-logo="http://l/a.png" group-title="News, UK",Harbour News',
    'http://x/1',
    '#EXTINF:-1 tvg-chno="not a number",Field Docs',
    'http://x/2',
  ].join('\n'));
  assert.equal(channels.length, 2);
  assert.deepEqual(
    { name: channels[0].name, group: channels[0].group, number: channels[0].number, tvgId: channels[0].tvgId },
    { name: 'Harbour News', group: 'News, UK', number: '101', tvgId: 'a.uk' },
  );
  assert.equal(channels[1].number, null);
});
