/**
 * Keeps the browser on ONE build of the web client.
 *
 * The client is a zero-build set of ES modules. index.html always revalidates,
 * but views are imported lazily from fixed URLs (./js/views/system.js), so
 * after a server update the browser could keep running an old view against
 * the new API from its HTTP cache. The old view then misread the new
 * responses: the Server page showed "0", "0 B" and "Unknown".
 *
 * Fix: when the server sends index.html it injects an import map that maps
 * `<doc dir>/js/` → `/b/<build>/js/`. Every module specifier, including the
 * relative imports inside modules, then resolves under one build-specific
 * prefix. A new build gets new URLs that no cache can hold, and those URLs can
 * be cached as immutable. Browsers without import-map support fall back to the
 * plain /js/ URLs, which are served `no-cache`.
 *
 * The build id is a hash of every client code file's path, size and mtime,
 * memoised for a moment, so editing a file changes it without a restart.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CODE_FILE = /\.(?:m?js|css|html?|json|webmanifest|map)$/i;
const MEMO_MS = 5000;
const SKIP_DIRS = new Set(['node_modules', '.git']);

let memo = { root: null, at: 0, id: null };

function listCodeFiles(root) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(childRel);
      } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

/** Short, URL-safe id for the client files currently on disk. */
function buildId(root, { force = false } = {}) {
  const now = Date.now();
  if (!force && memo.root === root && memo.id && now - memo.at < MEMO_MS) return memo.id;
  const hash = crypto.createHash('sha1');
  for (const rel of listCodeFiles(root)) {
    let stat;
    try {
      stat = fs.statSync(path.join(root, rel));
    } catch {
      continue;
    }
    hash.update(`${rel}\0${stat.size}\0${Math.floor(stat.mtimeMs)}\n`);
  }
  const id = hash.digest('hex').slice(0, 12);
  memo = { root, at: now, id };
  return id;
}

/**
 * Directory of the document URL, as the browser resolves `./js/` against it:
 * `/` → `/`, `/system` → `/`, `/movie/abc` → `/movie/`.
 */
function documentDir(requestPath) {
  const p = String(requestPath || '/');
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : p.slice(0, cut + 1);
}

const escapeScript = (json) => json.replace(/</g, '\\u003c');

/**
 * index.html with the import map and the build id injected at the top of
 * <head>, ahead of every module script (an import map must come first).
 */
function buildTags({ id, requestPath = '/' }) {
  const dir = documentDir(requestPath);
  const target = `/b/${id}/js/`;
  const imports = { '/js/': target };
  // Opened at a nested route (/movie/abc), `./js/x.js` resolves to
  // /movie/js/x.js. Map that prefix too, so the same module isn't loaded
  // twice under two URLs.
  if (dir !== '/') imports[`${dir}js/`] = target;
  const importMap = escapeScript(JSON.stringify({ imports }));
  const buildScript = `window.__VAULT_BUILD__=${escapeScript(JSON.stringify(id))};`;
  return {
    tags: `<script type="importmap">${importMap}</script><script>${buildScript}</script>`,
    // The only inline scripts Vault sends. The CSP allows exactly these by
    // hash (see cspHashes); every other inline script stays blocked.
    inline: [importMap, buildScript],
  };
}

function injectTags(html, tags) {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return tags + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + tags + html.slice(at);
}

function injectBuild(html, { id, requestPath = '/' }) {
  return injectTags(html, buildTags({ id, requestPath }).tags);
}

/** CSP source expressions ('sha256-…') for inline script bodies. */
function cspHashes(bodies) {
  return bodies.map(body => `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

/**
 * Add hash sources to the script-src of the Content-Security-Policy header
 * already set on `res` (by helmet). Hashes rather than a nonce: index.html
 * is answered with 304s, and a 304 reuses the cached body (and its old nonce)
 * under fresh headers. A hash is the same for the same build and path.
 */
function allowInlineScripts(res, hashes) {
  const header = res.getHeader('Content-Security-Policy');
  if (!header || !hashes.length) return;
  const policy = String(header);
  const next = /(^|;)\s*script-src\s/i.test(policy)
    ? policy.replace(/((?:^|;)\s*script-src)([^;]*)/i, (_, name, sources) => `${name}${sources} ${hashes.join(' ')}`)
    : `${policy};script-src 'self' ${hashes.join(' ')}`;
  res.setHeader('Content-Security-Policy', next);
}

/**
 * index.html carries a <meta> copy of the CSP for the static GitHub Pages
 * build, which can't send headers. The server sends the policy as a header
 * (plus frame-ancestors and the inline-script hashes), and browsers enforce
 * every policy they get. A second copy without the hashes would block the
 * injected scripts if a tag were ever moved below it, so it is removed here.
 */
function stripMetaCsp(html) {
  return html.replace(/[ \t]*<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>[ \t]*\r?\n?/gi, '');
}

/**
 * Point index.html's module URLs at the build-pinned copies: the
 * <link rel="modulepreload"> list (scripts/build-preload.js) and the main.js
 * entry. Import maps don't apply to a link's href or a script's src, so the
 * plain ./js/ URLs would be fetched once there and AGAIN under /b/<build>/js/
 * when main.js's imports resolve through the map. Pinned, they are the same
 * module-map entries, and cached as immutable (no revalidation on reload).
 */
function pinModuleUrls(html, id) {
  const target = `/b/${id}/js/`;
  return html
    .replace(/(<link\s+rel="modulepreload"\s+href=")\.\/js\//g, `$1${target}`)
    .replace(/(<script\s+type="module"\s+src=")\.\/js\/main\.js"/g, `$1${target}main.js"`);
}

/** Cached read of index.html (re-read when the file changes). */
let indexCache = { file: null, mtimeMs: 0, size: 0, html: '' };
function readIndex(file) {
  const stat = fs.statSync(file);
  if (indexCache.file !== file || indexCache.mtimeMs !== stat.mtimeMs || indexCache.size !== stat.size) {
    indexCache = { file, mtimeMs: stat.mtimeMs, size: stat.size, html: fs.readFileSync(file, 'utf8') };
  }
  return indexCache.html;
}

/** Express handler that sends index.html for the current build. */
function sendIndex(docsPath, req, res, next) {
  try {
    const id = buildId(docsPath);
    const { tags, inline } = buildTags({ id, requestPath: req.path });
    const html = injectTags(pinModuleUrls(stripMetaCsp(readIndex(path.join(docsPath, 'index.html'))), id), tags);
    allowInlineScripts(res, cspHashes(inline));
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html');
    // res.send adds the ETag (so reloads get a 304) and skips the body for HEAD.
    return res.send(html);
  } catch (err) {
    return next(err);
  }
}

/**
 * Serve the web client from `docsPath`:
 *   - `/` and `/index.html` → index.html with the import map (no-cache),
 *   - `/b/<build>/…`        → build-pinned files: immutable for the current
 *                             build, no-cache for an older one, 404 if absent,
 *   - everything else       → plain static files; code revalidates every time.
 */
function mountClient(app, docsPath) {
  const express = require('express');

  app.get(['/', '/index.html'], (req, res, next) => sendIndex(docsPath, req, res, next));

  // The current build never changes under its URL, so it is cached for good.
  // A tab still on an older build gets today's files, revalidated every time
  // (the old files are gone from disk anyway).
  const pinnedCurrent = express.static(docsPath, {
    index: false,
    fallthrough: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable'),
  });
  const pinnedOld = express.static(docsPath, {
    index: false,
    fallthrough: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  });
  app.use('/b/:build', (req, res, next) => {
    const handler = req.params.build === buildId(docsPath) ? pinnedCurrent : pinnedOld;
    // Never fall through to the SPA fallback: HTML for a module is useless.
    handler(req, res, () => res.status(404).end());
  });

  app.use(express.static(docsPath, {
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      // Code (JS/CSS/HTML/JSON) always revalidates; a 304 on the LAN costs
      // next to nothing. It used to be cached for an hour and then served
      // stale for up to a week, so after an update the browser kept running
      // old views against the new server.
      if (isCodeFile(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      // Fonts, icons and images rarely change between releases: 1h fresh,
      // then revalidated in the background.
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=604800');
    },
  }));
}

function isCodeFile(name) {
  return CODE_FILE.test(name);
}

module.exports = {
  stripMetaCsp, pinModuleUrls, buildId, injectBuild, buildTags, cspHashes, allowInlineScripts, documentDir, sendIndex, mountClient, isCodeFile, listCodeFiles };
