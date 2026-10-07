# Changelog

## [3.0.0] — in progress (branch `arena/0deefe55-vault-v2`)

### Efficiency pass — dead code stripped, hot paths fixed
Five-stage scan (dead modules/exports/imports → DOM & CSS → duplication →
client hot paths → server hot paths), then the findings were removed or fixed:

**Removed (nothing was reachable)**
- Dead stub modules: `components/collections.js`, `detailView.js`,
  `metadataEditor.js`, `uploadModal.js`, `utils/validators.js`
  (the AUDIT.md F-28 list, now gone).
- 21 exports nothing referenced (`getAudioElement`, `openLyricsModal`,
  `sleepStatus`, `toggleSidebar`, `manageProfile`, `formatDuration`,
  `slugify`, `parseYear`, `getFileExtension`, `preloadImage`, the unused
  constants, …) and 12 unused imports.
- **`renderStatsPanel` / "Playback stats"** was unreachable too — instead of
  deleting the feature it is now wired into the player's quality menu.

**Fixed**
- Three leaked `window` listeners that stacked on every route change
  (Continue Watching, the EQ panel, Settings → Devices) — they now register
  through `utils/lifecycle.js` and detach on unmount.
- A stale-view write in Settings (`#server-info`) that threw once the request
  resolved after navigating away.
- mDNS cache-flush TTL overflow (`ttl | 0x80000000` is negative in JS and
  Buffer rejects it) — the announcement previously failed with a warning.
- Install-to-home-screen prompt was never wired: `initInstallPrompt()` now
  exposes `window.vaultInstall` and Settings → Devices offers the button.
- `searchMetadata()` accepts `q` (the server expects `query`).

**Server performance**
- Library index operations are O(1): `updateItem` merged in place via `idMap`
  instead of `findIndex` + array swap, `removeItem` splices only the affected
  type bucket instead of rebuilding every index, `addItem` de-dupes through
  `idMap`/`pathMap`. A 20 000-item rescan no longer degrades to O(n²)
  (isolated benchmark: 20 000 updates 3 633 ms → 4 ms; 500 removals
  1 445 ms → 2 ms).
- `/api/system/disk` walks the cache tree once (sub-totals from the same pass)
  with batched `stat` calls — 5.2× faster on 3 400 files — and is memoised for
  15 s; `/api/system/health` probes the filesystem with bounded concurrency
  and a 30 s TTL, invalidated by scans, prunes, cache clears and restores.
- `prune-missing` uses the parallel probe pass; the deep health scan's
  sidecar check went from O(n²) to set lookups.

**Tooling**
- `scripts/import-check.js` now also reports imported-but-unused bindings
  (warnings; `--strict` fails) — the class of dead weight this pass removed.
- `scripts/config-example.js` regenerates `server/config.example.json` from
  `DEFAULT_CONFIG` with portable paths and placeholders (`npm run
  config:example`).
- Server tests 24 → 35 (mDNS packet builders, library index consistency).

### Added
- **Server subsystems (18):** events (SSE bus + job tracking), trash (soft
  delete with retention + restore), extras (watchlist, collections, smart
  rules, markers, bookmarks, podcast feeds, listen stats), profiles + sessions
  (per-profile libraries/history, PINs, session list/revoke), stats
  (Wrapped-style recap), SQLite index (optional, `node:sqlite`), transcode plan
  (quality ladder, hardware-accel detection), metadata agents (TMDB/MusicBrainz/
  NFO), podcasts (RSS/Atom + episode download), comics (CBZ reader), live TV
  (M3U/HDHomeRun/XMLTV + DVR), SyncPlay (rooms, drift correction, chat),
  notifications (webhook/ntfy/Discord/Telegram + Last.fm/ListenBrainz
  scrobbling), system (health, backups, log ring, disk usage), Subsonic API,
  HLS streaming (on-demand segmenter + playlists), JSON store utility, TOTP,
  ignore rules.
- **REST surface:** `/api/extras`, `/api/series`, `/api/profiles`,
  `/api/system`, `/api/podcasts`, `/api/comics`, `/api/livetv`,
  `/api/syncplay`, `/api/agent`, `/rest` (Subsonic), live `/api/events`;
  artwork/trailer/extras/trickplay/lyrics/chapters/plan/sources endpoints;
  playlist order/export/import/stats; HLS playlists; `/api/library/libraries`
  and `/api/library/recent`.
- **Client:** context menus with queue/watchlist/watched/trash-undo, Up Next
  queue panel (drag to reorder, save as playlist), synced lyrics with offset
  nudge, sleep timer + stop-after with fade, cast button, bookmarks,
  "stats for nerds", skip intro/recap/outro, chapter chips, trickplay scrub
  previews, quality selector, home hero + "Next up" + "Because you watched"
  rows, shows/seasons/episodes pages, My List, Continue Watching, Stats/Wrapped,
  profiles picker, server console, trash, downloads, podcasts, comics reader,
  live TV/DVR, SyncPlay rooms, QR pairing, multi-select batch actions, mobile
  gestures, bottom navigation, ambient artwork colours, offline downloads,
  quality badges, playlist export/import/drag-reorder, live updates over SSE.
- **Docs/config:** `server/config.example.json` regenerated from the real
  defaults (TOTP, profiles, Subsonic, libraries, ignore rules, scan schedule,
  storage backend, trickplay, trash, extras, notifications, Live TV, podcasts,
  metadata providers). Vendored `hls.js` + `qrcode-generator` under
  `docs/vendor/` with licences.

### Changed
- `docs/js/api.js` accepts plain-object request bodies (normalised to JSON) and
  gained the full v3 method surface + `markCompleted`.
- Video player emits `vault:video-opened` / `vault:timeupdate` /
  `vault:item-finished` and marks items completed on `ended`.
- `docs/css/v3.css` added to the CSS build (13 sheets → 93.5 KB minified,
  16.7 KB gzip).

### Verification
- `npm run lint` (syntax-check): 129 files OK · `node --test`: 24/24 pass ·
  server boots and serves `/api/health` 3.0.0.

## [Unreleased]

### Added
- **Icon system: emoji + dingbats → inline SVG.** Every UI glyph that was an
  emoji (🎬 ♫ 🔒 ✨ …) or a font-dependent dingbat (⌕ ≡ ◷ ∅ ⧉ ▲ ⛶ ↑ ✕ …) is now
  an inline stroke SVG from a single registry.
- **`docs/js/utils/icons.js`** — 55-icon set on the 24×24 Lucide grid, exposed as
  `icon(name, opts)` (template strings), `iconEl()` (live element), `setIcon()`
  (runtime glyph swaps), `setIconLabel()` (icon + text button) and
  `hydrateIcons()` (fills `[data-icon]` slots in static markup). All artwork is
  `stroke: currentColor` + `aria-hidden`, so icons follow the theme, cost no
  extra request, and never carry a second accessible name.
- `index.html` boots through `hydrateIcons()`; `docs/js/utils/icons.js` added to
  the service-worker shell (cache bumped `vault-v2-shell-v2` → `v3`).
- **`scripts/keyboard-check.js`** (`npm run test:keyboard`) — 22 zero-dependency
  checks driving the real `docs/js/keyboard.js` through a DOM stand-in, no
  browser or npm install required. It fails on the pre-fix handler (13 of its
  cases) and passes now; run it with `scripts/syntax-check.js` when touching the
  global key layer.

### Fixed
- **Space could not be typed into any form field.** The global shortcut layer
  handled `Space` → play/pause ahead of text entry (only `#search-input` was
  special-cased), so upload metadata — title, artist, album, genre, description
  — plus settings/onboarding inputs, swallowed every space. Typing now always
  wins; player keys only run while a player is open.
- **Media shortcuts fired with nothing playing.** The player probe matched the
  always-present `.video-player` node inside the hidden video modal, so `s`,
  `n`, `c`, `f`, `m`, `p`, `t`, `r`, `j`, `l`, `k` — and now `0`-`9` seeking,
  which was previously unreachable dead code — hijacked keystrokes on every
  page. The probe now checks for a genuinely visible player
  (`#video-modal.active`, `#mini-player.active`, `#now-playing.active`).
- **Space/Enter on a card's play button opened the detail view instead of
  playing.** The card/row keydown handler ran on bubbled events from the nested
  `.media-card-play` / `.media-list-play` button and `preventDefault()`-ed them;
  both handlers now ignore events whose target is not the card/row itself.
- Browser/OS chords (`Cmd+P`, `Cmd+S`, `Cmd+R`, `Ctrl+N`) are no longer
  swallowed by player shortcuts, and a focused control keeps its own keys
  (Space on a button/checkbox, arrows on a slider or `<select>`).

### Changed
- Replaced emoji/dingbats in: header (menu, search, theme, shortcuts), mini
  player + Now Playing (prev/play/pause/next/expand/mute/shuffle/repeat incl.
  repeat-one), video player (play/pause/mute/fullscreen ⇄ minimize, captions,
  EQ, theatre, PiP, next, close), sidebar nav + collapse arrows, toast status
  icons + close, media cards/list (play, placeholder covers, sort indicators),
  search palette (input, empty, no-results, recent), empty states across
  home/library/history/playlists/detail/404, favourites (outline ⇄ filled
  heart), rating star, copy buttons, upload flow (media-type cards, drop zone,
  file removal), settings section chips + external-link, and all 8 onboarding
  steps (feature icons, connection statuses, footer nav, complete badge).
- `metaGrid`, `searchModal`, `sidebar`, `detail`, `settings`, `upload`,
  `onboarding` etc. now emit icon markup through the shared helper instead of
  hand-written SVG strings (the duplicated shuffle/repeat markup in
  `index.html` + `miniPlayer.js` is gone).
- Check badges (login grid + onboarding grid) are masked inline SVG instead of
  `content: '✓'`, so they no longer depend on a system font carrying the glyph.
- `favicon.svg` V-mark is now a stroked `<path>` rather than `<text>` — identical
  rendering everywhere (launchers/tools without system-ui fonts included).
- Favourite buttons gained `aria-pressed` + a stateful `aria-label`; the
  fullscreen control now reflects state; attribute labels use `escapeAttr()`.

## [2.2.0] - 2026-09-27

Seven-stage repository optimization (audit → build → perf → accessibility →
UI → QoL → review). 15 commits on `arena/01a0dfb1-vault-v2`; every stage
verified against the AUDIT.md §5 regression contract before the next began.

### Performance — build, delivery, hot paths
- **CSS: 13 render-blocking stylesheets → 1.** `scripts/build-css.js` concatenates + minifies the 12 sources into `vault.css` deterministically (same md5 every run): 114,992 B sources → 76,507 B min → **13,337 B gz / 12,904 B on the wire (brotli)** — vs 18.5 KB gz across 13 requests before.
- **Compression middleware** (`server/middleware/compression.js`): brotli/zlib with proper `q`-value negotiation, SSE/Range/video exemptions, drain bridging — the Node server previously sent everything uncompressed.
- **Static cache policy**: `max-age=3600, stale-while-revalidate=604800` for versioned assets, `no-cache` for `sw.js`/config/HTML; access-log token redaction (`token=[redacted]`).
- **Backend data paths**: `writeJsonAtomic` (per-path write chain, temp+rename), sort-on-copy instead of mutating the master library array, WeakMap search haystack that self-invalidates, Range-aware transcode cache (206 on cached seeks), slice+decorate-sort on the library route.
- **Frontend**: `api.getLibrary` auto-pagination (fetches all pages in parallel when no explicit page), view subscription lifecycle (`docs/js/utils/lifecycle.js` — no leaks/stale writes), theme-switch stack-overflow fixed (~10k dispatches → exactly 1 per switch), scoped theme-transition class, `will-change` removed (1 000+ GPU layers), stagger capped at n+13, grain z-index/inset aligned, intrinsic-size dual declarations, onboarding lazy-loaded (~8 KB gz off the critical path).
- Tests: **0 → 24** (`node --test`: compression 18 + file serving 6); `scripts/syntax-check.js` green over 78 files.

### Accessibility — WCAG AA in all four themes (C-1–C-8)
- `scripts/contrast-check.js` (zero-dep, CI-ready): **baseline 14 FAIL/36 → 32/32 PASS**.
- Hierarchy lifts: tertiary alphas per theme (AA with margin), secondary where under AA; light status colors darkened to AA; warm warning distinct from accent.
- New accent roles per theme — `--accent-text`, `--accent-solid`, `--btn-accent-end`, `--on-accent`; ~20 usage swaps moved content off raw `--accent` (cold keeps bright cyan with a dark label; warm buttons deepen). Rating stars fixed (2.1:1 → AA on light).
- Focus traps on modals/command palette/shortcuts panel (new `utils/focusTrap.js`), Escape + focus restore; skip-link target focusable; video seek slider with live ARIA; history progressbars; login grid `aria-pressed` + ✓ cue; coarse-pointer targets extended to 44 px; `prefers-reduced-motion` blocks untouched by design.

### UI — sterile spots elevated, micro-interactions (C-9/C-10)
- Playlists skeleton fixed (was a blank div), settings cards get icon chips + hover lift, upload drop zone states, list-row zebra + accent edge, 404 gains Search + quick links.
- `.view-toggle` hover, custom select chevron, `.btn-danger`; native `confirm()`/`alert()` replaced by promise-based `components/confirmDialog.js` riding the trapped modal (delete uses one dialog + checkbox instead of two prompts).

### QoL (Stage 6)
- Sortable sticky list headers with ARIA + `<select>` sync; F-23 column collapse ≤640 px (library lists only).
- `Movies/Albums/Videos › title` breadcrumbs with section links; per-path scroll restoration + back-to-top (reduced-motion aware).
- Copy-to-clipboard (server URL, file path, grid pattern) via `utils/clipboard.js`.
- SW `vault:update-available` → sticky Refresh toast; first-run theme follows `prefers-color-scheme`; history `<time datetime>` + full-stamp tooltip.

### Fixed — pre-existing defects found and repaired
- Library sort mutated the shared store array (view order leaked across renders) — fixed by sorting a copy.
- Search over 1 000 items re-serialized the library per keystroke — cached haystack.
- Theme switch recursion (`RangeError` swallowed by store try/catch) — idempotence guard.
- `.skeleton-grid` referenced but defined nowhere; `aria-hidden` CSS rule hiding the grain overlay (2.1.0); sidebar active indicator clipped; mini-player/sidebar seam (2.1.0).
- Onboarding setup-complete displayed `enablement` as always-`true` (ternary bug, found in final review).

### Metrics (Stage 7 — measured in this environment)
| Metric | Before | After |
|---|---|---|
| Render-blocking CSS requests | 13 (105.7 KB → 18.5 KB gz) | **1** (76.5 KB min → 13.3 KB gz, 12.9 KB wire br) |
| Initial first-wave requests (est.) | ~29 | **~18** (1 HTML + config + vault + 15 shell modules) |
| Initial JS shell | ~40–45 KB gz (onboarding eager) | **25.3 KB gz / 21.2 KB br** (onboarding lazy) |
| Server compression | none | **brotli/gzip** negotiated, cached headers |
| Server tests | 0 | **24/24** |
| Token contrast (AA, 4 themes) | 14 FAIL / 36 | **32/32 PASS** |
| Theme-switch event dispatches | ~10 000 + RangeError | **1** |
| Dialog focus management | none | trapped + restored, Escape everywhere |
| Syntax/lint coverage | none | **78 files** green (`npm run lint`) |

Regression contract: AUDIT.md §5 (48 items) verified — static markers 38/38,
server tests 24/24, deploy-workflow greps intact; interactive flows
(playback/EQ/keyboard) code-reviewed, no removals anywhere in the series.

## [2.1.0] - 2026-09-26

### Fixed — the seam between the sidebar and the player
- **The mini-player no longer slides underneath the sidebar.** It was `position: fixed; left: 0; right: 0` — a full-bleed 80px bar with `z-index: 80` running *under* the sidebar's `z-index: 100`. Because the sidebar is translucent and blurs its backdrop, the player's cover, title and transport buttons smeared through it and its top border/hairline doubled up against the sidebar edge — the graphical glitch at the sidebar/player junction.
  The dock is now `z-index: var(--z-mini-player)` = **120**, above the sidebar (100) and header (90), so even where the shells overlap the player floats cleanly on top instead of ghosting through the glass.
- **The dock is centred inside the content stage, not the viewport.** It is bounded by `left: var(--sidebar-track)` / `right: var(--shell-gap)` with `max-width: 780px` and auto margins, so it can never reach the sidebar column — at 1440px it sits at x 457–1237, at 1024px it starts exactly where the sidebar island ends. It follows the sidebar when it collapses (`.app.sidebar-collapsed ~ #mini-player`) and owns the full width once the sidebar goes off-canvas (≤1024px).
- **Sidebar active indicator was invisible.** `.nav-item.active::before` sat at `left: -8px`, outside the sidebar's box, where the sidebar's `overflow: hidden` chopped it off. It now lives inside the pill at `left: 3px` with an accent glow, and is hidden when the sidebar is collapsed (where it would collide with the centred icon).
- **The film-grain overlay was never rendered.** `docs/css/accessibility.css` had `[aria-hidden="true"] { display: none }` — equal specificity to `.grain-overlay` but loaded after it, so the decorative overlay (and anything else marked `aria-hidden`) was display:none. Removed; `aria-hidden` is an a11y hint, not a presentation switch.
- **Collapsed-sidebar layout:** section titles are `display: none` when collapsed (previously `width: 0` on a block left a stray gap), nav items centre their icon, and the collapse button's label is hidden instead of relying on the shared `.nav-label` rule.

### Added — a real glassmorphism material system
- `docs/css/glass.css` rewritten as one recipe used by every floating shell: translucent tinted fill (`rgba(var(--glass-tint), …)`) + `backdrop-filter: blur() saturate()` + hairline border + **inset top sheen** (`inset 0 1px 0 var(--glass-highlight)`) + deep diffuse shadow + generous radius. Variants: `.glass`, `.glass-strong`, `.glass-subtle`, `.glass-flat`, `.glass-island`, `.glass-hover`, `.glass-sheen`, plus a `@supports not (backdrop-filter)` solid fallback.
- **Ambient light layer** (`#ambient` in `docs/index.html`, styled in `docs/css/themes.css`): a fixed, gradient-lit backdrop with per-theme colour leaks and a vignette. Without something behind it, `backdrop-filter` has nothing to frost and glass reads as flat grey — this is what makes the whole UI read as glass. The app shell and `.main` are now transparent so the light shows through.
- **Floating shells instead of full-bleed panels.** Sidebar, header and player are rounded islands inset from the viewport by `--shell-gap` (14px). The header is a sticky frosted bar that hangs over the content; the sidebar lost its hard `border-right` for a hairline + radius.
- **The Settings glass slider actually works now.** `--glass-intensity` is the single source of truth: `glass.css` derives blur radius (4→34px), fill opacity (0.014→0.24) and hairline strength from it. Previously `themes.js` overwrote `--glass-blur` with a fixed 8px and `--glass-opacity` (a variable nothing read), so the slider barely changed anything.
- New tokens in `variables.css`: `--shell-gap`, `--sidebar-track(-collapsed)`, `--dock-height`, `--dock-gap`, `--dock-max`, `--radius-2xl`, `--ease-spring`, per-theme `--glass-tint`, `--glass-highlight`, `--glass-ring`, `--ambient-1/2/3`, `--ambient-base`, `--card-bg`/`--card-border` as translucent tints, and theme-specific shadows for light/warm.

### Changed — full UI overhaul
- **Player dock is compact**: 64px tall (was 80px), 44px cover, tighter type, and a 3px progress rail hugging the island's top edge with an accent glow. Hidden state translates down by its own height + gap.
- **Everything chrome is glass**: header, sidebar, modals, command palette, toasts, EQ panel (incl. the video-player mini EQ), now-playing screen, lyrics, queue, settings cards, home hero, inline audio player, skip-intro and next-episode overlays, video control buttons and progress preview.
- **Cards, list rows and forms** use the same tint *without* `backdrop-filter` — `backdrop-filter` is GPU-expensive and RESEARCH.md explicitly limits it to the app chrome; hundreds of blurred cards would melt the frame rate.
- Softer radii (`--radius-md/lg/xl` 12/16/22px), accent-gradient primary buttons and logo, glowing accent progress bars/sliders, glass-morphic `kbd` chips, and a new `.toast-close` style (the button existed but had no CSS).
- **Toasts sit above the dock** (`bottom: calc(var(--dock-height) + var(--dock-gap) * 2)`) instead of underneath it.
- Content padding accounts for the island dock (`96px`), auth gate and onboarding wizard get the ambient backdrop + glass card, and ~24 inline `var(--bg-secondary)` / `var(--bg-tertiary)` opaque panels in the views were converted to translucent tints so nothing punches a hole in the glass.

## [2.0.1] - 2026-09-26

### Fixed — GitHub Pages playback (HTTPS → HTTP)
- **Media now plays from the GitHub Pages site with the default `http://localhost:4000` server.** `api.isMixedContent()` no longer pre-emptively blocks loopback URLs (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) — per the Secure Contexts spec, Chrome/Edge/Firefox allow these from HTTPS pages, and the old check refused to even attempt playback, showing "Browser blocked this stream" on every video/music.
- Genuinely-blocked URLs (plain-HTTP LAN/NAS addresses) now get a clear, actionable error in both players instead of a generic message, and the login screen shows an upfront warning when the configured server URL will be blocked.
- Fixed `api.baseUrl` staleness: the base URL was captured once at construction, so changing the Server URL (onboarding / settings / login screen) kept calling the old server until a full reload. It is now a live getter; removed the scattered `api.baseUrl = …` workarounds (which would now throw).
- `openssl` fallback in `scripts/generate-cert.js` now includes `subjectAltName` (Chrome/Firefox reject CN-only certs with `ERR_CERT_COMMON_NAME_INVALID`) plus per-OS trust instructions; added `npm run generate-cert` in `server/`.
- `verify()` no longer logs the user out when the server is merely unreachable (network errors keep the token; only a 401 clears the session).
- Grid step: an expired 5-minute challenge token now returns the user to the password step with a clear message instead of a dead-end error.

### Fixed — "Too many sign in attempts" lockout with correct credentials
- The auth rate limiter counted **every** request under `/api/auth/*` — including successful logins and the `/api/auth/verify` call made on every page load — so normal usage tripped the 10-per-15-minute cap and returned "Too many login attempts, please try again later" with the correct password/grid. The limiter now:
  - only applies to `POST /api/auth/login` and `POST /api/auth/grid` (`verify`/`logout` are exempt),
  - counts **only failed credential attempts** (wrong password or wrong grid, flagged by the routes) — successful sign-ins never consume the budget,
  - no longer counts expired-challenge 401s as wrong grid attempts.
- The `authService` brute-force lock (5 wrong passwords/grids → 15 min) is unchanged and remains the primary defense.
- Media endpoints (`/api/media/*`, `/api/transcode/*`) are exempt from the general 200-req/15-min cap — HTTP Range streaming could previously exhaust it and kill playback mid-video with 429s.

### Changed
- README troubleshooting rewritten for both issues (what actually gets blocked and the three fixes: localhost, `npm run generate-cert` + HTTPS, or a Cloudflare Tunnel).

## [2.0.0] - 2025-09-26

### Added — Stage 0: Research
- `RESEARCH.md` with competitive analysis of Netflix, Plex, Jellyfin, Emby, Disney+, HBO Max, Spotify, Apple Music, Tidal, Navidrome, Plexamp, foobar2000, YouTube, Vimeo, PeerTube, self-hosted servers
- Navigation, search, playback, queue, metadata, onboarding, accessibility reviewed per platform
- Gaps & opportunities: music second-class, no parametric EQ, weak search, binary theming, no in-app upload, etc.
- Technical research: GitHub Pages ↔ local server HTTPS via mkcert/Cloudflare Tunnel, codec support & transcoding strategy, Web Audio API EQ chain, static auth patterns, file indexing
- Design research: 2024-25 minimalist trends, glassmorphism, grain, 4-theme system, typography
- Research synthesis with final feature list

### Added — Stage 1: Architecture
- `ARCHITECTURE.md` with system diagram, repo structure, tech stack, full API spec, security architecture
- Frontend: vanilla JS SPA, no build, CSS custom properties theming, Web Audio API, Fuse.js, Service Worker
- Backend: Node.js Express, bcrypt, JWT, chokidar, music-metadata, ffmpeg, JSON DB, multer, helmet, cors, rate-limit
- API: auth, library, media streaming with Range, transcode, upload, playlists/favourites/history, settings, health, SSE
- Security: 2-step auth flow (password + grid), brute-force, JWT blacklist, CORS, rate limiting, CSP

### Added — Stage 2: Full Build — Backend
- `server/package.json` with all deps
- `server/config.js` with env overrides, defaults, merge logic
- `server/config.example.json` with documented example
- `server/index.js` with Express setup, helmet, cors, rate limiters, routes, static frontend serving, HTTPS support, graceful shutdown
- `server/middleware/auth.js` with JWT validation, query token support for media, blacklist
- `server/middleware/cors.js` with configurable origins, wildcard support, localhost + github.io allow
- `server/middleware/rateLimiter.js` with general/auth/upload limiters
- `server/middleware/errorHandler.js`
- `server/services/library.js` with JSON DB for library, favourites, playlists, history, CRUD, search, stats, genres
- `server/services/metadata.js` with music-metadata + ffprobe, cover art extraction, thumbnail generation, subtitle detection, canBrowserPlayDirectly
- `server/services/scanner.js` with recursive scan, chokidar watcher, determineType heuristic, parseMovieFilename, scanAll with removed cleanup
- `server/services/thumbnail.js` with getOrGenerateThumbnail, generateThumbnailAtTime
- `server/services/transcoder.js` with shouldTranscode, transcodeVideo, transcodeStream (chunked), transcodeAudioStream, cleanupCache LRU
- `server/services/authService.js` with brute-force Map persisted to JSON, validateCredentials, validateGridPattern (order-sensitive optional), challenge + access tokens
- `server/routes/auth.js` with login (challenge token), grid, logout (blacklist), verify
- `server/routes/library.js` with list (filter/search/sort/paginate), stats, genres, search, scan, get/update/delete item
- `server/routes/media.js` with stream (Range support), cover, thumbnail (on-demand generation), subtitle (SRT→VTT conversion), info (ffprobe), subtitles list
- `server/routes/transcode.js` with video transcode (cache check + stream), audio transcode, cache clear
- `server/routes/upload.js` with multer storage, fileFilter, adaptive handling for movie/music/video, cover/subtitle move, scanner integration
- `server/routes/playlists.js` with playlists CRUD, favourites add/remove, history add/clear, items add/remove
- `server/routes/settings.js` with get safe settings, update media paths/session timeout/cors, update credentials (password + grid)
- `server/utils/logger.js`, `validators.js`, `fileUtils.js` with sanitization, parseMovieFilename, cleanCache LRU
- `scripts/setup.js` interactive wizard for username/password/grid/media paths/port/JWT secret
- `scripts/generate-cert.js` mkcert/openssl helper for local HTTPS

### Added — Stage 2: Full Build — Frontend Foundation
- `docs/config.js` with apiBaseUrl configurable via localStorage override, basePath for GitHub Pages
- `docs/css/reset.css`, `variables.css` with 4 themes (dark #0A0A0A #7C5CFF, light, warm cream/amber, cold slate/cyan), `themes.css`, `glass.css` with dynamic intensity, `grain.css` with adjustable opacity, `layout.css` with sidebar collapsible + responsive, `components.css` with buttons/cards/grid/list/modal/forms/toast/skeleton/empty/rating/progress/slider, `player.css` with video player (progress preview, next episode overlay, skip intro) + mini-player + now playing + visualizer + lyrics + queue + subtitle ::cue, `search.css` command palette, `eq.css` 10-band + visual canvas + presets, `animations.css` pageEnter + stagger + reduced-motion, `accessibility.css` focus-visible + skip-link + AA contrast
- `docs/js/utils/constants.js` with themes, EQ presets, frequencies, shortcuts
- `docs/js/utils/format.js` with formatTime, formatBytes, formatDate, relative time, etc.
- `docs/js/utils/validators.js`, `lazyLoad.js` via IntersectionObserver, `fuse.js` lightweight fuzzy search with levenshtein + typo tolerance
- `docs/js/config.js` loader, `store.js` pub/sub with persistence, library filtering, queue/favourites/history helpers, `api.js` with fetch wrapper, auth header, 401 handling, stream URLs with token query, upload via XHR progress, all endpoints
- `docs/js/auth.js` with login + grid challenge + verify + logout
- `docs/js/themes.js` with setTheme, glass/grain intensity via CSS variables
- `docs/js/effects.js` with grain overlay creation, glass/grain sliders
- `docs/js/keyboard.js` with Alt+Space search, ? shortcuts, Esc, G+H/M/U/V/P/F/S nav, player JKL etc., sequence handling
- `docs/js/pwa.js` with SW registration, online/offline events
- `docs/js/router.js` with history API + hash fallback, dynamic routes :id, basePath support, 404.html redirect via sessionStorage
- `docs/js/components/toast.js` with success/error/info, auto-dismiss, animation
- `docs/js/components/sidebar.js` with sections Library/Your Collection/Manage, active state, collapsed, mobile overlay
- `docs/js/components/searchModal.js` with command palette UI, Fuse index, debounced search, grouped results, recent + history, keyboard nav, lazy images
- `docs/js/components/mediaCard.js` with cover, overlay play, progress, meta
- `docs/js/components/mediaGrid.js` with grid + skeleton + empty state + stagger
- `docs/js/components/mediaList.js` with table header + rows + cover + meta
- `docs/js/components/audioPlayer.js` with Web Audio API chain (10 BiquadFilter peaking + compressor + gain + analyser), crossfade via dual audio elements, gapless preload, Media Session API, queue, shuffle/repeat, volume, timeupdate/history, visualizer hook
- `docs/js/components/miniPlayer.js` with persistent bottom bar, progress bar, cover/title/artist, controls, now playing fullscreen with art + visualizer (32 bars from analyser), lyrics, queue, shuffle/repeat UI
- `docs/js/components/videoPlayer.js` with custom controls, progress with buffered/played/thumb/preview, play/pause, volume hover slider, mute, time, captions toggle, EQ, speed 0.25-3x, theatre, fullscreen, PiP, next episode overlay with countdown, skip intro, keyboard actions, mousemove show/hide, open-video event, resume from history
- `docs/js/components/shortcutsPanel.js` with modal showing all shortcuts grouped
- `docs/js/components/eqPanel.js` with 10-band UI, canvas visual curve with grid + 0dB line + smooth bezier + fill + points, presets, sliders -12 to +12dB, active state, save custom, enable toggle, reset
- `docs/js/components/modal.js`, `uploadModal.js` stub, `metadataEditor.js` stub, `collections.js` stub, `detailView.js` re-export
- `docs/js/views/home.js` with continue watching (progress filter), recently added, movies/music/videos, favourites, top rated, random pick with shuffle + play
- `docs/js/views/movies.js` with grid/list toggle, sort, filter, render
- `docs/js/views/music.js` with all/artist/album/genre grouping, play all/shuffle, grid/list, sort
- `docs/js/views/videos.js` with grid/list
- `docs/js/views/playlists.js` with create modal, grid, detail with track list, play all, delete, add to playlist
- `docs/js/views/favourites.js` with fav grid
- `docs/js/views/history.js` with history list + progress + relative time + clear
- `docs/js/views/upload.js` with type cards (movie/music/video) with active state, drop zone with dragover, file input, batch, file list with remove, adaptive metadata forms per type (movie: title/year/genre/desc/season/episode/cover/subtitle, music: title/artist/album/genre/cover, video: title/desc/tags/thumbnail), progress bar, upload via api.upload with progress callback, library refresh
- `docs/js/views/settings.js` with appearance (theme buttons, glass/grain sliders), playback (volume/crossfade/gapless/EQ button), server (API URL save/test/scan, server info), security (change creds with current pass + new user/pass/grid pattern), logout, about
- `docs/js/views/detail.js` with video detail (poster, title, meta, description, media info, actions: edit metadata modal, add to playlist modal, share, delete with file option) + music detail (album art, title/artist/year, play/shuffle/fav, track list)
- `docs/index.html` with auth gate (login step + grid step 4x4 with toggle, count, clear, submit, error, server URL display + change), app shell (sidebar container, header with mobile menu + breadcrumb + search trigger + theme toggle + shortcuts), content view container, mini-player (progress, cover, info, controls), now playing fullscreen (header, art with visualizer, info, progress slider, time, controls), video modal (video element, controls with progress buffered/played/thumb/preview, left/right controls, next episode overlay, skip intro), modals container, connection status, inline auth CSS, module script with full init (server URL change, grid logic, login/grid flow, checkAuth, showApp, theme/effects/keyboard/pwa/sidebar/search/router, load library, mobile menu, header actions, logout, online/offline, retry, init players, shortcuts panel, routes for /, /movies, /music, /videos, /playlists, /favourites, /history, /upload, /settings, /watch/:id, /movie/:id, /album/:id, shake animation, expose Vault globally)
- `docs/404.html` with GitHub Pages SPA hack via sessionStorage redirect
- `docs/manifest.json` PWA manifest
- `docs/favicon.svg`
- `docs/sw.js` with install (shell assets cache), activate (clean old), fetch (API network-first, navigate fallback to index.html, shell cache-first, default network-first with cache fallback)
- `.github/workflows/deploy.yml` with checkout, setup-node, verify frontend, configure-pages, upload artifact docs/, deploy-pages
- `CNAME` placeholder with instructions
- `.gitignore` with node_modules, server/data/cache/media/uploads, config.json, .env, logs, etc.
- `LICENSE` MIT

### Security
- Implemented all requirements: auth gate, grid challenge, JWT, brute-force, logout, CORS, rate limiting, helmet, sanitization, CSP, no secrets in frontend, file validation, etc.

### Notes
- Frontend is production-ready vanilla JS SPA, no build step, works on GitHub Pages with HTTPS workaround documented (mkcert, Cloudflare Tunnel, ngrok, local serve)
- Backend is production-ready Node.js with zero native deps required for basic (ffmpeg-static provides binaries), optional sharp for image processing
- All files complete, no TODOs, no placeholders

## [Unreleased] — Future
- Docker support
- SQLite option for large libraries
- HLS/DASH adaptive streaming
- Collaborative playlists
- Scrobbling integration (Last.fm)
- Chromecast/AirPlay casting
- Chapter support via metadata
- Lyrics .lrc sync
- Batch metadata editing
- Collections UI cross-media
- Mobile apps (Capacitor)
