# Vault — Architecture & Planning

## 1.1 System Architecture

### Overview
Vault is a split architecture:
- **Front-end**: Static site hosted on GitHub Pages (or any static host). Pure client-side SPA, no SSR. All UI, playback, EQ, search, theming, auth gate live here.
- **Back-end**: Lightweight Node.js local server that user runs on their machine/NAS. Handles file scanning, metadata, transcoding, uploads, auth validation, API.

```
┌─────────────────────────────────┐         HTTPS (via config)         ┌─────────────────────────────┐
│   GitHub Pages (Static SPA)     │  ───────────────────────────────►  │  Local Server (Node.js)     │
│                                 │  ◄───────────────────────────────  │  Express + ffmpeg + etc     │
│  - Auth gate (login + grid)     │   JSON API / Media Streams         │  - /api/auth/*              │
│  - Router, UI, themes           │                                    │  - /api/library/*           │
│  - Video player (custom)        │                                    │  - /api/media/* (stream)    │
│  - Audio player + EQ (WebAudio) │                                    │  - /api/upload/*            │
│  - Search (Fuse.js + modal)     │                                    │  - /api/transcode/*         │
│  - PWA / Service Worker         │                                    │  - File watcher (chokidar)  │
└─────────────────────────────────┘                                    │  - Index DB (JSON/SQLite)   │
                                                                       │  - Metadata extractors      │
                                                                       │  - Auth + rate limit + CORS │
                                                                       └─────────────────────────────┘
                                                                                │
                                                                                ▼
                                                                       ┌─────────────────┐
                                                                       │  User Media Dirs │
                                                                       │  /Movies, /Music, │
                                                                       │  /Videos, thumbs, │
                                                                       │  covers, subs     │
                                                                       └─────────────────┘
```

### Front-end ↔ Back-end Communication

**Config:**
- `docs/config.js` exposes `window.VAULT_CONFIG = { apiBaseUrl: 'http://localhost:4000', appName: 'Vault', version: '2.0.0' }`
- User edits this file OR sets via Settings UI (stored in localStorage overriding default).
- For GitHub Pages HTTPS → HTTP issue, README recommends:
  1. `mkcert` to generate trusted local HTTPS cert and run server on HTTPS.
  2. OR Cloudflare Tunnel / ngrok to get public HTTPS URL.
  3. OR run front-end locally via `npx serve docs` for pure HTTP dev.

**API Transport:**
- REST JSON over fetch. All endpoints prefixed `/api`.
- Auth: `Authorization: Bearer <token>` header. Token stored in localStorage after login+grid.
- Media streaming: `/api/media/stream/:id` returns file with Range support (206 Partial Content) for seeking.
- Transcoding: `/api/media/transcode/:id?quality=720p&format=mp4` returns ffmpeg on-the-fly stream with `Transfer-Encoding: chunked`, `Content-Type: video/mp4`.
- Upload: multipart/form-data via `/api/upload/:type` (movie/music/video).
- WebSocket optional: For real-time library updates, use Server-Sent Events (simpler) at `/api/events`. Front-end EventSource.

**CORS:**
- Server reads `CORS_ORIGINS` from config (default: `https://kokonut-dev.github.io,http://localhost:3000,http://localhost:5173,http://127.0.0.1:*`).
- Helmet CSP: `default-src 'self'; connect-src 'self' <apiBaseUrl>; media-src 'self' <apiBaseUrl> blob:; img-src 'self' <apiBaseUrl> data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'`

### Front-end Architecture (SPA)

**No framework? Decision: Vanilla JS + lightweight router + Web Components-ish pattern for maintainability, but structured as modules.**

- Why vanilla: Zero build step required for GitHub Pages simplicity, small bundle, full control. Can add esbuild later if needed.
- Structure: ES modules, imported via `<script type="module">`.
- Router: Hash-based or History API with fallback. Use History API (`/`, `/movies`, `/music`, etc.) with 404.html redirect hack for GitHub Pages SPA.
- State: Central store (pub/sub) in `js/store.js` — holds auth, library, player state, queue, settings, theme.
- Components: Each UI piece is a function returning DOM or class with mount/unmount.

**Key modules:**
- `js/app.js` — entry, init auth gate, router, theme, grain, glass, service worker.
- `js/auth.js` — login flow, grid challenge, token handling, brute-force UI.
- `js/router.js` — route definitions, guards.
- `js/store.js` — global state, localStorage persistence.
- `js/api.js` — fetch wrapper with auth, error handling, retry.
- `js/components/*` — sidebar, search modal, video player, audio player, EQ, etc.
- `js/views/*` — home, movies, music, videos, playlists, upload, settings, detail pages.
- `js/utils/*` — fuzzy search (Fuse.js vendored or CDN), formatters, keyboard shortcuts, lazy loader, etc.
- `css/*` — themes, components, glass, grain, animations.

### Back-end Architecture (Node.js)

**Stack:**
- Node.js 18+, Express 4.x
- `bcryptjs` for password hashing (pure JS, no native)
- `jsonwebtoken` for JWT
- `express-rate-limit`, `helmet`, `cors`, `multer` for uploads, `validator` for sanitization
- `chokidar` for file watching
- `music-metadata` for audio tags
- `fluent-ffmpeg` + `ffmpeg-static` + `ffprobe-static` for metadata & transcoding (fallback to system ffmpeg if available)
- `sharp` for image resizing (optional, fallback to no resize)
- `lowdb` or custom JSON DB for index (avoid native deps like better-sqlite3 for broad compatibility; provide SQLite option via config)
- `mime-types`, `fs-extra`

**Processes:**
- Main Express server
- Scanner: On startup + file watcher events, scans media dirs, extracts metadata, updates index JSON (`server/data/library.json`)
- Transcoder: On-demand ffmpeg processes, LRU cache of transcoded segments in `server/cache/`
- Thumbnail generator: Generates thumbnails for videos on scan

**Data:**
- `server/config.json` — user-editable: credentials hash, grid pattern, media paths, port, CORS, session timeout, etc.
- `server/data/library.json` — index DB
- `server/data/users.json` — attempts tracking for brute-force
- `server/media/` — default media dirs (if user doesn't configure external)
- `server/cache/` — transcoded files, thumbnails, covers
- `server/uploads/` — temp upload staging

---

## 1.2 Repository Structure

```
Vault-V2/
├── README.md
├── RESEARCH.md
├── ARCHITECTURE.md
├── CHANGELOG.md
├── LICENSE
├── .gitignore
├── CNAME (placeholder)
├── docs/                           # GitHub Pages front-end (static)
│   ├── index.html                  # Entry HTML
│   ├── 404.html                    # SPA fallback for GitHub Pages
│   ├── manifest.json               # PWA manifest
│   ├── sw.js                       # Service worker
│   ├── config.js                   # User-editable API base URL config
│   ├── favicon.svg
│   ├── css/
│   │   ├── reset.css
│   │   ├── variables.css           # CSS custom properties + themes
│   │   ├── themes.css              # Dark, Light, Warm, Cold definitions
│   │   ├── glass.css               # Frosted glass effects
│   │   ├── grain.css               # Grain texture
│   │   ├── layout.css              # Sidebar, main, responsive
│   │   ├── components.css          # Cards, buttons, modals, etc.
│   │   ├── player.css              # Video + audio player UI
│   │   ├── eq.css                  # EQ UI
│   │   ├── search.css              # Command palette
│   │   ├── animations.css          # Transitions, skeletons
│   │   └── accessibility.css
│   ├── js/
│   │   ├── app.js                  # Entry
│   │   ├── config.js               # Config loader (reads window.VAULT_CONFIG)
│   │   ├── auth.js
│   │   ├── router.js
│   │   ├── store.js
│   │   ├── api.js
│   │   ├── themes.js
│   │   ├── effects.js              # Glass + grain sliders
│   │   ├── keyboard.js             # Shortcuts
│   │   ├── pwa.js
│   │   ├── components/
│   │   │   ├── sidebar.js
│   │   │   ├── toast.js
│   │   │   ├── modal.js
│   │   │   ├── searchModal.js
│   │   │   ├── videoPlayer.js
│   │   │   ├── audioPlayer.js
│   │   │   ├── miniPlayer.js
│   │   │   ├── eqPanel.js
│   │   │   ├── uploadModal.js
│   │   │   ├── mediaCard.js
│   │   │   ├── mediaGrid.js
│   │   │   ├── mediaList.js
│   │   │   ├── detailView.js
│   │   │   ├── metadataEditor.js
│   │   │   ├── collections.js
│   │   │   └── shortcutsPanel.js
│   │   ├── views/
│   │   │   ├── home.js
│   │   │   ├── movies.js
│   │   │   ├── music.js
│   │   │   ├── videos.js
│   │   │   ├── playlists.js
│   │   │   ├── favourites.js
│   │   │   ├── history.js
│   │   │   ├── upload.js
│   │   │   ├── settings.js
│   │   │   └── login.js
│   │   └── utils/
│   │       ├── fuse.js             # Vendored Fuse.js (fuzzy search)
│   │       ├── format.js           # Time, size, etc.
│   │       ├── lazyLoad.js         # IntersectionObserver
│   │       ├── validators.js
│   │       └── constants.js
│   └── assets/
│       ├── grain.png               # Tiny noise texture (base64 or file)
│       ├── icons/                  # SVG icons
│       └── images/                 # Placeholder posters
├── server/
│   ├── package.json
│   ├── README.md                   # Server-specific setup
│   ├── index.js                    # Entry, Express setup
│   ├── config.js                   # Config loader + defaults
│   ├── config.example.json         # Example user config
│   ├── .env.example
│   ├── middleware/
│   │   ├── auth.js                 # JWT validation
│   │   ├── rateLimiter.js
│   │   ├── cors.js
│   │   └── errorHandler.js
│   ├── routes/
│   │   ├── auth.js                 # /api/auth/*
│   │   ├── library.js              # /api/library/*
│   │   ├── media.js                # /api/media/*
│   │   ├── upload.js               # /api/upload/*
│   │   ├── playlists.js
│   │   ├── transcode.js
│   │   └── settings.js
│   ├── services/
│   │   ├── scanner.js              # Directory scanning + file watcher
│   │   ├── metadata.js             # music-metadata + ffprobe
│   │   ├── transcoder.js           # ffmpeg on-the-fly
│   │   ├── thumbnail.js            # Video thumbs + cover art
│   │   ├── library.js              # Index DB CRUD
│   │   └── authService.js
│   ├── data/                       # Created at runtime, gitignored
│   │   └── .gitkeep
│   ├── cache/                      # Transcoded cache, gitignored
│   │   └── .gitkeep
│   ├── media/                      # Default media folders
│   │   ├── movies/
│   │   ├── music/
│   │   └── videos/
│   └── utils/
│       ├── fileUtils.js
│       ├── logger.js
│       └── validators.js
├── .github/
│   └── workflows/
│       └── deploy.yml              # GitHub Pages deploy
└── scripts/
    ├── setup.js                    # Interactive setup for server config
    └── generate-cert.js            # mkcert helper
```

---

## 1.3 Technology Stack

### Front-end (docs/)
- **Language**: HTML5, CSS3 (custom properties), JavaScript ES2022 (modules)
- **No heavy framework**: Vanilla JS for zero build, fast load, full control. If needed, use lightweight `lit` or `preact` but decision is vanilla for now.
- **Libraries (vendored/CDN)**:
  - Fuse.js 7.x — fuzzy search, 10KB gzipped
  - No jQuery, no Bootstrap
- **Web APIs**:
  - Web Audio API — EQ, compressor, reverb, analyser, crossfade
  - Media Source Extensions (optional) for advanced streaming
  - Picture-in-Picture API, Fullscreen API
  - IntersectionObserver for lazy loading
  - Service Worker + Cache API for PWA
  - Media Session API for lock screen controls
  - Web Animations API for smooth transitions
- **CSS**:
  - Custom properties for theming
  - backdrop-filter for glass
  - CSS Grid + Flexbox for layout
  - clamp(), aspect-ratio, :has() where supported
  - prefers-reduced-motion, prefers-color-scheme
- **Build**: None required for dev, but GitHub Actions can run esbuild for minification if desired. Keep simple: no build for v1.

### Back-end (server/)
- **Runtime**: Node.js 18+ (LTS)
- **Framework**: Express 4.x
- **Auth**: bcryptjs (hash), jsonwebtoken (JWT)
- **Security**: helmet, express-rate-limit, cors, validator, DOMPurify (if needed)
- **File handling**: multer, chokidar, fs-extra, mime-types
- **Metadata**: music-metadata (audio), fluent-ffmpeg + ffmpeg-static + ffprobe-static (video/audio probe & transcode)
- **Images**: sharp (optional, fallback if not installed)
- **DB**: JSON file via lowdb-like custom (no native deps). Optionally better-sqlite3 if user enables.
- **Utils**: dotenv for env, morgan for logging

### Codecs / Playback
- **Audio native**: MP3, AAC, FLAC (modern browsers), WAV, OGG Vorbis, OPUS, M4A/ALAC (Safari + Chrome)
- **Audio transcode fallback**: Server transcodes WMA, AIFF, DSD, etc. → Opus 128k or AAC 256k via ffmpeg
- **Video native**: MP4 H.264 (universal), WebM VP8/VP9 (Chrome/Firefox), AV1 (Chrome/Firefox/Safari 16+), HEVC H.265 (Safari, Chrome 107+ HW)
- **Video transcode fallback**: MKV, AVI, MOV, WMV, FLV → H.264/AAC fragmented MP4 (`-movflags frag_keyframe+empty_moov -preset veryfast -crf 23`)
- **Subtitles**: SRT, VTT, ASS/SSA → VTT conversion via ffmpeg or custom parser, served as TextTrack

### Dev Tools
- **GitHub Actions**: Deploy docs/ to Pages
- **Lint**: ESLint optional
- **Package manager**: npm

---

## 1.4 API Specification

Base URL: `http://localhost:4000` (configurable via `config.js`)

All responses JSON unless streaming media. Errors: `{ error: string, code: string, details?: any }`

### Auth

#### POST /api/auth/login
- **Body**: `{ username: string, password: string }`
- **Response 200**: `{ challengeToken: string, message: "Grid challenge required" }` OR if grid disabled (not recommended): `{ token: string, expiresAt: ISO }`
- **Response 401**: `{ error: "Invalid credentials" }`
- **Rate limit**: 5 req / 15 min per IP (brute-force protection)
- **Notes**: Validates username/password against bcrypt hash in config. Issues short-lived challengeToken (5 min) for grid step.

#### POST /api/auth/grid
- **Body**: `{ challengeToken: string, pattern: number[] }` — pattern is array of 8 indices 0-15 (order matters? Configurable; default order matters for security)
- **Response 200**: `{ token: string, expiresAt: ISO, user: { username } }` — JWT valid for configurable timeout (default 24h)
- **Response 401**: `{ error: "Invalid grid pattern" }`
- **Rate limit**: Same bucket as login.

#### POST /api/auth/logout
- **Headers**: Authorization Bearer
- **Response 200**: `{ message: "Logged out" }`
- **Notes**: Server blacklists token (in-memory) until expiry.

#### GET /api/auth/verify
- **Headers**: Authorization Bearer
- **Response 200**: `{ valid: true, user, expiresAt }`
- **Response 401**: `{ valid: false }`

### Library

#### GET /api/library
- **Headers**: Auth
- **Query**: `?type=movie|music|video|all&search=&genre=&year=&sort=title|dateAdded|year|rating|duration|size&order=asc|desc&page=1&limit=50`
- **Response 200**: `{ items: MediaItem[], total: number, page, limit }`

#### GET /api/library/:id
- **Headers**: Auth
- **Response 200**: `MediaItem` full with metadata, technical info, file path (sanitized)

#### PUT /api/library/:id
- **Headers**: Auth
- **Body**: Partial MediaItem metadata (title, artist, album, genre, year, description, rating, etc.)
- **Response 200**: Updated MediaItem
- **Notes**: Updates index, not file tags (optional: write ID3 if audio).

#### DELETE /api/library/:id
- **Headers**: Auth
- **Query**: `?deleteFile=true|false` — if true, deletes file from disk
- **Response 200**: `{ message: "Deleted" }`

#### GET /api/library/stats
- **Headers**: Auth
- **Response 200**: `{ totalMovies, totalMusic, totalVideos, totalSize, recentlyAdded: MediaItem[] }`

#### GET /api/library/genres
- **Headers**: Auth
- **Response 200**: `{ genres: string[] }`

#### GET /api/library/search
- **Headers**: Auth
- **Query**: `?q=string`
- **Response 200**: `{ results: { movies: [], music: [], videos: [] }, query }` — server-side fallback search, but primary search is client-side Fuse.js on full library.

### Media Streaming

#### GET /api/media/stream/:id
- **Headers**: Auth (or token query param `?token=` for <video> src which can't set headers — validate query token)
- **Response 200/206**: File stream with `Accept-Ranges: bytes`, `Content-Type` mime, supports Range header
- **Notes**: Uses fs.createReadStream with range.

#### GET /api/media/cover/:id
- **Headers**: Auth OR query token
- **Response 200**: Image file (jpg/png) — cover art extracted

#### GET /api/media/thumbnail/:id
- **Headers**: Auth OR query token
- **Query**: `?time=10` — seconds for thumbnail (optional)
- **Response 200**: JPG thumbnail

#### GET /api/media/subtitle/:id/:subtitleId
- **Headers**: Auth OR query token
- **Response 200**: VTT file (converted if needed)

#### GET /api/media/info/:id
- **Headers**: Auth
- **Response 200**: `{ codec, bitrate, sampleRate, resolution, fileSize, filePath, duration, etc. }` — ffprobe data

### Transcoding

#### GET /api/media/transcode/:id
- **Headers**: Auth OR query token
- **Query**: `?quality=1080p|720p|480p|original&format=mp4|webm&audioCodec=aac|opus`
- **Response 200**: Chunked transcoded stream, `Content-Type: video/mp4`, `Transfer-Encoding: chunked`
- **Notes**: Spawns ffmpeg, pipes stdout to response. Cache key based on id+quality+format.

#### GET /api/media/transcode/audio/:id
- **Query**: `?codec=opus|aac|mp3&bitrate=128|256|320`
- **Response 200**: Transcoded audio stream

### Upload

#### POST /api/upload/:type
- **Params**: type = movie|music|video
- **Headers**: Auth
- **Body**: multipart/form-data
  - `file`: File (or multiple files via `files[]`)
  - `metadata`: JSON string with title, year, genre, etc.
  - `cover`: Optional image file
  - `subtitle`: Optional subtitle file
- **Response 200**: `{ items: MediaItem[], message: "Upload complete" }`
- **Notes**: Saves to appropriate dir structure, triggers scanner to index.

#### GET /api/upload/progress/:uploadId
- **Headers**: Auth
- **Response 200**: `{ progress: 0-100, status }` — for large files, if using chunked upload. Simple version uses multer progress via frontend XHR.

### Playlists / Collections / Favourites / History

#### GET /api/playlists
- **Headers**: Auth
- **Response 200**: `{ playlists: Playlist[] }`

#### POST /api/playlists
- **Headers**: Auth
- **Body**: `{ name, description, type: 'playlist'|'collection', items: id[] }`
- **Response 200**: Playlist

#### GET /api/playlists/:id
- **Headers**: Auth
- **Response 200**: Playlist with items expanded

#### PUT /api/playlists/:id
- **Headers**: Auth
- **Body**: Partial playlist
- **Response 200**: Updated

#### DELETE /api/playlists/:id
- **Headers**: Auth
- **Response 200**: Deleted

#### POST /api/playlists/:id/items
- **Headers**: Auth
- **Body**: `{ itemId }`
- **Response 200**: Updated playlist

#### DELETE /api/playlists/:id/items/:itemId
- **Headers**: Auth
- **Response 200**: Updated

#### GET /api/favourites
- **Headers**: Auth
- **Response 200**: `{ items: MediaItem[] }`

#### POST /api/favourites/:id
- **Headers**: Auth
- **Response 200**: { favourited: true }

#### DELETE /api/favourites/:id
- **Headers**: Auth
- **Response 200**: { favourited: false }

#### GET /api/history
- **Headers**: Auth
- **Response 200**: `{ history: HistoryItem[] }` — each with itemId, watchedAt, progress

#### POST /api/history
- **Headers**: Auth
- **Body**: `{ itemId, progress, duration, completed }`
- **Response 200**: HistoryItem

#### DELETE /api/history
- **Headers**: Auth
- **Response 200**: Cleared

### Settings

#### GET /api/settings
- **Headers**: Auth
- **Response 200**: Server settings (media paths, etc., excluding secrets)

#### PUT /api/settings
- **Headers**: Auth
- **Body**: Partial settings (media paths, session timeout, etc.)
- **Response 200**: Updated settings

#### PUT /api/settings/credentials
- **Headers**: Auth
- **Body**: `{ currentPassword, newUsername?, newPassword?, newGridPattern?: number[] }`
- **Response 200**: { message: "Credentials updated" }

### System

#### GET /api/health
- **No auth** (or optional)
- **Response 200**: `{ status: "ok", version, uptime, libraryCount }`

#### GET /api/events
- **Headers**: Auth
- **Response**: Server-Sent Events stream `text/event-stream`
- **Events**: `library:update`, `scan:start`, `scan:complete`, `upload:progress`

---

## 1.5 Security Architecture

### Authentication Flow

```
1. User visits GitHub Pages front-end
   → App checks localStorage for token
   → If no token or invalid → show Login Gate (full-screen, no UI leaks)

2. Login Gate Step 1: Credentials
   - Form: username, password
   - Client: POST /api/auth/login { username, password }
   - Server:
     * Check brute-force store: if IP locked (5 fails in 15 min) → 429
     * Load config.json: get username hash? Actually store username plaintext + password bcrypt hash
     * Compare username (case-sensitive)
     * bcrypt.compare(password, hash)
     * If fail: increment attempts, return 401
     * If success: reset attempts, issue challengeToken (JWT with 5 min expiry, payload { username, step: 'grid', jti })
     * Return challengeToken

3. Login Gate Step 2: Grid Challenge
   - UI: 4x4 grid (16 squares), user must click exactly 8 in correct pattern
   - No visual hint which are correct
   - Client tracks selected indices, shows selected state (user sees own selection)
   - On submit 8 squares: POST /api/auth/grid { challengeToken, pattern: [0,3,5,...] }
   - Server:
     * Verify challengeToken valid and step=grid
     * Load expected pattern from config (array of 8 numbers, order matters? Configurable; default order-insensitive but we will make order-sensitive for stronger security, with option)
     * Compare: if config says orderMatters=true, compare exact order; else sort both and compare
     * If fail: increment grid attempts (same bucket), return 401, client resets grid
     * If success: issue final JWT access token (payload { username, jti, iat, exp }), expiry configurable (default 24h)
     * Return token + expiresAt

4. Session
   - Client stores token in localStorage: `vault_token`, `vault_expiresAt`
   - All API calls include Authorization: Bearer token
   - Server middleware validates JWT signature (secret from config), checks expiry, checks blacklist (logout)
   - Front-end periodically calls /api/auth/verify to check still valid; if 401, redirect to login
   - Session timeout: configurable (default 24h). Token expiry enforces.

5. Logout
   - Client: POST /api/auth/logout with token
   - Server: Add jti to blacklist (in-memory + JSON) until expiry
   - Client: Clear localStorage, redirect to login

6. Brute-force protection
   - In-memory Map: ip → { count, firstAttemptTime, lockedUntil }
   - On each failed login/grid attempt: increment
   - If count >=5 and within 15 min window: set lockedUntil = now + 15 min, return 429 with Retry-After
   - Successful login resets count
   - Persist to data/bruteforce.json to survive restart
   - Configurable: maxAttempts, lockoutDuration
```

### Additional Security

- **CORS**: Configurable allowed origins. Default includes GitHub Pages origin `https://kokonut-dev.github.io` plus localhost for dev. Server checks Origin header, returns appropriate CORS headers. No wildcard when credentials.
- **Rate limiting**: `express-rate-limit` — 100 req / 15 min per IP for general API, 20 req / 15 min for upload, 5 / 15 min for auth. Configurable.
- **Helmet**: Sets CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.
  - CSP: `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: <apiBaseUrl>; media-src 'self' blob: <apiBaseUrl>; connect-src 'self' <apiBaseUrl>; worker-src 'self' blob:`
  - Note: 'unsafe-inline' needed for some inline styles, but mitigate via nonce if possible. For v1, allow.
- **Input sanitization**:
  - Server: `validator` to escape, trim, check lengths. Multer filename sanitization: remove path traversal, allow only safe chars.
  - Client: DOMPurify for any user-generated content rendered (though self-hosted personal, still).
  - Search input sanitized, no regex injection.
  - Metadata fields: max lengths enforced.
- **No secrets in front-end**: `config.js` only contains apiBaseUrl, not credentials. Credentials only in server config.json which is gitignored.
- **JWT secret**: Generated random 64-char on first setup, stored in server config, not in repo.
- **HTTPS**: Recommend mkcert for local HTTPS or Cloudflare Tunnel for remote. Document mixed content handling.
- **File upload**: Validate mime type via magic bytes, not just extension. Limit file size (configurable, default 10GB for movies). Scan for path traversal. Save to isolated media dirs, not arbitrary paths.
- **Error handling**: No stack traces leaked to client in production. Log server-side.
- **Dependency security**: `npm audit`, keep deps updated.

---

## Decisions & Trade-offs

- **JSON DB vs SQLite**: Start JSON for zero native deps (better-sqlite3 requires compilation). Provide upgrade path. JSON is fine for <10k items; for larger libraries, recommend SQLite via config flag.
- **Vanilla JS vs Framework**: Vanilla for simplicity, no build, fast. If project grows, can migrate to Preact (3KB) without rewrite.
- **Transcoding**: On-the-fly via ffmpeg, not pre-transcode. Cache results LRU. For low-power devices, recommend direct-play friendly formats.
- **Auth storage**: localStorage not httpOnly, but acceptable for personal self-hosted. Mitigate XSS via CSP + sanitization. Alternative: cookie with httpOnly requires server to set cookie from different origin — complex with CORS. So localStorage is pragmatic.
- **Grid pattern**: 4x4 8-click = C(16,8)=12870 combinations. With order matters, 16P8=~500M. Good second factor for personal use, memorable pattern.
- **PWA**: Service worker caches shell (HTML/CSS/JS) but not media. Offline UI works, shows "Server unreachable" overlay.

---

*This architecture was designed to be premium, secure, and maintainable, balancing zero-build simplicity for GitHub Pages with powerful local server capabilities.*
