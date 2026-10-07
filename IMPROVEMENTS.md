# Vault V2 — Improvement Backlog (proposals, nothing implemented)

> Reviewed at commit `395b830` (branch `arena/0deefe55-vault-v2`). Every item below was checked
> against the actual code — nothing here is already implemented, and the "dead UI" items in
> Tier 1 are features the README/HTML already promise but the JS never wires up.
>
> **Effort:** `S` ≈ under a day · `M` ≈ a few days · `L` ≈ a week+ (feels like new subsystems)
> **Value:** 🔥 = changes how the product feels · ✨ = strong polish · ▫ = nice-to-have

Legend of sources: what the comparable popular platform does that Vault currently doesn't.

---

## Implementation status — `arena/0deefe55-vault-v2`

> Updated as work lands. **Done** = code merged on the branch and passing
> `npm run lint` (syntax-check) + the server test suite; **Partial** = core is
> in but some wiring/UI is still missing; **Todo** = not started.

### Server (complete)
- **All 18 new services** load and the server boots: events (SSE bus + jobs),
  trash (soft delete + retention), extras (watchlist, collections, markers,
  bookmarks, feeds, listens), profiles + sessions, stats, sqliteIndex,
  transcodePlan (quality ladder + HW-accel detection), agent (TMDB/MusicBrainz/
  NFO), podcasts (RSS/Atom), comics (CBZ reader), livetv (M3U/HDHomeRun/XMLTV),
  syncplay (rooms + drift), notifications (webhook/ntfy/Discord/Telegram,
  Last.fm/ListenBrainz), system (health, backups, logs), subsonic, hls.
- **Routes mounted:** `/api/extras`, `/api/series`, `/api/profiles`,
  `/api/system`, `/api/podcasts`, `/api/comics`, `/api/livetv`,
  `/api/syncplay`, `/api/agent`, `/rest` (Subsonic), live `/api/events`;
  `library` (libraries/recent/scan/trash-aware delete), `media` (artwork,
  trailer, extras, trickplay, lyrics, chapters, plan, sources), `playlists`
  (order, M3U export/import, stats, scrobbles), `transcode` (HLS + `?plan=true`),
  `settings` (validates every new block).
- **Boot/smoke verified:** `/api/health` 3.0.0, grid login, 14 endpoints 200,
  `/rest/ping` ok, SQLite index available, 24/24 tests pass.

### Client
- **Done:** full v3 API client; SSE live-update client; context menus (queue,
  watchlist, watched, playlist, trash+undo); Up Next queue panel with drag
  reorder; synced lyrics with offset; sleep timer + stop-after; cast button;
  bookmarks; stats-for-nerds panel; skip intro/recap/outro; chapter chips;
  trickplay scrub preview; quality selector; hero + smart rows on Home;
  new views for **Shows (seasons/episodes)**, **My List**, **Continue
  Watching**, **Stats/Wrapped**, **Profiles**, **Server console**, **Trash**,
  **Downloads**, **Podcasts**, **Comics reader**, **Live TV/DVR**,
  **SyncPlay**; sidebar + bottom-nav entries; multi-select batch actions;
  touch gestures; ambient artwork colour extraction; offline downloads;
  QR pairing module; playlist export/import/reorder; quality badges on cards;
  `v3.css` component sheet.
- **Done (settings & playback):** TOTP enable/disable + recovery codes,
  active-session list with revoke / sign-out-everywhere, QR pairing panel,
  remote-access helper, subtitle size/colour/background/timing with a live
  preview, default playback speed, volume normalisation and skip-silence —
  all persisted in `vault_playback_prefs` and applied to both players.
- **Done (library UX):** **Audiobooks** view (resume, chapters, speed, sleep
  timer, bookmarks) and **Artists / Artist** views (play all, shuffle, queue,
  album grouping); virtualised rendering for grids over 150 items
  (`utils/virtualGrid.js` → `mediaGrid`); Media Session for video (lock-screen
  controls, metadata, playlist nav); context menus on list rows as well as
  cards; `window.vaultPlayback` provides current-time/seek helpers.
- **Done (ops):** mDNS announcement (`vault.local`, opt-in via
  `server.mdns` / `VAULT_MDNS=1`), Dockerfile + `docker-compose.yml` (ffmpeg
  included), systemd unit + launchd plist + `deploy/README.md`, provider
  API-key cards in the Server console; ffmpeg resolution now falls back to the
  system binary when the bundled one is missing.
- **Todo:** nothing outstanding from the approved list — future work tracked in
  `IMPROVEMENTS.md` history and the PR description.

## Tier 1 — Finish what's already shipped in the UI (dead buttons + README drift)

These are half-built: the DOM exists, the API exists, or both — but there's no wiring. Each one
is a "the app already looks like it has this" credibility fix, and all are quick.

| # | Item | Platform | What's actually there | Work | Val |
|---|---|---|---|---|---|
| 1 | **Skip Intro / Skip Recap** | Plex, Jellyfin, Netflix | `#skip-intro` button in `index.html:234` — **zero JS references**, and no intro/outro data anywhere | Markers per item: ffmpeg black-frame + silence detection at scan, plus manual "mark intro" from the player. Auto-show button only in the window, per-series memory, optional auto-skip | M | 🔥 |
| 2 | **Lyrics (synced)** | Spotify, Apple Music | `#lyrics-container` exists; **nothing writes to it**; no `.lrc` parsing | Embedded lyrics via `music-metadata` (already a dep) + sidecar `.lrc`; auto-scroll, click-a-line-to-seek, offset nudge, full-screen view | M | 🔥 |
| 3 | **Up Next / queue panel** | Spotify | Store has `queue`, `addToQueue(item, next)`, `removeFromQueue`, `clearQueue`; `#queue-container` / `#now-playing-queue` are **never rendered** | Up Next drawer: drag reorder, jump-to, remove, clear, "save queue as playlist", already-played history. Add "Play next / Add to queue" to card menus | M | 🔥 |
| 4 | **Playback quality selector + stats** | YouTube, Plex | API supports `?quality=480p\|720p\|1080p\|original`; README claims a quality selector; **no UI** | Gear menu (Auto/Original/1080/720/480), remembered per device, plus "stats for nerds" (codec, res, bitrate, buffer, dropped frames, transcode reason) | S–M | 🔥 |
| 5 | **Chapters** | YouTube, Plex | None anywhere (`ffprobe` streams are already parsed) | Extract chapters at scan → chapter list on detail page, tick marks + chapter tooltip on the scrub bar, `,`/`.` to jump | S–M | ✨ |
| 6 | **Posters & backdrops for video** | Plex, Jellyfin | Cards use a 2:3 poster frame but movies only ever get a 16:9 frame grab at 25 % → crops badly. No `poster.jpg` / `folder.jpg` / `backdrop.jpg` detection, no artwork picker | Sidecar + embedded-art detection, artwork chooser (upload / pick a frame), backdrop hero on the detail page | M | 🔥 |
| 7 | **Live library updates** | Jellyfin | `/api/events` SSE exists server-side; **never consumed** | Wire scan progress bar, "12 new items added" toast, live refresh after upload/delete — store is already refresh-capable | S–M | ✨ |
| 8 | **PWA install prompt + update toast** | — | `showInstallPrompt()` never called; `vault:update-available` fires with no listener | Install CTA (Home/settings), sticky "New version — Refresh" toast | S | ▫ |

---

## Tier 2 — Structural parity with Plex / Jellyfin

| # | Item | Platform | Gap in Vault | Work | Val |
|---|---|---|---|---|---|
| 9 | **TV series support** (show → season → episode) | Plex, Jellyfin, Netflix | Items already carry `season`/`episode` and there's a same-folder "next episode" heuristic, but there is **no show grouping, no season/episode pages, no Next Up, no watched state, no play-all**. The Movies view is even titled "Movies & Series" | Show grouping (SxxEyy + folder), show page with seasons/episodes (thumbs, progress, watched), Next Up row on Home, auto-advance across the show, "Play from here" | L | 🔥 |
| 10 | **Multi-user profiles** | Netflix "Who's watching", Jellyfin, Plex Home | One account; favourites/history/playlists are global | Users file, profile picker after grid unlock, per-profile favourites/history/playlists/continue-watching, optional PIN, Kids flag (rating filter), admin vs viewer | L | 🔥 |
| 11 | **Watchlist / "My List"** | Netflix | Favourites only; no separate "play later" concept | Watchlist button on cards/detail + Home row; keep Favourites as "loved it" | S–M | ✨ |
| 12 | **Multiple libraries + ignore rules** | Plex, Jellyfin | Exactly one folder per type; no way to separate "4K Movies" / "Kids Movies" / "Docs" or to skip files | N libraries (name, type, paths[], scan schedule, ignore globs), sidebar switcher, per-library rescan | M–L | 🔥 |
| 13 | **Online metadata agents** | Plex/Jellyfin's defining feature | No TMDB/TVDB/MusicBrainz anywhere — titles come from filenames, synopses/cast/posters are all missing | Opt-in agent: match by title+year → poster, backdrop, synopsis, cast, rating, genres; "Fix match" + poster picker; cached locally so offline still works | L | 🔥 |
| 14 | **Subsonic API subset** | Navidrome | No compatibility layer | Implement the `/rest/*` subset → existing mobile/desktop apps (Symfonium, play:Sub, Feishin, Sonixd) work against Vault with zero app development | M–L | 🔥 |
| 15 | **Browse pages: genre / decade / rating / unwatched** | Jellyfin "Browse by", Netflix | `genreSet` + `/api/library/genres` exist server-side but the UI never uses them; filters are a single text box | Filter chips with counts, multi-select facets (genre, year range, resolution, codec, watched), sortable "See all" pages | M | 🔥 |
| 16 | **Context menu on cards/rows** | Plex, Jellyfin, Spotify | Every action is buried in the detail page | Right-click / long-press: Play next · Add to queue · Add to playlist · Add to watchlist · Mark watched · Copy path · Download · Delete | S–M | 🔥 |
| 17 | **Multi-select + batch operations** | Plex, Jellyfin, Spotify | One item at a time | Selection mode (shift-click range), batch metadata edit, batch add-to-playlist, batch mark watched, batch delete | M | ✨ |
| 18 | **Drag reorder: queue, playlists, playlist tracks** | Spotify | Server only has add/remove item — **no reorder endpoint**; no DnD in playlist detail | `PUT /api/playlists/:id/order` + HTML5 drag & drop | S–M | ✨ |
| 19 | **Adaptive streaming (HLS)** | Plex, Jellyfin | One chunked ffmpeg stream: seek-hostile, no quality adaptation, no session resume | HLS with 2–3 renditions, per-session state, "Auto" quality from measured bandwidth | L | 🔥 |
| 20 | **Casting + video Media Session** | Plex, Jellyfin, YouTube | Media Session is wired for **audio only**; no AirPlay/Chromecast at all | Remote Playback API (AirPlay, cheap) + optional Cast SDK; media keys + lock-screen controls for video | M–L | ✨ |
| 21 | **Watched state + Continue-Watching cleanup** | Jellyfin | `completed` exists in the history API but the client never sets or reads it | Mark watched/unwatched, reset progress, remove from Continue Watching, unwatched badges, hide-watched filter | S–M | 🔥 |
| 22 | **Trailers + extras** | Plex, Jellyfin | Not detected | `*-trailer.mp4`, `extras/`, `featurettes/`, deleted scenes → Trailer button on hero, Extras row on detail | S–M | ✨ |
| 23 | **Collections (folder + rule based)** | Plex | `components/collections.js` is a dead stub | Folder→collection, smart collections ("unwatched 90s action", "4K"), cross-media collections (the RESEARCH.md promise) | M | ✨ |
| 24 | **Library health dashboard** | Plex/Jellyfin issues, *arr | Nothing surfaces broken libraries | Missing files, unplayable codecs, no artwork/metadata, duplicates (hash), orphaned sidecars, cache size — with one-click fixes | M | ▫ |

---

## Tier 3 — Playback & discovery parity (Spotify / Netflix / YouTube)

| # | Item | Platform | Gap | Work | Val |
|---|---|---|---|---|---|
| 25 | **Video mini-player** | YouTube | Closing the video modal stops playback; you can't browse while watching | Minimize to a draggable corner player that survives route changes (PiP already exists but is a separate window) | M | 🔥 |
| 26 | **Sleep timer + "stop after N" + fade out** | Plexamp, Spotify | No timer at all | Audio & video; fades out, optional "finish current episode" | S | ✨ |
| 27 | **Audio speed / skip silence / loudness normalization** | Plexamp, Spotify, VLC | No speed control for audio; no ReplayGain/leveling | 0.5–3× with pitch correction, per-type memory, silence skip, normalization toggle | M | ✨ |
| 28 | **Subtitle tracks + styling + delay** | Jellyfin, VLC | Only a captions on/off toggle | Track picker with language labels, font/size/colour/background/edge/position, ±0.5 s delay, remembered per series, ASS basics, optional burn-in | M | 🔥 |
| 29 | **Home redesign: hero + carousels** | Netflix, Disney+, Spotify | Flat grids, no hero, no per-row "See all", no arrows | Featured billboard (backdrop + resume/play), horizontal rails with arrow buttons, "See all" per row | M | 🔥 |
| 30 | **Locally-computed smart rows** | Netflix, Spotify | Home rows are "recently added" + favourites only. `playCount` exists on items and is **never incremented** | "Because you watched X", "Rediscover", "Top 10 in your library", "Recently played", "Unwatched in genres you like" — pure local heuristics | S–M | 🔥 |
| 31 | **Resume-from-another-device UX** | Plex | Server history syncs, but nothing tells you | "Continue from 42 % on your phone?" prompt on play; per-device position sync indicator | S–M | ✨ |
| 32 | **Colour from artwork** | Spotify, Apple Music | Themes are static | Canvas dominant-colour extraction → ambient glow behind Now Playing / detail hero; optional "match theme to artwork" | S | 🔥 |
| 33 | **Quality / format badges** | Plex, Tidal, Apple Music | Not shown | 4K · HDR · x265 · Dolby on cards/detail; FLAC · Hi-Res; "Direct play vs transcoded" chip | S | ✨ |
| 34 | **Playlist UX upgrades** | Spotify | No covers, runtime, or interop | Per-playlist cover + description + total runtime, auto "Liked Songs" from favourites, duplicate detection, M3U import/export | S–M | ✨ |
| 35 | **Artist & album pages** | Spotify, Navidrome | Music view does inline grouping with track lists — no navigable artist/album pages | Artist page (discography, top tracks), album page (track list, runtime, play/shuffle) | M | ✨ |
| 36 | **Stats / "Wrapped" page** | Spotify Wrapped, Tautulli | `/api/library/stats` exists; no UI | Watch/listen time by month, top genres/artists/shows, most played, library size saved | M | ✨ |
| 37 | **Grid keyboard navigation + rebindable shortcuts** | Plex/Jellyfin TV, Linear | Only the search modal handles arrows; shortcut panel is read-only | Arrow-key roving focus, Home/End, type-ahead, Space=play, Enter=open; editable keybinds | S–M | ✨ |
| 38 | **Mobile gestures + bottom nav** | Netflix/Spotify mobile | Hamburger + sidebar; no gestures | Double-tap sides ±10 s, swipe down to dismiss player, long-press 2×, swipe between rails, safe-area insets, bottom tab bar | M | ✨ |
| 39 | **Trash + undo** | Gmail, Spotify | Delete is immediate (confirm dialog only) | Soft-delete to `data/trash` with 10 s undo toast; undo for playlist delete / history clear; empty trash | S–M | 🔥 |
| 40 | **Offline downloads** | Netflix, Spotify, Plex | SW caches the shell only; media always streams | "Download" queue into Cache Storage/OPFS, quota meter, Wi-Fi-only setting, offline playback | L | ▫ |

---

## Tier 4 — Server, ops & security

| # | Item | Platform | Gap | Work | Val |
|---|---|---|---|---|---|
| 41 | **Transcode controls + hardware acceleration** | Plex, Jellyfin | No HW accel detection/UI, no bitrate caps, no tune mapping, no visible cache usage | Detect NVENC/VAAPI/QSV/VideoToolbox + toggle, quality/bitrate caps per library, tone mapping, "why is it transcoding" reason, cache cap with usage display | M–L | 🔥 |
| 42 | **Per-device sessions + revocable tokens** | Netflix devices, Plex | One opaque token per login; no device list, no "remember this device" | Session list (device, IP, last seen), individual revoke, remember-30-days | M | ✨ |
| 43 | **TOTP 2nd factor + recovery codes** | Jellyfin, Plex | Grid pattern is the only 2nd factor and is unrecoverable if forgotten | Optional TOTP (any authenticator) + one-time recovery codes; grid stays the default | M | ✨ |
| 44 | **Real CSP + enforce CORS** | — | `helmet({contentSecurityPolicy:false})` while docs claim CSP; CORS callback allows every origin | Restore a working CSP for the same-origin mode and make the allow-list real, without breaking GitHub-Pages playback | S–M | 🔥 |
| 45 | **Remote-access wizard** | Plex/Jellyfin remote access | It's 3 README paragraphs + manual tunnel setup | Settings page: test tunnel URL, phone QR, CORS/mixed-content diagnostics, health check | M | 🔥 |
| 46 | **QR pairing / mDNS / TV quick-connect** | Plex, Jellyfin | You type the URL (and the 8-square grid!) on the TV | QR that opens the UI with the server URL prefilled, `vault.local` announcement, 6-digit code login approved from a phone | M | ✨ |
| 47 | **In-app server console** | Jellyfin, *arr | Server info is a raw JSON dump; logs only in the terminal | Log tail + download, cache clear, disk usage per library, backup/restore of `data/` as zip, version + update banner | M | ✨ |
| 48 | **Notifications & integrations** | Plex/Jellyfin webhooks | None (`vault:*` events are browser-only) | Webhooks for scan/upload complete, ntfy/Discord/Telegram, Last.fm / ListenBrainz scrobbling, "now playing" | M | ▫ |
| 49 | **SQLite index + large-library performance** | Jellyfin, Plex | JSON DB + client fetching 1000-item pages won't scale; grids render every card | Opt-in `better-sqlite3` index, server-side paging, client virtualization/infinite scroll | M–L | 🔥 |
| 50 | **Docker + service install** | self-hosted norm | README says "leave the terminal open"; no container | `docker compose up` option + systemd/launchd/Windows-service unit so Vault survives reboots | S–M | ✨ |
| 51 | **CI/test expansion** | — | `node --test` covers compression + file serving only | Root lint/format configs, route tests, smoke boot against a temp media dir, artifact checks in the deploy workflow | S–M | ▫ |

---

## Tier 5 — Big bets (only if you want to grow beyond "movies + music")

| # | Item | Platform | Notes |
|---|---|---|---|
| 52 | **Audiobooks mode** | Audiobookshelf | Chapters, per-book resume, speed, sleep timer, ±30 s, bookmarks, "Continue listening". Fits the existing audio stack closely — highest value/effort ratio in this tier |
| 53 | **SyncPlay / Watch Party** | Jellyfin | Room host + guests sync play/pause/seek over SSE/WS; optional chat |
| 54 | **Podcasts (RSS/OPML)** | AntennaPod, Audiobookshelf | New media type with feed fetching, auto-download, per-podcast settings |
| 55 | **Comics / manga / eBooks** | Komga, Kavita | Reader view; an entirely separate pipeline |
| 56 | **Live TV / DVR** | Plex, Jellyfin, Emby | Tuner (HDHomeRun) + EPG; large |

---

## Suggested order

1. **Tier 1 first** (items 1–8) — cheap, and they close the gap between the README and reality.
2. **9 (series) + 21 (watched state)** — the single biggest reason Vault feels smaller than Plex/Jellyfin.
3. **16 + 17 + 18 + 3 + 29 + 30** — makes daily browsing and queueing feel like Spotify/Netflix.
4. Then 12/13 (libraries + metadata agents) if you want real library management, and 44/41 for security/performance hygiene.
