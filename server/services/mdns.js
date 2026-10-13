/**
 * Minimal mDNS / DNS-SD responder so the server announces itself as
 * `<hostname>.local` (default `vault.local`) on the local network.
 *
 * Zero dependencies: replies to PTR/SRV/TXT/A queries for the service type
 * `_vault._tcp.local` and to A queries for the chosen hostname. A device on
 * the same LAN — a TV browser, an iPad — can then open `http://vault.local:4000`
 * without anyone typing an IP address (IMPROVEMENTS item 46).
 *
 * Disabled by default; enable with `server.mdns: { enabled: true }` in
 * config.json or `VAULT_MDNS=1`. Some networks block multicast, in which case
 * the responder simply never gets a query — nothing else changes.
 */
const dgram = require('dgram');
const os = require('os');
const logger = require('../utils/logger');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_vault._tcp.local';

let socket = null;
let config = {};
let started = false;

function lanAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = typeof entry.family === 'string' ? entry.family : `IPv${entry.family}`;
      if (family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

/** Encode a domain name as a sequence of length-prefixed labels. */
function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const chunks = parts.map(part => {
    const buf = Buffer.from(part, 'utf8');
    return Buffer.concat([Buffer.from([buf.length]), buf]);
  });
  return Buffer.concat([...chunks, Buffer.from([0])]);
}

function parseName(buffer, offset) {
  const labels = [];
  let jumped = false;
  let cursor = offset;
  let guard = 0;
  while (cursor < buffer.length && guard++ < 64) {
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      // Compression pointer — follow once, then stop.
      const pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      if (jumped) break;
      jumped = true;
      cursor = pointer;
      continue;
    }
    labels.push(buffer.slice(cursor + 1, cursor + 1 + length).toString('utf8'));
    cursor += length + 1;
  }
  return { name: labels.join('.'), next: jumped ? offset + 2 : cursor };
}

function readQuestions(buffer) {
  const questions = [];
  if (buffer.length < 12) return questions;
  const qdcount = buffer.readUInt16BE(4);
  let offset = 12;
  for (let i = 0; i < qdcount && offset < buffer.length; i++) {
    const { name, next } = parseName(buffer, offset);
    const type = buffer.readUInt16BE(next);
    questions.push({ name, type });
    offset = next + 4;
  }
  return questions;
}

function record(type, name, rdata) {
  return { type, name, rdata };
}

function aRecord(name, address) {
  const parts = address.split('.').map(Number);
  return record(12, name, Buffer.from(parts));
}

function serializeRecord({ type, name, rdata }, { ttl = 120, flush = true } = {}) {
  const nameBuf = encodeName(name);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(0x0001, 2); // class IN
  // Cache-flush bit is the top bit of the 32-bit TTL. (`ttl | 0x80000000`
  // yields a negative JS number and Buffer rejects it — add instead.)
  header.writeUInt32BE(flush ? (ttl + 0x80000000) >>> 0 : ttl, 4);
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameBuf, header, rdata]);
}

function buildResponse(answers) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id
  header.writeUInt16BE(0x8400, 2); // response, authoritative
  header.writeUInt16BE(0, 4); // qdcount
  header.writeUInt16BE(answers.length, 6); // ancount
  return Buffer.concat([header, ...answers.map(a => serializeRecord(a))]);
}

function buildTxt() {
  const version = require('../package.json').version || '3.0.0';
  const strings = [
    `path=/`,
    `version=${version}`,
  ].map(text => {
    const buf = Buffer.from(text, 'utf8');
    return Buffer.concat([Buffer.from([buf.length]), buf]);
  });
  return Buffer.concat(strings);
}

function buildAnswers({ hostname, port, addresses }) {
  const instance = `${hostname}.${SERVICE_TYPE}`;
  const answers = [];

  // PTR: where is the service?
  answers.push(record(12, SERVICE_TYPE, encodeName(instance)));
  // SRV: which host + port? priority 0, weight 0, port, target.
  const srv = Buffer.alloc(6 + encodeName(`${hostname}.local`).length);
  srv.writeUInt16BE(0, 0);
  srv.writeUInt16BE(0, 2);
  srv.writeUInt16BE(port, 4);
  encodeName(`${hostname}.local`).copy(srv, 6);
  answers.push(record(33, instance, srv));
  // TXT: version + path hints.
  answers.push(record(16, instance, buildTxt()));
  // A: the addresses themselves.
  for (const address of addresses) answers.push(aRecord(`${hostname}.local`, address));
  return answers;
}

function handleMessage(buffer) {
  const questions = readQuestions(buffer);
  if (!questions.length) return;

  const { hostname = 'vault', port = 4000 } = config;
  const addresses = lanAddresses();
  const wanted = questions.some(({ name, type }) => {
    const lower = name.toLowerCase();
    if (lower === SERVICE_TYPE.toLowerCase()) return type === 12 || type === 255;
    if (lower === `${hostname}.${SERVICE_TYPE}`.toLowerCase()) return type === 33 || type === 16 || type === 255;
    if (lower === `${hostname}.local`) return type === 1 || type === 255;
    return false;
  });
  if (!wanted) return;

  const response = buildResponse(buildAnswers({ hostname, port, addresses }));
  socket.send(response, 0, response.length, MDNS_PORT, MDNS_ADDR, (err) => {
    if (err) logger.warn(`mDNS reply failed: ${err.message}`);
  });
}

function start(options = {}) {
  if (started) return false;
  config = { hostname: 'vault', port: 4000, ...options };
  if (!config.enabled) return false;

  try {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => logger.warn(`mDNS socket error: ${err.message}`));
    socket.on('message', (message) => {
      try { handleMessage(message); } catch { /* malformed packet — ignore */ }
    });
    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDR);
        const addresses = lanAddresses();
        // Unprompted announcement so devices see us without querying.
        const packet = buildResponse(buildAnswers({
          hostname: config.hostname,
          port: config.port,
          addresses,
        }));
        socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, () => {});
        logger.info(`mDNS: announcing ${config.hostname}.local:${config.port} on ${addresses.join(', ') || 'no LAN address'}`);
      } catch (err) {
        logger.warn(`mDNS announcement failed: ${err.message}`);
      }
    });
    started = true;
    return true;
  } catch (err) {
    logger.warn(`mDNS disabled: ${err.message}`);
    return false;
  }
}

function stop() {
  if (!socket) return;
  try { socket.dropMembership(MDNS_ADDR); } catch { /* not a member */ }
  try { socket.close(); } catch { /* already closed */ }
  socket = null;
  started = false;
}

module.exports = {
  start,
  stop,
  isStarted: () => started,
  _internals: { encodeName, parseName, buildAnswers, buildResponse, serializeRecord, lanAddresses },
};
