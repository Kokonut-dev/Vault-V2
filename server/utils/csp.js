/**
 * Content-Security-Policy: the policy below allows exactly what the app needs:
 *   * scripts from this server only. No inline <script>, no inline event
 *     handlers (onclick=…), no eval: an injected string of HTML can't run
 *     code. The two tags the server itself injects into index.html (import
 *     map + build id) are allowed by their SHA-256 hash (utils/clientBuild.js),
 *   * stylesheets from this server only (style-src-elem): no inline <style>.
 *     style="" attributes stay allowed (style-src-attr): the templates use
 *     them for layout, and they can't run script. Browsers too old for the
 *     -elem/-attr directives fall back to style-src, which keeps
 *     'unsafe-inline' for them only,
 *   * media/images from the API base URL (which is this server, or the tunnel
 *     origin the user configured),
 *   * connect to the same origins for fetch()/SSE.
 * `frame-ancestors 'none'` + `object-src 'none'` keep the clickjacking and
 * plugin vectors closed.
 *
 * docs/index.html carries the same policy in a <meta> tag (for the GitHub
 * Pages copy of the app); server/test/csp.test.js keeps the two in step.
 */
const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  // accounts.google.com: Google Identity Services, only loaded when an
  // admin connects a Google account for Drive import.
  scriptSrc: ["'self'", 'https://accounts.google.com'],
  scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'"],
  styleSrcElem: ["'self'", 'https://accounts.google.com/gsi/style'],
  styleSrcAttr: ["'unsafe-inline'"],
  // Podcast episodes and their artwork are served by the podcast's own
  // host; with media-src 'self' every feed episode failed to load.
  imgSrc: ["'self'", 'data:', 'blob:', 'https:', 'http:'],
  mediaSrc: ["'self'", 'blob:', 'data:', 'https:', 'http:'],
  fontSrc: ["'self'", 'data:'],
  connectSrc: ["'self'", 'https:', 'http:', 'blob:'],
  workerSrc: ["'self'", 'blob:'],
  frameSrc: ["'self'", 'blob:', 'https://accounts.google.com'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  manifestSrc: ["'self'"],
};

module.exports = { CSP_DIRECTIVES };
