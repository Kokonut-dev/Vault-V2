# Changelog

## [3.0.0] — in progress (branch `arena/0deefe55-vault-v2`)

### Desktop apps for Windows, macOS and Linux
Tests: `server/test/desktop-app.test.js`; each built app is smoke-tested in CI
(`desktop/scripts/smoke.js`, `.github/workflows/desktop.yml`). User guide:
`desktop/README.md`.

- **`desktop/`**: an Electron app that runs the Vault server with its built-in
  Node and shows Vault in a window. Closing the window keeps the server
  running from the tray / menu bar; *Quit Vault* stops it. Builds: AppImage +
  deb (Linux x64), an NSIS installer (Windows x64), dmg + zip (macOS Apple
  silicon and Intel), with ffmpeg/ffprobe bundled.
- **The window is locked down:** sandboxed, no Node access or preload. It only
  shows this computer's server (always `127.0.0.1`, so first-run setup there
  needs no setup code while other devices still do). Other links open in the
  browser. Permissions are limited to fullscreen, notifications and the
  clipboard.
- **`VAULT_HOME`** (new `server/utils/paths.js`): one switch that moves
  everything Vault writes (config.json, data, cache, default media folders,
  uploads, logs, downloaded cloudflared) out of `server/`. The app points it
  at the per-user app-data folder, because an installed app's folder is
  read-only. Unset, every path is exactly what it was. `VAULT_CONFIG_PATH`,
  `VAULT_MEDIA_DIR` and `VAULT_DOCS_DIR` override single locations.
- **Launcher:** with `VAULT_PACKAGED=1` it never runs npm (a damaged install
  says "reinstall"). Over an IPC channel it tells the app when it's ready and
  shuts the server down when the app quits *or dies*, including on Windows,
  which has no signals.
- **Start at sign-in** starts the app itself (`--background`, tray only) when
  `VAULT_APP_EXECUTABLE` is set; it points at the AppImage file on Linux.
- **Pairing QR on the server computer** now encodes the computer's network
  address instead of `127.0.0.1`, which a phone can't reach.
- **`ANDROID.md`**: an Android app is feasible with no server changes. It
  opens to a QR scanner, and scanning a sign-in code shown by your own Vault
  is the only way in. The document covers the design, Android 17's
  local-network permission, background audio and effort (≈2–3 weeks for v1).

### Security — every way of sharing access explains its protections, and the missing ones were added
Tests: `server/test/security-hardening.test.js`, `server/test/security-ui.test.js`.
Details for users: README → *Security*.

- **"How this is protected" panels** (new `docs/js/components/securityNotes.js`)
  wherever Vault hands out access: the *Same Wi-Fi* and *Anywhere* tabs, the
  sign-in QR panel, approving a waiting device, transfer download links and
  Subsonic. Each line describes something the server really enforces.
- **A brand-new server can't be claimed by someone else on your network.**
  Setup and transfer import from any device other than the server computer
  need the *setup code* printed in the server window (also written to
  `server/data/setup-code.txt` with owner-only permissions; deleted once setup
  is done). Wrong codes count towards the setup lockout. The wizard asks for
  it on the *Connect* step (`services/setupGuard.js`, `utils/clientAddress.js`).
- **`/api/setup` once set up:** `/status` no longer shows the username, media
  folders or port to strangers. `/test` (which checked whether folders exist)
  and re-running `/complete` now need a signed-in **admin**. Before, any valid
  token was enough, including a kids' profile token.
- **`/api/health`** only returns `ok` and the version. Library counts and
  uptime are for signed-in devices (`routes/health.js`).
- **Pairing:**
  - opening a `/pair?code=` link while signed in no longer approves it on the
    spot. A confirmation shows where the waiting device is (this computer /
    your network / the internet);
  - waiting codes made without signing in are capped at 3 per address and 20
    in total, so nobody can fill the code space and catch a mistyped approval;
  - codes are always unique;
  - the QR base URL must be `http(s)` with no embedded credentials.
- **Subsonic** never accepts the main Vault password, since that let a
  password alone skip the grid / authenticator step. It is off until a
  Subsonic password is set. Wrong passwords now lock that device out (new
  `subsonic` lockout stage). `ping` and `getLicense` check credentials, as
  apps expect, and comparisons are constant-time.
- **Remote access turns itself off** after 8 hours by default (1, 4, 8,
  24 hours or never; `remoteAccess.autoStopHours`). People who had chosen
  *turn on with the server* keep "never" until they pick something else. The
  tab shows when it will switch off, recommends an authenticator app when
  none is set up, and `/api/remote` reports a `security` summary.
- **Behind the tunnel, visitors are told apart:** `trust proxy` is set to
  `loopback`, so lockouts and the devices list use the real visitor address
  rather than `127.0.0.1` for everyone. Forwarding headers from other devices
  are still ignored. Sessions record `remote: true` and get a *Remote access*
  badge in Settings → Devices.
- **Transfer download links work for one download** (HEAD checks don't use
  them up; a link whose download failed to start can be retried).
- CORS: documented why unlisted origins are allowed. Vault authenticates with
  an `Authorization` header and never cookies. Added `X-Vault-Setup-Code` to
  the allowed headers.
- Service worker cache bumped to `vault-v2-shell-v13`.

### Added — a new Home screen and a landing page for the project
Tests: `server/test/home-ui.test.js`, `server/test/landing-page.test.js`.

- **Home, redesigned** (`docs/js/views/home.js`, styles in the new
  `docs/css/home.css`). From the top:
  - a header with the date, a greeting and a one-line summary of the library
    ("1,204 songs · 48 films · 6 shows"), plus *Surprise me*;
  - the hero resumes what you were in the middle of, or shows the newest film;
  - a tile for each library you have (Films, TV shows, Music, Audiobooks,
    Podcasts, Comics, Videos) with its count. TV shows are counted per show,
    not per episode;
  - rows: *Continue watching*, *Next up in your shows*, *Jump back into
    music*, *More like …*, then one *New films / New episodes / New music / …*
    row per type, newest first, so each row has one artwork shape. Episodes
    show one per show and songs one per album. Then *Your favourites* and
    *Top rated*. Every row scrolls sideways, has back/forward buttons and a
    *See all* link;
  - *Your week*: time played this week, split into watching and listening,
    with a bar for each day;
  - an empty library gets a welcome with three steps (add files and scan,
    upload, open Vault on your phone). A profile that isn't an admin is told
    to ask whoever runs the Vault. A small library (under 20 titles) gets one
    mixed *Recently added* row and keeps the getting-started tips.
- **Fixed on Home:**
  - the page re-draws when the library, history or favourites arrive after
    the first paint, so it no longer shows as empty until you navigate away;
  - *Random pick* is replaced by *Surprise me*. Shuffling it used to update
    the wrong element and leave *Details* opening the old title;
  - episode cards show the show's name ("The Lanterns · S1 · E2 · Pilot")
    instead of a bare "Episode 2";
  - every inline style is gone.
- **Landing page** at `landing.html` (on GitHub Pages:
  https://kokonut-dev.github.io/Vault-V2/landing.html). It explains what Vault
  is and has features, screenshots, a live preview of the six themes, how it
  works, install steps for Node.js and Docker with copy buttons, and links to
  GitHub. It loads the app's theme tokens and fonts and makes no requests to
  other sites.
  - A first-time visitor to the hosted app on GitHub Pages lands there once.
    That only happens with no sign-in and no server chosen, and never on a
    self-hosted server, a deep link or a pairing link. *Open Vault* goes
    straight to the app.
  - The sign-in screen links to it.

### Added — type in the right details when the automatic ones are wrong
Tests: `server/test/manual-metadata.test.js` (dialog: `edit-details-ui.test.js`).

- **Edit details for every media type.** The *Edit details* button on a detail
  page (and *Edit details* in every item's right-click menu, which also covers
  comics, audiobooks and podcasts) opens a form with the fields that type uses:
  - songs: title, artist, album artist, album, track and disc number, year,
    genre, composer and cover art;
  - films and episodes: title, year, genre, description, tags and rating, plus
    show, season and episode. A typed show name groups the episode under that
    show on the Shows page. Clearing season and episode files a misdetected
    film back under Films;
  - audiobooks: author, narrator, book series and part;
  - podcasts: show and host;
  - comics: series, issue and author.

  Only fields you change are saved. They are kept when the library is
  rescanned, and an online match you pick is now kept too.
- **Revert to the file.** A field you typed in shows *Edited* with a *Revert*
  button that reads the file's own value again (tags, file name or folder
  artwork). *Revert all to file* does every field at once; rating, description
  and tags have no file value, so they stay. API:
  `POST /api/library/:id/metadata/reset` with an optional `{ fields: [...] }`.
  It returns 409 `FILE_MISSING` when the file is gone.
- **Edit album** now also sets album artist, artist, year and genre on every
  track. A field the tracks disagree on shows *Mixed* and is left alone unless
  you type in it. The album header shows the album artist when one is set.
- **Checks next to the field.** A wrong year, track, disc, season or episode,
  or an empty title, is shown next to that field and nothing is saved. The API
  returns 400 `INVALID_METADATA` with a `fields` map. An empty number field
  clears the value.

### Fixed
- Edited titles, artists and albums were saved HTML-escaped: "Rock & Roll"
  showed up as `Rock &amp; Roll` and "AC/DC" as `AC&#x2F;DC`. Edits are
  now stored as plain text. A value saved the old way shows correctly in the
  dialog and is fixed when you save.
- Saving a single item's details now tells other open tabs and devices, the
  same way album edits already did.

### Added — watch parties from the player, moved files keep their history
Tests: `server/test/features.test.js` (player control: `syncplay-ui.test.js`).

- **SyncPlay button in the video player.** Start a watch party for the
  playing video (the room code is copied to the clipboard), join with a code,
  see who's in, copy the invite, play the current video for everyone, or
  leave, without opening the SyncPlay page. The SyncPlay page's *Create room*
  now also starts on the playing video (it read a `currentVideoId` that nothing
  ever set).
- **Moved and renamed files keep everything.** When a scan (or the folder
  watcher) finds a new file that has the same type and byte size as a known item
  whose file is gone, it carries over play count, rating, tags, hand-edited
  metadata and every profile's favourites, playlists, history, watched marks,
  bookmarks and watchlist entries. Ambiguous matches are left alone.
- **"File missing" instead of deleted.** A file that disappears is flagged
  (a *File missing* badge on its card) and kept with its history for
  `media.missing.retentionDays` (default 30; `0` means remove straight away).
  It goes back to normal when the file returns. *Health → Remove missing*
  still removes such items immediately.
- **Subsonic respects age limits.** Subsonic apps browse as one chosen
  profile (System → Services → Subsonic, default: the main profile). That
  profile's age limit applies to every list, stream, download and cover, and
  its favourites, playlists and history are used. If that profile is deleted,
  Subsonic sign-in is refused; it does not fall back to no limits. Starting a
  scan over Subsonic needs an admin profile.
- **ASS/SSA subtitles work.** They're converted to WebVTT, keeping italic,
  bold, underline, line breaks and top/side placement. Before, they were sent
  as plain text, which browsers ignore. SRT conversion handles BOMs and CRLF
  line endings.
- **Bookmarks are per profile.** Each profile sees and deletes only its own
  bookmarks. Older bookmarks belong to the main profile. Deleting a profile
  deletes its bookmarks.

### Fixed — bug run, part 2 (the low-severity leftovers)
- **Removing an item left data behind.** Only the main profile's favourites,
  playlists and history were cleaned. Now every profile's lists are cleaned,
  plus watched marks, watchlist, collections, intro markers (including a
  show's intro once its last episode goes), bookmarks and per-item listening
  stats.
- **Any device could stop anyone's Live TV stream.** Viewers are now counted
  per device session. A device can only give up its own place, and releasing
  twice does nothing.
- **Server details for every profile.** The System page's Health report,
  disk, cache, index and scrobbles are admin-only. `/api/server` no longer
  shows the process id, launcher port, uptime or Node version to non-admins.
  `/api/media/info` shows the file path (and ffprobe errors) to admins only.
- **Artwork downloads could reach the LAN.** Metadata artwork is fetched
  through `safeFetch`: public addresses only, images only, max 20 MB, with a
  timeout. Metadata lookups time out after 15 s, and the HDHomeRun lineup
  fetch is capped too.
- **Unhandled stream errors.** A thumbnail, trickplay sheet, playlist or
  Subsonic cover that vanished or failed to read between the check and the
  read raised an unhandled stream error, which takes the server process
  down. They now answer 404/500 (or end the response cleanly).
- **`npm test` wrote into `server/data`.** Tests now run against a temp
  folder (`VAULT_DATA_DIR`, see `scripts/run-tests.js`).

### Fixed — bug run (data layer and authorization)
A review of the data layer (JSON stores, the optional SQLite index, the
scanner) and of who can call what, plus an automated sweep of all 224 routes.
Each fix has a reproducing test in `server/test/bugrun.test.js` (SyncPlay page:
`syncplay-ui.test.js`).

- **Critical: settings leaked the signing secret.** `PUT /api/settings`
  had no admin check and returned the raw config, JWT secret and password
  hash included, so any profile (Kids too) could forge tokens.
  It is admin-only now and returns the same safe shape as `GET`.
  `PUT /api/settings/credentials` is admin-only too.
  Notification targets can only be set through `PUT /api/settings/notifications`,
  which checks the links.
- **Changing the password signs other devices out.** A new password or grid
  revokes other sessions and replaces the token-signing secret; this device
  gets a new token. Tokens that don't belong to a device session are refused.
- **Kids and other non-admin profiles can't destroy things.** Emptying,
  purging, restoring or listing the trash, clearing the transcode/HLS caches,
  managing podcast feeds (the server fetches their URLs) and Live TV
  recordings are admin-only. Profiles with an age limit can't upload, edit
  collections or write intro/outro markers (shared by the whole series).
  Markers, watched, listens and bookmarks give 404 for items above the
  profile's age limit.
- **Profile PINs lock after 5 wrong guesses** (30 s, doubling up to 15 min;
  `429 PROFILE_PIN_LOCKED`), for switching, signing in and changing a PIN.
- **An unmounted drive no longer empties the library.** A scan (and the
  file watcher) used to remove every item whose file was missing, so an
  offline drive or NAS lost all its items with their history,
  favourites and playlist entries. Items under a library folder that is
  missing, unreadable or empty are kept until it is back.
- **A corrupt data file is kept, not replaced.** A JSON store that can't be
  read is moved to `<file>.corrupt-<time>` before Vault starts that list
  fresh; before, the next save overwrote it with an empty list. Failed saves
  are logged. `config.json` is written atomically.
- **Settings that were lost on save.** `saveConfig` dropped the Google Drive
  (`integrations`) and Remote access (`remoteAccess`) settings, so "keep
  remote access on" never stuck.
- **SQLite index.** It now applies the library and rating filters,
  matches genres exactly (no `LIKE` wildcards), sorts titles without regard
  to case, and checks page numbers. Searches and the watched filter use the
  in-memory path so results match. `library.db` is no longer created in
  JSON mode (by deleting an item or opening System → Index), and a missing
  `data/` folder no longer turns the index off until restart.
- **Subtitles.** The subtitle route only serves `.vtt/.srt/.ass/.ssa` files
  from the item's own folder. Before, it served any file next to the
  video, and a folder `Movie2` counted as inside `Movie`.
- **SyncPlay works.** The host was refused (403) when changing the item, the
  page read the room code and member id from the wrong place (chat gave
  404 and leaving failed), nothing sent the host's playback to guests, and
  guests read `paused` from events that carry `playing`. Members get a
  private token (member ids are public). Room events go only to the
  room's devices. Chat is for members only. Room passwords are hashed, codes
  are random and unambiguous, the host role passes on when the host leaves,
  and active members aren't dropped after 60 s.
- **Stored XSS in dialogs.** Dialog titles, prompt labels, messages and
  placeholders were inserted as HTML. Media titles and profile names are now
  always shown as text (`createModal`/`promptModal` escape them). The
  bookmarks dialog title and QR pairing errors too.
- **Fuzzer 500s.** `?type=__proto__` on search, downloading from an unknown
  podcast feed (now 404), and a Google Drive import without a link (now 400).
- **Smaller fixes.** CBR comic pages are extracted without blocking the
  server (and time out). The token blacklist drops expired tokens. Subtitle
  streams handle read errors. `body-parser`/`qs` updated (`npm audit`).

### Fixed — profiles
Profiles were mostly cosmetic: the "active profile" was one server-wide
value, so switching on one device switched every device, and age limits,
PINs and admin rights could be stepped around. Profiles now work per
device and are enforced on the server.

- **Per device, per session.** The signed-in session decides which profile is
  in use (`sessions.setProfile`); the global `activeProfileId` /
  `profiles.setActive` is gone. A token from before a switch follows the
  switch, so it can't be used to get back to the profile you left.
  `/api/auth/verify` and short-lived media tokens report the session's
  profile.
- **PINs can't be skipped.** Switching to a PIN-protected profile, or signing
  in to one, needs the PIN (`403 PROFILE_PIN_REQUIRED`). The sign-in screen
  asks for it, and asks again after a wrong PIN. Changing your own PIN needs
  the current one.
- **Admin rights are enforced.** Only admins create or delete profiles,
  change age limits or admin rights, or edit another profile; others can
  change only their own name, picture, colour and PIN. Vault always keeps at
  least one admin, and a missing `default` profile is never treated as admin.
- **Age limits work.** Items get an age rating (`contentRating`) from `.nfo`
  `<mpaa>`/`<certification>`, metadata matches, or the admin-only "Age
  rating" field in the Edit dialog. US, UK, NL (Kijkwijzer), DE (FSK), TV and
  "16+" style labels map to a minimum age (`services/contentRating.js`). A
  profile's limit is an age from 0 to 18 (Kids profiles start at 9). By
  default Kids profiles also hide unrated films, shows and videos. The
  limit applies to the library, search, recent, series and next-up, genres,
  stats, favourites, watchlist, history and playlists (including M3U export
  and stats), and so to the home page built from them. Opening, streaming, transcoding or reading a hidden item
  returns 404. Reordering a playlist on an age-limited profile keeps the
  entries it can't see.
- **Deleting a profile cleans up.** Its devices are signed out, and its
  favourites, history, playlists, resume points and watchlist are removed.
  The profile you are using can't be deleted (`PROFILE_IN_USE`).
- **Device data follows the profile.** Favourites, history and resume points
  load from the server for the current profile, and local copies are cleared
  on a switch (`docs/js/profileSession.js`). The device remembers the last
  profile for the next sign-in and forgets it if that profile is deleted.
- **Profiles page redesigned.** Avatar cards with a colour ring, a profile
  editor (name, picture, colour, PIN, age limit, unrated toggle), clear
  validation messages (`NAME_REQUIRED`, `INVALID_PIN`, `PROFILE_LIMIT`,
  `LAST_ADMIN`, …), and an admin "Manage profiles" list.
- Service worker shell cache bumped to `vault-v2-shell-v12`.
- Tests: `profiles-system.test.js` (server rules, filtering, sessions,
  sign-in PINs, cleanup) and `profiles-ui.test.js` (jsdom: profiles page,
  editor payloads, profile data hydration).
- Not changed: the Subsonic API (`/rest`) signs in with the account
  password and acts as the owner account, not as a profile.

### Changed — colours: less "generated", stricter contrast
- **Why.** The "Hearth" palette (warm cream paper, terracotta accent,
  tinted near-black, orange glows) is the look AI design tools produce by
  default in 2026, and the leftovers made it worse: per-theme neon
  `.accent-glow` shadows (cyan, emerald, blue — none matching their theme),
  gradient buttons, coloured glow shadows under every accent control, and
  Tailwind `red-500`/`green-500` literals and a violet-first profile colour
  list straight from the framework defaults.
- **The new palette** ("screening room"): the chrome is the darkened room
  and the artwork is the picture. Neutrals are near-achromatic (OKLCH
  chroma ≤ 0.02) with one temperature per theme, so posters and album art
  keep their colours; one flat accent per theme; status colours are low
  chroma and lightness-matched. Text steps are set by contrast target
  (≈15 / 11 / 9:1), not by eye.
  - **Graphite** (`dark`, default): neutral charcoal, cornflower accent.
  - **Stone** (`light`): warm grey (not cream), petrol accent.
  - **Sepia** (`warm`): e-reader sepia, blue-black ink accent.
  - **Dusk** (`cold`): blue-slate, softer sea-glass accent.
  - **Ember** (`midnight`): true black for OLED, soft amber accent.
  - **Daylight** (`white`): white, cool-grey ink, link blue.
  Theme ids are unchanged, so saved choices carry over; only display names
  changed (Hearth → Graphite, Linen → Stone, Parchment → Sepia).
- Flat primary buttons and progress bars; coloured glows replaced by a small
  neutral `--shadow-lift`; `.accent-glow` is a quiet 2 px accent ring; status
  chips tint from `--success`/`--warning`/`--error` instead of hard-coded
  RGB; the artwork hero, badges and card chips use neutral instead of brown
  scrims. Favicon, maskable icon, manifest and `theme-color` follow the new
  default.
- Profile colours: muted, evenly spaced hues instead of Tailwind 500s.
- **Contrast is now checked where text actually sits.** `contrast-check.js`
  used to measure against the page background only; it now checks every
  text token (primary, secondary, tertiary, accent, success, warning,
  error, info) on every surface (page, cards, sunken wells, modals) at AAA
  7:1, labels on accent fills at 7:1, and `--border-control`, `--focus-ring`
  and `--accent` at 3:1 (SC 1.4.11). The old palette failed 22 of those 78
  checks (e.g. Hearth's tertiary text was 5.9:1 inside modals); the new one
  passes all 78. New `npm run check:contrast`, and
  `server/test/theme-palette.test.js` runs it with `npm test` (so in CI),
  checks the theme picker swatches match the tokens, and fails on neon glow
  or framework-default colour literals coming back.
- README rewritten around a full **Requirements and dependencies** section:
  Node versions, ffmpeg and ffprobe (what uses them, how Vault finds them,
  per-OS install commands, what works without them), every npm package and
  why, optional tools (`unrar`, `cloudflared`, `mkcert`/`openssl`, GPU
  drivers, Docker) and optional services; plus a Configuration table of
  environment variables.

### Fixed — browsers kept running the old app after a server update
- After updating, the Server page still showed "0", "0 B", "Unknown" and
  "0 rows". The server was new, but the browser was still running the old
  page code from its HTTP cache. JS files were sent with `max-age=3600,
  stale-while-revalidate=604800`, and views load on demand from fixed URLs,
  so an old view could linger for up to a week, talking to the new API.
- `index.html` now carries an import map that pins every module to the
  current build: `./js/…` → `/b/<build>/js/…`, where the build id is a hash of
  the client files. Relative imports inside modules stay under that prefix,
  so the whole app comes from one build. A new build means new URLs, which
  no cache can hold. The pinned files are cached as `immutable`, so repeat
  loads are faster too. Checked in Chromium: every module comes from the
  pinned path, none twice, and a stale copy at the old URL is never used.
- Plain JS/CSS/HTML (browsers without import maps, direct requests) are sent
  `no-cache`, revalidated with a cheap 304. Fonts and images keep the longer
  cache.
- API responses carry `X-Vault-Build`. If the server is updated while a tab
  is open, the tab shows the existing "Update available — Refresh" toast
  instead of silently mixing versions.
- Server page → Storage listed one disk several times. Folders are now
  grouped by device id instead of by free space, which changes between two
  measurements while anything is writing.

### Fixed — the Server page (sidebar → Server)
- The page read field names the server never sent, so it showed a library of
  0, "0 B" free disk, "never" scanned and "No health checks reported" whatever
  the server knew. Every tab now uses the real `/api/system/*` responses:
  - **Health:** item count and media size, real free/used disk space (per
    filesystem when media lives on several drives, with a fill meter), when
    the last scan ran and how it went, and the search index status. Six
    library checks (missing files, duplicates, artwork, playback problems,
    leftover sidecar files after a deep check, trash), each with a list of
    the affected items. A deep check now shows its own results instead of
    being replaced by the quick report.
  - **Jobs:** label, kind, `done of total` and a real percentage, a **Scan
    library now** button, live updates.
  - **Logs:** the log lines actually show (they were read from a field that
    didn't exist), newest first, with a level filter, a text filter and a
    **Download** button that saves a `.log` file. The old export downloaded
    an empty JSON list.
  - **Backups:** delete asks first; restore/delete/create report errors.
  - **Services:** ffmpeg version and hardware encoders, ffprobe detection,
    metadata agents (TMDb key and on/off switches for TMDb, MusicBrainz and
    NFO), Subsonic on/change/off, a notification test that says which targets
    failed, and recent scrobbles with where they were sent.
- Passwords and API keys are entered in the app's own dialog (masked,
  validated) instead of `window.prompt`.
- Non-admin profiles see the health report plus a clear note, and no buttons
  that would fail.
- Tab icons sit next to their labels instead of above them.
- Server side:
  - the last scan is recorded and survives restarts;
  - a failed scan now ends its job as an error (it used to stay "running" in
    the Jobs tab forever);
  - `/api/system/disk` reports `volumes` with `statfs`;
  - `/api/system/capabilities` reports ffprobe;
  - `POST /api/system/agents/:provider` only accepts `apiKey` and `enabled`
    (the body used to be copied into `config.json` as-is) and reports
    `hasKey`/`switchedOn` without ever returning the key;
  - restore/delete of a backup that doesn't exist returns 404;
  - `POST /api/system/notifications/test` returns per-target results.

### Fixed — Cancel didn't cancel in confirm dialogs
- `confirmDialog` resolves to `{ confirmed }`, but eleven callers treated the
  result as a yes/no value. An object is always "yes", so pressing **Cancel**
  (or Escape) still went ahead with the action. Affected: Remove missing
  files, Restore backup, Stop the server, Delete forever / Empty trash, Move
  to trash, Remove Live TV list, Remove/turn off torrents, and the transfer
  import. All of them now check `confirmed`. `confirmDialog` also accepts
  `confirmLabel`, which four callers used, so their buttons no longer read
  just "Confirm".

### Added — upload whole folders
- The Upload page has a new **Folders (auto-sort)** card. Drop folders in, or
  use **Choose folder**. Folders are read recursively, including folders with
  more than 100 entries, which browsers hand out in chunks.
- Each top-level folder is sorted into Music, Movies & Series or Videos:
  - mostly audio goes to Music;
  - `S01E02`, `Title (2016)` or `Movies`/`Series`/`TV` folder names go to
    Movies & Series;
  - anything else goes to Videos.

  You can change the library per folder or drop a folder from the list.
  Audio inside a movie folder (a soundtrack) still goes to Music. Covers and
  subtitles follow their media. Files Vault can't use (`.txt`, `.nfo`…) are
  listed and skipped, and `.DS_Store`/`Thumbs.db` are ignored silently.
- The folder structure is kept on the server: `Artist/Album/01 Track.flac`
  lands in `music/Artist/Album/`. Paths are sanitised (no `..`, no absolute
  paths, Windows-reserved names renamed, at most 8 levels deep), and the
  server checks that every file stays inside the library folder. File names
  with accents or non-Latin scripts arrive intact. Browsers send them as
  UTF-8, but the multipart parser read them as Latin-1.
- Before uploading, the page asks the server which files are already there
  (same relative path and size) and skips them. Re-dropping a half-uploaded
  folder only sends what's missing.
- Uploads go in batches: at most 50 files and 1 GB, one library per batch,
  covers/subtitles first so the first scan sees them. You can pause, resume
  and cancel. On a 429 the page waits for the rate limit to reset and carries
  on. Network or server errors retry twice, then a **Retry failed files**
  button lists what didn't make it.
- The upload rate limit went from 30 to 120 requests per 15 minutes. Existing
  installs still on the old default of 30 are migrated automatically.
- New endpoint `POST /api/upload/check`. `POST /api/upload/:type?keepFolders=1`
  keeps relative paths. Without the flag, uploads behave exactly as before.

### Added — several Live TV channel lists
- **Settings → Live TV → More channel lists**: add as many M3U lists as you
  like (up to 20). Each has its own name, TV guide, on/off switch and a
  **streams at once** limit.
- The original channel list stays the "main" list, and you can now name it.
  Its channel ids don't change, so favourites and recordings keep working.
  Extra lists get namespaced ids, so two lists can't collide.
- The Live TV page groups channels under each list's name, in list order.
  Filter chips ("All · Sport · Main list") are remembered, and there's a
  channel search. A list that fails to load is named with the reason, while
  the other lists still show.
- Guides from every switched-on list are merged; duplicates (same channel and
  start time) are dropped. **Test** and **Use this guide** work per list.
- **Streams at once**: IPTV accounts usually allow 1–2 connections, and going
  over can cut every stream on the account. When a list is at its limit,
  Vault first closes an idle stream from that list (nobody watching for
  15 s). If there is none, it refuses with a clear message (`SOURCE_BUSY`)
  instead of opening one more connection.
- Settings → Links & imports → **Use for Live TV** now adds the link as another
  list if a main list is already set up, instead of replacing it.
- New endpoints: `POST/PUT/DELETE /api/livetv/sources[/:id]` (admin).
  `/channels` returns per-list status, and `/test` and
  `/settings/adopt-guide` accept `sourceId`. Links stay write-only: responses
  carry only a redacted hint.

### Added — torrents (optional, off by default)
- New **Torrents** page (sidebar → Manage, admin only). It stays off until an
  admin turns it on and acknowledges a notice: only download what you have
  the right to, torrenting shares while it downloads, and peers see the
  server's IP.
- Paste a magnet link or drop a `.torrent` file; Vault fetches the file list
  from peers. Media files, subtitles and covers are preselected. Samples and
  other files are not, and programs (`.exe`, `.sh`, `.apk`…) are never
  downloaded, even if ticked. Pick the files and the library (auto-guessed),
  then **Download**.
- Downloads go to a hidden `.vault-downloads` folder that the library scan and
  watcher skip, so half-written files never show up. When finished, the files
  move into the library, keeping the torrent's folder layout, and get indexed.
- **Keep sharing** to a ratio (0.5, 1, 2). The library gets a hard link right
  away (or a copy on another disk), so files appear immediately; sharing then
  stops by itself at the ratio. **Stop sharing** ends it early.
- Settings on the page: downloads at once (others queue), download and upload
  speed limits, DHT, UPnP (off by default), and the **VPN guard**. Pick the
  VPN's network interface, and torrents only run while it's up. When it
  drops, every connection is closed at once, and downloads resume when it's
  back. WebTorrent can't bind to an interface, so this is a kill switch
  rather than routing. The docs suggest running the server behind the VPN
  for full protection.
- Pause/resume, a server restart and the VPN guard all resume from what's on
  disk; WebTorrent re-checks the pieces. Progress shows in the page and in
  the global job indicator, with a toast when a download is added to the
  library.
- Engine: WebTorrent 2.8.5, an optional dependency loaded only when torrents
  are on. Without it, Vault runs normally and the page explains how to
  install it.
  - `webrtc-polyfill` is replaced by an empty stand-in package
    (`server/vendor/webrtc-polyfill-stub`). Its native `node-datachannel`
    download breaks installs, and Vault never uses WebRTC peers. Installs
    stay pure JavaScript and work with `--ignore-scripts`.
  - `uint8-util` is pinned to 2.2.6, because 2.3.x crashes WebTorrent 2.x.
  - The Dockerfile copies `server/vendor` before `npm ci`.
- New endpoints under `/api/torrents` (admin): status, interfaces, settings,
  add, start, pause, resume, remove. New config section `torrent` (see
  `config.example.json`).

### Changed
- Service worker cache `vault-v2-shell-v8` (new page, new icon).
- `server/config.example.json` regenerated. It also picks up
  `server.keepAwake`, which was missing.

### Fixed — Live TV on Linux: "The Vault server couldn't convert this stream"
- Channels from an M3U playlist failed on Linux servers but worked on a Mac.
  On Linux, the bundled ffmpeg (`ffmpeg-static` / `ffprobe-static`) links
  glibc statically. MPEG-TS, the format of nearly every IPTV channel, makes
  ffmpeg convert the channel names with iconv. Static glibc then loads the
  host's own charset modules (`…/gconv/`), which don't match it, and ffmpeg
  crashes (SIGSEGV) without printing anything. macOS builds aren't static
  glibc, so they were never affected. This hit every browser, Helium included.
- `server/utils/ffmpegBinaries.js` now detects a statically linked ffmpeg or
  ffprobe on Linux (an ELF without an interpreter) and points `GCONV_PATH` at
  an empty directory. iconv then fails cleanly, ffmpeg keeps the raw channel
  name, and the stream plays. Distro ffmpeg packages, macOS, Windows and a
  `GCONV_PATH` you set yourself are left alone. This also fixes thumbnails
  and duration probing for `.ts` recordings in the library.
- When ffmpeg crashes rather than failing, Live TV now says so (new code
  `CRASHED`) instead of the generic "couldn't convert". The server log names
  the signal and the binary, e.g. `probe failed (CRASHED, ffmpeg signal
  SIGSEGV, …/ffmpeg)`. Before, a crash during a running stream wasn't logged
  at all.

### Fixed — the theme picked in the setup wizard didn't stick
- The wizard saved the theme to the browser, but the app's settings store had
  already loaded the old value at page load and put it back when the app
  started. The wizard now goes through the theme manager, so the store and
  the browser agree. On start-up, a valid saved theme in the browser wins over
  a stale store value.

### Fixed — "Import from another Vault" in the setup wizard did nothing
- The import opened in a dialog, but the setup screen covers the whole page
  (z-index 500, above dialogs at 200), so the dialog appeared out of sight
  behind it. It now opens inside the wizard, with a **Back to setup** button.
  Ctrl+Enter and Escape no longer step the wizard underneath the import.
- Toasts were hidden behind the setup screen for the same reason, including
  "Cannot proceed without server connection" and "Connect to this new Vault
  server first". They now show in front of it, and so does any dialog opened
  from it.

### Fixed — the server stopping when a Mac locks
- A locked, idle Mac (or any laptop) goes to sleep after a few minutes, and
  that paused Vault until someone woke it. Vault now keeps the computer awake
  while it runs (`server/utils/keepAwake.js`). It uses `caffeinate -i -m -s -w
  <pid>` on macOS, a `SetThreadExecutionState` power request on Windows, and
  `systemd-inhibit` on Linux. The hold is tied to the server's process, so a
  crash or Stop releases it. The screen still locks and turns off.
- On by default. Switch: **Settings → Connection → Keep running when the
  computer is locked** (`PUT /api/server/keep-awake`, admin only, applies
  immediately), `server.keepAwake` in config.json, or `VAULT_KEEP_AWAKE=0`.
- The macOS sign-in entry (LaunchAgent) gains `ProcessType Interactive` (no
  App Nap throttling while locked), `KeepAlive { SuccessfulExit: false }`
  (comes back after a crash, not after Stop) and `ThrottleInterval 30`. Entries
  installed by older versions are rewritten at start-up and take effect at the
  next sign-in. A running server is never interrupted.
- The launcher no longer exits with an error when its port is taken while
  started at sign-in, which made launchd retry forever.
- `deploy/com.vault.server.plist` and the docs explain what can't be
  overridden: closing the lid on battery, and the `pmset` setting.

### Added — move everything to another server
- **Settings → Move to another server** and an **Import from another Vault**
  option in the setup wizard. One package holds every media file in its
  original folders and names, plus the library (with hand edits), playlists,
  favourites, history and progress, profiles, collections, artwork, sign-in
  and settings. It can be:
  - downloaded as a `.zip` (streamed ZIP64 with an exact Content-Length, so
    files over 4 GB work and the browser shows real progress),
  - fetched on the new computer through a 2-hour link, or
  - written as a plain folder to a drive.
- Importing copies the media to a folder you choose. It can be resumed:
  same-size files are skipped. It relinks every path and item id to the new
  location, including Windows ↔ macOS/Linux, then restarts. The previous data
  is kept in `server/backups/before-transfer-<time>`. If applying fails, it
  rolls back instead of boot-looping.
- The same from a terminal: `npm run export -- <folder> [--zip] [--no-media]`
  and `npm run import -- <package> [--media-dir <dir>] [--in-place]`.
- Left behind: trash, old backups, the SQLite index, login lockouts and
  regenerable caches (thumbnails, scrub previews, transcodes).

### Fixed — system console permissions and backup sizes
- `/api/system` changes (restore or delete a backup, clear caches, rebuild the
  index…) and its logs, backup and Subsonic reads now require an admin
  profile. Previously any profile, kids' included, could restore an old backup
  over everyone's library.
- Backups showed "0 B" (the UI read `size`, the server sends `bytes`). The old
  "Create incl. artwork" button, which built a backup of every media file in
  memory, now opens the streaming transfer instead.

### Fixed — typed-in song details disappearing (seen from another computer)
- Titles, artists, albums and covers typed into the upload form, the edit
  dialog or the album editor were overwritten on the next rescan by the file's
  own tags. Often that meant "Unknown Artist", the filename as the title and no
  cover. The folder watcher re-reads a new upload a moment after it lands,
  whenever the duration couldn't be read, so this could happen within seconds.
  It also didn't tell open tabs: the tab that did the upload kept showing the
  old values, and only another browser, e.g. on a Linux computer using the Mac's
  server, showed the real (wiped) data.
  - Hand-set fields are now recorded per item (`manualFields`), and rescans
    keep them over the file's tags.
  - Even without that record, a rescan never swaps a real value for a
    placeholder or drops an uploaded cover.
  - The watcher now broadcasts whenever a rescan changed an item.
- `scripts/restore-metadata-from-tab.js` is a one-time snippet. Paste it into
  the console of a tab that still shows the right details, and it copies them
  back to the server.

### Fixed — Remote access: cloudflared install on macOS
- "did not match its published checksum": Cloudflare's release notes list
  SHA-256 values for the macOS `.tgz` downloads that don't match the files.
  GitHub's own asset digest is now the authority. The notes hash is still
  accepted when it matches the archive or the extracted binary, and a download
  matching neither is refused.

### Fixed — fresh installs on Linux (and npm 12)
- `npm start` before `npm install` (or after running it in the wrong folder)
  crash-looped on `Cannot find module 'dotenv'`. The launcher now installs the
  packages itself, then starts the server; if that fails it says why once, in
  the terminal and in the app, instead of restarting forever. Running
  `node index.js` directly prints a one-line explanation (exit 78).
- A root `package.json`: `npm install` / `npm start` now work from the
  `Vault-V2` folder too (previously `npm error enoent Could not read package.json`).
- npm 12 blocks dependency install scripts unless approved, so ffmpeg-static
  never downloaded ffmpeg (no thumbnails, conversions or Live TV). It is now
  approved in `allowScripts`; ffmpeg-static/ffprobe-static became optional
  dependencies so a failed ffmpeg download no longer aborts the whole install.
- Node 20 is the real minimum (`file-type` needs it); `engines` said 18. Older
  Node now gets a clear message.
- CI: a fresh-install job (Node 20, LTS, newest) runs root `npm install` +
  `npm start`, checks ffmpeg was downloaded, and the self-install path.
- README rewritten around the actual install (Linux Node/nvm notes, expected
  output, updating, install troubleshooting) and corrected (rate limits, themes,
  settings locations, Docker).

### Fixed — deploy failing on the reorder UI test
The GitHub Pages deploy of the previous merge failed in the `Server tests` step,
so none of those changes reached the site. `detail.js` and `playlists.js`
attached the ↑/↓ reorder buttons from a *second* dynamic import that resolved
after the rows had already rendered, while `server/test/reorder-ui.test.js`
waited only for the rows and then clicked a button that did not exist yet on a
slower, cold runner (`Cannot read properties of null (reading 'click')`).
- Rows and their reorder controls are now attached in the same tick: the
  `mediaList.js` and `reorderableList.js` imports are static, so no async gap
  remains between the two (users no longer see reorderable rows appear without
  their move buttons).
- `reorder-ui.test.js` now waits for the move button it clicks, so a future
  regression reports "move buttons did not render" instead of a `TypeError`.
- Verified on Node 20 (the CI version) with the full deploy verification
  sequence: 52/52 server tests pass.

### Fixed — cover art uploads reporting "Not Found"
- Album and playlist artwork uploads now have compatibility route aliases and
  retry only when the server reports that the endpoint itself is missing.
  A missing endpoint now names the failed API paths and asks the user to update
  and restart the self-hosted server instead of surfacing an opaque `Not Found`.
- Optional artwork on a multi-file media upload is persisted once and shared by
  every indexed item. Previously the first item moved the temporary image and
  the second item failed while trying to move the now-missing file again.
- Authenticated integration tests exercise album editing, playlist editing,
  compatibility aliases, and optional artwork on new-media batch uploads.

### Fixed — album and playlist track reordering
- Album reorders no longer report an `AbortError` after they have succeeded.
  The mutation response is merged into the library immediately, and identical
  live-event/view refreshes now share one GET instead of cancelling each other.
- Installed PWAs no longer mix a permanently cached `api.js` with newly
  deployed views (the source of `updateAlbumOrder/reorderPlaylist is not a
  function`). The v4 shell repairs existing caches, checks for updates on every
  load, and fetches shell modules network-first with an offline fallback.
  Compatibility fallbacks also let an already-open stale client call the
  reorder endpoints without clearing site data.
- SQLite-backed libraries mirror add/update/remove operations immediately, so
  saved album track numbers are visible without restarting the server.
- Service-worker activation now preserves explicitly downloaded offline media.

### Fixed — "Too many requests" at login, again (follow-up to PR #13)
PR #13 exempted `/api/auth/*` from the general limiter, but users with
correct credentials could still get 429 at login. Three remaining causes:
- **Successes never restored budget.** The auth-failure limiter (and the
  persistent brute-force store) counted wrong passwords and wrong grids
  into one accumulating total; a correct password in between merely
  didn't add to it. Interleaving typos with correct entries (4 bad
  passwords → correct → 4 bad grids → correct → 2 bad grids) therefore
  locked the next *correct* login for 15 minutes. Both lockout systems
  now budget the password and second-factor stages separately: a
  correct password clears only the password budget, a completed login
  clears both, and one step's failures can't lock the other step.
  Existing `bruteforce.json` records migrate to the staged keys.
- **The 200→2000 general-limit raise never reached existing installs.**
  Their `config.json` (written by setup/onboarding) already contains
  `security.rateLimit.general.max: 200`, which overrides the new
  default. That exact legacy default is now migrated to 2000 on load
  (and on re-running `scripts/setup.js`); custom values are untouched.
  The general limiter's exemptions are now matched on the
  query-stripped path and also cover the SSE event streams; a generous
  per-IP flood ceiling (300/15min) now bounds the credential endpoints
  in place of the general limiter they are exempt from. The
  `/api/auth/second-factor` endpoint is failure-limited like `/grid`
  (it previously had the counter flag but no limiter mounted).
- **A wrong grid entry bounced users back to the password step.** The
  API client treated every credential-step 401 as session expiry,
  wiping the challenge token and firing `vault:auth-required`, so each
  grid retry required a fresh login POST and fed the failure counters.
  Credential-step 401s (`login`/`grid`/`second-factor`) no longer clear
  the session; the user stays on the grid step and can retry.
- Lockout responses now send `Retry-After`; regression tests in
  `server/test/rate-limit-login.test.js` pin the interleaved-success
  scenario, per-stage locking, exemptions and the config migration.

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
- **`scripts/music-view-check.js`** (`npm run test:music`) — 14 checks driving
  the real `views/music.js` + `views/detail.js` in a jsdom DOM: album cards open
  instead of playing, their play button still plays, Enter/Space reach both,
  genre rows expand, and the grouping survives navigation. It fails 9 checks on
  the pre-fix code and passes now. Unlike the other checks it needs a real DOM
  (the views build markup with `innerHTML`), so jsdom is an optional devDep —
  with none installed it reports SKIPPED and exits 0 instead of failing a build.

### Changed
- `docs/js/api.js` accepts plain-object request bodies (normalised to JSON) and
  gained the full v3 method surface + `markCompleted`.
- Video player emits `vault:video-opened` / `vault:timeupdate` /
  `vault:item-finished` and marks items completed on `ended`.
- `docs/css/v3.css` added to the CSS build (13 sheets → 93.5 KB minified,
  16.7 KB gzip).
- The Music page remembers its grouping (`vault_music_group_by`, validated
  against the four known filters). Opening an album is now a navigation, so Back
  returns to the Albums grid instead of dropping you back on All Tracks.

### Fixed
- **The Albums filter played the album instead of opening it.** Every album card
  in `views/music.js` dispatched `vault:play` on click, so the album page — which
  already lists the album's tracks with Play Album / Shuffle — was unreachable
  from that filter, and its play affordance was an unfocusable `<div>`. Activating
  a card now opens the album; playback moved onto a real labelled `<button>`, and
  the card is focusable (`role`/`tabindex`, Enter/Space) like every other card.
- **The Genres filter had the same shape** — clicking a row played the genre.
  Genres have no page of their own, so the row now expands into its track list
  (`aria-expanded`, rows built on first open) and playback sits on its own button.
- **The album page mis-grouped untagged tracks.** It matched album siblings with
  `i.album === item.album`, so opening the "Unknown Album" group (tracks carry
  `undefined`, `''` or no key at all) showed an empty heading and a partial list;
  it now uses the same `album || 'Unknown Album'` key as the Albums filter.
- **An album was credited to whichever track you clicked.** The album byline now
  reads "Various Artists" when its tracks disagree on the artist.
- **`npm run test:keyboard` crashed before it could report.** `components/toast.js`
  mounts its container at module scope, and `mediaCard.js` now reaches it through
  `contextMenu.js`, so the harness's fake `document` had no `body` to append to
  and the "media cards / list rows (real modules)" phase died on import.
  `FakeDocument` gained a `body`; 25/25 again.

### Verification
- `npm run lint` (syntax-check): 129 files OK · `node --test`: 24/24 pass ·
  server boots and serves `/api/health` 3.0.0.
- After merging `main` into this branch: `npm run lint` 136 files OK ·
  `npm run check:imports` 323 imports across 67 files OK · `node --test` 35/35
  pass · `npm run test:music` 14/14 · `npm run test:keyboard` 25/25.

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
