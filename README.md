# Vault — Your Personal Netflix + Spotify. Private. Yours.

**Vault is a self-hosted media server that makes your movies, shows, music, audiobooks and videos look and feel premium — no cloud, no tracking, no subscriptions.**

You run a small server on your own computer and open the app in your browser. Your files never leave your house.

- **App:** https://kokonut-dev.github.io/Vault-V2/ — or `http://localhost:4000`, served by your own server
- **Runs on:** Linux, macOS and Windows (or Docker)

**Contents:** [Install](#install) · [First run](#first-run--the-setup-wizard) · [Keep it running](#keep-it-running) · [Updating](#updating) · [Adding media](#adding-your-media) · [Daily use](#daily-use) · [Remote access](#use-vault-on-your-phone-tablet-or-tv) · [Troubleshooting](#troubleshooting) · [Features](#features) · [Developers](#for-developers)

---

## Install

### 1. What you need

| | |
|---|---|
| **Node.js 20 or newer** | The current LTS (24 or 26) is recommended. Check with `node -v`. |
| **git** | To download Vault and update it later. Check with `git --version`. |
| **About 300 MB of disk** | For Vault and its packages, plus room for your media. |

ffmpeg (used for thumbnails, converting formats and Live TV) is downloaded automatically during install, so you don't need to install it yourself.

<details>
<summary><b>Installing Node.js and git on Linux</b></summary>

Distribution packages are often too old (Debian 12 and Ubuntu 24.04 ship Node 18, Ubuntu 22.04 ships Node 12). The simplest reliable route is **nvm**, which installs Node into your home folder — no `sudo` needed:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash
# close and reopen the terminal, then:
nvm install --lts
node -v        # should print v24.x or newer
```

git: `sudo apt install git` (Debian/Ubuntu/Mint), `sudo dnf install git` (Fedora), `sudo pacman -S git` (Arch).

Up-to-date distributions can also use their own packages: `sudo dnf install nodejs` (Fedora), `sudo pacman -S nodejs npm` (Arch). Check `node -v` afterwards.
</details>

<details>
<summary><b>Installing Node.js and git on macOS or Windows</b></summary>

- **macOS:** the LTS installer from https://nodejs.org, or `brew install node git`. git also comes with the Xcode command line tools (`xcode-select --install`).
- **Windows:** the LTS installer from https://nodejs.org and Git from https://git-scm.com. Use the default options, then open a **new** PowerShell window so both are on the PATH.
</details>

### 2. Download, install, start

Open a terminal — Linux: `Ctrl + Alt + T` · macOS: `Cmd + Space` → *Terminal* · Windows: Start → *PowerShell* — and run:

```bash
git clone https://github.com/Kokonut-dev/Vault-V2.git
cd Vault-V2
npm install
npm start
```

`npm install` takes about a minute and ends with `added … packages`. Warnings about deprecated packages or "vulnerabilities" are normal; an `npm error` line is not (see [Troubleshooting](#install-problems)).

After `npm start` you should see:

```
[launcher] ready on http://127.0.0.1:4001 — the app can now start/stop the server
[launcher] starting server (pid 12345)
...
[INFO] Vault server (HTTP) running at http://0.0.0.0:4000
[INFO] Vault server ready!
[launcher] server is up on port 4000
```

Both commands work in either the `Vault-V2` folder or `Vault-V2/server`. If you run `npm start` without `npm install`, Vault installs its packages itself the first time.

**Leave this window open** while you use Vault, or see [Keep it running](#keep-it-running) to never need the terminal again.

### 3. Open Vault

Go to **http://localhost:4000** in Chrome, Firefox, Edge or Safari on the same computer. The [GitHub Pages app](https://kokonut-dev.github.io/Vault-V2/) works too and connects to `http://localhost:4000`.

> **Prefer Docker?** `docker compose up -d --build` in the `Vault-V2` folder runs Vault with ffmpeg included. Edit the media volumes in `docker-compose.yml` first. See [deploy/README.md](deploy/README.md).

---

## First run — the setup wizard

The first time you open Vault, a 6-step wizard appears:

1. **Welcome** → **Get Started**
2. **Connect to Server** — `http://localhost:4000` is filled in. Click **Test & Continue**. If it can't connect, check the terminal still says `Vault server ready!`.
3. **Create Admin Account** — a username (3+ characters: letters, numbers, `_`, `-`) and a password you'll remember.
4. **Security Grid** — your second password: click **exactly 8** of the 16 squares in a pattern you'll remember. With **Order matters** on, you must click them in the same order every time (more secure). **Write the pattern down.**
5. **Media & Preferences** — pick a theme and media folders. The defaults (`./media/movies`, `./media/music`, `./media/videos`) live inside `Vault-V2/server/media/` and are created for you.
6. **Ready to Launch** — review and click **Complete Setup**.

You're signed in automatically. Next time: username + password, then your 8 squares.

---

## Keep it running

**No terminal needed after the first start.** `npm start` also runs a tiny helper, the *launcher* (on `127.0.0.1:4001`, this computer only), which lets the app start, restart and stop the server:

- If the server isn't running, the sign-in screen and the "server disconnected" banner show a **Start server** button.
- **Settings → Connection → Server program:** **Restart**, **Stop server**, and **Start Vault when this computer starts**. That last one runs Vault quietly in the background after you sign in to your computer (Windows, macOS and Linux).

Running a headless server instead? `deploy/vault.service` (systemd) and `deploy/com.vault.server.plist` (launchd) are ready-made service files — see [deploy/README.md](deploy/README.md).

---

## Updating

```bash
cd Vault-V2
git pull
npm install
```

Then restart Vault: **Settings → Connection → Restart**, or `Ctrl + C` in the terminal and `npm start` again. Your account, library and settings (`server/config.json`, `server/data/`) are kept.

---

## Adding your media

**Upload in the app** — sidebar → **Upload**, choose the type, then drag files in. They appear in the library when the upload finishes.

**Copy files** (fastest for lots of files) — put them in `Vault-V2/server/media/` (`movies`, `music`, `videos`, `audiobooks`, `podcasts`, `comics`) or in the folders you chose in the wizard. Vault notices new files automatically. To force a rescan, go to **Settings → Connection → Scan library now**.

**Import from Google Drive**
1. In Drive: right-click a file or folder → **Share** → *General access* → **Anyone with the link** → **Copy link**.
2. In Vault: **Upload** → **Import from Google Drive** → paste the link → **Preview**.
3. Untick anything you don't want, choose where it goes (or leave *Automatic*) → **Import**. Progress shows live, and you can cancel at any time.

For private files, add an API key or OAuth client ID in **Settings → Links & imports**, then use **Connect Google account** on the Upload page. Your Google sign-in stays in the browser tab; Vault never stores it.

**Formats:** `.mp4 .mkv .webm .avi .mov .mp3 .flac .wav .ogg .opus .m4a .aac` and many more. Anything the browser can't play natively is converted on the fly.

---

## Daily use

- **Home** — continue watching, recently added, picks
- **Movies & Series, TV Shows, Music, Artists, Audiobooks, Videos, Podcasts, Comics** — grid or list, sort and filter
- **Live TV & DVR** — M3U/IPTV channels, played through the server
- **My List, Playlists, Favourites, History** — your collections and where you left off
- **SyncPlay** — watch together in sync
- **Your Stats** — what you've watched and listened to
- **Settings** — appearance (6 themes), playback, EQ, subtitles, security, devices, connection

**Keyboard shortcuts** — press `?` in the app for the full list.

| Key | Action |
|---|---|
| `Alt + Space` (Mac: `Option + Space`) | Search |
| `Space` / `K` | Play / pause (while a player is open) |
| `←` / `→` | Seek −10 s / +10 s |
| `↑` / `↓` | Volume |
| `0`–`9` | Jump to 0 %–90 % |

---

## Use Vault on your phone, tablet or TV

Click the **phone icon** in the top bar (or **Settings → Connection → Use Vault on other devices**).

**Same Wi-Fi**
1. Pick **Same Wi-Fi**. A QR code appears.
2. Scan it with the phone's camera. Vault opens **already signed in** (the code works once and expires after 5 minutes; untick *Sign the other device in automatically* to share just the address).
3. No camera (TV, games console)? Open the address shown, choose **Sign in with a code from another device**, and approve the 6-digit code on a signed-in device.

If the phone can't connect, the dialog explains why. Usually Vault is set to *this computer only*, and the dialog offers a one-click switch. On Linux, a firewall may also block port 4000: `sudo ufw allow 4000/tcp` (Ubuntu) or `sudo firewall-cmd --add-port=4000/tcp --permanent && sudo firewall-cmd --reload` (Fedora).

**From anywhere** (mobile data, work, a friend's house)
1. Pick **Anywhere** → **Turn on remote access**.
2. The first time, Vault downloads Cloudflare's small tunnel program (checksum-verified, about 40 MB) and gives you a private `https://…trycloudflare.com` address with its own QR code.
3. Your password and grid still protect Vault. Turn it off from the same place. You can also have it start with the server.

Prefer your own setup? `cloudflared tunnel --url http://localhost:4000`, Tailscale and ngrok all work. For a trusted local HTTPS certificate, use `npm run generate-cert` in `server/` (see *Mixed content* below).

---

## Troubleshooting

### Install problems

**`Error: Cannot find module 'dotenv'` (or `express`, …), or the server keeps restarting**
Vault's packages aren't installed: `npm install` was skipped, failed, or ran in another folder. Run `npm install` in `Vault-V2` (or `Vault-V2/server`), then `npm start`. Current versions detect this and install the packages themselves; if that fails, the reason is shown in the terminal and in the app.

**`npm error enoent Could not read package.json`**
You're not in the Vault folder. `cd Vault-V2` first (`ls` should show `server`, `docs` and `package.json`).

**`Vault needs Node.js 20 or newer` / `SyntaxError` / `Unsupported engine`**
Your Node is too old (`node -v`). Install the current LTS (see [What you need](#1-what-you-need)), then `npm install` again.

**`EACCES: permission denied` during `npm install`**
Don't use `sudo npm install`. If you did once, fix ownership with `sudo chown -R "$USER" Vault-V2 ~/.npm` and run `npm install` again. Using nvm avoids this entirely.

**`install scripts blocked … ffmpeg-static` (npm 12+)**
npm 12 only runs install scripts you've approved. Vault approves ffmpeg-static in `server/package.json`, so update (`git pull`) and run `npm install` again. If ffmpeg still can't be downloaded (offline, proxy or firewall), the install continues without it. In that case install ffmpeg system-wide: `sudo apt install ffmpeg`, `sudo dnf install ffmpeg`, `sudo pacman -S ffmpeg` or `brew install ffmpeg`.

**`Port 4000 is already in use`**
Another Vault (or another app) is running on it. Close it, or start on another port: `VAULT_PORT=4005 npm start` (Windows PowerShell: `$env:VAULT_PORT=4005; npm start`). Then use `http://localhost:4005` in the app.

### Using Vault

**"Cannot connect to Vault server"**
- Is it running? Press **Start server** on the sign-in screen if it's shown; otherwise `cd Vault-V2` → `npm start`.
- Is the address right? Sign-in screen → bottom → **Server** → *Change* → `http://localhost:4000`.

**"Invalid credentials"**
- The username is case-sensitive (see `auth.username` in `server/config.json`).
- Forgot the password? Run `npm run setup` in `server/`, or delete `server/config.json` and restart to run the wizard again (your media files are not touched).

**"Too many login attempts"**
- Only **wrong** answers count, per step: 5 wrong passwords lock the password step for that IP for 15 minutes, and 5 wrong grid patterns lock the grid step. Wait, or delete `server/data/bruteforce.json` and restart.
- "Login session expired" on the grid step just means the 5-minute window passed. Enter your password again; it doesn't count as a failed attempt.
- Your grid pattern is in `server/config.json` → `auth.gridPattern` (squares are numbered 0 at the top left to 15 at the bottom right).

**Mixed content (HTTPS page, HTTP server)**
- `http://localhost:4000` works from the GitHub Pages app in Chrome, Edge and Firefox.
- Blocked: plain-HTTP addresses that **aren't** localhost (e.g. `http://192.168.1.50:4000`), and all HTTP in Safari. Fix it in one of these ways:
  1. Open the app from your server directly (`http://localhost:4000` or `http://<server-ip>:4000`), so everything is on the same origin.
  2. Give the server HTTPS: `cd server && npm run generate-cert`, set `"server": { "https": { "enabled": true } }` in `server/config.json`, and trust the generated certificate.
  3. Use remote access (Cloudflare tunnel, which gives you free HTTPS).
- Vault warns about a blocked address on the sign-in screen instead of failing silently.

**No thumbnails / a video won't convert**
ffmpeg is missing; see the ffmpeg item under [Install problems](#install-problems). To use a specific build, set `FFMPEG_PATH` and `FFPROBE_PATH` before starting. Hardware encoders (NVENC, QuickSync, VAAPI, AMF) are only used after a test encode succeeds, so a GPU-less machine falls back to the CPU.

**Upload fails: "File too large"** — the default limit is 10 GB. Change `media.maxUploadSizeMB` in `server/config.json`.

**A Live TV channel or IPTV movie won't play**
- Streams are played through the server, which repackages them with ffmpeg. **Settings → Live TV** warns when ffmpeg is missing.
- **Settings → Live TV → Test links** checks a few entries and tells you whether they play, need converting, or fail (e.g. "access denied" means an expired subscription or a wrong password in the link).
- Up to 4 streams run at once (`livetv.maxStreams`). Idle streams stop after 45 s (live) or 5 min (movies).

**Something looks broken right after an update** — hard-reload the page (`Ctrl + Shift + R`, Mac `Cmd + Shift + R`) and restart the server.

**Start over** — delete `server/config.json` and restart; the wizard appears again. Your media files are not touched.

---

## Features

**Library** — watches your folders and adds new files automatically; reads tags and cover art (artist, album, year, genre) and video details; generates thumbnails; fuzzy, typo-tolerant search; sorting and filters; metadata editing; trash with restore.

**Video player** — custom controls, thumbnail previews on the timeline, speed 0.25×–2×, theatre mode, Picture-in-Picture, subtitles (SRT/VTT/ASS), skip intro, next-episode countdown. It converts unsupported formats on the fly and seeks instantly via range requests.

**Music player** — Web Audio graph with a 10-band EQ (±12 dB, presets, custom presets), gapless playback, crossfade 0–12 s, a soft fade on pause and skip, shuffle and repeat, queue, lyrics, a time preview while seeking, a full-screen Now Playing with visualiser, and lock-screen controls (Media Session).

**More** — Live TV & DVR (M3U/IPTV), audiobooks, podcasts, comics, SyncPlay, profiles, listening/watching stats, Google Drive import, and an installable PWA.

**Look and feel** — six themes (Hearth, Linen, Parchment, Dusk, Ember, Daylight), smooth animations that respect *reduced motion*, and a layout that adapts from phone to desktop. Accessible: keyboard navigation, focus rings, ARIA labels, and contrast-checked colours.

**Security**
- Two factors: a password (bcrypt-hashed), then the 8-of-16 grid (12,870 combinations, or about 518 million with *order matters*).
- Short-lived challenge token after the password, then an access token (24 h by default, configurable 1 h–30 d). Signing out revokes the token.
- Brute-force lockout per step, which survives restarts.
- Rate limits per 15 minutes: 2000 general, 10 sign-in, 30 upload.
- Helmet security headers and CSP. CORS allows only the Vault app and localhost by default (add your own domains in Settings).
- Uploads are checked by content (magic bytes), not just extension, and file names are sanitised against path traversal.

---

## How it works

```
[Your browser]  →  Vault app (from GitHub Pages or your own server)
      ↓  REST API + token
[Your computer] →  Node.js server on :4000  →  your media folders
```

The app is a static site and holds no data. The server runs on your machine and streams your files directly to your browser. Nothing is uploaded anywhere.

---

## For developers

```bash
npm install            # root: installs server/ packages too
npm start              # launcher + server (http://localhost:4000)
npm run dev            # server only, auto-reload (nodemon)
npm test               # server tests (node --test)
npm run build:css      # rebuild docs/css/vault.css — after editing any docs/css/*.css
```

From `server/`: `npm run lint` (syntax check), `npm run check:imports`, `npm run test:keyboard`, `npm run test:music`, `npm run setup` (terminal setup wizard), `npm run generate-cert`.

**CI** — `.github/workflows/test.yml` runs on every pull request: lint, server tests, the `vault.css` freshness check, and a fresh-install test (Node 20, current LTS and newest) that starts the server the way a new user does. `.github/workflows/deploy.yml` re-runs the checks on `main` and publishes `docs/` to GitHub Pages.

**Project structure**
```
package.json        → root scripts; `npm install` here also installs server/
docs/               → the app: a vanilla-JS SPA (no build step), published to GitHub Pages
  css/              → source stylesheets; vault.css is the generated bundle (don't edit)
  js/               → app shell, api.js, router, store, components/, views/, utils/
server/             → Node.js + Express API
  launcher.js       → start/stop helper on 127.0.0.1:4001; installs missing packages
  index.js          → the server
  config.js         → loads server/config.json (your account and settings — gitignored)
  routes/ services/ middleware/ utils/
  media/            → default library folders
  data/ cache/      → library index, history, thumbnails, conversions (gitignored)
  test/             → node --test suites
scripts/            → CSS build and check scripts
deploy/             → Docker, systemd and launchd notes and files
```

**API at a glance**
```
GET  /api/health                     public health check
GET  /api/setup/status               { needsSetup }
POST /api/setup/complete             create the account and config
POST /api/auth/login                 { username, password } → challengeToken
POST /api/auth/grid                  { challengeToken, pattern } → token
GET  /api/library?search=&type=&genre=&sort=&page=&limit=
GET  /api/media/stream/:id?token=    range requests supported
POST /api/upload/:type               multipart
```

---

## License

MIT — see [LICENSE](LICENSE).
