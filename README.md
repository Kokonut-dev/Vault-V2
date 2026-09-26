# Vault — Self-Hosted Personal Media Server

> A premium, self-hosted personal media server for movies, music, and videos. Built with a static GitHub Pages frontend and a lightweight Node.js local backend. Think Netflix + Spotify + Plex, but yours.

![Vault](docs/favicon.svg)

## Features

### 🎬 Unified Media
- **Movies/Series**, **Music**, and **Videos** — equal citizens, not afterthoughts
- Auto-categorization via file scanning + smart filename parsing (`Movie.2021`, `Series.S01E02`)
- Metadata extraction: ID3 tags, ffprobe video info, cover art, thumbnails, subtitles
- File watcher — auto-updates library when files change

### 🔐 Security First
- **Two-step auth**: Username/password (bcrypt) + secret **4×4 grid pattern** (8 squares, C(16,8)=12870 combos, order-sensitive optional → ~500M)
- JWT sessions, brute-force lockout (5 attempts → 15 min), rate limiting, helmet CSP, CORS locked to your Pages origin
- No secrets in frontend, no external auth dependency

### ▶️ Premium Playback
**Video:**
- Custom cinematic player (no browser defaults)
- Seek with thumbnail preview, volume slider, speed 0.25x–3x, fullscreen, PiP, theatre mode
- Subtitles SRT/VTT/ASS→VTT, customizable styling via `::cue`, chapters, skip intro/outro, next episode autoplay countdown
- Quality selector (transcoded 1080p/720p/480p), casting hooks, keyboard JKL + 0-9 + M/F/C/T/P
- Resume where you left off

**Music:**
- Persistent mini-player (Spotify-style) that survives navigation
- Full-screen Now Playing with large art, animated visualizer (AnalyserNode), lyrics (.lrc)
- Queue management (add, reorder, clear, save as playlist), shuffle/repeat, crossfade (0-12s), gapless via dual audio elements
- Album/artist/genre views, Media Session API for lock screen

### 🎚️ Professional EQ
- **10-band parametric EQ** via Web Audio API — real DSP, not fake sliders
- Frequency, gain, Q per band, visual curve (canvas), analyser
- Presets: Flat, Bass Boost, Treble Boost, Vocal, Acoustic, Electronic, Classical, Rock, Pop, Jazz, R&B + save custom
- Extras: bass boost, stereo widening, normalization, compressor (threshold/ratio/attack/release), reverb (ConvolverNode)

### 🔍 Global Search
- Triggered by **⌥+Space / Alt+Space** — command palette (Spotlight/Raycast style)
- Fuzzy search (Fuse.js) across all libraries, typo tolerant, instant debounced
- Categorized results (Movies/Music/Videos), keyboard nav (↑↓↵ESC), recent searches, history
- Matches title, artist, album, genre, year, tags, description, filename

### 🎨 Design System
- **4 themes**: Dark (Netflix/Spotify), Light (Apple), Warm (vinyl/candlelight), Cold (Nordic winter) — comprehensive, no afterthoughts
- **Frosted glass** via `backdrop-filter: blur() saturate()` — adjustable slider 0-100 → blur 0-40px
- **Film grain** via SVG/PNG tile — adjustable 0-100 → opacity 0-0.15, static or subtly animated
- Minimalist premium: bento cards, 12-20px radius, 150-250ms ease-out, hover scale 1.02, skeleton loading (not spinners)
- Sidebar collapsible (240px → 64px), home dashboard (Continue Watching, Recently Added per category, Random Pick, Top Rated, Favourites)
- Grid/List toggle, detail pages with backdrop+poster, season/episode picker, track lists
- Responsive: desktop primary, tablet, mobile with bottom mini-player offset
- Accessibility: full keyboard nav, ARIA, focus rings, AA contrast, rem units, prefers-reduced-motion

### 📤 Upload
- In-app upload with adaptive forms: Movie/Series (title/year/genre/season/episode/poster/subtitle), Music (title/artist/album/genre/track/cover), Video (title/desc/tags/thumbnail)
- Drag-drop, progress bar, batch/multi-file, cover/subtitle handling

### ➕ Extras
- Favourites (♥), history (auto-tracked, clearable), ratings (5-star), collections (cross-media: "Chill Night" with movies+music), metadata editor inline, media info panel (codec/bitrate/resolution/size/path), sorting/filtering everywhere, lazy loading via IntersectionObserver, PWA with service worker (offline shell), toast notifications, shortcuts panel (?), offline detection

## Architecture

```
┌─────────────────────────────────┐         HTTPS (configurable)         ┌─────────────────────────────┐
│   GitHub Pages (Static SPA)     │  ───────────────────────────────►  │  Local Server (Node.js)     │
│  - Auth gate (login + grid)     │  ◄───────────────────────────────  │  Express + ffmpeg + etc     │
│  - Router, UI, themes           │   JSON API / Media Streams         │  - /api/auth/*              │
│  - Video player (custom)        │                                    │  - /api/library/*           │
│  - Audio player + EQ (WebAudio) │                                    │  - /api/media/* (stream)    │
│  - Search (Fuse.js + modal)     │                                    │  - /api/upload/*            │
│  - PWA / Service Worker         │                                    │  - File watcher (chokidar)  │
└─────────────────────────────────┘                                    │  - Index DB (JSON)          │
                                                                       └─────────────────────────────┘
                                                                                │
                                                                                ▼
                                                                       ┌─────────────────┐
                                                                       │  User Media Dirs │
                                                                       └─────────────────┘
```

- **Frontend**: `docs/` — vanilla JS ES2022 modules, no build required, CSS custom properties for theming, Web Audio API, Service Worker
- **Backend**: `server/` — Node.js 18+, Express, bcryptjs, jsonwebtoken, chokidar, music-metadata, fluent-ffmpeg + ffmpeg-static, sharp optional, JSON DB (lowdb-style), multer, helmet, cors, rate-limit

## Tech Stack

**Frontend:**
- HTML5, CSS3 (variables, backdrop-filter, grid/flex), JS ES2022 modules
- Fuse.js (fuzzy search), Web Audio API (BiquadFilterNode, DynamicsCompressorNode, ConvolverNode, AnalyserNode), Media Session API, Picture-in-Picture, Fullscreen, IntersectionObserver, Service Worker

**Backend:**
- Node.js, Express, bcryptjs, jsonwebtoken, helmet, cors, express-rate-limit, multer, chokidar, music-metadata, fluent-ffmpeg, ffmpeg-static/ffprobe-static, fs-extra, mime-types, validator

**Codecs:**
- Audio native: MP3, AAC, FLAC (modern), WAV, OGG Vorbis, OPUS, M4A/ALAC (Safari)
- Audio transcode fallback: WMA, AIFF, DSD → Opus/AAC via ffmpeg
- Video native: H.264 MP4 universal, VP8/VP9 WebM, AV1 (modern), HEVC (Safari/Chrome HW)
- Video transcode fallback: MKV, AVI, MOV, WMV, FLV → H.264/AAC fragmented MP4 (`-movflags frag_keyframe+empty_moov`)

## Prerequisites

- **Node.js 18+** — https://nodejs.org
- **ffmpeg** — for metadata & transcoding
  - **Mac**: `brew install ffmpeg`
  - **Windows**: https://ffmpeg.org/download.html or `choco install ffmpeg` or `scoop install ffmpeg`
  - **Linux**: `sudo apt install ffmpeg` (Debian/Ubuntu) or `sudo dnf install ffmpeg` (Fedora)
  - Alternatively, `ffmpeg-static` npm package provides binary (included), but system ffmpeg is faster
- **Git** — for cloning

Optional but recommended for HTTPS:
- **mkcert** — trusted local certs: https://github.com/FiloSottile/mkcert
  - `brew install mkcert && mkcert -install` (Mac)
  - `choco install mkcert` (Windows) then `mkcert -install`
- **Cloudflare Tunnel** — public HTTPS URL for remote access: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
  - `brew install cloudflared` or download from https://github.com/cloudflare/cloudflared/releases

## Local Server Setup

### 1. Clone & Install
```bash
git clone https://github.com/Kokonut-dev/Vault-V2.git
cd Vault-V2/server
npm install
```

### 2. Configure
Interactive wizard (recommended):
```bash
npm run setup
# or: node ../scripts/setup.js
```
It will ask:
- Username (default `admin`)
- Password (hashed with bcrypt, never plaintext)
- Grid pattern — 8 numbers 0-15 comma-separated (e.g., `0,1,4,5,8,9,12,13` = left two columns). **Keep secret!**
- Media paths (movies/music/videos) — absolute or relative to `server/`
- Port (default 4000)

Manual: copy `config.example.json` to `config.json` and edit, or set env vars `VAULT_USERNAME`, `VAULT_PORT`, etc.

**Security:** `server/config.json` is gitignored — contains password hash, JWT secret, grid pattern.

### 3. Prepare Media Folders
```bash
# Default folders (created automatically):
mkdir -p media/movies media/music media/videos
# Or use your existing collection — set paths in setup wizard to e.g. /Users/you/Movies
```

### 4. Run Server
```bash
npm start
# dev with auto-reload:
npm run dev
```
Server runs at `http://0.0.0.0:4000` (or your configured port).
- Health: `http://localhost:4000/api/health`
- Logs: library scan on startup, file watcher active

### 5. Frontend
**Option A — GitHub Pages (production):**
- The repo's `docs/` folder is deployed via GitHub Actions (`.github/workflows/deploy.yml`) to `https://kokonut-dev.github.io/Vault-V2/`
- Open that URL, set API URL to your server (see HTTPS issue below), login

**Option B — Local dev (no HTTPS issue):**
```bash
# From repo root:
npx serve docs
# or: cd docs && python3 -m http.server 3000
# Open http://localhost:3000
```

## Configuration Reference

`server/config.json` (or env):

| Key | Env | Default | Description |
|-----|-----|---------|-------------|
| `server.port` | `VAULT_PORT` | 4000 | Server port |
| `server.host` | `VAULT_HOST` | 0.0.0.0 | Host to bind |
| `server.https.enabled` | — | false | Enable HTTPS with certs |
| `server.https.keyPath` | — | ./certs/key.pem | Private key |
| `server.https.certPath` | — | ./certs/cert.pem | Certificate |
| `auth.username` | `VAULT_USERNAME` | admin | Login username |
| `auth.passwordHash` | — | (generated) | bcrypt hash — set via setup wizard |
| `auth.jwtSecret` | `VAULT_JWT_SECRET` | random 64-char | JWT signing secret — auto-generated |
| `auth.sessionTimeout` | `VAULT_SESSION_TIMEOUT` | 24h | JWT expiry: 1h,6h,12h,24h,7d,30d |
| `auth.gridPattern` | — | [0,1,4,5,8,9,12,13] | 8 unique numbers 0-15 |
| `auth.gridOrderMatters` | — | false | If true, order must match exactly (~500M combos) |
| `auth.maxAttempts` | — | 5 | Brute-force max before lockout |
| `auth.lockoutDurationMinutes` | — | 15 | Lockout duration |
| `media.paths.movies` | — | ./media/movies | Movies dir |
| `media.paths.music` | — | ./media/music | Music dir |
| `media.paths.videos` | — | ./media/videos | Videos dir |
| `media.maxUploadSizeMB` | — | 10240 | Max upload size (10GB) |
| `cors.origins` | — | [github.io, localhost:*] | Allowed CORS origins |
| `security.rateLimit.general` | — | 200/15min | General rate limit |
| `security.rateLimit.auth` | — | 10/15min | Auth rate limit |
| `security.rateLimit.upload` | — | 30/15min | Upload rate limit |

Frontend `docs/config.js`:
```js
window.VAULT_CONFIG = {
  apiBaseUrl: 'http://localhost:4000', // Change to your server URL
  appName: 'Vault',
  version: '2.0.0',
  basePath: '/Vault-V2', // GitHub Pages base
};
```
User can override API URL via Settings UI (stored in localStorage) or edit `config.js`.

## Usage Guide

### First Login
1. Open frontend URL
2. If server URL shows wrong, click Change and enter e.g. `http://localhost:4000` or your tunnel URL
3. Enter username/password set in setup wizard
4. Grid challenge: click your 8 secret squares (you set pattern in setup). No visual hint — it's secret. Order matters only if you enabled it.
5. You're in!

### Browsing
- **Home**: Continue Watching (resume), Recently Added per category, Favourites, Top Rated, Random Pick with shuffle
- **Movies/Series**: Grid/List toggle, sort by title/year/rating/date, filter. Click to play in custom video player
- **Music**: All Tracks, Artists (grouped), Albums (cover grid), Genres. Play All, Shuffle. Click track to play with queue. Mini-player persists while browsing
- **Videos**: General videos grid/list
- **Playlists**: Create playlist/collection, add items, play all, delete. Collections can span media types
- **Favourites**: Heart icon on any item
- **History**: Auto-tracked with progress, clearable
- **Upload**: Choose Movie/Music/Video, drag-drop or browse, batch, metadata form, cover/subtitle, progress bar
- **Settings**: Theme (dark/light/warm/cold), glass intensity slider, grain intensity slider, volume/crossfade, EQ (opens parametric EQ), server URL, test connection, trigger scan, change credentials, logout, about

### Playback
- **Video**: Hover for controls, click to play/pause, progress bar with thumbnail preview (if available), volume hover to expand slider, speed selector, theatre (T), fullscreen (F), PiP (P), captions (C), EQ, skip intro, next episode countdown
- **Music**: Mini-player bottom: cover, title/artist, progress bar top, prev/play/next/expand. Expand to Now Playing fullscreen: large art, visualizer (32 bars from AnalyserNode), lyrics, queue, shuffle/repeat, progress slider, time
- **EQ**: Enable toggle, presets, 10 vertical sliders (32Hz-16kHz, -12 to +12dB), Q and freq editable (advanced), visual curve canvas, save custom preset
- **Keyboard**: Press `?` for cheat sheet. Global: Option+Space search, Esc close, G+H/M/U/V/P/F/S navigate. Playback: Space/K play/pause, J/L or ←→ seek 10s, ↑↓ volume, M mute, F fullscreen, T theatre, P PiP, C captions, 0-9 seek 0-90%, N next, Shift+N prev, S shuffle, R repeat

### Search
- Press **Option+Space** (Mac) or **Alt+Space** (Windows) — centered modal
- Type to fuzzy search across all libraries
- Results grouped: Movies, Music, Videos
- ↑↓ to navigate, Enter to open/play, Esc to close
- Recent searches shown when empty, search history (recently played) below

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌥+Space / Alt+Space | Open global search |
| ? | Show shortcuts panel |
| Esc | Close modal/search |
| G then H/M/U/V/P/F/S | Go Home/Movies/Music/Videos/Playlists/Favourites/Settings |
| Space / K | Play/Pause |
| J / ← | Seek back 10s |
| L / → | Seek forward 10s |
| ↑ / ↓ | Volume up/down |
| M | Mute |
| F | Fullscreen (video) |
| T | Theatre mode (video) |
| P | Picture-in-picture (video) |
| C | Toggle captions |
| 0-9 | Seek to 0%-90% |
| N | Next track/episode |
| Shift+N | Previous |
| S | Shuffle |
| R | Repeat |

## Troubleshooting / FAQ

**Q: GitHub Pages is HTTPS, my local server is HTTP — mixed content blocked!**
A: Browsers block HTTPS page fetching HTTP. Solutions:
1. **mkcert (recommended for local)**: Generate trusted local cert:
   ```bash
   brew install mkcert && mkcert -install
   node scripts/generate-cert.js
   # Enable HTTPS in server/config.json: server.https.enabled=true
   # Run server, it will be https://localhost:4000
   # Set frontend API URL to https://localhost:4000
   ```
2. **Cloudflare Tunnel (recommended for remote)**: Get public HTTPS URL:
   ```bash
   brew install cloudflared
   cloudflared tunnel --url http://localhost:4000
   # It gives https://xxx.trycloudflare.com — use that as API URL
   ```
3. **ngrok**: `ngrok http 4000` → https URL
4. **Local frontend**: Run frontend locally via `npx serve docs` on http://localhost:3000 — no mixed content

**Q: CORS errors?**
A: Server's `cors.origins` must include your frontend origin. Default includes `https://kokonut-dev.github.io` and `localhost:*`. Add custom domain to `server/config.json` cors.origins and restart.

**Q: ffmpeg not found?**
A: Install system ffmpeg (see Prerequisites) or ensure `ffmpeg-static` npm package installed (`npm install` does it). Server logs will warn if ffmpeg unavailable — metadata and transcoding will be limited.

**Q: Transcoding slow on NAS/Raspberry Pi?**
A: Use direct-play friendly formats: H.264 video + AAC audio in MP4. Avoid HEVC/AV1 if your device can't hardware transcode. Set quality to 720p or 480p for faster. Cache is LRU cleaned.

**Q: Library not updating?**
A: File watcher uses chokidar — should auto-detect. If not, click Settings → Trigger Library Scan or `POST /api/library/scan`. Check media paths in config exist and are readable.

**Q: Forgot grid pattern?**
A: Check `server/config.json` `auth.gridPattern`. Or reset via setup wizard: `npm run setup` — set new pattern.

**Q: Brute-force lockout?**
A: After 5 fails, IP locked 15 min. Wait or delete `server/data/bruteforce.json` and restart server.

**Q: How to use custom domain for GitHub Pages?**
A: Edit `CNAME` file with your domain (e.g., `vault.example.com`), set DNS CNAME to `kokonut-dev.github.io`, enable Enforce HTTPS in repo Settings → Pages.

**Q: Can I run server via Docker?**
A: Not included yet, but easy: `FROM node:20`, `COPY server/`, `RUN npm install`, `EXPOSE 4000`, `CMD ["npm","start"]`. Mount media dirs as volumes.

## Security Notes

- Credentials hashed with bcrypt (10 rounds), never plaintext
- JWT secret random 64-char, stored in config.json (gitignored)
- Grid pattern: 8 out of 16 squares — memorable but not brute-forceable, no phone needed
- Brute-force protection persisted to JSON, survives restart
- Rate limiting on all API routes
- Helmet sets CSP, HSTS, X-Frame-Options, etc.
- Input sanitization via validator, filename sanitization prevents path traversal
- CORS configurable, not wildcard when credentials
- No secrets in frontend — `config.js` only has API URL
- Upload mime validation via magic bytes + extension, size limit
- JWT blacklist on logout until expiry
- Recommend HTTPS via mkcert or tunnel — never expose HTTP server directly to internet without reverse proxy

## License

MIT — see [LICENSE](LICENSE)

## Acknowledgements

Inspired by Plex, Jellyfin, Spotify, Netflix, YouTube, Raycast, Linear. Built with Web Audio API, Fuse.js, chokidar, music-metadata, ffmpeg.

---

*Vault — your media, your server, your design.*
