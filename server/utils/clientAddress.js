/**
 * Where a request really comes from.
 *
 * Vault's own Cloudflare tunnel (and any reverse proxy the owner runs on the
 * same computer) connects from 127.0.0.1, so "the socket is loopback" alone
 * does NOT mean "the person is sitting at this computer". Proxies add a
 * forwarding header, so a loopback socket *with* one of these headers is
 * treated as remote.
 */
const FORWARD_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip', 'true-client-ip'];

function isLoopbackAddress(address) {
  const a = String(address || '').toLowerCase();
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.') || a === '::ffff:127.0.0.1' || a.startsWith('::ffff:127.');
}

function wasForwarded(req) {
  const headers = req?.headers || {};
  return FORWARD_HEADERS.some(h => headers[h] != null && String(headers[h]).trim() !== '');
}

/** True only for a direct request from this computer (not through a tunnel/proxy). */
function isLocalRequest(req) {
  const socketAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  return isLoopbackAddress(socketAddress) && !wasForwarded(req);
}

/** True when the request arrived through Vault's tunnel or another proxy on this computer. */
function cameThroughProxy(req) {
  const socketAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  return isLoopbackAddress(socketAddress) && wasForwarded(req);
}

module.exports = { isLoopbackAddress, isLocalRequest, cameThroughProxy, FORWARD_HEADERS };
