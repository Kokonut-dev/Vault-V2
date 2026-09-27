# Vault V2 — Stage 1: Deep Audit & Inventory

> **Date:** 2026-09-26 · **Branch:** `arena/01a0dfb1-vault-v2` · **Baseline commit:** `7f7aaac`
> **Status:** Stage 1 complete — no code changed. Awaiting approval before Stage 2.

---

## 1. Scope & Method

All **95 tracked files** were read end-to-end: frontend (`docs/`), backend (`server/`), CI
(`.github/workflows/deploy.yml`), scripts, configs, docs (README, ARCHITECTURE, RESEARCH,
CHANGELOG), LICENSE, CNAME, .gitignore. Sizes were measured, contrast ratios computed
programmatically against WCAG 2.1 formulas, and the request/dependency graph of the SPA
was traced module-by-module.

---

## 2. Repository Inventory

| Area | Files | Notes |
|---|---|---|
| Root docs | README.md (383 L), ARCHITECTURE.md (578 L), RESEARCH.md (477 L), CHANGELOG.md (156 L) | Consistent with code; a few claims drift (see F-24, F-44) |
| CI/CD | `.github/workflows/deploy.yml` | Structural checks (onboarding files, `enablement:true`) → upload `docs/` → Pages. **No lint, no tests, no minification step.** |
| Frontend HTML | `index.html` (1000 L, 36.5 KB), `404.html`, `manifest.json`, `sw.js`, `config.js`, `favicon.svg` | Zero-build vanilla ES-module SPA; auth gate + inline critical CSS in `index.html` |
| Frontend CSS | 13 files, **105.7 KB raw / 18.5 KB gzip** | All 13 are render-blocking `<link>`s in `<head>` |
| Frontend JS | 44 modules, **246.7 KB raw / 54.5 KB gzip** | Views lazy-loaded via dynamic `import()`; core shell + onboarding loaded eagerly |
| Backend | `index.js`, `config.js`, 4 middleware, 8 routes, 6 services, 3 utils, `package.json` | Express 4, JSON "DB" (`server/data/*.json`, gitignored), ffmpeg-based transcoding |
| Scripts | `scripts/setup.js` (CLI wizard), `scripts/generate-cert.js` (mkcert/openssl) | |
| Missing | **No tests, no ESLint/Prettier config, no root package.json, no lock file** (`package-lock.json` is gitignored — F-30) | |

**Dependency audit (server):** all 17 declared dependencies are imported somewhere — no
unused packages. `sharp` is promised by README/ARCHITECTURE but is **not** a dependency
(F-26). Frontend ships **zero** third-party runtime libraries (fuse.js is a 4.4 KB
hand-rolled fuzzy matcher, not the real Fuse.js).

---

## 3. Architecture & Data-Flow Map

```
GitHub Pages (docs/)  ── fetch/REST + Bearer JWT ──►  Local Express server (server/)
  vanilla ES-module SPA                              ├── JSON DB: data/library.json, favourites,
  ├─ router (History API, /Vault-V2 base on gh.io)   │   playlists, history, bruteforce, blacklist
  ├─ store (pub/sub + localStorage persistence)      ├── Scanner: chokidar + ffprobe/music-metadata
  ├─ api client (GET cache, abort, retry)            ├── Transcoder: fluent-ffmpeg → chunked stream
  ├─ auth: password → 5-min challengeToken → grid    ├── Thumbnail: ffmpeg screenshots (320px)
  ├─ players: <video> overlay + WebAudio EQ graph    └── multer upload → scanner re-index
  ├─ search: in-memory Fuse-like index               Static: serves docs/ + SPA fallback (same-origin
  ├─ PWA: sw.js shell cache (gh.io only)               playback, avoids mixed content)
  └─ 4 themes × CSS custom properties
```

**Auth flow:** `POST /login` (bcrypt) → challengeToken → `POST /grid` (8-of-16 pattern,
optional order-sensitivity) → access JWT (24 h default) → blacklist on logout. Brute-force:
5 fails / 15 min per IP persisted to `data/bruteforce.json` + a separate response-driven
HTTP failure limiter. Media streams accept `?token=` query auth.

**Design system** (`docs/css/variables.css` + `glass.css` + `themes.css`):
- Spacing 4/8/16/24/32/48/64; radius 8/12/16/22/28/full; easing `--ease-out` cubic-bezier(0.16,1,0.3,1); durations 150/250/400 ms; z-index ladder 0→9998.
- 4 themes (dark default, light, warm, cold) via `[data-theme]` tokens incl. per-theme ambient gradients.
- One glass recipe (fill + `backdrop-filter` + hairline + sheen + shadow), intensity slider 0–100 drives blur/fill; `@supports` fallback for no-backdrop-filter browsers.
- Film grain: SVG-turbulence base64 + PNG noise, `mix-blend-mode: overlay`, JS intensity classes.

---

## 4. Performance Baseline (measured)

| Metric | Value |
|---|---|
| HTML | 36.5 KB → **8.7 KB gz** (critical auth CSS inlined ✓) |
| CSS total | 105.7 KB → **18.5 KB gz** across **13 render-blocking requests** |
| JS total (all) | 246.7 KB → **54.5 KB gz** (views are lazy ✓) |
| JS initial shell (est. gz) | ~40–45 KB (store, api, auth, router, themes, effects, keyboard, pwa, toast, sidebar, search+fuse, **onboarding 8 KB gz eagerly imported**, format) |
| Initial requests (HTTP/1.1 local server) | ~29 (HTML + config.js + 13 CSS + ~15 modules) |
| Images | None in repo; covers/thumbs served by API. Thumbnails 320 px JPEG ✓; **covers served at original size** (F-26) |
| Fonts | System stack only — zero font downloads ✓ (but dead `preconnect` to fonts.googleapis.com, F-27) |
| Compression | **None on the Node server** (no `compression` middleware) — F-1 |
| Minification | None (zero-build by design) — F-8 |
| Backend writes | `writeJsonSync(…, {spaces:2})`, debounced 300–500 ms | 
| Cache headers | Static: none from `express.static` (defaults). Thumbs/covers: `public, max-age=86400` ✓. Streams: `private, max-age=0, must-revalidate` ✓ |

**Estimated vitals (mobile, cold cache):** FCP ≈ 1.2–1.7 s, LCP ≈ 1.6–2.2 s (auth-gate
heading), TBT ≈ 100–200 ms (grain blend + global transitions add style/paint cost),
CLS ≈ <0.05 (aspect-ratio boxes + fixed dock). Lighthouse Perf ≈ 80–90 desktop / 65–80
mobile; **Accessibility ≈ 75–85** (contrast failures below). These are the numbers Stage 7
must beat.

---

## 5. Regression Contract ⚠️ NOTHING HERE MAY BREAK

### Auth & setup
- [ ] Onboarding: 6-step wizard (welcome → server test → account + **live password strength** → 8-square grid with order-matters toggle → theme/paths/CORS → review → complete), skip-to-login when configured, `enablement:true` in response
- [ ] `GET /api/setup/status|defaults`, `POST /api/setup/test|complete|reset` semantics & public-until-done rule
- [ ] Login step → challenge token → grid step; expired challenge returns to password step with message (not dead-end)
- [ ] Grid submit: max-8 selection, clear, count "X / 8", shake on failure, keyboard operable
- [ ] Wrong password/grid → 401; 5 fails → 15-min lock (429 + retry time), survives restart; successes never counted
- [ ] Logout blacklists token (incl. `/verify` reporting revoked); network errors do NOT log user out
- [ ] Login screen: server URL display + change, mixed-content warning only for genuinely blocked non-loopback HTTP URLs
- [ ] `npm run setup` CLI wizard; `npm run generate-cert` with SAN cert

### Library & browsing
- [ ] Home: Continue Watching (5–95 % progress), Recently Added (+ per-type), Favourites, Top Rated, Random Pick with Shuffle, empty state with CTA; welcome username
- [ ] Movies/Music/Videos: grid ⇄ list toggle (persisted), sort select, **debounced** filter, Music: artist/album/genre grouping, Play All, Shuffle
- [ ] Detail pages (movie/video + album/track): play, shuffle, favourite heart (optimistic), edit metadata modal, add-to-playlist modal, share, delete (library-only vs +file), technical-details info, resume-progress positioning
- [ ] History list with progress bars, relative timestamps, play buttons, clear (server + local fallback)
- [ ] Favourites view, live-updating on heart toggle
- [ ] Playlists: create (name/desc/type), open, play-all, delete, add/remove items
- [ ] Library reload after scan/upload/delete/metadata-edit (`getLibrary limit:1000` refresh paths)

### Playback
- [ ] Video: custom overlay controls, buffered/played/thumb scrub + hover preview, click-to-seek, drag thumb, volume/mute, speed 0.25–3×, theatre, PiP, fullscreen, captions toggle, EQ modal, next/prev-episode, **skip intro**, **10 s next-episode countdown + autoplay**, resume from history, direct-play → transcode fallback → error UI with "Try transcoding"
- [ ] Audio: WebAudio graph (10 biquad EQ → compressor → gain → analyser), EQ panel (11 presets + custom save + enable/reset, canvas curve), gapless-ish preload, crossfade 0–12 s (rAF fade + element swap), shuffle/repeat off|all|one, queue add/next, Media Session handlers, mixed-content guard toast
- [ ] Mini-player dock: show/hide, progress rail, transport, volume slider, mute, expand → Now Playing with visualizer bars driven by analyser; shuffle/repeat states
- [ ] Keyboard: Alt/Space search, `?` panel, Esc, G-then-H/M/U/V/P/F/S nav, space/k/j/l/arrows/m/f/t/p/c/n/s/r + 0–9 seek + Shift+N — **only while a player is active**
- [ ] Progress/history persistence (local every 5–10 s + server POST)

### Search & global UI
- [ ] Command palette: 150 ms debounce, fuzzy grouped results, counts, ↑↓/Enter/Esc, lazy thumbs, highlight class, recent searches (10), recently-played section, empty states
- [ ] 4-theme cycle button + Settings theme buttons; glass/grain sliders live-update tokens & overlay
- [ ] Sidebar: collapse persisted, active pill + indicator, mobile hamburger + overlay, logout
- [ ] Breadcrumb label per route; route error + 404 views with Go Home
- [ ] Toasts (success/error/info/warning, auto-dismiss, close button); connection-status bar with retry; `vault:online/offline` handling
- [ ] PWA: SW registered **only on github.io**, shell cache, offline navigation → index; update-available event
- [ ] Settings: volume/crossfade/gapless, API URL save + test, trigger scan, credentials change (password/user/grid), logout, server health JSON

### Server/API
- [ ] Range streaming (206), cover/thumb caching, subtitle serving with SRT→VTT, `?token=` auth
- [ ] Upload: per-type dirs, magic-ish mime + extension + blocklist validation, collision-safe names, metadata overrides, cover/subtitle sidecar handling, progress via XHR
- [ ] Scanner: mtime/size skip, batch scan, remove-missing on full scan, watcher add/change/unlink, graceful-shutdown flush
- [ ] Rate limits: general (media/transcode exempt), auth-failure-only counting, upload cap
- [ ] Deploy workflow greps (`onboarding.css/js`, `enablement`, `VAULT_ENABLEMENT`) keep passing

---

## 6. Findings

### 🔴 Critical performance issues

**F-1 · No HTTP compression on the server.** `server/index.js` has no `compression`
middleware (and no brotli). Every JSON response — notably `GET /api/library` returning up
to 1 000 full items (paths, subtitles, metadata) — goes out uncompressed, likely 300 KB–1 MB
≈ 5–10× larger than gzipped. Also affects static assets when the Node server serves the UI
(the recommended same-origin mode).
*Impact: largest single payload win available. Fix in Stage 2 via `compression` (gzip;
brotli is build-time territory we don't have).*

**F-2 · Global `* { transition-property: …; transition-duration: 0.3s }` in `themes.css`.**
Every element in the app — including all 1 000 media cards — tracks transitions on
`background-color, border-color, color, box-shadow`. Consequences: (a) hovering or
re-rendering hundreds of nodes keeps style recalculation/transition bookkeeping hot;
(b) a theme switch triggers a paint storm across every node; (c) it silently fights
component-level `transition: all` rules. This is a textbook anti-pattern.
*Fix direction: scope the theme-transition to a root-level class applied only during theme
switches (`.theme-transition *`), or drop the blanket rule — component CSS already defines
its own transitions everywhere that matters.*

**F-3 · `will-change: transform` on every `.media-card-cover img`.**
`components.css` promotes each card image to its own compositor layer. A 1 000-card grid ⇒
1 000+ GPU layers (each ≥ card-sized texture) → GPU memory blowup, slower style/layout,
exactly the opposite of the intent. *Fix: remove `will-change`; the hover `scale(1.05)`
transition runs fine without it, or add it only in `:hover`.*

**F-4 · Store subscription leak in every list view.**
`store.subscribe()` returns an unsubscribe function, but `views/movies.js`, `music.js`,
`videos.js`, `favourites.js`, `history.js` never call it — and route mounts wipe the DOM
(`viewContainer.innerHTML = ''`) without cleaning up. Each navigation to a view adds
permanent listeners that re-render **detached** containers on every library/history event.
After a browsing session this is dozens of redundant full re-renders per event + retained
DOM trees (memory leak + progressive slowdown).
*Fix: router should provide a per-mount cleanup registry (`onUnmount`), or views capture and
invoke the returned unsubscribes when a `vault:before-unmount` fires.*

**F-5 · Film-grain overlay: full-viewport `mix-blend-mode` + infinite animation above
everything.** `#grain-overlay` is `position: fixed; inset: 0; z-index: 9998` (above modals,
toasts, auth gate, onboarding), and `::after` is a **2× viewport-sized** layer (`inset:-50%`)
animated `translate` via `steps(10)` **forever**. Blending that layer re-composites the whole
screen on every step; on low-end GPUs this is a constant tax while the app is idle.
Also a stacking-correctness smell: grain paints over dialogs and the login screen.
*Fix: lower z-index below UI (e.g. between ambient and content), drop `inset:-50%` to
`inset:0` (the shift animation only needs small deltas), pause the animation when the tab
is hidden, and default the animated layer off in favor of the static variant already
shipped (`.grain-static` — currently dead code, F-33).*

**F-6 · JWTs leak into access logs.** Media URLs carry `?token=…` and `morgan('combined')`
logs full query strings → long-lived bearer tokens on disk in server logs. Combined with
**F-7** below, this is the worst security pairing found.
*Fix: redact `token` in morgan format, or (better, Stage 3+) move media auth to short-lived
signed URLs.*

**F-7 · Error stack traces sent to clients by default.** `errorHandler` appends `err.stack`
whenever `NODE_ENV !== 'production'` — the server never sets `NODE_ENV`, so production
self-hosters get stacks in responses. *Fix: invert the default (only include when
`VAULT_DEBUG=true`).*

**F-8 · Transcode cache cleanup never runs.** `transcoder.cleanupCache()` (the 5 GB LRU the
README promises) is exported but **never called**; `cache/transcoded` grows unbounded until
the user manually hits `DELETE /api/transcode/cache`. *Fix: schedule cleanup (interval +
after transcode completes) in Stage 2/3.*

### 🟡 Moderate optimization opportunities

- **F-9 · 13 render-blocking CSS files, un-minified, un-merged.** On HTTP/1.1 (local
  server) that's 13 round trips before first paint. Stage 2: concatenate into one
  `vault.css` (keeping per-file sources), minify, and keep the inline auth-gate critical CSS.
  No behavior change, big connect-time win on LAN/HTTP1.1.
- **F-10 · `onboarding.js` (35 KB raw / 8 KB gz — largest module) is statically imported**
  by the entry script even though it only runs when `needsSetup`. Dynamic-import it inside
  `showOnboarding()`.
- **F-11 · No pagination in the client.** `getLibrary({limit:1000})` is hardcoded in six
  places; the server paginates but the client ignores it. >1 000-item libraries silently
  truncate; every refresh ships the whole index. Stage 3: windowed fetching or cache+增量.
- **F-12 · Grids render every item into the DOM** (1 000 cards). `content-visibility:auto`
  mitigates paint, but `contain-intrinsic-size: 180px 270px` mismatches music (1:1) and
  video (16:9) cards → scrollbar jumping. Virtualization (small, dependency-free
  windowing) or at least per-type intrinsic sizes are Stage 3 candidates.
- **F-13 · `.stagger > *` entrance animation applies to every card in every grid** — a
  1 000-card render fires 1 000 animations simultaneously. Cap stagger to the first ~12
  visible cards (CSS `nth-child(n+13) { animation: none }`).
- **F-14 · Server-side per-request work:** `GET /api/library` rebuilds search haystacks
  per item per call, and when no filter applies it calls `.sort()` **on the master in-memory
  array** (`getAll()` returns the live reference — side-effecting global state). Search
  result ordering also depends on prior mutation. Cache a haystack + sort key per item at
  index time; sort a copy.
- **F-15 · Sync JSON writes on the event loop.** `writeJsonSync(spaces:2)` for library /
  blacklist / bruteforce / playlists runs synchronously; a large `library.json` (1 000 ×
  ~1 KB) blocks the server ~tens of ms per debounced save. Use async writes (or
  `writeJson` + atomic rename) and drop `spaces` in hot paths.
- **F-16 · Cached transcodes ignore Range.** `GET /api/transcode/:id` sets
  `Accept-Ranges: bytes` but pipes the whole cache file regardless of `Range` → seeking in
  a cached transcode re-downloads from 0 or stalls. Reuse `sendFileWithRange` (which is
  otherwise solid).
- **F-17 · Music filter input is not debounced** (movies/videos use 150 ms) — `renderMusic`
  does a full grid rebuild per keystroke; also its `getFiltered()` bypasses the `_haystack`
  optimization the other views use.
- **F-18 · Home view delays content by an artificial `setTimeout(…, 300)`** and rebuilds via
  full `innerHTML` on every visit; random-pick shuffle updates through a fragile
  `querySelector('div div div')` chain.
- **F-19 · Unthrottled/global input handlers:** video player `mousemove` (adds/removes
  classes + resets a timeout per event, not passive), document-level thumb-drag `mousemove`,
  `vault:timeupdate` CustomEvent dispatched every rAF (~60/s) even when no UI is visible.
  rAF-gating exists (good) but events should skip dispatch when Now Playing/mini-player
  aren't shown.
- **F-20 · `express.static` serves the SPA with no cache policy** (no `maxAge`,
  no immutable hashed assets — fine for zero-build, but HTML/CSS/JS get revalidated every
  visit). Add short `max-age` + ETag tuning; keep `no-cache` for `index.html`.
- **F-21 · Covers shipped at original size** (embedded album art can be 2–10 MB each;
  grid view fetches dozens). README promises optional `sharp` resizing — not installed.
  Stage 2/3: add `sharp` (justified dependency) for 320/640 px cover variants, or
  ffmpeg-based resize to avoid a native dep.
- **F-22 · Dead network/feature paths:** SSE `/api/events` implemented server-side but
  never consumed by the client; `showInstallPrompt()` never called; `vault:update-available`
  fired but nothing listens (no "new version — refresh" toast). Cheap QoL wins later.
- **F-23 · Video controls row has no responsive rules** — 7 right-side buttons + left
  cluster overflow small phones (≤400 px). `.media-list` fixed `1fr 120px 80px 60px` grid
  also has **no** mobile breakpoint → title column collapses to slivers on ≤480 px.
- **F-24 · Docs drift:** README says "LRU cache 5 GB" (F-8: never runs), "CSP" via helmet
  (F-25: disabled), "sharp optional" (F-21: absent). Stage 7 must reconcile docs with reality.

### 🟢 Minor improvements

- **F-25 · `helmet({contentSecurityPolicy: false})`** — CSP disabled while ARCHITECTURE/
  README claim XSS protection via CSP. (Security, but also cheap to restore with the
  documented policy.)
- **F-26 · CORS middleware allows every origin anyway** (`callback(null, true)` even when
  blocked) — the allow-list is decorative. Either enforce or simplify (documented as
  intentional for personal use; flag for the user).
- **F-27 · Dead `preconnect` to fonts.googleapis.com** — no font stylesheet exists; remove
  (saves a DNS+TLS handshake or drop it from preload hints).
- **F-28 · Stub/dead modules:** `components/collections.js`, `metadataEditor.js`,
  `uploadModal.js` (navigates to /upload), `detailView.js` (re-export), all unreferenced;
  unused imports (`renderMediaList` in history.js, `formatRelativeTime` in home.js);
  `store.applyFilters`/`_haystack` machinery mostly bypassed by views; keyboard manager's
  `register()/unregister()` API unused (logic is hard-coded).
- **F-29 · `console.log` ×10 + init logging** in production frontend paths (store warns ok);
  SW logs on install/activate. Trim the informational ones.
- **F-30 · Lock file gitignored** — installs are non-reproducible; no lint/test anywhere;
  CI only deploys. (Repo-hygiene, Stage 2 scope decision needed.)
- **F-31 · Deprecated `String.prototype.substr`** ×2 (keyboard.js, library.js).
- **F-32 · Redundant persistence:** `themes.js` writes localStorage directly *and* via
  `store.set(…, persist)` (double-write per change).
- **F-33 · Unused CSS:** `.grain-static`, `.card-grain`, `.keyboard-nav` rules, `.hover-lift`,
  `.pulse`… (verify per-class usage before pruning in Stage 3).
- **F-34 · `manifest.json` `start_url: "/Vault-V2/"`** breaks when the UI is served by the
  local server at `/` (install prompt points at a 404 path).
- **F-35 · `onboarding.bindEvents` adds a `document` keydown listener on every render()**
  — re-entering the wizard double-binds (guarded by an element check, but the listener
  persists forever after).
- **F-36 · `history.js` rebuilds rows with per-row listeners; `mediaList` uses inline
  `onerror` attributes** — works, but CSP-friendly cleanup belongs in Stage 3.
- **F-37 · EQ canvas fixed 800×200 backing store** regardless of CSS size — blurry on
  HiDPI / stretched on wide panels (scale by `devicePixelRatio` in Stage 5).
- **F-38 · `skip-intro` and `next-episode-overlay` share the same position** (bottom 88px,
  right) — they can overlap when both show.

### 🎨 Visual / contrast / liveliness issues

Computed WCAG ratios (sRGB, measured against each theme's `--bg-primary`):

| Token / usage | dark | light | warm | cold | Verdict |
|---|---|---|---|---|---|
| `--text-tertiary` (hints, kbd, placeholders, section titles, meta) | **3.49** | **2.85** | **2.35** | **4.22** | ❌ AA fail in **all four** themes (needs 4.5) |
| `--text-secondary` | 7.29 | 5.10 | ~4.9 | ~6 | ✅ |
| `--text-primary` | 17.6 | ~15 | ~13 | ~15 | ✅ AAA |
| `error #EF4444` as text (auth-error, onboarding error) | 5.32 | **3.45** | — | 5.32 | ❌ light fail |
| `success #22C55E` as text (onboarding success, connection test) | 8.78 | **2.09** | — | 8.78 | ❌ light fail |
| `warning #F59E0B` as text (mixed-content warning) | 9.31 | **1.97** | — | 9.31 | ❌ light fail |
| White on `--accent` (btn-primary, play buttons, badges) | **4.35** (#7C5CFF) | 5.16 | ~4.0 (#D97706) | ~10 | ⚠️ dark/warm marginally under 4.5 for 14 px bold |
| `--accent` as text (nav active, links, counts) | 4.60 | 5.16 | **2.89** | 10.76 | ❌ warm fail |

**C-1 · `--text-tertiary` fails AA in every theme** — the single biggest contrast defect;
it's used everywhere small text lives (11–13 px hints, `kbd` chips, grid-square numbers,
placeholders, `.search-trigger` label, breadcrumbs, list headers, empty-state footers).
Fix by lifting the alpha per theme (e.g. dark 0.38→0.55+, light 0.42→0.58+, warm
0.42→0.60+, cold to ≥ #94A3B8 full) while keeping the hierarchy vs secondary.
**C-2 · Status colors as text fail on light/warm** (error/success/warning boxes in auth,
onboarding, connection tests) — darken per-theme (`--error` etc. already differ per theme;
the *hard-coded* `#EF4444/#22C55E/#F59E0B` literals in `index.html` inline CSS,
`onboarding.css`, and `search`/`auth` boxes bypass the theme tokens). Use theme tokens.
**C-3 · Warm-theme accent-as-text (2.89:1)** — nav active, badge, links in warm need a
darker accent variant for text usage (`--accent-strong` #92400E passes).
**C-4 · btn-primary white-on-accent 4.35:1** — nudge gradient start to ≥ #6B4FE0 (hover
stop already passes) to clear AA for bold 14 px.
**C-5 · Focus management:** `*:focus{outline:none}` is paired with `:focus-visible` (OK),
but **modals/command palette don't trap Tab** (comments in `accessibility.css` literally
say "Focus first element" with no implementation), skip-link target `#main-content` isn't
`tabindex="-1"`, and video progress/volume have no keyboard-operable slider semantics.
**C-6 · Touch targets:** `@media (pointer:coarse)` covers `.btn/.nav-item/.media-card/
.btn-icon` but misses search trigger, view toggles, filter chips, EQ presets,
`toast-close`, mini-player buttons (34–38 px). Target ≥44 px.
**C-7 · Color-only states:** login grid selection = fill color + scale only (onboarding
grid has a ✓; login grid doesn't) — add check/pressed semantics. History progress bars
carry no numeric/ARIA text.
**C-8 · Reduced motion:** covered globally in `animations.css` (animations + transitions)
and grain — ✅ strong already; keep intact through all stages.
**C-9 · Dead/sterile spots to elevate (Stage 5):**
  - Playlists page: **broken loading state** — `.skeleton-grid` class is referenced by
    `playlists.js`/`home.js` but **defined nowhere in CSS** → users see an empty div while
    loading (use `renderSkeletonGrid`).
  - Settings page: five visually identical flat cards; About card is plain text.
  - Upload drop zone & type cards: functional but flat (border-dashed box).
  - List view rows: no visual accent rhythm (alternating tint/dividers are minimal).
  - 404 page: has icon + Go Home but no search/quick-links.
  - Empty states elsewhere are actually good (icon + message + CTA) — use them as the model.
**C-10 · Micro-interaction gaps:** `.view-toggle button` has transition but **no :hover
style**; sort `<select>` uses default OS chrome (no custom arrow/appearance) inconsistent
with glass inputs; footer/nav items fine. Native `confirm()`/`alert()` in delete flows and
"Technical Details" break the design language (also blocks the toast system).

### ✨ QoL feature opportunities (implement only where they fit)

1. **Copy-to-clipboard buttons**: server URL (login/settings), media file path (detail),
   grid pattern at setup-complete (with "copied ✓" toast) — high value, zero deps.
2. **Real breadcrumbs**: `#breadcrumb` shows a single title; detail pages could show
   `Movies › Title`.
3. **Sortable list headers** in `mediaList` (title/duration/year columns are static) +
   sticky header for long lists.
4. **Back-to-top** floating button on long grids; **scroll-position restoration** when
   navigating back from detail (router currently drops it).
5. **Fix + extend skeletons** (C-9) — playlists, and a shimmer skeleton for the detail page
   already exists ✓.
6. **SW update toast** — listen to `vault:update-available` → "New version — Refresh".
7. **Replace `confirm()/alert()`** with the existing modal/toast system.
8. **Relative timestamps with `<time title>`** full stamp (history already relative ✓ —
   add hover detail + `<time datetime>` semantics).
9. **First-run system theme detection** (`prefers-color-scheme` when no saved theme) —
   currently always defaults dark despite light being available.
10. **Media-list responsive collapse** (F-23) — hide year/duration columns ≤640 px rather
    than overflowing.

---

## 7. Risk Register (things Stage 2+ must not disturb)

1. Deploy workflow greps (`onboarding.css/js` referenced in index.html, `enablement` in
   setup routes/config, `VAULT_ENABLEMENT`) — renaming files or strings breaks CI.
2. Inline auth-gate CSS in `index.html` is the first-paint path — don't move it into a
   deferred sheet.
3. `window.VAULT_CONFIG` must load **before** any module reads config (`config.js` in head).
4. Glass token derivation (`--glass-intensity` → blur/fill/hairline calcs) and the
   `@supports not (backdrop-filter)` fallback must stay consistent if CSS is concatenated.
5. Event contract (`vault:*` custom events) is the de-facto API between 40+ modules —
   renames are cross-cutting.
6. `?token=` media auth and loopback mixed-content exemption (recently fixed per CHANGELOG
   2.0.1) are load-bearing for GitHub Pages playback.
7. Rate-limiter `skip` rules for `/media/` + auth-failure-only counting (recently fixed) —
   do not regress.
8. Changelog 2.1.0 documents the glass/sidebar/dock z-index system (z 90/100/120) — keep.

---

## 8. Suggested Stage 2 scope (for approval)

1. **Compression** middleware (F-1) + static cache headers (F-20).
2. **CSS pipeline**: concatenate + minify 13 sheets → one file (keep sources), preserving
   order semantics; inline auth CSS untouched (F-9).
3. **JS**: dynamic-import `onboarding.js` (F-10); trim dead preconnect (F-27); drop
   informational console.logs (F-29).
4. **Guardrail fixes that belong to "infrastructure"**: morgan token redaction (F-6),
   stack-trace default-off (F-7), transcode-cache cleanup scheduling (F-8).
5. **Env/config hygiene**: decide on lock-file policy + minimal ESLint/Prettier config
   (F-30) — no behavior change.
6. Defer F-11/F-12/F-14/F-15/F-16 (server/client data-path work) to Stage 3; all contrast
   (C-*) to Stage 4; liveliness (C-9/C-10) to Stage 5; QoL list to Stage 6.

**No functionality changes. Every checkbox in §5 must remain green after each stage.**
