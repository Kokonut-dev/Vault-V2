# Vault V2 — Service Evaluation

> **Scope:** the whole service. That covers the Node.js server (`server/`), the web/PWA client (`docs/`), the desktop
> apps (`desktop/`), the Docker/deploy tooling, CI, and the documentation.
> **Snapshot:** `main` at `40ed468` (after PR #52), November 2026.
> **Scale:** each category is scored **out of 1000**. The total is the plain sum of all categories, with an average
> alongside it.
>
> **Updates (same PR):** the critical pre-setup login flaw (§2) has been **fixed**. So have the two remaining
> Security weak spots: the CSP no longer allows inline scripts or `<style>` blocks, and full sign-in tokens are no
> longer accepted in web addresses. Each fix has regression tests. Security and Privacy are re-scored below, with
> the snapshot scores kept in brackets.

---

## Summary

| # | Category | Score / 1000 | Verdict |
|---|---|---:|---|
| 1 | Features & functional scope | **860** | Unusually broad for a self-hosted server: video, music, TV/DVR, podcasts, books, comics, SyncPlay, desktop and PWA. |
| 2 | Security | **820** (was 640) | A strong layered design. Fixed: the pre-setup login flaw, CSP `'unsafe-inline'` scripts and styles, and full tokens in URLs. Dependency advisories remain. |
| 3 | Privacy & data ownership | **900** (was 870) | No telemetry or third-party scripts, and online lookups are opt-in. Your data stays on your machine. |
| 4 | Reliability & data integrity | **720** | Atomic writes and quarantine of corrupt files, but no scheduled backups. A single JSON store is the default. |
| 5 | Performance & scalability | **680** | Lean client with lazy loading and compression. The JSON index and in-memory search limit large libraries. |
| 6 | Code quality & maintainability | **650** | Clean, dependency-light modules. No linter or types, many silent `catch {}` blocks, several 1000+ line files. |
| 7 | Testing & CI | **700** | 348 tests and a 3-version Node matrix. 73% line coverage, and key UI modules have no tests at all. |
| 8 | UX / UI design | **780** | Polished themes, onboarding and Home. Settings are dense and some flows are expert-oriented. |
| 9 | Accessibility & inclusivity | **740** | AAA contrast enforced in CI, plus ARIA and keyboard checks. English only, and no screen-reader testing. |
| 10 | Documentation | **800** | Thorough README, architecture and platform guides. Some plan/audit docs are stale, and there's no CONTRIBUTING or SECURITY file. |
| 11 | Installation, deployment & operations | **760** | Runs from npm, Docker (non-root, health check) or desktop installers. Unsigned binaries, and no published image. |
| 12 | Interoperability & ecosystem | **620** | Subsonic API and opt-in TMDB/MusicBrainz. No Chromecast/DLNA, Jellyfin/Plex APIs or native mobile clients. |
| | **Total** | **9 030 / 12 000** (was 8 820) | **Average 753 / 1000 (was 735). A capable, privacy-respecting media server. Its security fixes are done; next it needs a quality-engineering push.** |

Categories carry equal weight. If Security counted double (it guards the user's home network), the weighted average
would be **758 / 1000** (728 before the fixes).

---

## 1. Features & functional scope — 860 / 1000

**Justification**

- **Library:** watch folders and folder uploads, tags, thumbnails, metadata editing ("Edit details"), trash and
  restore, and Google Drive import. Torrents are optional and off by default.
- **Video:** on-the-fly transcoding, HLS, hardware-acceleration planning (`transcodePlan`), subtitles,
  picture-in-picture and skip-intro.
- **Music:** a 10-band EQ, gapless playback, crossfade, lyrics, a visualiser and Media Session integration.
- **Beyond films and music:** Live TV/DVR, podcasts, audiobooks, comics, SyncPlay (watch together), multiple
  profiles, statistics, an installable PWA with offline downloads, and native desktop apps for Windows, macOS and
  Linux.
- **Opt-in metadata agents:** MusicBrainz/Cover Art Archive and TMDB, plus local `.nfo` / `.info.json` sidecars
  (`server/services/agent.js`).
- **Depth vs breadth:** some modules (Live TV, podcasts, transcoder) are much shallower in tests and polish than the
  core library and players (see §7). Breadth is ahead of depth there.

**Possible improvements**

- Native Android/iOS apps. `ANDROID.md` describes the plan, and Android 17's `ACCESS_LOCAL_NETWORK` permission has
  to be handled.
- Casting (Chromecast/DLNA) and a "continue on another device" handoff.
- Smart/automatic collections (e.g. "unwatched 90s films") and rule-based playlists.
- Per-user parental controls with content ratings, building on the TMDB metadata.

---

## 2. Security — 820 / 1000 (snapshot: 640)

**Justification: strengths**

- **Login:** bcrypt passwords plus a picture-grid second factor (8 cells chosen from 16), optional TOTP, lockout,
  and revocable sessions (every token must carry a live `sid`).
- **Scoped media tokens:** web addresses only ever carry a separate media token. It is limited to `GET`/`HEAD`
  on media paths, expires after 12 hours, and is redacted from request logs (`server/index.js`).
- **Strict Content-Security-Policy:** no inline scripts, event handlers or `<style>` blocks. The only inline
  scripts (the server's import map and build id) are allowed by their exact SHA-256 hash (`server/utils/csp.js`).
- **Rate limits:** per 15 min, 2000 general / 10 sign-in / 120 upload requests.
- **Request hardening:** Helmet, a CORS allowlist, magic-byte upload validation and path sanitisation against
  traversal.
- **Remote access:** setup from anything other than the server computer needs a one-time setup code. The tunnel
  turns itself off after 8 hours, and device pairing uses a single-use QR code or pairing code valid for 5 minutes.
- **Frontend escaping:** dynamic text goes through escaping helpers in toasts, modals and dialogs (`modal.js`,
  `toast.js`, `confirmDialog.js`).

**Justification: weaknesses**

- ✅ **Fixed — was CRITICAL: default credentials worked before setup.** A freshly started, unconfigured server accepted
  `POST /api/auth/login` from its **LAN IP** with the factory defaults (`admin` / `admin` plus the default grid
  pattern) and issued a full-access admin token.
  - The setup routes are protected by `setupGuard` (setup code for non-local requests), but the login route is not.
  - So any device on the same network can skip the setup-code protection, sign in as admin during the pre-setup
    window, and reach `/api/settings`, `/api/system`, `/api/server` and `/api/remote`. The last two include
    turning on the internet tunnel.
  - This directly contradicted the guarantee that the app "does not expose the home network".
  - **Fix:** until setup is done, every `/api/auth/*` route and the auth middleware refuse requests that aren't
    direct loopback (`403 SETUP_REQUIRED`), even with the setup code, which is only for setup. Completing setup
    also clears any session made with the factory login. Regression test:
    `security-hardening.test.js` ("the factory login only works on this computer"). It fails without the fix.
    The re-score adds +120: the critical flaw is gone, but the issues below remain.
- ✅ **Fixed — was 🟠: the CSP allowed `'unsafe-inline'`** for `script-src` and `style-src`, which greatly weakened
  Helmet's XSS protection.
  - **Fix:** every inline script, `onerror`/`onload` handler and `<style>` block moved into files
    (`js/boot-head.js`, `js/main.js`, `js/utils/imageFallback.js`, `css/auth-gate.css`, `css/views.css`, and the
    landing and 404 pages).
  - The policy is now `script-src 'self'` plus SHA-256 hashes for the server's two injected scripts, with
    `script-src-attr 'none'` and `style-src-elem 'self'`. Runtime subtitle CSS uses a constructable stylesheet.
  - The GitHub Pages build carries the same policy in a `<meta>` tag.
  - Checked in headless Chromium against a live server (onboarding, signed-in app, playback, live events): no CSP
    violations. Tests: `csp.test.js`.
  - `style-src-attr 'unsafe-inline'` remains for `style="…"` attributes. Those can't run script; at worst
    injected markup could restyle the page.
- ✅ **Fixed — was 🟠: full JWTs were accepted in query strings.** URLs leak through browser history, proxies and the
  `Referer` header.
  - **Fix:** a full sign-in token in `?token=` is now refused (`401 QUERY_TOKEN_NOT_ALLOWED`).
  - `<video>`, `<img>`, subtitles, HLS and the live-events stream get a separate media token from
    `GET /api/auth/media-token`. It is read-only, limited to media paths, valid for 12 hours, tied to the session
    (signing out or revoking the device kills it), and renewed automatically.
  - Tests: `media-links.test.js`, `security-hardening.test.js`, `player-livetv.test.js`.
- 🟠 **`npm audit --omit=dev` reports 4 high-severity advisories.** All of them come through `webtorrent` 2.8.5
  (`bittorrent-tracker`, `ip`, `torrent-discovery`). Torrents are off by default and admin-only, which lowers the
  real risk.
- 🟡 **Security-relevant dependencies are a major version behind:** `helmet` 7→8, `express-rate-limit` 7→8,
  `multer` 1.4.5-lts→2.x, `express` 4→5 and `bcryptjs` 2→3.
- 🟡 **The TOTP module has 19% line coverage.** A second factor deserves near-complete tests.

**Possible improvements** (in priority order)

1. ✅ *Done:* sign-in and the signed-in API are blocked from other devices until setup is finished, with a regression
   test. A further step would be to not create a usable factory `admin` account at all, even locally.
2. ✅ *Done:* `'unsafe-inline'` removed for scripts and `<style>`. Next: turn on
   `require-trusted-types-for 'script'`, and move the remaining `style="…"` attributes into classes.
3. ✅ *Done:* full-scope tokens are refused in query strings; URLs carry 12-hour media tokens. A further step would
   be single-item signed URLs, so one leaked link opens one file only.
4. Upgrade to `webtorrent` 3.x (or isolate it in a child process), and move to helmet 8, multer 2 and
   express-rate-limit 8.
5. Add a `SECURITY.md` with a disclosure process, and run `npm audit` / CodeQL in CI.
6. Bring `totp`, `auth` and `setupGuard` to ≥ 95% branch coverage.

---

## 3. Privacy & data ownership — 900 / 1000 (snapshot: 870)

**Justification**

- No analytics, telemetry or crash reporting, and no third-party CDNs, fonts or frontend libraries. The client
  loads nothing from outside your server.
- Online metadata providers (TMDB, MusicBrainz) are **opt-in and off by default**, and their results are cached on
  disk so the library keeps working offline.
- Data lives in plain, inspectable JSON files under the user's data folder (`VAULT_HOME`). Backup/restore produces a
  zip of that folder (`services/system.js`).
- Remote access is opt-in, time-limited (8 h tunnel) and paired explicitly.
- **Deductions:**
  - ~~The pre-setup login flaw (§2) can expose the library to other devices on the network.~~ Fixed (+30).
  - Remote access relies on a third-party tunnel provider, so when it is on, traffic metadata passes through that
    provider.
  - There's no per-profile privacy setting (e.g. hiding watch history from other profiles or from stats).

**Possible improvements**

- A "privacy dashboard" listing every outbound connection the server can make, with its current on/off state.
- Per-profile options to hide or exclude history from shared statistics.
- Encryption at rest for the data folder (session store, tokens, Drive credentials) and for backup zips.
- Document the data flows of the tunnel provider and offer a self-hosted alternative (e.g. WireGuard or Tailscale
  guidance).

---

## 4. Reliability & data integrity — 720 / 1000

**Justification**

- `utils/jsonStore.js` writes atomically (temp file + rename) and **quarantines** corrupt files instead of
  overwriting them. Ten services share it.
- Optional `node:sqlite` mirror for Node 22.13+ (`services/sqliteIndex.js`).
- The Docker image has a `HEALTHCHECK`, and the desktop launcher supervises the server process.
- Media files are never modified by default: metadata edits are stored separately, and deletions go to the trash.
- **Deductions:**
  - Backups are **manual only**. There's no scheduled backup, retention policy or off-machine copy.
  - The JSON store keeps whole files in memory and rewrites them on every change. That's fine below ~10k items
    (which `ARCHITECTURE.md` acknowledges), but slow and fragile for big libraries.
  - 26 bare `catch {}` blocks in the server (and 113 commented empty catches overall) can hide real failures.
  - The trash and playlists modules have weak test coverage (32% and 43%).

**Possible improvements**

- Scheduled, rotating backups (e.g. a nightly job keeping 7) with an optional second location, and a one-click
  restore test.
- Make SQLite the default on Node ≥ 22.13, with automatic migration from JSON and the JSON store kept as a fallback.
- Replace silent catches with `logger.debug` (or explicit "expected" comments), and add a lint rule that forbids
  empty blocks.
- Add a startup self-check that validates every store and reports problems in Settings → System.

---

## 5. Performance & scalability — 680 / 1000

**Justification**

- No build step and no frontend framework: native ES modules, with each view lazy-loaded. All client JS is
  1.08 MB raw / **281 KB gzip** in total (not all loaded up front), and `vault.css` is 193 KB raw / 34 KB gzip.
- A dependency-free compression middleware (brotli > gzip > deflate), a service worker shell cache (`v15`),
  virtualised grids and range requests for media.
- Hardware-accelerated transcoding is planned per device.
- **Deductions:**
  - Search is in-memory substring matching on the server, plus a hand-rolled fuzzy matcher in the client. There's
    no index, so it scales linearly.
  - The default JSON index has the limits described in §4.
  - No `modulepreload` hints, so lazy views load in a waterfall on slow links.
  - Transcode and HLS paths have low coverage (14% and 27%), so performance regressions there would go unnoticed.
  - No benchmarks or load tests exist.

**Possible improvements**

- Use SQLite FTS5 for full-text search once SQLite is the default.
- Add `<link rel="modulepreload">` for the Home view and the player modules, and split the largest CSS file by
  view.
- A small benchmark suite (scan 10k/50k fake items, search latency, concurrent streams) run in CI with thresholds.
- A transcode queue with per-device concurrency limits and visible progress.

---

## 6. Code quality & maintainability — 650 / 1000

**Justification**

- Clear layout: routes → services → utils, plus middleware. Small dependency footprint, and zero frontend runtime
  dependencies.
- Readable modules with explanatory header comments. `ARCHITECTURE.md` records design decisions.
- **Deductions:**
  - **No linter, formatter or type checking.** There's only an `.editorconfig`, with no ESLint, Prettier,
    TypeScript or JSDoc type checks. About 60k lines of JS is a lot to keep consistent by hand.
  - **Several very large files:** `docs/js/api.js` (1650 lines), `settings/server.js` (1241),
    `audioPlayer.js` (1121), `onboarding.js` (1062), `services/torrent.js` (964) and `library.js` (949).
  - Many silent catches (§4).
  - Behind several majors: Express 5, chokidar 6, music-metadata 12, dotenv, mime-types and others.
  - HTML is built with template strings throughout, which depends on authors remembering to escape.

**Possible improvements**

- Add ESLint (with `no-empty`, `no-unused-vars`, `eqeqeq`) and Prettier, and enforce them in CI.
- Add `// @ts-check` with JSDoc types, starting with `api.js`, the auth middleware and `jsonStore`, so types are
  checked without a build step.
- Split the largest files by concern (e.g. `api.js` into `api/library.js`, `api/auth.js`, …).
- Use a tiny tagged-template `html\`\`` helper that escapes by default.
- Plan a dependency-upgrade sprint: Express 5, helmet 8, multer 2, chokidar 4+.

---

## 7. Testing & CI — 700 / 1000

**Justification**

- **348 tests** (347 pass, 1 skipped) using `node:test` and jsdom. They cover the server, auth, uploads, the
  service worker, the context menu and more.
- Extra CI checks: syntax, imports, CSS build, keyboard reachability, music view, and **WCAG AAA contrast**.
- **CI:** three workflows. Tests run on Node 20, LTS and latest, `deploy.yml` publishes GitHub Pages, and
  `desktop.yml` builds a 4-target desktop matrix with draft releases on `v*` tags.
- **Deductions:**
  - Coverage is **73% lines / 73% branches / 63% functions**.
  - **39 source files are never loaded by any test**, including `audioPlayer`, `queuePanel`, `eqPanel`,
    `searchModal`, `sidebar`, `keyboard`, `pwa`, the music/movies/shows views, and the CORS and error-handler
    middleware.
  - Very low coverage in `virtualGrid` (14%), `transcoder` (14%), `livetv` (15%), `totp` (19%), `thumbnail` (20%)
    and `podcasts` (20%).
  - No end-to-end browser tests, no coverage threshold in CI, no dependency or security scanning.
  - The suite takes about 2 minutes and leaves `server/cache/restream/` behind.

**Possible improvements**

- Fail CI if coverage drops (start at 73% and raise it over time), and report coverage on PRs.
- Playwright smoke tests: setup → login → play a video → play music → open settings, on Chromium and WebKit.
- Unit tests for `totp`, `transcoder` (mocking ffmpeg), the CORS and error-handler middleware, and the players.
- Add `npm audit --omit=dev --audit-level=high`, CodeQL and Dependabot.
- Clean up temp/cache directories in test teardown.

---

## 8. UX / UI design — 780 / 1000

**Justification**

- **Six themes** with a consistent design system, a redesigned Home and a public landing page.
- Guided onboarding, including a QR pairing flow.
- Media-centric details: a context menu on right-click / ⋯ button (left click plays, fixed in PR #52), a mini
  player, a queue panel, an EQ panel, a search modal, skip-intro and PiP.
- Toasts and confirmation dialogs explain what happened. Security-sensitive screens (sharing, remote access)
  describe their protections in plain language.
- **Deductions:**
  - Settings is very dense: `settings/server.js` alone is over 1200 lines of UI. Advanced options (transcoding,
    tunnels, torrents) sit next to everyday ones.
  - Some error messages assume technical knowledge (e.g. "is ffmpeg installed?").
  - No usability testing has been recorded. The plan docs describe intended revamps whose completion isn't tracked.

**Possible improvements**

- A "Simple / Advanced" toggle in Settings, with search inside Settings.
- Friendlier errors with a "Fix it" action (e.g. an ffmpeg download link for the user's OS).
- First-run empty states that point to "Add a folder" for every library type.
- A short usability round (5 users, scripted tasks), with the findings recorded in the repo.

---

## 9. Accessibility & inclusivity — 740 / 1000

**Justification**

- **WCAG AAA contrast is enforced automatically** for all themes (`npm run check:contrast` in CI). That's rare and
  commendable.
- 337 ARIA attributes, dialogs with `aria-modal` and focus trapping, Escape to close, a keyboard reachability check
  script, `aria-pressed` on toggles, and `aria-hidden` on decorative icons.
- Media Session support gives hardware and lock-screen media keys.
- `prefers-reduced-motion` is honoured (22 rules across CSS/JS), and subtitles can be resized, recoloured,
  given a background and re-timed (`playbackPrefs.js`).
- **Deductions:**
  - **No internationalisation.** The UI is English only, with hard-coded strings and `lang="en"`.
  - No automated axe/Lighthouse audit and no documented screen-reader test pass.
  - The players, queue and search modal (the most interactive widgets) have no accessibility tests (§7).

**Possible improvements**

- Extract strings into a small i18n layer (JSON per locale) and ship Dutch, German, French and Spanish first.
- Run axe-core in jsdom or Playwright in CI.
- Do an NVDA/VoiceOver walkthrough of the core flows and document it.
- Add keyboard and ARIA tests for the players, queue panel and search modal.

---

## 10. Documentation — 800 / 1000

**Justification**

- `README.md` (581 lines): features, Node version table, security model, terminal and desktop instructions.
- `ARCHITECTURE.md` (660 lines) records design rationale and trade-offs.
- `CHANGELOG.md` is detailed, and there are dedicated guides: `ANDROID.md` (with current Android 17 requirements),
  `desktop/README.md` and `deploy/README.md`.
- Code comments explain *why*, not just *what* (e.g. `agent.js`, `jsonStore.js`, `modal.js`).
- **Deductions:**
  - Stale or historical documents sit next to current ones: `AUDIT.md` (Sept 2026), `IMPROVEMENTS.md`,
    `RESEARCH.md`, `SETTINGS_REVAMP_PLAN.md` and `UI_REVAMP_PLAN.md`, with no "status" markers.
  - The CHANGELOG heading still references a working branch, and the 3.0.0 entry is "in progress".
  - No `CONTRIBUTING.md`, `SECURITY.md`, code of conduct or issue/PR templates.
  - No API reference (OpenAPI) for the REST endpoints.

**Possible improvements**

- Move plan and audit docs to `docs/history/`, each with a status line ("completed in v3.0.0").
- Finalise the 3.0.0 CHANGELOG entry with its release date.
- Add `CONTRIBUTING.md` (setup, `npm ci`, test commands, style), `SECURITY.md`, and issue/PR templates.
- Generate an OpenAPI spec for `/api/*` and publish it with the Pages site.

---

## 11. Installation, deployment & operations — 760 / 1000

**Justification**

- Several install paths:
  - `npm ci && npm start` on Node 20/22/24.
  - A Docker image that runs as non-root (`USER node`) with a `HEALTHCHECK`, plus a `docker-compose.yml`.
  - Desktop installers for Windows, macOS (Intel and Apple Silicon) and Linux built in CI.
  - A GitHub Pages client.
- The desktop launcher listens on 127.0.0.1 only. All writes go through `paths.HOME`, so the apps work from
  read-only install locations.
- Settings → System has backup/restore, cache management and library health tools.
- **Deductions:**
  - Desktop builds are **unsigned**, so users see SmartScreen and Gatekeeper warnings.
  - There's no auto-update.
  - No Docker image is published (users must build it themselves).
  - No metrics endpoint (Prometheus) or structured log option.
  - Upgrades rely on `git pull` + `npm ci`, which has repeatedly caused lockfile conflicts.

**Possible improvements**

- Publish multi-arch images to GHCR from the tag workflow.
- Code-sign the Windows and macOS builds and add auto-update (e.g. `electron-updater` with GitHub Releases).
- Add an optional `/metrics` endpoint and JSON log format.
- Provide an in-app "Update available" notice and a one-command upgrade script that resets lockfiles safely.

---

## 12. Interoperability & ecosystem — 620 / 1000

**Justification**

- **Subsonic API** at `/rest` with 26 endpoints (browse, search3, playlists, star, scrobble, stream with bitrate
  transcoding, cover art). Existing Subsonic clients such as DSub, Symfonium and play:Sub can connect.
- Opt-in TMDB and MusicBrainz agents, and `.nfo` / `.info.json` sidecars, so libraries prepared for Kodi, Plex or
  Jellyfin reuse their metadata.
- Standard formats: HLS, WebVTT/SRT subtitles, M3U/M3U8 + XMLTV-style IPTV sources for Live TV, and Google Drive
  import.
- **Deductions:**
  - Casting is limited to the browser Remote Playback API. There's no Chromecast sender, DLNA/UPnP server or
    AirPlay integration.
  - No Jellyfin- or Plex-compatible API, so their large client ecosystems (TV apps, consoles) can't connect.
  - No native mobile or TV apps yet.
  - No Trakt or Last.fm scrobbling, and no webhooks or plugin API.

**Possible improvements**

- Add a DLNA/UPnP media server (it's discoverable by smart TVs and consoles), plus Chromecast via the Cast Web
  Sender SDK.
- Last.fm and ListenBrainz scrobbling (building on the Subsonic `scrobble` path) and Trakt sync for video.
- Webhooks (item added, playback started) for home-automation tools.
- Native Android TV and Android clients, as planned in `ANDROID.md`.

---

## Top 5 priorities

| Priority | Action | Category impact |
|---|---|---|
| 1 | ✅ **Done:** block default-credential login before setup for non-loopback requests, with a regression test | Security +120, Privacy +30 (applied) |
| 2 | ✅ **Done:** remove CSP `'unsafe-inline'` and full-scope query tokens | Security +60 (applied) |
| 3 | Add ESLint/Prettier/`@ts-check` plus a coverage gate and Playwright smoke tests | Code quality +100, Testing +120 |
| 4 | Scheduled backups and a SQLite-by-default index with FTS search | Reliability +100, Performance +120 |
| 5 | DLNA/Chromecast, published Docker image, signed desktop builds | Interop +120, Operations +80 |

With priorities 1 and 2 done, the average is **753**. Doing priorities 3 and 4 as well would lift it to about **790 / 1000** (9 470 / 12 000).

---

## Method

Evidence was gathered on the base commit with the following:

- **Tests:** `cd server && npm ci && npm test -- --experimental-test-coverage` (348 tests; 73.15% lines,
  73.14% branches, 62.55% functions).
- **Dependencies:** `npm audit --omit=dev` and `npm outdated` in `server/`.
- **Live probe:** a fresh server with an empty data folder (`VAULT_HOME=/tmp/evalhome PORT=4555 node index.js`),
  queried over its LAN address to test setup and login behaviour.
- **Static review:** routes, middleware, services and client components. Line counts with `wc -l`, and patterns
  (empty catches, ARIA usage, outbound URLs, escaping) with `grep`.
- **CI:** the workflow definitions in `.github/workflows/` and the repository's own check scripts (`scripts/*.js`,
  `npm run check:contrast`).

Scores are relative to mature self-hosted media servers (Jellyfin, Plex, Navidrome) and to general good practice
for a networked home service. 1000 would mean best-in-class with nothing significant to improve.
