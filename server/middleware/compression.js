/**
 * Response compression — zero-dependency middleware built on Node's zlib.
 *
 * Why not the `compression` package: Vault's needs are small and well-defined
 * (JSON APIs + static assets; media streams and SSE must NEVER be touched),
 * so a built-in implementation keeps the dependency surface at zero.
 *
 * Behaviour:
 *  - Negotiates br > gzip > deflate from Accept-Encoding (q-values honoured).
 *  - Decides lazily at the first body write, when Content-Type is known:
 *      * only text/*, application/(json|javascript|xml|…), image/svg+xml compress
 *      * byte-Range requests and `text/event-stream` are never touched
 *      * responses already carrying Content-Encoding pass through untouched
 *  - Buffers up to `threshold` bytes so sub-threshold payloads go out raw
 *    (headers stay mutable while nothing has hit the socket).
 *  - Removes Content-Length when compressing; sets Vary: Accept-Encoding on
 *    compressible responses so shared caches stay honest.
 *  - HEAD, Range requests, and clients with no usable Accept-Encoding bypass
 *    the middleware entirely (zero overhead on media streaming).
 */
const zlib = require('zlib');

const COMPRESSIBLE_RE = /^(text\/|application\/(json|javascript|ecmascript|xml|manifest\+json|rss\+xml|atom\+xml|ld\+json|xhtml\+xml)|image\/svg\+xml)/i;
// Media/binary types that must never be buffered or encoded.
const NEVER_COMPRESS_RE = /^(video\/|audio\/|font\/|multipart\/)|\/(zip|gzip|br|woff2?|mp4|mp3|ogg|webm|flac|jpeg|png|gif|webp|avif)$/i;

const BROTLI_QUALITY = 5; // good ratio/latency balance for LAN + WAN serving
const GZIP_LEVEL = 6;

function pickEncoding(header) {
  if (!header) return null;
  const entries = String(header)
    .split(',')
    .map(part => {
      const segs = part.trim().split(';');
      const name = (segs[0] || '').trim().toLowerCase();
      const qMatch = /(?:^|;)\s*q=([0-9.]+)/i.exec(segs.slice(1).join(';'));
      const q = qMatch ? parseFloat(qMatch[1]) : 1;
      return { name, q: isNaN(q) ? 0 : q };
    })
    .filter(e => e.name);

  const qOf = n => {
    const e = entries.find(x => x.name === n);
    return e ? e.q : 0;
  };
  const identityQ = qOf('identity');
  // `identity` is implicitly acceptable (q=1) unless listed with q=0.
  const identity = entries.some(e => e.name === 'identity') ? identityQ : 1;

  const candidates = [
    ['br', qOf('br')],
    ['gzip', qOf('gzip')],
    ['deflate', qOf('deflate')],
  ].sort((a, b) => b[1] - a[1]);

  if (candidates[0][1] > 0) return candidates[0][0];
  const star = qOf('*');
  if (star > 0 && identity === 0) return 'gzip'; // client refuses identity
  return null; // plain identity is fine
}

function createEncoder(encoding) {
  if (encoding === 'br') {
    return zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: 0,
      },
    });
  }
  if (encoding === 'gzip') return zlib.createGzip({ level: GZIP_LEVEL });
  if (encoding === 'deflate') return zlib.createDeflate({ level: GZIP_LEVEL });
  return null;
}

function appendVary(res, value) {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', value);
    return;
  }
  const list = String(current)
    .split(',')
    .map(v => v.trim().toLowerCase());
  if (!list.includes(value.toLowerCase())) {
    res.setHeader('Vary', `${current}, ${value}`);
  }
}

function toBuffer(chunk, encoding) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : undefined);
}

function createCompression({ threshold = 1024 } = {}) {
  return function compressionMiddleware(req, res, next) {
    if (req.method === 'HEAD') return next();
    if (req.headers.range) return next(); // byte-range streams stay untouched
    if (req.headers['x-no-compress']) return next();

    const encoding = pickEncoding(req.headers['accept-encoding']);
    if (!encoding) return next();

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);

    let mode = 'undecided'; // undecided | raw | compress
    let encoder = null;
    let pending = [];
    let pendingBytes = 0;

    function flushRaw(callback) {
      const bufs = pending;
      pending = [];
      pendingBytes = 0;
      let ok = true;
      for (const b of bufs) ok = originalWrite(b);
      if (typeof callback === 'function') process.nextTick(callback);
      return ok;
    }

    function decide() {
      if (mode !== 'undecided') return mode;

      if (res.headersSent) {
        mode = 'raw'; // e.g. SSE called flushHeaders() before the first write
        return mode;
      }

      const type = String(res.getHeader('Content-Type') || '');
      const existingEncoding = res.getHeader('Content-Encoding');
      const contentLength = parseInt(res.getHeader('Content-Length'), 10);

      const compressible =
        !!type &&
        !existingEncoding &&
        COMPRESSIBLE_RE.test(type) &&
        !NEVER_COMPRESS_RE.test(type);

      if (!compressible) {
        mode = 'raw';
        return mode;
      }

      // Correctness for shared caches: any compressible response varies on
      // Accept-Encoding, whether or not this payload ended up encoded.
      appendVary(res, 'Accept-Encoding');

      const bigEnough =
        pendingBytes >= threshold || (!isNaN(contentLength) && contentLength >= threshold);
      if (!bigEnough) {
        mode = 'raw';
        return mode;
      }

      encoder = createEncoder(encoding);
      if (!encoder) {
        mode = 'raw';
        return mode;
      }

      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', encoding);

      encoder.on('data', chunk => {
        originalWrite(chunk);
      });
      encoder.on('error', () => {
        if (!res.destroyed) res.destroy();
      });

      mode = 'compress';
      const buffered = pending;
      pending = [];
      pendingBytes = 0;
      for (const b of buffered) encoder.write(b);
      return mode;
    }

    res.write = function compressedWrite(chunk, encodingArg, cb) {
      const callback = typeof encodingArg === 'function' ? encodingArg : cb;
      const enc = typeof encodingArg === 'string' ? encodingArg : undefined;

      if (mode === 'raw') {
        const ok = originalWrite(chunk, enc);
        if (typeof callback === 'function') process.nextTick(callback);
        return ok;
      }

      if (chunk !== undefined && chunk !== null && toBuffer(chunk, enc).length > 0) {
        const buf = toBuffer(chunk, enc);
        pending.push(buf);
        pendingBytes += buf.length;
      }

      if (mode === 'undecided') {
        if (pendingBytes >= threshold) decide();
        if (mode === 'raw') return flushRaw(callback);
        if (mode === 'undecided') {
          // Still buffering — report success; data goes out on decide/end.
          if (typeof callback === 'function') process.nextTick(callback);
          return true;
        }
      }

      // mode === 'compress'
      let ok = true;
      const bufs = pending;
      pending = [];
      pendingBytes = 0;
      for (const b of bufs) ok = encoder.write(b);
      // Backpressure bridge: callers (e.g. express.static's file pipe) pause
      // their source when we return false and only resume on 'drain'. The
      // encoder drains independently as it compresses, so surface that as a
      // response-level drain — otherwise file streams never resume and the
      // response hangs after the first chunk.
      if (!ok) encoder.once('drain', () => res.emit('drain'));
      if (typeof callback === 'function') process.nextTick(callback);
      return ok;
    };

    res.end = function compressedEnd(chunk, encodingArg, cb) {
      let body = chunk;
      let enc = encodingArg;
      let done = cb;
      if (typeof body === 'function') {
        done = body;
        body = undefined;
        enc = undefined;
      } else if (typeof enc === 'function') {
        done = enc;
        enc = undefined;
      }

      if (mode === 'raw') {
        if (body !== undefined && body !== null) return originalEnd(body, enc, done);
        if (typeof done === 'function') return originalEnd(done);
        return originalEnd();
      }

      if (body !== undefined && body !== null) {
        const buf = toBuffer(body, enc);
        if (buf.length > 0) {
          pending.push(buf);
          pendingBytes += buf.length;
        }
      }

      if (mode === 'undecided') decide();

      if (mode === 'raw') {
        flushRaw(); // buffered body (if any) goes out as plain bytes
        if (typeof done === 'function') return originalEnd(done);
        return originalEnd();
      }

      // mode === 'compress'
      const bufs = pending;
      pending = [];
      pendingBytes = 0;
      for (const b of bufs) encoder.write(b);
      // NOTE: zlib's writable-side end callback fires BEFORE the final deflate
      // output reaches 'data' — we must wait for the readable side to finish
      // or the gzip/brotli footer is lost (truncated streams downstream).
      encoder.once('end', () => {
        originalEnd();
        if (typeof done === 'function') done();
      });
      encoder.end();
      return res;
    };

    next();
  };
}

module.exports = createCompression;
module.exports.createCompression = createCompression;
module.exports._internals = { pickEncoding, COMPRESSIBLE_RE };
