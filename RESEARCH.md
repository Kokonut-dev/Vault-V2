# Vault — Deep Research & Competitive Analysis

> Stage 0 — Completed before any code was written. This document captures the competitive landscape, gaps, technical constraints, and design direction that informed Vault's architecture.

---

## 0.1 Competitive Landscape Analysis

### Video / Movies / Series

#### Netflix
**Does well:**
- Hero-first detail pages with backdrop + gradient, immediate play CTA
- Resume row is sacred — always first, with progress bars embedded in thumbnails
- Skip intro/recap detection (UX delight), next episode countdown overlay
- Adaptive bitrate streaming, thumbnail scrubbing
- Keyboard: space, arrows, M, F, etc. standardized
- Micro: hover scale + preview clip on browse, sound on hover muted by default

**Does poorly:**
- No real file management, no metadata editing
- Search is weak — no fuzzy, no multi-category
- No EQ, no subtitle styling beyond basics
- Discovery is algorithmic black box, no user curation power

#### Plex
**Does well:**
- Gold standard for self-hosted: automatic library categorization, metadata agents, remote access via Plex Relay
- Rich metadata display (cast, crew, extras), watch together
- Transcoding on-the-fly with quality selector
- Collections, playlists, continue watching across devices

**Does poorly:**
- UI feels dated, heavy, inconsistent theming
- Music experience is secondary (Plexamp is separate app)
- Settings are buried, overwhelming
- Authentication is Plex account dependent, not fully self-hosted
- Performance on low-end NAS can be poor

#### Jellyfin
**Does well:**
- Fully open source, self-hosted, no phone-home
- Plugin ecosystem, live TV, good codec support
- User profiles, parental controls
- Free, community driven

**Does poorly:**
- UI/UX is functional but not premium — inconsistent spacing, weak animations
- Mobile apps lag behind web
- Search is basic substring, no command palette
- No advanced audio processing, no EQ
- Onboarding is technical, not guided

#### Emby
**Does well:**
- Similar to Plex but with better live TV, DVR
- Good metadata management, intro detection (premium)
- Hardware transcoding support

**Does poorly:**
- Paywalled features behind Premiere
- UI is cluttered, navigation confusing
- Music still afterthought

#### Disney+ / HBO Max
**Does well:**
- Brand-specific collections, curated rows, GroupWatch / co-viewing
- High production value detail pages, extras, behind scenes
- Dolby Vision/Atmos badges, quality indicators
- Kids profiles, accessibility subtitles

**Does poorly:**
- No personalization beyond watchlist
- No file ownership — streaming only
- No advanced playback controls beyond basics

---

### Music

#### Spotify
**Does well:**
- Persistent mini-player, queue management with drag reorder is benchmark
- Crossfade, gapless, normalization, EQ (basic 6-band), blend, smart shuffle
- Command palette via search, keyboard shortcuts
- Collaborative playlists, daily mixes, discovery
- Canvas, lyrics sync, now playing full-screen with large art

**Does poorly:**
- EQ is buried, only 6 bands, no parametric
- No file ownership, no local file metadata editing
- Queue UX breaks on large queues
- No true lossless in UI (at time of writing)

#### Apple Music
**Does well:**
- Typography, album art focus, lossless & spatial audio badges
- Library organization: Artists, Albums, Songs, Made for You
- Integration with local files (though clunky)
- Lyrics, sing mode

**Does poorly:**
- Web app is weak vs native
- No advanced audio processing
- Heavy, slow for large libraries

#### Tidal
**Does well:**
- Audiophile positioning, quality badges (Master, HiFi)
- Credits, detailed metadata

**Does poorly:**
- UI is dark but not flexible theming
- No EQ at all

#### Navidrome / Funkwhale
**Does well:**
- Lightweight, self-hosted, Subsonic API compatibility
- Good for large libraries, fast scanning
- Multi-user, sharing

**Does poorly:**
- UI is barebones, no visualizer, no EQ, no crossfade
- No video support
- Metadata editing minimal

#### Plexamp
**Does well:**
- Best Plex music UX: beautiful album art, sweet fades, loudness leveling, sonic analysis for mixes
- Offline, CarPlay

**Does poorly:**
- Requires Plex server, separate app
- No video

#### foobar2000
**Does well:**
- Ultimate customization, DSP chain, parametric EQ, advanced tagging
- Lightweight, handles huge libraries

**Does poorly:**
- UI from 2003, steep learning curve, not web

---

### Video (General / UGC)

#### YouTube
**Does well:**
- Chapters, transcript search, thumbnail scrubbing, quality selector, speed, captions styling, theatre mode, mini-player PiP, queue
- Keyboard shortcuts comprehensive (JKL, arrows, M, F, C, etc.)
- Search is world-class: typo tolerance, filters

**Does poorly:**
- Algorithmic, ads, no ownership
- No EQ beyond volume
- Library management weak

#### Vimeo / PeerTube
**Does well:**
- Clean player, privacy controls, no ads
- PeerTube: federated, self-hosted, P2P

**Does poorly:**
- Smaller ecosystem, less polish

---

### Self-Hosted Media Servers Summary Table

| Platform | Strength | Weakness | Navigation | Search | Playback | Queue | Metadata | Onboarding |
|----------|----------|----------|------------|--------|----------|-------|----------|------------|
| Plex | Transcoding, apps, remote | Closed, music weak | Sidebar + top | Basic | Custom, good | Basic | Agent-based | Easy but account |
| Jellyfin | OSS, free | UI polish | Sidebar | Basic | Native + transcode | Basic | Good | Technical |
| Emby | Live TV, DVR | Paywall | Top nav | Basic | Good | Basic | Good | Medium |
| Navidrome | Lightweight music | No video | Sidebar | Fast but basic | Simple audio | Subsonic queue | ID3 | Easy |
| Streama | Simple video | Abandoned-ish | Simple | None | Basic | None | Manual | Easy |

---

## 0.2 Gaps & Opportunities

### What Everyone Gets Wrong
- **Music is second-class** in video-first servers; video is absent in music-first servers. Vault should be truly equal.
- **No serious audio processing**: Even Spotify's EQ is 6-band graphic. No parametric EQ, no compressor, no stereo widening in any mainstream platform. Audiophiles must use system-wide EQ.
- **Search is an afterthought**: Only YouTube and Spotify have decent search. Self-hosted has no fuzzy, no command palette, no cross-library.
- **Theming is binary**: Dark/light only. No warm/cold emotional themes, no grain, no glassmorphism customization.
- **No unified keyboard-first workflow**: Power users want Raycast/Alfred style command palette for media. None offer Option+Space global search.
- **Upload is missing**: Self-hosted expects you to SMB/FTP files in. No in-app upload with metadata forms.
- **No adjustable aesthetic effects**: Glassmorphism and grain are trendy but no player lets user tune them.
- **Metadata editing requires external tools**: Plex/Jellyfin allow some, but not inline with good UX.
- **No visualizer in browser**: Winamp nostalgia absent.
- **Resume is video-only**: Music rarely remembers position in long mixes/podcasts.
- **No collections that span media types**: Want "Chill Night" with both movies and lo-fi music.
- **Accessibility**: Keyboard nav often incomplete, focus rings missing, screen reader support weak.

### Cross-Category Feature Ports That Would Be Brilliant
- **From music → video**: Crossfade (between episodes?), EQ (video audio sweetening), queue management, gapless, visualizer, Now Playing full-screen for movies (show backdrop + metadata + ambient).
- **From video → music**: Chapters for albums (track markers), skip intro for music (skip long intros), thumbnail scrubbing for audio waveform preview, theatre mode for album art.
- **From code editors / productivity → media**: Command palette (⌥+Space) global search, keyboard shortcut cheat sheet (?), multi-cursor style multi-select for batch operations.
- **From photography apps → media**: Rating system, collections, metadata batch editing, info panel with technical specs.

### What Makes Vault Better for Self-Hosted
- Truly unified: Movies, Series, Music, Videos equal citizens.
- Browser EQ is professional-grade parametric 10-band with Web Audio API — no other self-hosted does this client-side.
- Global command palette search across all libraries with fuzzy matching.
- Premium aesthetic: 4 emotional themes + adjustable glassmorphism + adjustable grain — feels like a designed product, not an admin panel.
- In-app upload with smart categorization forms — no need to SSH.
- Offline-first PWA shell, works even if server temporarily unreachable (UI loads, shows cached).
- Security: Two-step auth (password + secret 4x4 grid pattern) — memorable but not brute-forceable, no external auth dependency.
- Keyboard-first: Every action has shortcut, shortcuts panel.
- Metadata editor inline, collections cross-media, favourites, history, ratings.
- Custom video player that rivals YouTube + Netflix combined, with subtitle styling, chapters, skip buttons.
- Persistent mini-player that survives navigation.
- Local server is lightweight Node.js, no Docker required (but supports it), SQLite index, file watcher.

---

## 0.3 Technical Research

### Front-end ↔ Local Server Communication for GitHub Pages Static Site

**Challenge:** GitHub Pages is HTTPS, local server is HTTP on localhost/LAN → mixed content blocked.

**Solutions evaluated:**
1. **Direct HTTP from HTTPS** — blocked by browsers. Not viable.
2. **Local server with self-signed HTTPS** — works but requires cert generation, user must trust cert. Good for advanced users. Provide script.
3. **Reverse proxy with mkcert** — `mkcert localhost` generates trusted local cert. Best UX if user installs mkcert.
4. **Tunneling (Cloudflare Tunnel, ngrok, Tailscale)** — exposes local server via HTTPS URL. Best for remote access. Recommend Cloudflare Tunnel (free, no account limits like ngrok). Provide instructions.
5. **Browser extension to allow mixed content** — not viable.
6. **Configurable server URL** — front-end reads `config.js` with `API_BASE_URL`. User sets to `https://localhost:4000` or tunnel URL. Document clearly.
7. **CORS:** Server must allow origin `https://kokonut-dev.github.io` (or custom domain) plus `http://localhost:*` for local dev. Configurable CORS_ORIGINS env.

**Decision:** Front-end config file `config.js` with `window.VAULT_CONFIG = { apiBaseUrl: 'https://localhost:4000', ... }`. Server CORS configurable. README explains mkcert + Cloudflare Tunnel.

### Browser Media Playback & Codecs

**Audio:**
- Native browser support: MP3 (all), AAC/M4A (all modern), Vorbis (Chrome/Firefox), Opus (Chrome/Firefox/Edge/Safari 17+), FLAC (Chrome/Firefox/Edge/Safari 14+), WAV (all), ALAC (Safari native, Chrome via transmux).
- Not natively supported everywhere: WMA, AIFF (partial), DSD.
- Strategy: Server probes via ffprobe, returns codec info. If browser can't play (check `canPlayType`), server transcodes on-the-fly to Opus 128k or AAC 256k via ffmpeg streaming (chunked). Cache transcoded version.

**Video:**
- Native: H.264 MP4 (universal), VP8/VP9 WebM (Chrome/Firefox), AV1 (Chrome/Firefox/Edge, Safari 16+), H.265 HEVC (Safari native, Chrome 107+ with hardware).
- Not native: Many MKV, AVI, WMV, FLV.
- Strategy: Direct play if codec is H.264 + AAC in MP4. Otherwise, server transcodes to H.264/AAC fragmented MP4 via ffmpeg with `-movflags frag_keyframe+empty_moov` for streaming. Support quality selector: 1080p, 720p, 480p transcodes.
- Subtitles: Convert SRT/ASS to VTT on server, serve as text track. Custom styling via ::cue.

**Libraries:**
- No heavy player library (Video.js, Plyr) — custom UI for premium feel, but use native <video> element.
- HLS.js / dash.js considered but fragmented MP4 direct is simpler for self-hosted.

### EQ / Audio Processing via Web Audio API

**Architecture:**
- Source: `MediaElementAudioSourceNode` from <audio> or <video> element (note: cross-origin requires CORS).
- Chain: Source → BiquadFilterNode x10 (peaking, lowshelf, highshelf) → DynamicsCompressorNode → StereoPannerNode (for widening via clever mid/side) → GainNode (volume) → ConvolverNode (reverb, optional) → AnalyserNode (visualizer) → Destination.
- BiquadFilterNode supports peaking EQ. For true parametric, need frequency, Q, gain per band.
- Presets: Map of 10 gains per preset. Custom profiles stored in localStorage.
- Visual curve: Calculate frequency response via `getFrequencyResponse` or manual math plotting magnitude vs frequency (log scale). Draw on canvas.
- Bass boost: Lowshelf at 100Hz + gain.
- Stereo widening: Use ChannelSplitter/Merger with mid/side processing or simple delay/chorus via DelayNode.
- Normalization: Use DynamicsCompressor + loudness measurement (ReplayGain from metadata if available, else simple RMS via Analyser).
- Compressor: DynamicsCompressorNode with threshold, knee, ratio, attack, release.
- Reverb: ConvolverNode with impulse response generated procedurally (small room).
- Crossfade: Two audio elements + GainNode crossfade via Web Audio API timing.
- Gapless: Preload next track, use MediaSource or two elements.

**Caveats:**
- `createMediaElementSource` can only be called once per element, must manage lifecycle.
- Autoplay policies: Must be triggered by user gesture. Show play button.

### Static-Site Authentication Patterns

**Constraints:** No server-side rendering on GitHub Pages, no httpOnly cookie from static host.

**Pattern:**
- Auth lives on local server: /api/auth/login validates credentials (bcrypt hash stored in server config).
- Returns JWT (short-lived access token + longer refresh) OR opaque token stored in server memory/DB.
- Front-end stores token in localStorage (or secure cookie via JS). Not httpOnly, but acceptable for self-hosted personal use. Mitigate XSS via strict CSP.
- Grid challenge is second factor: After password, server returns challenge token, client shows grid, user clicks 8 squares, sends pattern hash, server validates.
- Session expiry configurable (default 24h).
- Brute-force: In-memory store of attempts per IP, lockout after 5 fails 15 min. Persist to JSON.
- All API endpoints check Authorization: Bearer token.
- Front-end has auth gate component that blocks render until authenticated.

**Security extras:**
- Rate limiting via express-rate-limit.
- Helmet for CSP, HSTS, etc.
- Input sanitization via validator, DOMPurify on front-end.
- CORS locked to configured origins.

### Local File Indexing, Metadata Extraction, Search

**Indexing:**
- Chokidar file watcher on configured media paths.
- On startup, recursive scan, stat files, filter by extension.
- SQLite via better-sqlite3 (fast, synchronous) or JSON file for simplicity (no native deps). Choose JSON + optional SQLite: Start with JSON for zero native deps, migrate to SQLite if needed. Use `lowdb` or custom.
- Store: id, path, filename, size, type (movie/music/video), title, year, genre, etc., duration, bitrate, codec, cover art path, addedAt, lastPlayed, playCount, rating, etc.
- Debounce file watcher events.

**Metadata:**
- Audio: `music-metadata` package (supports ID3, Vorbis, MP4, FLAC). Extracts title, artist, album, year, genre, track, cover art (buffer → save as jpg).
- Video: `ffprobe` via fluent-ffmpeg or exec. Extract duration, resolution, codec, bitrate. For movies/series, parse filename for title/year/season/episode via regex (e.g., `Movie.Name.2021.1080p` or `Series.S01E02`).
- Thumbnails: ffmpeg screenshot at 25% duration, save as jpg, use sharp to resize.
- Subtitles: Detect .srt/.vtt/.ass alongside video, index.

**Search:**
- Client-side search index built from server's /api/library (returns all metadata). Use Fuse.js for fuzzy matching (lightweight, fast, typo tolerant).
- Fields: title, artist, album, genre, year, tags, description, filename.
- Results categorized. Debounce 150ms.
- Recent searches in localStorage.

---

## 0.4 Design Research

### Minimalist Media UI Trends 2024-2025
- **Bento / card grid**: Rounded 12-20px corners, soft shadows, not sharp.
- **Large typography**: Title 32-48px bold, metadata 13-14px muted.
- **Sidebar collapsible**: Icon-only collapsed, 240px expanded, with active indicator pill.
- **Bottom mini-player**: Spotify established pattern, now universal.
- **Skeleton over spinner**: Content-aware skeletons (poster-shaped).
- **Command palette**: Raycast, Linear, Spotify have popularized ⌘K. Vault uses ⌥+Space for uniqueness and to avoid browser conflicts.
- **Micro-interactions**: 150-250ms ease-out, scale 1.02 on hover, not 1.1. Opacity + transform only (GPU).
- **Content over chrome**: UI chrome is minimal, content (posters, art) is hero.

### Frosted Glass / Glassmorphism
- Technique: `background: rgba(255,255,255,0.08); backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); border: 1px solid rgba(255,255,255,0.1);`
- Dark mode: light glass (white at low opacity). Light mode: dark glass (black at low opacity) or white glass with shadow.
- Performance: backdrop-filter is GPU heavy. Limit to modals, sidebars, mini-player, not entire page. Provide intensity slider that maps to blur(0px) to blur(40px) and opacity 0.02 to 0.3.
- Fallback: `@supports not (backdrop-filter: blur(1px)) { background: var(--bg-elevated); }`
- Layering: Use pseudo-element for glass to avoid affecting children.

### Film Grain / Noise Texture
- Techniques:
  1. **CSS + data URI**: Small base64 noise PNG (100x100) tiled, opacity 0.03-0.15, `pointer-events: none; position: fixed; inset: 0; z-index: 9999; mix-blend-mode: overlay;`
  2. **SVG filter**: `<filter id="noise"><feTurbulence baseFrequency="0.9" /></filter>` — heavier.
  3. **Canvas**: Animated grain — too heavy.
- Decision: PNG tile with CSS, static, opacity controlled by CSS variable `--grain-opacity`. Slider 0-100 maps to opacity 0-0.15. Optional subtle animation via `transform: translate` with steps.
- Must be toggleable, not distracting.

### Colour Palette System with Multiple Themes

**Approach:** CSS custom properties, 4 themes as `[data-theme="dark"]` etc.

**Shared scales:**
- --bg-primary, --bg-secondary, --bg-elevated, --bg-hover
- --text-primary, --text-secondary, --text-tertiary, --text-inverse
- --border, --border-strong
- --accent, --accent-hover, --accent-muted
- --success, --warning, --error
- --shadow, --shadow-strong
- --glass-bg, --glass-border, --glass-blur
- --grain-opacity

**Themes:**

1. **Dark**: bg #0A0A0A, #121212, #1A1A1A, text #FFFFFF 90%, #FFFFFF 60%, #FFFFFF 35%. Accent #E50914 (Netflix red) or #1DB954 (Spotify green) — choose custom #FF3B30? Decision: #7C5CFF purple for uniqueness, premium. Borders rgba(255,255,255,0.08).
2. **Light**: bg #FFFFFF, #F7F7F8, #EDEEF0, text #0A0A0A 90%, 60%, 40%. Accent #7C5CFF same. Borders rgba(0,0,0,0.08).
3. **Warm**: bg #FDF6E3 (cream), #F5E6C8, #E8D5B5, text #3D2B1F, muted #8C7A65. Accent #D97706 (amber-600) burnt orange. Borders rgba(61,43,31,0.1).
4. **Cold**: bg #F0F4F8, #E2E8F0, #CBD5E1, text #1E293B, muted #64748B. Accent #0E7490 (teal-700). Dark variant of cold could be slate-900: but spec says light cold. Actually make cold dark-ish? Let's make Cold: bg #0F172A (slate-900), #1E293B, #334155, text #F1F5F9. Accent #22D3EE (cyan-400). Feels Nordic winter night.

**Implementation:** All themes defined in `:root` and `[data-theme]` overrides. No hardcoded colors in components — always var().

### Typography Best Practices for Media Apps
- **Font family:** System font stack for performance + familiarity: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', 'Segoe UI', Roboto, sans-serif`. Optional: Include Inter via Google Fonts as fallback, but system is faster.
- **For display titles:** Use 600-700 weight, tight letter-spacing -0.02em, line-height 1.1.
- **For body:** 400 weight, 14-15px, line-height 1.5, letter-spacing 0.
- **For metadata:** 12-13px, 500 weight, uppercase 0.05em tracking, muted color.
- **Mono for technical info:** `ui-monospace, SFMono-Regular, Menlo, monospace` for bitrate, file path.
- **Scale:** Use rem, base 16px. Scale: 12, 13, 14, 16, 18, 20, 24, 32, 40, 48.
- **Line clamp:** Titles clamp 1-2 lines with ellipsis.

---

## 0.5 Research Synthesis

### Bullet-Point Insights Directly Influencing Vault

- Plex/Jellyfin prove self-hosted market exists but UX is not premium — opportunity for Apple-level polish.
- Persistent mini-player is non-negotiable for music; must survive route changes via global state.
- Command palette search (Option+Space) is differentiator — no competitor does it.
- 10-band parametric EQ via Web Audio API is unique selling point — must be real DSP, not fake sliders.
- Visual EQ curve + analyzer + presets = pro feel.
- Four emotional themes > binary dark/light — user expresses mood.
- Adjustable glassmorphism + grain gives user control over aesthetic intensity — personalization beyond colors.
- Upload with adaptive forms removes need for SMB/FTP — huge UX win for non-technical users.
- Grid challenge 4x4 8-click pattern is memorable second factor, better than TOTP for personal use (no phone needed).
- Brute-force protection + JWT + CORS locked to Pages origin = secure enough for personal.
- Transcoding strategy: direct play H.264/AAC, transcode others on fly via ffmpeg fragmented MP4 — balances compatibility and server load.
- Metadata: music-metadata for audio, ffprobe for video, sharp for thumbnails — all Node.js friendly.
- File watcher via chokidar for auto-index updates.
- Skeleton loading, not spinners — perceived performance.
- Keyboard shortcuts for everything, ? panel to discover.
- Crossfade + gapless via dual audio elements + Web Audio API.
- Theatre mode for video (wider player, dim surroundings) — YouTube pattern, loved.
- Skip intro/outro per series — store in JSON.
- Resume playback position for both video and audio.
- Collections that span media types — unique.
- Inline metadata editor — no external tool needed.
- Media info panel with technical specs — for nerds.
- Sorting/filtering in every library view — essential for large libraries.
- PWA with service worker for offline shell.
- Toast notifications for feedback.
- Drag-drop upload + batch + progress.
- Picture-in-picture + fullscreen + casting hooks.
- Subtitle styling customizable (font, size, color, bg, position) via ::cue.
- Visualizer in Now Playing (canvas + AnalyserNode).
- Scrobbling hooks (expose now playing).
- Lazy loading images via IntersectionObserver.
- Accessibility: full keyboard nav, ARIA, focus rings, AA contrast, rem units, prefers-reduced-motion.

### Final Feature List (Spec + Research Additions)

**Core (from brief):**
- Auth gate: username/password + 4x4 grid 8-click pattern, JWT, brute-force lockout, logout, CORS, rate limit, CSP, sanitization
- Local server: Node.js, scans dirs, categorizes Movies/Series/Music/Videos, index DB, file watcher, metadata extraction, uploads, REST API, transcoding
- Upload: choice Movie/Series/Music/Video, adaptive forms, drag-drop, progress, batch
- Video player: custom UI, play/pause/seek with thumbnail preview, volume, speed 0.25x-3x, fullscreen, PiP, subtitles SRT/VTT/ASS, styling, chapters, next episode autoplay countdown, skip intro/outro, quality selector, casting, keyboard shortcuts, resume, theatre mode
- Music player: mini-player persistent, full-screen Now Playing with art + visualizer + lyrics, play/pause/skip/seek, shuffle/repeat, queue reorder, playlists CRUD, volume, speed, crossfade, gapless, album/artist/genre/all views, shortcuts, scrobbling hooks
- EQ: 10-band parametric with freq/gain/Q, presets (Flat, Bass Boost, Treble Boost, Vocal, Acoustic, Electronic, Classical, Rock, Pop, Jazz, R&B, Custom), save custom, visual curve, bass boost/cut, stereo widening, normalization, compressor, reverb
- Codecs: audio MP3/AAC/FLAC/WAV/OGG/OPUS/ALAC/WMA/AIFF/M4A, video MP4/MKV/WebM/AVI/MOV/WMV/FLV, subtitles SRT/VTT/ASS, transcode fallback
- Search: Option+Space / Alt+Space, centered modal, all libraries, categorized, fuzzy, instant debounced, keyboard nav, recent, history clearable
- Themes: Dark, Light, Warm, Cold — comprehensive
- Frosted glass adjustable slider
- Grain adjustable slider
- Sidebar collapsible, Home dashboard (Continue Watching/Listening, Recently Added per category, Playlists, Random Pick, Rediscover), Grid/List toggle, Detail pages (movie backdrop+poster+meta, series season/episode, album track list, artist discography, video)
- Animations: page crossfade/slide, hover scale/shadow, skeleton, mini-player slide, modal fade+scale, respects prefers-reduced-motion
- Accessibility: keyboard nav, ARIA, focus, screen reader, AA contrast, rem
- Additional: favourites, history, ratings, collections, metadata editor, shortcuts panel ?, toasts, settings page (theme, glass, grain, EQ, playback prefs, library paths, session timeout, creds change, grid change, about), mini-player persists, media info panel, sorting/filtering, lazy loading, PWA, error handling

**Added from research:**
- Visualizer (canvas waveform/bars) in Now Playing
- Lyrics display (.lrc support)
- Waveform preview on audio seek
- Cross-media collections
- Smart rows: Random Pick, Rediscover, Recently Played, Top Rated, Most Played
- Batch metadata editing
- Keyboard: JKL for video (YouTube), 0-9 for seek percentage, M mute, F fullscreen, C captions, etc.
- Theatre mode toggle (T)
- Picture-in-picture toggle (P)
- Mini-player expand/collapse with gesture
- Queue: save as playlist
- Playlist: collaborative? No, personal only, but drag reorder
- Transcoding cache with LRU cleanup
- Thumbnail generation on server via ffmpeg
- Cover art extraction and caching via sharp
- File watcher debounced
- PWA install prompt
- Offline detection toast
- Connection lost overlay with retry
- Empty states with illustrations and CTA
- Long title handling (marquee on hover in mini-player)
- Scrobbling hooks: expose window.VAULT_NOW_PLAYING
- Service worker caching strategies: shell cache-first, API network-first
- Error boundaries per route
- Performance: virtualized lists for large libraries (or pagination)
- Security: helmet, rate limit, sanitization, JWT, bcrypt
- Config: config.js for API base URL, not hardcoded
- README: mkcert + Cloudflare Tunnel for HTTPS

---

## References & Inspiration

- Plex architecture docs, Jellyfin API docs, Navidrome Subsonic API
- Web Audio API MDN, BiquadFilterNode, DynamicsCompressorNode, ConvolverNode
- CSS backdrop-filter MDN, glassmorphism tutorials
- Fuse.js docs for fuzzy search
- chokidar, music-metadata, fluent-ffmpeg, better-sqlite3, sharp
- Apple HIG, Material You, Linear app design, Raycast command palette
- WCAG 2.1 AA, ARIA practices, keyboard nav patterns

---

*This research was conducted pre-code to ensure Vault is not just another media server, but a premium product that learns from best and worst of industry.*
