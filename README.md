# Vault — Your Personal Netflix + Spotify. Private. Yours.

**Vault is a self-hosted media server that makes your movies, shows, music, audiobooks and videos look and feel premium — no cloud, no tracking, no subscriptions.**

You run a small server on your own computer and open the app in your browser. Your files never leave your house.

- **App:** https://kokonut-dev.github.io/Vault-V2/ — or `http://localhost:4000`, served by your own server
- **What it looks like:** https://kokonut-dev.github.io/Vault-V2/landing.html — features, screenshots and themes on one page
- **Runs on:** Linux, macOS and Windows (or Docker)
- **Needs:** Node.js 20+, git, and ffmpeg + ffprobe (bundled automatically on most systems) — full list in [Requirements and dependencies](#requirements-and-dependencies)

**Contents:**
[Install](#install) ·
[Requirements and dependencies](#requirements-and-dependencies) ·
[First run](#first-run--the-setup-wizard) ·
[Keep it running](#keep-it-running) ·
[Moving to a new computer](#moving-to-a-new-computer) ·
[Updating](#updating) ·
[Adding media](#adding-your-media) ·
[Daily use](#daily-use) ·
[Remote access](#use-vault-on-your-phone-tablet-or-tv) ·
[Configuration](#configuration) ·
[Troubleshooting](#troubleshooting) ·
[Features](#features) ·
[Developers](#for-developers)

---

## Install

> **Want an app instead?** The **Vault desktop app** for Windows, macOS and Linux bundles everything (no Node.js, git or terminal), runs the server from the tray or menu bar, and keeps your library in your user folder. Download it from the [Desktop apps workflow](https://github.com/Kokonut-dev/Vault-V2/actions/workflows/desktop.yml) or a release, and see [desktop/README.md](desktop/README.md) for install notes. Interested in Android? [ANDROID.md](ANDROID.md) explains how a QR-first Android app would work.

### 1. What you need

| | |
|---|---|
| **Node.js 20 or newer** | The current LTS (24) is recommended. Check with `node -v`. |
| **git** | To download Vault and update it later. Check with `git --version`. |
| **ffmpeg and ffprobe** | Downloaded automatically by `npm install` on Windows, macOS and most Linux PCs. You only install them yourself if that download fails — see [ffmpeg and ffprobe](#ffmpeg-and-ffprobe). |
| **About 300 MB of disk** | For Vault and its packages (ffmpeg is most of that), plus room for your media. |

Everything else is either installed by `npm install` or optional. The complete list, with what each piece is for and what stops working without it, is in [Requirements and dependencies](#requirements-and-dependencies).

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

> **Prefer Docker?** `docker compose up -d --build` in the `Vault-V2` folder runs Vault on Node 22 with ffmpeg and ffprobe included. Edit the media volumes in `docker-compose.yml` first. See [deploy/README.md](deploy/README.md).

---

## Requirements and dependencies

### At a glance

| What | Needed? | Installed by | Used for |
|---|---|---|---|
| **Node.js ≥ 20** (+ npm) | Required | You | Runs the server and the launcher. Node 22.13+ also unlocks the optional SQLite library index. |
| **git** | Recommended | You | Downloading and updating Vault (`git pull`). A ZIP download from GitHub also works, but then updates are manual. |
| **ffmpeg** | Strongly recommended | `npm install` (ffmpeg-static), or you | Converting video/audio the browser can't play, HLS streaming, thumbnails, timeline previews (trickplay), Live TV / IPTV, silence detection for gapless music. |
| **ffprobe** | Strongly recommended | `npm install` (ffprobe-static), or you | Reading video details: duration, resolution, codecs, HDR, audio tracks, subtitles, chapters. |
| **A modern browser** | Required | You | Chrome, Edge, Firefox or Safari (current versions). The app is a plain web page — nothing to install on phones or TVs. |
| `unrar` | Optional | You | Reading `.cbr` comics. `.cbz` works without it. |
| `cloudflared` | Optional | Vault, on demand | **Remote access → Anywhere**. Downloaded (checksum-verified, ~40 MB) the first time you switch it on. |
| `mkcert` or `openssl` | Optional | You | `npm run generate-cert` for local HTTPS. mkcert makes a certificate your browsers trust; openssl makes a self-signed one. |
| `caffeinate` / `systemd-inhibit` / PowerShell | Optional | Your OS | Keeping the computer awake while Vault runs (macOS / Linux / Windows). Built in on all three. |
| GPU drivers (NVIDIA, Intel, AMD) | Optional | You | Hardware video encoding (NVENC, QuickSync, VAAPI, AMF). Only used if a test encode succeeds; otherwise Vault uses the CPU. |
| Docker | Optional | You | The alternative install: `docker compose up -d --build`. The image includes ffmpeg and ffprobe. |

### ffmpeg and ffprobe

Vault looks for each program in this order and uses the first one that exists:

1. `FFMPEG_PATH` / `FFPROBE_PATH`, if you set them;
2. the copy `npm install` downloaded (the `ffmpeg-static` and `ffprobe-static` packages, in `server/node_modules`);
3. `ffmpeg` / `ffprobe` on your `PATH` (a system install).

**What still works without them:** browsing, uploading, music and video in formats the browser plays natively (MP4/H.264, WebM, MP3, AAC, FLAC, Opus…), cover art and tags from music files. **What doesn't:** converting other formats (MKV with unusual codecs, AVI, WMA…), thumbnails and timeline previews, video details such as resolution and duration for non-native formats, HLS, Live TV and IPTV movies. **Settings → Live TV** and the **Server** page tell you when ffmpeg is missing.

**Check what Vault will use:**

```bash
cd Vault-V2/server
node -e "const b=require('./utils/ffmpegBinaries'); console.log(b.ffmpegBinary(), b.ffprobeBinary())"
```

**Install them yourself** (only if the automatic download failed — offline, behind a proxy, an unusual CPU, or npm blocked the install script):

| System | Command | Gives you |
|---|---|---|
| Debian / Ubuntu / Mint / Raspberry Pi OS | `sudo apt install ffmpeg` | ffmpeg + ffprobe |
| Fedora | `sudo dnf install ffmpeg-free` (or `ffmpeg` from RPM Fusion for every codec) | ffmpeg + ffprobe |
| Arch / Manjaro | `sudo pacman -S ffmpeg` | ffmpeg + ffprobe |
| macOS (Homebrew) | `brew install ffmpeg` | ffmpeg + ffprobe |
| Windows | `winget install Gyan.FFmpeg` (or download from https://www.gyan.dev/ffmpeg/builds/ and add its `bin` folder to `PATH`) | ffmpeg + ffprobe |

Check with `ffmpeg -version` and `ffprobe -version` in a **new** terminal, then restart Vault. To pin a particular build, start Vault with `FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe npm start`.

> **Linux and Live TV:** the bundled Linux ffmpeg is a static build. Vault works around the glibc/iconv crash those builds have on MPEG-TS channels, but if a channel still fails, a distribution ffmpeg (`sudo apt install ffmpeg` and `FFMPEG_PATH=$(which ffmpeg)`) is the most reliable choice.

### Node.js versions

| Node | Status |
|---|---|
| 18 and older | Not supported — Vault refuses to start and says so. |
| 20 | Supported (the oldest version CI tests). |
| 22 / 24 (LTS) | Recommended. From 22.13 the built-in `node:sqlite` module is available without flags, so you can set `"media": { "storage": "sqlite" }` for a faster index on very large libraries. The default JSON index needs nothing extra. |
| Newest release | Tested in CI on every pull request. |

### npm packages

`npm install` (from the repository root or `server/`) installs these into `server/node_modules`. You never install them by hand.

| Package | Why |
|---|---|
| express, helmet, cors, express-rate-limit, morgan | The web server, security headers/CSP, CORS, rate limits, request log |
| jsonwebtoken, bcryptjs, validator | Sign-in tokens, password hashing, input checks |
| multer, mime-types, fs-extra | Uploads (including whole folders), content types, file moves |
| chokidar | Watching your media folders for new files |
| music-metadata | Tags and cover art from audio files |
| fluent-ffmpeg | Driving ffmpeg/ffprobe |
| dotenv | Reading an optional `server/.env` file |
| *optional:* ffmpeg-static, ffprobe-static | The bundled ffmpeg and ffprobe binaries (see above) |
| *optional:* webtorrent 2.8.5 | The Torrents page. Pinned, because 3.x needs Node 22+ |
| *dev only:* clean-css, jsdom, nodemon | Building `vault.css`, DOM tests, auto-reload in `npm run dev` |

npm 12+ only runs install scripts you've approved. Vault approves the one it needs (ffmpeg-static's download) in `server/package.json`, so a normal `npm install` just works.

The app itself (`docs/`) has **no build step and no npm dependencies**: it's plain JavaScript modules, with `hls.js` and `qrcode-generator` vendored under `docs/vendor/` (licences included) and the Figtree and Fraunces fonts self-hosted under `docs/fonts/`.

### Optional online services

All off until you configure them, all in **Settings**:

- **Metadata:** TMDB (needs your own free API key), MusicBrainz, and local `.nfo` files.
- **Notifications and scrobbling:** webhook, ntfy, Discord, Telegram; Last.fm and ListenBrainz.
- **Google Drive import:** public links need nothing; private files need an API key or OAuth client ID.
- **Live TV:** your own M3U/IPTV lists, HDHomeRun tuners and XMLTV guides.

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

**Setting up from another device** (a headless server, a NAS or Docker)? The wizard asks for a **setup code**. It's printed in the server window when Vault starts, and saved in `server/data/setup-code.txt` (with Docker: `docker compose logs vault`). This stops anyone else on your network from claiming a brand-new server before you do. On the computer running Vault, no code is needed.

---

## Keep it running

**No terminal needed after the first start.** `npm start` also runs a tiny helper, the *launcher* (on `127.0.0.1:4001`, this computer only), which lets the app start, restart and stop the server:

- If the server isn't running, the sign-in screen and the "server disconnected" banner show a **Start server** button.
- **Settings → Connection → Server program:** **Restart**, **Stop server**, and **Start Vault when this computer starts**. That last one runs Vault quietly in the background after you sign in to your computer (Windows, macOS and Linux).

Running a headless server instead? `deploy/vault.service` (systemd) and `deploy/com.vault.server.plist` (launchd) are ready-made service files — see [deploy/README.md](deploy/README.md).

### When your computer locks or goes idle

Locking the screen doesn't stop Vault, but **sleep** does: a MacBook that's locked and idle (especially on battery) goes to sleep after a few minutes, and everything on it pauses, Vault included. Phones and TVs then can't reach it until you wake the Mac.

So **Vault now keeps the computer awake while it runs.** Your screen still turns off and locks as usual; only *idle sleep* is blocked, and only while Vault is running. It's on by default; switch it off under **Settings → Connection → Server program → Keep running when the computer is locked**.

- **macOS** uses Apple's built-in `caffeinate`. While Vault runs, `pmset -g assertions` lists it as *PreventUserIdleSystemSleep*.
- **Windows** uses the standard "system required" power request (`powercfg /requests` lists it).
- **Linux** uses `systemd-inhibit`.
- If Vault crashes or you stop it, the hold goes away with it, so your computer never stays awake for nothing.
- Turn it off for one run with `VAULT_KEEP_AWAKE=0 npm start`.

**What it can't override:**
- **Closing a MacBook's lid** still puts it to sleep, unless it's plugged in with an external display, keyboard and mouse attached (clamshell mode). Leave the lid open, or use a stand.
- **Battery:** to be safe on a laptop that's always on, plug it in. On macOS you can also turn on **System Settings → Battery → Options → "Prevent automatic sleeping on power adapter when the display is off"** (on older Macs: **Energy Saver** → *Prevent computer from sleeping automatically when the display is off*). From a terminal: `sudo pmset -c sleep 0`.
- **Start Vault when this computer starts** brings Vault back after a restart or crash. On macOS that entry now runs at full priority, so App Nap doesn't slow it down while the screen is locked. If you had already turned it on, Vault updates the entry by itself; the change applies from your next sign-in.

---

## Moving to a new computer

Changing servers? Vault can pack up **everything** into one package and unpack it on the new computer:

- every media file, **in exactly the same folders and with the same names** (open the package and browse it like any folder),
- your library with all hand-edited titles, covers and artwork,
- playlists, favourites, watch history and resume positions, profiles, collections, Live TV, and
- your sign-in (username, password, grid) and settings.

**On the old computer:** **Settings → Move to another server → Take everything with you**:
- **Download** saves a `.zip`. Your browser shows the progress; files over 4 GB are fine.
- **Copy link** gives you a link that works for 2 hours. Open it on the new computer to download straight there, with no USB stick needed.
- **Save to a drive or folder** writes a normal folder, e.g. on a USB drive (`/Volumes/MyDrive` on a Mac, `E:\` on Windows). This is the fastest option for big libraries.
- Choose **Library & settings only** if you'll move the media yourself, for example on an external drive you just plug into the new computer.

**On the new computer:** [install Vault](#install), run `npm start` and open the app. In the setup wizard, choose **Import from another Vault**. On a server that's already set up, use **Settings → Move to another server → Import** instead. Pick where your media should go, then choose the `.zip` or give the path to the package. Vault copies the files and **relinks everything to the new folders**, which works even between a Mac and Windows. Then it restarts. Sign in with your old username, password and grid.

The current library and settings on the new computer are saved in `server/backups/before-transfer-…` first. The new computer keeps its own network settings (port, HTTPS). Deleted items in the trash don't come along.

**From a terminal** (handy over SSH, or for a very large library):

```bash
# old computer: writes a folder (add --zip for one .zip file, --no-media for library & settings only)
npm run export -- /Volumes/MyDrive

# new computer: copy into ~/Vault Media, or use --in-place to keep using the files where they are
npm run import -- "/Volumes/MyDrive/Vault transfer - old-mac - 2026-11-18" --media-dir ~/"Vault Media"
npm start
```

An import that was interrupted can simply be run again; files already copied are skipped.

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

**Upload whole folders** — on the Upload page, pick **Folders (auto-sort)** and drop folders in (or use **Choose folder**). An `Artist/Album` or `Show/Season 1` folder keeps its structure, and covers and subtitles stay next to their files. Vault sorts each folder into Music, Movies & Series or Videos, and you can change any folder before uploading. Files already in your library (same path and size) are skipped. Big folders upload in batches; you can pause, cancel and retry failed files. Folder upload works in Chrome, Edge, Firefox and Safari.

**Download torrents** (off by default, admin only) — sidebar → **Torrents**. Read the notice and turn it on, then paste a magnet link or drop a `.torrent` file. Pick the files you want and where they go; Vault downloads them into a hidden folder and moves them into your library when they're done. You can limit speeds, set how many run at once, and keep sharing to a ratio after a download finishes. **VPN guard:** pick your VPN's network interface (e.g. `wg0`, `tun0`), and torrents only run while it's connected; they pause the moment it drops. Vault can't route torrents through a VPN by itself. For full protection, run the whole server behind the VPN (e.g. Docker with gluetun). Only download what you have the right to.

**Copy files** (fastest for lots of files) — put them in `Vault-V2/server/media/` (`movies`, `music`, `videos`, `audiobooks`, `podcasts`, `comics`) or in the folders you chose in the wizard. Vault notices new files automatically. To force a rescan, go to **Settings → Connection → Scan library now**.

**Import from Google Drive**
1. In Drive: right-click a file or folder → **Share** → *General access* → **Anyone with the link** → **Copy link**.
2. In Vault: **Upload** → **Import from Google Drive** → paste the link → **Preview**.
3. Untick anything you don't want, choose where it goes (or leave *Automatic*) → **Import**. Progress shows live, and you can cancel at any time.

For private files, add an API key or OAuth client ID in **Settings → Links & imports**, then use **Connect Google account** on the Upload page. Your Google sign-in stays in the browser tab; Vault never stores it.

**Formats:** `.mp4 .mkv .webm .avi .mov .mp3 .flac .wav .ogg .opus .m4a .aac` and many more. Anything the browser can't play natively is converted on the fly.

---

## Daily use

- **Home** — pick up where you left off, next episodes, a tile per library, what's new per type, favourites and your week; a new library gets a step-by-step welcome
- **Movies & Series, TV Shows, Music, Artists, Audiobooks, Videos, Podcasts, Comics** — grid or list, sort and filter
- **Live TV & DVR** — M3U/IPTV channels, played through the server. Add as many channel lists as you like (**Settings → Live TV → More channel lists**), each with its own guide and a streams-at-once limit so you never go over a provider's connection limit. Channels are grouped by list, and you can filter and search them.
- **My List, Playlists, Favourites, History** — your collections and where you left off
- **SyncPlay** — watch together in sync
- **Your Stats** — what you've watched and listened to
- **Server** (admins) — health, background jobs, logs, disk usage, backups, library index
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
3. Your password and grid still protect Vault. It **turns itself off after 8 hours** (choose 1, 4, 8, 24 hours or never), or turn it off from the same place. You can also have it start with the server.

Every sharing screen has a **How this is protected** panel. The full list is under [Security](#security).

Prefer your own setup? `cloudflared tunnel --url http://localhost:4000`, Tailscale and ngrok all work. For a trusted local HTTPS certificate, use `npm run generate-cert` in `server/` (see *Mixed content* below).

---

## Security

Vault is built so that using it doesn't open up your home network. Here is what it does, and what it can't promise.

**What Vault never does**
- It never opens ports on your router. From the internet, your home network looks the same as before. The one exception is the optional torrent downloader: it has a *UPnP / NAT-PMP* setting that can open its own port. It's off by default, so leave it off unless you really need it.
- It only answers on its own port (4000). It gives no access to your other devices, your router or files outside your media folders.
- The **Anywhere** address doesn't change that. This computer connects *out* to Cloudflare, so your home IP address stays hidden.

**Who can get in**
- **Sign-in always needs two steps:** your password, then your grid pattern (or an authenticator code, if you turn that on in **Settings → Security**). Recovery codes are there if you lose your phone.
- **Guessing doesn't work.** After 5 wrong tries, that device is locked out for 15 minutes. Each stage counts separately: password, second step, setup code and Subsonic. Behind the tunnel, each visitor is counted by their own address, not as one shared one.
- **Every device is listed** in **Settings → Devices**, with its address and a *Remote access* badge if it came in through the Anywhere address. Sign any device out there; changing your password signs out every other device.
- **Profiles keep their limits.** A kids' profile can't change server settings, turn on remote access or add a device with more rights than it has.

**Sharing access**

| What | Protection |
|---|---|
| Sign-in QR code / 6-digit code | Works once, expires after 5 minutes, signs in only as *your* profile. Wrong codes are throttled per device and for the whole server. |
| A TV asking to be approved | You always see a confirmation with where the device is (this computer, your network or the internet). Opening a pairing link someone sent you never approves it by itself. At most 3 waiting codes per address and 20 in total, so nobody can flood the code space. |
| Same Wi-Fi address | Only works inside your home network, and devices still have to sign in. It's plain `http://`, so avoid it on public Wi-Fi (use Anywhere, or `npm run generate-cert` for HTTPS). |
| Anywhere (Cloudflare tunnel) | Uses `https`, with a random address that changes each time. Turns itself off after 8 hours by default. Admins only. |
| Transfer download link | Admins only, works for one download, expires after 2 hours. It contains your settings, so keep it to yourself. |
| Subsonic apps | Off until you set a separate Subsonic password. Your Vault password is never accepted there, because Subsonic can't ask for the second step. Wrong passwords lock that device out. |
| A brand-new server | Only the computer running it can set it up without the setup code. Another device needs the code printed in the server window. The same applies to importing a transfer package. |

**Behind the scenes:** strangers get very little from the server. `/api/health` only returns `ok` and the version, and `/api/setup/status` shows no username or folders. Sign-in tokens are tied to a device and can be revoked. Media links carry read-only tokens that expire, and those are blanked out in the logs. The browser app sends a strict Content-Security-Policy, refuses to be framed, and sends no referrer. Vault doesn't use cookies, so other websites can't act as you.

**What no app can promise.** Vault can't make an absolute guarantee, and neither can any other app. What you do matters too:
1. Use a **strong, unique password** and turn on an **authenticator app** (Settings → Security).
2. Leave **Anywhere** off when you don't need it, or keep the automatic switch-off.
3. Check **Settings → Devices** now and then, and sign out anything you don't recognise.
4. Keep Vault, Node.js and your computer updated.
5. Want a private link that only your own devices can open, with no public address at all? Use [Tailscale](https://tailscale.com) instead of the Anywhere tab. Cloudflare carries tunnel traffic and could technically read it.

Found a security problem? Please open a private security advisory on GitHub (**Security → Report a vulnerability**) rather than a public issue.

---

## Configuration

Most settings live in the app (**Settings**), which writes them to `server/config.json` (created by the setup wizard, never committed). `server/config.example.json` lists every option with its default. A few things can also be set from the environment — in the terminal, in `server/.env`, or in `docker-compose.yml`.

Variables marked \* are **first-run defaults**: once the setup wizard has saved `server/config.json`, the value in that file wins (`server.port`, `server.host`, `auth.jwtSecret`, `auth.sessionTimeout`). Edit the file and restart to change them later.

| Variable | Default | What it does |
|---|---|---|
| `VAULT_PORT` \* | `4000` | Port the server listens on |
| `VAULT_HOST` \* | `0.0.0.0` | Address to listen on (`127.0.0.1` = this computer only) |
| `VAULT_LAUNCHER_PORT` | `4001` | Port of the start/stop helper (always `127.0.0.1`) |
| `FFMPEG_PATH` / `FFPROBE_PATH` | auto | Use a specific ffmpeg / ffprobe |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | GPU device for VAAPI encoding on Linux |
| `VAULT_KEEP_AWAKE` | `1` | `0` lets the computer sleep while Vault runs |
| `VAULT_MDNS` | off | `1` announces `vault.local` on your network |
| `CLOUDFLARED_PATH` | auto | Use your own `cloudflared` for remote access |
| `VAULT_JWT_SECRET` \* | random | Signing secret for sign-in tokens |
| `VAULT_SESSION_TIMEOUT` \* | `24h` | How long a sign-in lasts |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `VAULT_DEBUG` | off | `1` includes error details in API responses (never on a public server) |
| `ALLOW_SETUP_RESET` | off | `true` allows resetting setup through the API |
| `VAULT_HOME` | `server/` | Folder for everything Vault writes: `config.json`, `data/`, `cache/`, `media/` (default folders), `uploads/`, `logs/`, `bin/`. The desktop app sets it to your app-data folder. Move the existing ones with it if you change it |
| `VAULT_MEDIA_DIR` | `$VAULT_HOME/media` | Parent of the default media folders (movies, music, …) used before setup picks your own |
| `VAULT_DATA_DIR` | `$VAULT_HOME/data` | Where the data files (library, profiles, history…) live. `npm test` points it at a temp folder; *Move to another server* still uses `$VAULT_HOME/data`, so on a real install move `VAULT_HOME` instead |

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
npm 12 only runs install scripts you've approved. Vault approves ffmpeg-static in `server/package.json`, so update (`git pull`) and run `npm install` again. If ffmpeg still can't be downloaded (offline, proxy or firewall), the install continues without it. In that case install ffmpeg (which includes ffprobe) system-wide — commands per system are in [ffmpeg and ffprobe](#ffmpeg-and-ffprobe).

**`Port 4000 is already in use`**
Another Vault (or another app) is running on it. Close it, or move Vault to another port: set `"server": { "port": 4005 }` in `server/config.json` and restart. (Before the setup wizard has run there's no config file yet, so use `VAULT_PORT=4005 npm start`, or in Windows PowerShell `$env:VAULT_PORT=4005; npm start`.) Then use `http://localhost:4005` in the app.

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

**No thumbnails / a video won't convert / duration shows 0:00**
ffmpeg or ffprobe is missing or can't run. Check which ones Vault picked (see [ffmpeg and ffprobe](#ffmpeg-and-ffprobe)), install them if needed, and restart. To use a specific build, set `FFMPEG_PATH` and `FFPROBE_PATH` before starting. Hardware encoders (NVENC, QuickSync, VAAPI, AMF) are only used after a test encode succeeds, so a GPU-less machine falls back to the CPU.

**A `.cbr` comic won't open** — install `unrar` (`sudo apt install unrar` on Debian/Ubuntu, the RAR command-line tools from rarlab.com on macOS, or WinRAR on Windows — make sure `unrar` is on your `PATH`), or convert the file to `.cbz`.

**Upload fails: "File too large"** — the default limit is 10 GB. Change `media.maxUploadSizeMB` in `server/config.json`.

**A Live TV channel or IPTV movie won't play**
- Streams are played through the server, which repackages them with ffmpeg. **Settings → Live TV** warns when ffmpeg is missing.
- **Settings → Live TV → Test links** checks a few entries and tells you whether they play, need converting, or fail (e.g. "access denied" means an expired subscription or a wrong password in the link).
- Up to 4 streams run at once (`livetv.maxStreams`). Idle streams stop after 45 s (live) or 5 min (movies).
- **Linux, "couldn't convert this stream" or "ffmpeg crashed"**: older Vault versions ran the bundled static ffmpeg in a way that crashed on MPEG-TS channels on Linux, while the same channel worked on a Mac. Update and restart the server. If it still fails, look for the `[Restream]` line in the server log. As a last resort, install your distro's ffmpeg and set `FFMPEG_PATH=$(which ffmpeg)`.

**Vault stops answering when my Mac locks** — it's going to sleep. Check that **Settings → Connection → Keep running when the computer is locked** is on, keep the lid open and the charger in. See [When your computer locks or goes idle](#when-your-computer-locks-or-goes-idle).

**Something looks broken right after an update** — restart the server. Open tabs notice the new version and offer a **Reload**; if one doesn't, hard-reload it (`Ctrl + Shift + R`, Mac `Cmd + Shift + R`).

**Start over** — delete `server/config.json` and restart; the wizard appears again. Your media files are not touched.

---

## Features

**Library** — watches your folders and adds new files automatically; reads tags and cover art (artist, album, year, genre) and video details; generates thumbnails; fuzzy, typo-tolerant search; sorting and filters; metadata editing (type in the right title, artist, album, year, show/season/episode… per media type, kept over rescans, with revert to the file’s values); trash with restore.

**Video player** — custom controls, thumbnail previews on the timeline, speed 0.25×–2×, theatre mode, Picture-in-Picture, subtitles (SRT/VTT/ASS), skip intro, next-episode countdown. It converts unsupported formats on the fly and seeks instantly via range requests.

**Music player** — Web Audio graph with a 10-band EQ (±12 dB, presets, custom presets), gapless playback, crossfade 0–12 s, a soft fade on pause and skip, shuffle and repeat, queue, lyrics, a time preview while seeking, a full-screen Now Playing with visualiser, and lock-screen controls (Media Session).

**More** — Live TV & DVR (several M3U/IPTV lists), folder upload, torrents (optional), audiobooks, podcasts, comics, SyncPlay, profiles, listening/watching stats, Google Drive import, and an installable PWA.

**Look and feel** — six themes: **Graphite** (dark, default), **Dusk** (blue-slate), **Ember** (true-black for OLED), **Daylight** (white), **Stone** (warm grey) and **Sepia** (e-reader sepia). Neutral chrome so your artwork keeps its own colours, one flat accent per theme, animations that respect *reduced motion*, and a layout that adapts from phone to desktop.

**Accessibility** — keyboard navigation throughout, visible focus rings, ARIA labels, and **WCAG AAA** colour contrast in every theme: all text is at least 7:1 on every surface it sits on, and controls and focus rings at least 3:1. `npm run check:contrast` verifies this, and it runs with the test suite on every pull request.

**Security**
- Two factors: a password (bcrypt-hashed), then the 8-of-16 grid (12,870 combinations, or about 518 million with *order matters*).
- Short-lived challenge token after the password, then an access token (24 h by default, configurable 1 h–30 d). Signing out revokes the token.
- Brute-force lockout per step, which survives restarts.
- Rate limits per 15 minutes: 2000 general, 10 sign-in, 120 upload requests (one request carries up to 50 files; the Upload page waits and carries on if you hit the limit).
- Helmet security headers and CSP. CORS allows only the Vault app and localhost by default (add your own domains in Settings).
- Uploads are checked by content (magic bytes), not just extension, and file names and folder paths are sanitised against path traversal.
- Torrents are off by default and admin-only. `.exe` and other programs are never downloaded, and nothing leaves the library folder.

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
npm run check:contrast # WCAG check of every theme (also part of npm test)
```

From `server/`: `npm run lint` (syntax check), `npm run check:imports`, `npm run test:keyboard`, `npm run test:music`, `npm run setup` (terminal setup wizard), `npm run generate-cert`.

**CI** — `.github/workflows/test.yml` runs on every pull request: lint (syntax + import graph), server tests (including the theme contrast check), the `vault.css` freshness check, and a fresh-install test on Node 20, the current LTS and the newest release. That test checks that ffmpeg was downloaded and starts the server the way a new user does. `.github/workflows/deploy.yml` re-runs the checks on `main` and publishes `docs/` to GitHub Pages.

**Colours** — every colour comes from the tokens in `docs/css/variables.css` (one block per theme). Don't hard-code colours in component sheets; use the tokens (`--accent-solid`/`--on-accent` for filled buttons, `--accent-text` for accent-coloured text, `--success`/`--warning`/`--error` for status). Change a token, run `npm run build:css` and `npm run check:contrast`.

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
scripts/            → CSS build, contrast check, setup, transfer and check scripts
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
POST /api/upload/:type               multipart (?keepFolders=1 keeps relative paths)
POST /api/upload/check               { type, files:[{path,size}] } → { existing }
GET  /api/livetv/channels            channels + per-list status
POST /api/livetv/sources             add a channel list (admin)
GET  /api/torrents                   status + downloads (admin)
POST /api/torrents                   { magnet, type } or multipart "torrent"
GET  /api/system/health              library health report (admin)
GET  /api/system/capabilities        ffmpeg / ffprobe versions, hardware encoders (admin)
GET  /api/events                     live updates (Server-Sent Events)
GET  /rest/*                         Subsonic-compatible API for music apps
```

---

## License

MIT — see [LICENSE](LICENSE).
