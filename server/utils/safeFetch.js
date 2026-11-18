/**
 * safeFetch — GET a user-supplied URL from the server without turning Vault
 * into an open proxy (SSRF hardening, see SETTINGS_REVAMP_PLAN.md SR-7).
 *
 *  - http/https only, no other schemes
 *  - the address is validated at *connect* time through a custom `lookup`,
 *    so a hostname that re-resolves (DNS rebinding) is still checked
 *  - link-local / cloud-metadata / multicast / unspecified ranges are always
 *    blocked; loopback + private LAN ranges are allowed by default because
 *    the main use is a tuner or IPTV proxy on the home network (HDHomeRun,
 *    Threadfin, Dispatcharr). Pass `allowPrivate: false` to block them too.
 *  - redirects are followed manually (max 3) and every hop is re-validated
 *  - hard byte cap (reject, or `truncate: true` to keep the first N bytes)
 *  - overall timeout
 *  - gzip/deflate/br decoded transparently, including `.gz` guide files
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const zlib = require('zlib');

class SafeFetchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const V4_ALWAYS_BLOCKED = [
  '0.0.0.0/8',        // "this network" / unspecified
  '169.254.0.0/16',   // link-local, incl. 169.254.169.254 cloud metadata
  '192.0.0.0/24',     // IETF protocol assignments (incl. 192.0.0.192 Oracle metadata)
  '224.0.0.0/4',      // multicast
  '240.0.0.0/4',      // reserved + broadcast
];
const V4_PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '100.64.0.0/10'];

/** Expand an IPv6 literal to 8 numeric groups, or null. */
function expandIPv6(addr) {
  if (!net.isIPv6(addr)) return null;
  let text = addr.toLowerCase();
  // Trailing dotted quad → two hex groups
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[2]);
    text = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill('0') : [];
  const groups = [...h, ...fill, ...t].map(g => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every(g => g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedIPv4(addr) {
  const g = expandIPv6(addr);
  if (!g) return null;
  const v4 = () => `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  const zeros = (from, to) => g.slice(from, to).every(x => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return v4();                       // ::ffff:a.b.c.d (mapped)
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4();         // ::ffff:0:a.b.c.d (translated)
  if (zeros(0, 6) && (g[6] || g[7] > 1)) return v4();                    // ::a.b.c.d (compatible, not :: / ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4();      // 64:ff9b::/96 NAT64
  return null;
}

/**
 * Classify an IP literal. Returns null when allowed, otherwise a reason.
 */
function blockedReason(ip, { allowPrivate = true } = {}) {
  let addr = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!addr) return 'no address';
  // IPv6 forms that embed an IPv4 address (mapped ::ffff:a9fe:a9fe — which
  // is how Node normalises [::ffff:169.254.169.254] — compatible ::a.b.c.d,
  // and NAT64 64:ff9b::/96) are judged by the embedded IPv4 address.
  const embedded = embeddedIPv4(addr);
  if (embedded) addr = embedded;

  if (net.isIPv4(addr)) {
    if (V4_ALWAYS_BLOCKED.some(c => inV4(addr, c))) return 'link-local, metadata or reserved address';
    if (!allowPrivate && V4_PRIVATE.some(c => inV4(addr, c))) return 'private network address';
    return null;
  }
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    if (a === '::' || a === '0:0:0:0:0:0:0:0') return 'unspecified address';
    if (/^fe[89ab]/.test(a)) return 'link-local address';
    if (a.startsWith('ff')) return 'multicast address';
    if (a.startsWith('fd00:ec2:')) return 'cloud metadata address';
    if (!allowPrivate && (a === '::1' || /^f[cd]/.test(a))) return 'private network address';
    return null;
  }
  return 'not an IP address';
}

const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data', 'instance-data.ec2.internal']);

/** Parse + validate a URL string for server-side fetching. Throws SafeFetchError. */
function validateUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new SafeFetchError('Enter a full link starting with http:// or https://', 'INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('Only http:// and https:// links can be fetched', 'BAD_SCHEME');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new SafeFetchError('The link has no host name', 'INVALID_URL');
  if (BLOCKED_HOSTNAMES.has(host)) throw new SafeFetchError('That address is not allowed', 'BLOCKED_ADDRESS');
  return url;
}

function guardedLookup(options) {
  return (hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
    dns.lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
      for (const entry of list) {
        const reason = blockedReason(entry.address, options);
        if (reason) {
          return callback(new SafeFetchError(`Blocked: ${hostname} resolves to a ${reason}`, 'BLOCKED_ADDRESS'));
        }
      }
      if (lookupOptions.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

function requestOnce(url, options) {
  const lib = url.protocol === 'https:' ? https : http;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Literal IPs skip DNS entirely, so check them here.
  if (net.isIP(host)) {
    const reason = blockedReason(host, options);
    if (reason) return Promise.reject(new SafeFetchError(`Blocked: ${reason}`, 'BLOCKED_ADDRESS'));
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET',
      lookup: guardedLookup(options),
      headers: {
        'User-Agent': 'Vault/3.0 (+link fetcher)',
        Accept: options.accept || '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: options.timeoutMs,
    }, resolve);
    req.on('timeout', () => req.destroy(new SafeFetchError('The server took too long to answer', 'TIMEOUT')));
    req.on('error', reject);
    req.end();
  });
}

function decoderFor(res, url) {
  const enc = String(res.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') return zlib.createBrotliDecompress();
  return null;
}

/**
 * Fetch a URL as text.
 * @returns {Promise<{text, status, contentType, finalUrl, truncated, bytes}>}
 */
async function safeFetchText(input, {
  maxBytes = 5 * 1024 * 1024,
  timeoutMs = 15000,
  truncate = false,
  allowPrivate = true,
  accept,
  maxRedirects = 3,
} = {}) {
  const options = { allowPrivate, timeoutMs, accept };
  let url = validateUrl(input);
  const deadline = Date.now() + timeoutMs;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(url, { ...options, timeoutMs: Math.max(1000, deadline - Date.now()) });
    const status = res.statusCode || 0;

    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop === maxRedirects) throw new SafeFetchError('Too many redirects', 'TOO_MANY_REDIRECTS');
      url = validateUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      const hint = status === 401 || status === 403 ? ' — check the username/password in the link'
        : status === 404 ? ' — the link may have expired or has a typo' : '';
      throw new SafeFetchError(`The server answered ${status}${hint}`, 'HTTP_STATUS');
    }

    const declared = Number(res.headers['content-length'] || 0);
    if (!truncate && declared && declared > maxBytes && !res.headers['content-encoding']) {
      res.resume();
      throw new SafeFetchError(`The file is larger than ${Math.round(maxBytes / 1048576)} MB`, 'TOO_LARGE');
    }

    let stream = res;
    const decoder = decoderFor(res, url);
    if (decoder) stream = res.pipe(decoder);

    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let gunzipped = false;

    const text = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        res.destroy();
        reject(new SafeFetchError('The download took too long', 'TIMEOUT'));
      }, Math.max(1000, deadline - Date.now()));
      const finish = () => {
        clearTimeout(timer);
        let buffer = Buffer.concat(chunks);
        // A .gz file served as application/octet-stream (common for XMLTV).
        if (!decoder && !gunzipped && buffer[0] === 0x1f && buffer[1] === 0x8b) {
          try {
            buffer = truncate
              ? zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).subarray(0, maxBytes)
              : zlib.gunzipSync(buffer, { maxOutputLength: maxBytes });
          } catch (err) {
            return reject(new SafeFetchError(err.code === 'ERR_BUFFER_TOO_LARGE'
              ? `The file is larger than ${Math.round(maxBytes / 1048576)} MB` : 'Could not decompress the file', 'TOO_LARGE'));
          }
          gunzipped = true;
        }
        resolve(buffer.toString('utf8'));
      };
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          if (!truncate) {
            clearTimeout(timer);
            res.destroy();
            return reject(new SafeFetchError(`The file is larger than ${Math.round(maxBytes / 1048576)} MB`, 'TOO_LARGE'));
          }
          chunks.push(chunk.subarray(0, chunk.length - (bytes - maxBytes)));
          truncated = true;
          res.destroy();
          stream.removeAllListeners('data');
          return finish();
        }
        chunks.push(chunk);
      });
      stream.on('end', () => { if (!truncated) finish(); });
      stream.on('error', err => {
        if (truncated) return;
        clearTimeout(timer);
        reject(err instanceof SafeFetchError ? err : new SafeFetchError(`Download failed: ${err.message}`, 'NETWORK'));
      });
    });

    return {
      text,
      status,
      contentType: String(res.headers['content-type'] || ''),
      finalUrl: url.toString(),
      truncated,
      bytes,
    };
  }
  throw new SafeFetchError('Too many redirects', 'TOO_MANY_REDIRECTS');
}

/**
 * Open a URL for streaming (large binary downloads such as podcast
 * episodes) with the same guarantees as safeFetchText: scheme check,
 * connect-time address check, every redirect hop re-validated.
 * @returns {Promise<{res: import('http').IncomingMessage, finalUrl: string}>}
 */
async function safeFetchStream(input, {
  timeoutMs = 30000,
  allowPrivate = true,
  accept,
  maxRedirects = 5,
} = {}) {
  const options = { allowPrivate, timeoutMs, accept };
  let url = validateUrl(input);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await requestOnce(url, options);
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop === maxRedirects) throw new SafeFetchError('Too many redirects', 'TOO_MANY_REDIRECTS');
      url = validateUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new SafeFetchError(`The server answered ${status}`, 'HTTP_STATUS');
    }
    // The connect timeout must not cut a long download short.
    res.socket?.setTimeout?.(0);
    return { res, finalUrl: url.toString() };
  }
  throw new SafeFetchError('Too many redirects', 'TOO_MANY_REDIRECTS');
}

/** Map low-level network errors to something a person can act on. */
function friendlyError(err) {
  if (err instanceof SafeFetchError) return err.message;
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'That host name could not be found — check for typos';
  if (code === 'ECONNREFUSED') return 'Nothing answered at that address and port';
  if (code === 'ECONNRESET') return 'The connection was reset by the server';
  if (code === 'CERT_HAS_EXPIRED' || /certificate/i.test(err?.message || '')) return 'The site\'s HTTPS certificate is not valid';
  return err?.message || 'The link could not be fetched';
}

module.exports = { safeFetchText, safeFetchStream, validateUrl, blockedReason, friendlyError, SafeFetchError };
