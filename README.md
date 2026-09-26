# Vault — Your Personal Netflix + Spotify. Private. Yours.

**Vault is a self-hosted media server that makes your movies, music, and videos look and feel premium — with no cloud, no tracking, no subscriptions.**

You run a tiny server on your own computer. You open a beautiful app in your browser. That's it. Your files never leave your house.

Live app: **https://kokonut-dev.github.io/Vault-V2/**

---

## What You Need Before You Start

- A computer — Mac, Windows, or Linux all work
- **Node.js 18+** — download from https://nodejs.org (click the big green LTS button and install it)
- Your movies, music, or videos (any format)

No Docker. No database. No complex setup.

---

## Setup Guide — 3 Minutes, 3 Commands

This is designed so anyone can do it. Follow exactly.

### 1. Get Vault

Open **Terminal**:
- Mac: Press `Cmd + Space`, type `Terminal`, hit Enter
- Windows: Press Start, type `cmd` or `PowerShell`, hit Enter
- Linux: `Ctrl + Alt + T`

Copy and paste this (right-click → Paste, then Enter):

```bash
git clone https://github.com/Kokonut-dev/Vault-V2.git
cd Vault-V2/server
npm install
```

Wait about 30-45 seconds until it finishes. You'll see no errors at the end.

### 2. Start Your Server

In the **same** Terminal window, paste:

```bash
npm start
```

You should see:

```
Vault server (HTTP) running at http://0.0.0.0:4000
Health check: http://0.0.0.0:4000/api/health
Vault server ready!
```

**Important:** Leave this window open. If you close it, Vault stops. This window IS your server.

### 3. Open Vault and Complete the Wizard

Open your browser (Chrome, Safari, Firefox, Edge) and go to:

```
https://kokonut-dev.github.io/Vault-V2/
```

If it's your first time, you will see the **Onboarding Wizard — 6 simple steps**. No skipping needed, just follow:

#### Step 1 — Welcome
Shows you what Vault is. Click **Get Started →**

#### Step 2 — Connect to Server
It already shows `http://localhost:4000`. Click **Test**. You should see `✓ Connected`.

- If you see `✕ Cannot connect`: go back to your Terminal. Is it still showing `Vault server ready!`? If not, run `npm start` again. Then click Test again.
- Click **Test & Continue →**

#### Step 3 — Create Admin Account
- **Username:** pick anything, e.g., `admin` or `alex`. 3+ letters, only letters/numbers/_/-
- **Password:** 4+ characters. Use something strong you'll remember.
- **Confirm Password:** type it again.
- You'll see password strength (Weak / Fair / Good / Strong).

Click **Continue →**

#### Step 4 — Security Grid (Your Second Password)
You see 16 squares numbered 0-15 in a 4x4 grid.

Click **exactly 8 squares** that form a pattern you'll remember. Example: four corners + four in the middle. Or a letter shape.

- Counter shows `X / 8 selected`
- Click again to unselect
- Toggle **Order matters**: OFF = you can click them in any order later (easier). ON = you must click in exact same order (more secure).
- When 8 are selected, you'll see `✓ Pattern set: [0,1,4,5...]`

**Write this pattern down on paper.** This is your secret second factor. No one else should know it.

Click **Continue →**

#### Step 5 — Media & Preferences
- **Theme:** Click Dark, Light, Warm, or Cold. Dark is default and looks best. You can change later.
- **Media Paths:** Leave as default for now:
  - Movies: `./media/movies`
  - Music: `./media/music`
  - Videos: `./media/videos`
  These folders will be created automatically on your computer inside `Vault-V2/server/media/`
- **CORS Origins (optional):** Leave empty unless you use Cloudflare Tunnel later.

Click **Continue →**

#### Step 6 — Review & Complete
You see everything you chose: Server URL, Username, Grid Pattern, Theme, Paths.

Double-check. Then click **Complete Setup ✨**

You'll see `✓ Setup complete!` and `Enablement: true`. After 1 second, you enter Vault automatically. If not, it will ask you to login with the account you just created.

**That's it. Vault is ready.**

---

## Adding Your Movies, Music, Videos

Two ways, both easy:

### Way A — Upload Inside Vault (Easiest)
1. In Vault, look left sidebar → click **Upload**
2. Choose **Movie**, **Music**, or **Video**
3. Drag your files into the box or click to browse
4. Click Upload — progress bar shows
5. Files appear in your library in seconds

### Way B — Copy Files Directly (Fast for Lots of Files)
1. On your computer, open folder `Vault-V2/server/media/`
2. You'll see three folders: `movies`, `music`, `videos`
3. Copy your files there (e.g., `my-movie.mp4` into `movies`)
4. In Vault → **Settings** → click **Trigger Library Scan**
5. Vault scans and adds them

Supported formats: `.mp4, .mkv, .webm, .avi, .mov, .mp3, .flac, .wav, .ogg, .opus, .m4a, .aac` and 20+ more. If a file isn't natively supported, Vault transcodes it on-the-fly.

---

## How to Use Vault Daily

**Login next time:**
1. Make sure server is running: Terminal → `cd Vault-V2/server` → `npm start`
2. Open https://kokonut-dev.github.io/Vault-V2/
3. Enter username + password → Continue
4. Click your 8 secret squares → Unlock Vault

**Navigation:**
- **Home** — Continue watching, recently added, random picks, stats
- **Movies / Music / Videos** — Grid or list view, sort by title/year/added, filter by genre/year
- **Playlists** — Create playlists or collections, add any item
- **Favourites** — Heart icon on any card
- **History** — Where you left off, progress saved
- **Upload** — Add more media
- **Settings** — Everything customizable

**Keyboard shortcuts:**
- `Alt + Space` (Mac: `Option + Space`) → Global search
- `?` → Show all shortcuts
- `Space` → Play/Pause (when player focused)
- `← →` → Seek 10s, `↑ ↓` → Volume

---

## All Features — Detailed

### Library & Management
- **Auto-scanning:** Uses `chokidar` to watch your media folders. Add a file → appears automatically. No manual refresh needed after initial scan.
- **Metadata extraction:** Reads ID3 tags (artist, album, year, genre, cover art) for music via `music-metadata`. Reads video resolution, codec, duration via `ffprobe`.
- **Covers & Thumbnails:** Extracts embedded cover art, generates video thumbnails (320x180) on scan.
- **Search:** Client-side fuzzy search via Fuse.js (10KB) — instant, typo-tolerant. Server-side fallback `/api/library/search`. Recent searches saved.
- **Sorting & Filtering:** By title, date added, year, rating, duration, size, genre, year.
- **Metadata editing:** Edit title, artist, album, genre, year, description, rating directly in detail view.
- **Delete:** Delete from library only, or delete file from disk too.

### Video Player (Custom, No Native Controls)
- **Format support:** MP4 H.264 (universal), WebM VP9, AV1, HEVC H.265 where supported. Everything else → transcoded to H.264/AAC fragmented MP4 on-the-fly.
- **Controls:** Play/pause, next episode, volume with slider, mute, time display, progress bar with buffered/ played distinction, thumbnail preview on hover, keyboard seek.
- **Advanced:** Playback speed (0.25x–2x), theatre mode, Picture-in-Picture, fullscreen, captions (SRT/VTT/ASS→VTT), skip intro button, next episode overlay with countdown (10s), auto-play next.
- **Streaming:** Range requests (206 Partial Content) for instant seeking, even in 4K.

### Audio Player (Spotify-like)
- **Web Audio API:** Real audio graph — not just `<audio>` tag.
- **10-band EQ:** -12dB to +12dB per band, visual curve with bezier + fill, presets (flat, bass boost, vocal, etc.), custom presets save, enable toggle, reset.
- **Features:** Gapless playback, crossfade 0–12s, shuffle, repeat off/all/one, volume, mute, queue (add next / add to queue), mini-player always visible (glass effect), fullscreen now-playing with visualizer (analyser), lyrics display, Media Session API (lock screen controls on phone).
- **Transcoding:** WMA, AIFF, ALAC, etc. → Opus/AAC/MP3 on-the-fly.

### Security — Two Factors, Zero Cloud
- **Step 1:** Username + password (bcrypt hashed, never stored plain).
- **Step 2:** Grid challenge — 4×4 = 16 squares, choose 8. Combinations: C(16,8)=12,870. With order matters: P(16,8)=~500M. No visual hint.
- **JWT:** Short-lived challenge token (5 min) after password, then final access token (default 24h, configurable 1h–30d).
- **Brute-force protection:** 5 failed attempts → lock IP for 15 minutes (configurable). Stored in `server/data/bruteforce.json`, survives restart. Returns 429 with retry time.
- **Logout:** Token blacklisted until expiry.
- **CORS:** Only allows `https://kokonut-dev.github.io` + localhost by default. Add your tunnel domains in setup or Settings.
- **Helmet:** CSP, HSTS, X-Frame-Options, etc.
- **Rate limiting:** General 200 req/15min, auth 10/15min, upload 30/15min.
- **Sanitization:** All inputs escaped via `validator`, filenames sanitized (no path traversal), mime-type checked by magic bytes, not just extension.

### Appearance — Premium Feel
- **Themes:** Dark (default #0A0A0A), Light, Warm (amber), Cold (blue). CSS variables, instant switch, saved in localStorage.
- **Glassmorphism:** `backdrop-filter: blur(20px)` with intensity slider 0–100% in Settings. Frosted glass cards, sidebar, player.
- **Film Grain:** Subtle noise texture overlay, intensity slider 0–100%, respects `prefers-reduced-motion`.
- **Animations:** Page enter, card hover (translateY + scale), skeleton loaders, shake on wrong grid, onboarding enter, complete pop. All respect `prefers-reduced-motion`.
- **Layout:** Sidebar collapsible, mobile hamburger menu, responsive grid (1–6 columns), bottom mini-player, theatre mode.
- **Accessibility:** Focus-visible rings, skip link, ARIA labels, keyboard navigation for grid, screen reader support.

### PWA & Offline
- **Installable:** Add to home screen on phone/desktop. Manifest with icons, theme color.
- **Service Worker:** Caches shell (HTML/CSS/JS) but not media. Offline UI shows "Server disconnected — retrying..." with retry button. Reconnects automatically.

### Playlists, Favourites, History
- **Playlists:** Create, rename, delete, add/remove items. Types: playlist vs collection.
- **Favourites:** Heart any item, stored locally + server.
- **History:** Progress per item (e.g., 42% watched), watchedAt timestamp, resume where left off. Last 100 kept.

### Server & Transcoding
- **Node.js 18+ / Express 4.x**, zero native deps by default (except optional sharp).
- **ffmpeg-static + ffprobe-static** for transcoding & probing, fallback to system ffmpeg if available. LRU cache in `server/cache/transcoded` (default 5GB max).
- **Data:** `server/config.json` (your credentials, never committed), `server/data/library.json` (index), `server/data/*` (bruteforce, blacklist, playlists, history, favourites).
- **Cache:** `server/cache/thumbnails`, `covers`, `transcoded` — gitignored, safe to delete.
- **Upload:** `multer` multipart, max 10GB default, magic-byte validation.

### Onboarding & Setup API
- **First run:** No `config.json` → `GET /api/setup/status` returns `needsSetup:true`. Frontend shows 6-step wizard.
- **Endpoints:**
  - `GET /api/setup/status` — public, tells if setup needed
  - `GET /api/setup/defaults` — safe defaults for UI
  - `POST /api/setup/test` — validates media paths existence
  - `POST /api/setup/complete` — creates config, hashes password, generates JWT secret, ensures dirs, returns token + `enablement:true`
- **Config:** After completion, `server/config.json` contains `onboarding: { completedAt, completedBy, version, theme, enablement:true }`. Deploy workflow checks this.

### Deployment
- **Frontend:** Static SPA in `docs/` hosted on GitHub Pages. No build step needed (vanilla JS). `404.html` hack for SPA routing (History API).
- **GitHub Actions `.github/workflows/deploy.yml`:** Checks core files + onboarding wizard files (`onboarding.js/css`), checks backend setup routes + `enablement:true`, validates `VAULT_ENABLEMENT=true`, then uploads `docs/` artifact and deploys via `actions/deploy-pages@v4`.

---

## How It Works — Simple Explanation

```
[Your Browser]  →  https://kokonut-dev.github.io/Vault-V2/  (beautiful UI, no data)
      ↓ HTTPS (or http://localhost:4000 locally)
[Your Computer] →  Node.js server at :4000  →  Your media folders
      ↓
[Your Files] stay on your disk. Nothing uploaded anywhere.
```

Frontend is static (GitHub Pages). Backend is local (your machine). They talk via REST API + token. Media streams via `Range` requests, so seeking is instant.

---

## Remote Access — Use Vault From Your Phone Outside Home

By default Vault only works at home (`localhost`). To use from phone anywhere:

**Easiest — Cloudflare Tunnel (free, secure, HTTPS):**
1. Install `cloudflared`: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. Run: `cloudflared tunnel --url http://localhost:4000`
3. You'll get a URL like `https://random-words-1234.trycloudflare.com`
4. In Vault → Settings → API Base URL → paste that URL → Save → Test Connection
5. On your phone, open GitHub Pages URL — it will now connect via tunnel. Or add that tunnel URL as a bookmark.

**Alternative — Tailscale / ngrok / mkcert:**
- Tailscale gives you a private VPN URL.
- ngrok similar to Cloudflare Tunnel.
- mkcert creates trusted local HTTPS cert so GitHub Pages HTTPS can talk to `https://localhost:4000` without mixed-content block. Run `scripts/generate-cert.js`.

---

## Troubleshooting — If Something Breaks

**"Cannot connect to Vault server"**
- Is Terminal still open showing `Vault server ready!`? If not: `cd Vault-V2/server` → `npm start`
- Is Server URL correct? Login screen → bottom → `Server: http://localhost:4000` → Click Change → type `http://localhost:4000`
- Try local frontend to avoid HTTPS block: `cd Vault-V2` → `npx serve docs` → open `http://localhost:3000`

**"Invalid credentials"**
- Username is case-sensitive. Check `server/config.json` → `auth.username`
- Password: if you forgot, delete `config.json` and restart setup wizard, or run `npm run setup` in `server/`

**"Too many login attempts / locked out"**
- Lockout only counts **wrong** credentials. Successful logins and normal page loads never trip it.
- After 5 wrong passwords/grids, Vault locks that IP for 15 min. Wait 15 min or delete `server/data/bruteforce.json` and restart server.
- Grid squares: check `server/config.json` → `auth.gridPattern` shows your numbers (e.g. [0,1,4,5,8,9,12,13]). Count from 0 top-left to 15 bottom-right.
- If the grid step says your "login session expired", just enter your password again — the 5-minute challenge window passed; this is not a failed attempt.

**"Mixed Content / HTTPS vs HTTP"**
- Good news: **`http://localhost:4000` works from the GitHub Pages site.** Chrome, Edge and Firefox never block `localhost` / `127.0.0.1` from HTTPS pages, so the default setup (server on your computer, UI on github.io) just plays.
- What IS blocked: plain-HTTP addresses that are **not** localhost (e.g. `http://192.168.1.50:4000` from a NAS or another machine), and all HTTP in Safari. Fix any of these ways:
  1. Serve the UI from the local server instead: open `http://localhost:4000` (same origin, no mixed content), or `npx serve docs` (http → http).
  2. Give the server HTTPS: `cd server && npm run generate-cert`, set `"server": { "https": { "enabled": true } }` in `server/config.json`, then use `https://localhost:4000` as the Server URL. Trust the generated cert so the browser accepts it.
  3. Use Cloudflare Tunnel (free HTTPS): `cloudflared tunnel --url http://localhost:4000` → set that URL as the Server URL.
- Vault detects a blocked URL up front and warns you on the login screen instead of failing silently.

**"Upload fails / File too large"**
- Default max 10GB. Check `server/config.json` → `media.maxUploadSizeMB`. Increase if needed.

**"No thumbnails / Transcoding fails"**
- ffmpeg might be missing. Server uses `ffmpeg-static` but if install failed (cert error), install ffmpeg system-wide: `brew install ffmpeg` (Mac) or `sudo apt install ffmpeg` (Linux), then restart.

**Reset everything:**
- Delete `server/config.json` → restart server → wizard appears again. Your media files stay safe.

---

## For Developers

```bash
server/
  npm run dev     → nodemon auto-reload
  npm run setup   → old CLI wizard (interactive terminal)
  npm start       → production

docs/
  npx serve docs  → frontend at http://localhost:3000
  # No build needed — vanilla ES modules

API:
  GET  /api/health              → public health
  GET  /api/setup/status        → needsSetup?
  POST /api/setup/complete      → create config, returns token + enablement:true
  POST /api/auth/login          → {username,password} → challengeToken
  POST /api/auth/grid           → {challengeToken,pattern} → token
  GET  /api/library?search=&type=&genre=&sort=&page=&limit=
  GET  /api/media/stream/:id?token=  (Range support)
  POST /api/upload/:type        (multipart)

Deploy:
  .github/workflows/deploy.yml checks:
    - docs/index.html, config.js, onboarding.js/css
    - server/routes/setup.js + enablement:true
    - VAULT_ENABLEMENT=true env
```

**Project structure:**
```
docs/           → GitHub Pages SPA (vanilla JS)
  css/          → variables, themes, glass, grain, onboarding, player, etc.
  js/
    onboarding.js → 6-step wizard
    api.js        → fetch wrapper + setup methods
    auth.js, store.js, router.js, themes.js
    components/   → sidebar, searchModal, audioPlayer, videoPlayer, eqPanel, etc.
    views/        → home, movies, music, videos, playlists, settings, etc.
server/
  index.js      → Express + mounts /api/setup public
  config.js     → loads/saves config.json, onboarding.enablement:true
  routes/setup.js → onboarding API
  routes/auth.js, library.js, media.js, upload.js, etc.
  services/     → scanner (chokidar), library (JSON DB), transcoder, thumbnail
  media/        → default folders (movies/music/videos)
  data/         → library.json, bruteforce.json, etc. (gitignored)
  cache/        → thumbnails/covers/transcoded (gitignored)
```

---

## Security in Plain Words

- Password is scrambled with bcrypt — even if someone steals `config.json`, they can't read it.
- Grid pattern is secret — like a PIN but 12,870 combinations (500M with order).
- After 5 wrong logins, Vault locks that IP for 15 minutes.
- Nothing goes to internet. Your movies stay on your disk.
- JWT tokens expire (24h default). Logout blacklists token.
- All inputs sanitized, no path traversal, no XSS via CSP.

---

## License

MIT — do whatever you want. See [LICENSE](LICENSE)

---

**Made with ❤️ — Your media, your server, your rules. Enablement: true, Onboarding: 6 steps, Private: always.**
