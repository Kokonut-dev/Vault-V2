# Vault desktop app (Linux, macOS, Windows)

The Vault server as a normal app: install it, open it, and your library is
there. You don't need Node.js, a terminal or `npm install`.

- The app **runs the server** and opens Vault in its own window.
- **Close the window** and Vault keeps serving your phones and TV from the
  tray (Windows/Linux) or menu bar (macOS). **Quit Vault** in that menu stops
  the server.
- **Start at sign-in:** Settings → Server → *Start Vault when this computer starts*
  starts the app in the background (tray only, no window).
- **Updates keep your library.** Settings, library and logs live outside the
  app, so reinstalling or uninstalling never deletes them.

## Download

Every build of the [Desktop apps workflow](../.github/workflows/desktop.yml)
uploads these files. Tagged versions (`v3.0.0`, …) also attach them to a draft
GitHub release.

| System | File | Notes |
|---|---|---|
| Windows 10/11 (x64) | `Vault-<version>-win-x64.exe` | Installer. Per-user, no admin rights needed. |
| macOS, Apple silicon | `Vault-<version>-mac-arm64.dmg` | Drag to Applications. |
| macOS, Intel | `Vault-<version>-mac-x64.dmg` | |
| Linux (x64) | `Vault-<version>-linux-x86_64.AppImage` | `chmod +x` and run. On Ubuntu 22.04+ you may need `sudo apt install libfuse2`. |
| Debian / Ubuntu (x64) | `Vault-<version>-linux-amd64.deb` | `sudo apt install ./Vault-*.deb`. **Use this on Ubuntu 24.04+**, where AppArmor blocks the AppImage's sandbox. |

ffmpeg and ffprobe (thumbnails, transcoding, metadata) are bundled.

### The first launch shows a warning: why?

These builds are **not signed with a paid Apple/Microsoft certificate** yet,
so the operating system can't say who made them:

- **Windows:** "Windows protected your PC" → *More info* → *Run anyway*.
- **macOS:** "Vault can't be opened because Apple cannot check it…" →
  right-click Vault in Applications → *Open* → *Open*. On macOS 15+, use
  *System Settings → Privacy & Security → Open Anyway*. You only do this once.
- **Linux:** no warning.

To remove the warnings, add signing secrets to the workflow:

- Apple Developer ID + notarisation: `CSC_LINK`, `CSC_KEY_PASSWORD`,
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and set
  `mac.identity` to your identity instead of `"-"`.
- A Windows code-signing certificate: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

## Where your things are

| What | Windows | macOS | Linux |
|---|---|---|---|
| Settings, library index, logs | `%APPDATA%\Vault\server` | `~/Library/Application Support/Vault/server` | `~/.config/Vault/server` |
| Default media folders | `%USERPROFILE%\Vault Media` | `~/Vault Media` | `~/Vault Media` |

The first-run setup lets you choose any folders you like. The tray menu has
*Open media folder*, *Open Vault data folder* and *Open logs*.

**Moving from a git clone:** in the clone run `npm run export`. In the app,
use Settings → *Move to another server* to import it. You can also copy
`server/config.json` and `server/data/` into the folder above while the app is
quit.

## Security

The app keeps the same protections as `npm start`. It adds nothing that
opens your network.

- **The window only shows this computer's Vault** (`http://127.0.0.1:<port>`).
  Any other link opens in your normal browser. The page runs sandboxed, with
  no access to your files or to Node.js, and may only ask for fullscreen,
  notifications and copy-to-clipboard.
- Because the window is on the server computer, first-run setup there needs
  **no setup code**. Any other device still needs the setup code, which is in
  `logs/launcher.log` and `data/setup-code.txt` in the data folder above.
- Like `npm start`, the server listens on your home network (port 4000) so
  your phone and TV can reach it. Nothing is opened on your router.
  *Use on another device → Anywhere* (a Cloudflare tunnel) stays off until you
  turn it on, and switches itself off after 8 hours.
- Pairing a phone: Settings → Account → *Pair a device* shows a single-use
  QR code with this computer's **network** address (never `127.0.0.1`).
- The launcher's control port (4001) listens on this computer only. In the
  app it is driven over a private IPC channel, and the server stops with the
  app.

## Build it yourself

You need Node.js 22.12+. Each platform builds its own app (ffmpeg is
downloaded for the target):

```bash
cd desktop
npm ci
npm start                 # run from source (uses ../server and ../docs)
npm run dist:linux        # AppImage + deb  → desktop/dist/
npm run dist:win          # NSIS installer (run on Windows)
npm run dist:mac-arm64    # dmg + zip (run on a Mac)
npm run dist:mac-x64
```

How it fits together:

- `scripts/stage.js` copies `server/` and `docs/` into `stage/vault/`. It
  leaves out config, data, caches and tests, runs `npm ci --omit=dev` for the
  target platform, and drops other platforms' ffprobe and native binaries.
- electron-builder packs `main.js` + `loading.html` + `assets/` into
  `app.asar`, and copies `stage/vault` to `resources/vault`.
- At runtime `main.js` starts `resources/vault/server/launcher.js` with
  Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), with
  `VAULT_HOME=<app data>/server` and `VAULT_PACKAGED=1` (never run npm). The
  launcher starts the server and reports to the app.
- `scripts/smoke.js <app executable>` starts a built app with a temporary
  home and checks the API, the web app, bundled ffmpeg, where files were
  written, and that quitting stops the server. CI runs it on every platform.
- `scripts/make-icons.js` redraws `assets/*.png` from the favicon's geometry.

Not built yet: Linux/Windows on ARM. `ffprobe-static` has no binaries for
them; such a build would rely on a system ffmpeg. Auto-update is also missing.

## Android

See [ANDROID.md](../ANDROID.md). The short answer is yes. The app would open
to a QR scanner and only get in by scanning a sign-in code shown by your
Vault.
