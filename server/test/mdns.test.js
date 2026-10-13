/**
 * Tests for the zero-dependency mDNS responder.
 *
 * These cover the packet builders only — no multicast sockets, so the suite
 * stays hermetic (CI containers frequently block multicast).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const mdns = require('../services/mdns');
const { encodeName, parseName, buildAnswers, buildResponse, serializeRecord, lanAddresses } = mdns._internals;

test('encodeName produces length-prefixed labels ending with a zero byte', () => {
  const buf = encodeName('_vault._tcp.local');
  assert.equal(buf[0], 6); // "_vault" is 6 bytes
  assert.equal(buf[buf.length - 1], 0);
  assert.ok(buf.includes(Buffer.from('_tcp')));
});

test('parseName round-trips an encoded name', () => {
  const { name, next } = parseName(encodeName('_vault._tcp.local'), 0);
  assert.equal(name, '_vault._tcp.local');
  assert.equal(next, encodeName('_vault._tcp.local').length);
});

test('serializeRecord writes the cache-flush bit without overflowing', () => {
  // Regression: `ttl | 0x80000000` is negative in JS and Buffer rejects it.
  const record = serializeRecord({ type: 12, name: 'local', rdata: Buffer.from([0]) });
  const nameLength = encodeName('local').length;
  assert.equal(record.readUInt32BE(nameLength + 4), (120 + 0x80000000) >>> 0);

  const plain = serializeRecord({ type: 12, name: 'local', rdata: Buffer.from([0]) }, { flush: false, ttl: 300 });
  assert.equal(plain.readUInt32BE(nameLength + 4), 300);
});

test('buildAnswers covers PTR, SRV, TXT and A records', () => {
  const answers = buildAnswers({ hostname: 'vault', port: 4000, addresses: ['192.168.1.5', '10.0.0.2'] });
  const types = answers.map(a => a.type);
  assert.deepEqual(types, [12, 33, 16, 12, 12]);
  // SRV payload: priority 0, weight 0, then the port.
  const srv = answers[1].rdata;
  assert.equal(srv.readUInt16BE(0), 0);
  assert.equal(srv.readUInt16BE(2), 0);
  assert.equal(srv.readUInt16BE(4), 4000);
  // A records carry the raw addresses.
  assert.deepEqual([...answers[3].rdata], [192, 168, 1, 5]);
});

test('buildResponse is a well-formed unsolicited response', () => {
  const packet = buildResponse(buildAnswers({ hostname: 'vault', port: 4000, addresses: ['127.0.0.1'] }));
  assert.equal(packet.readUInt16BE(0), 0); // id must be 0 for mDNS
  assert.equal(packet.readUInt16BE(2) & 0x8400, 0x8400); // response + authoritative
  assert.equal(packet.readUInt16BE(6), 4); // 4 answers
});

test('lanAddresses only returns non-loopback IPv4 addresses', () => {
  for (const address of lanAddresses()) {
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.ok(!address.startsWith('127.'), `loopback leaked: ${address}`);
  }
});

test('start() is a no-op unless enabled (and stop() is always safe)', () => {
  assert.equal(mdns.start({ enabled: false }), false);
  assert.equal(mdns.isStarted(), false);
  mdns.stop();
  assert.equal(mdns.isStarted(), false);
});
