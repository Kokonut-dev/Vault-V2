# Vault UI Revamp — "Hearth"

> **Brief (user):** *"UI feels and looks soulless. No character, no presence. Doesn't look cozy, looks worn. Animations, typography and even a new logo would make stuff much better. However, I believe that using research would be a better idea."*
>
> **Hard requirement:** WCAG 2.2 **AA** minimum everywhere. The repo's own gate (`scripts/contrast-check.js`) already enforces **AAA 7:1** for theme text tokens; that gate must keep passing.

This document is the plan *and* the record of execution. It follows the requested order:

1. [Current UI issues](#1-current-ui-issues) (with a measured baseline)
2. [Peer research](#2-peer-research) — competitors, what they get wrong, what applies to Vault
3. [UI/UX research](#3-uiux-research) — principles, typography, contrast, motion, trends, logo
4. [Compare & contrast](#4-compare--contrast-with-the-current-ui)
5. [Consolidated improvement list](#5-consolidated-improvement-list--execution-methods) with execution methods
6. [Execution log & results](#6-execution-log--results)

---

## 0. Method

| Step | How |
|---|---|
| Real app, real data | Ran the actual server (`server/index.js`) against a fixture library (6 movies with poster + backdrop, a 3-episode series, 4 albums, 2 videos) and drove it with headless Chromium. |
| Screenshots | Every route × all 6 themes, desktop 1440×900 and mobile 390×844, **before** and **after** (`design/screenshots/`). |
| axe-core 4.10 | WCAG 2.0/2.1/2.2 A + AA rule tags, auth screen + `/`, `/movies`, `/music`, `/settings`, all 6 themes. |
| Pixel-true contrast | axe cannot measure text on images, gradients or blur. A custom harness freezes animation, turns grain off, records each text node's colour, re-renders with all text transparent, screenshots the real backdrop, and takes the **10th-percentile** contrast ratio of the pixels behind every text box (4.5:1, or 3:1 for large text). |
| Token gate | `node scripts/contrast-check.js` (AAA 7:1, 48 checks). |
| Research | 16 targeted searches across user forums (r/PleX, r/selfhosted, r/jellyfin, r/plexamp, Hacker News), product reviews (XDA, piunikaweb, MacStories), and UX references (Material, WCAG 2.2 Understanding docs, APCA, Nielsen Norman, Infinum). |

---

## 1. Current UI issues

### 1.1 Measured baseline

| Audit | Result (before) |
|---|---|
| axe-core violations | **306 nodes** over 30 page × theme combinations (same 5 rule failures in every theme) |
| Pixel contrast | **43 of 1 372** text boxes below AA |
| Token gate (`contrast-check.js`) | 48/48 pass (tokens are fine; *usage* is where it breaks) |

axe failures (identical across themes):

| Rule | Where | Cause |
|---|---|---|
| `label` (critical) | every route | `#now-playing-slider` has no accessible name |
| `nested-interactive` (serious) | home 13, movies 9, music 12 | media card is `role="button"` *and* contains a `<button>` |
| `select-name` (critical) | /movies, /music | `#sort-select` has no label |
| `label` ×6 (critical) | /settings | glass, grain, volume, crossfade sliders, API URL, remote URL |
| `scrollable-region-focusable` | everywhere | `.modal-body` scrolls but cannot be focused by keyboard |

Pixel-contrast failures:

| Element | Themes | Worst ratio | Needed |
|---|---|---|---|
| Hero title on backdrop | light, warm, white | **1.02** | 3.0 |
| Hero "Details" / "My list" buttons | light, warm, white | 1.12 | 4.5 |
| Settings theme chips (each chip renders in *its own* theme's tokens) | all | 1.00 | 4.5 |
| Sidebar "V" logo text | dark, warm, cold, midnight | 1.56 | 4.5 |
| Card duration / title / meta over artwork | dark | 2.65 | 4.5 |

### 1.2 Visual and experience issues (from screenshots and code review)

| # | Issue | Why it matters to the brief |
|---|---|---|
| I-1 | **No identity.** The logo is a letter "V" in a purple gradient square. There is no display typeface (`--font-display: var(--font-sans)` = the OS system stack), so Vault looks like every admin template. | "No character, no presence." |
| I-2 | **Cool SaaS palette.** Violet `#7C5CFF` on blue-black `#08080B`, plus a purple/cyan/pink "aurora". These are the defaults of 2021–23 dev-tool marketing pages. | "Doesn't look cozy." |
| I-3 | **Worn materials.** Every surface is translucent glass with a hairline border, a top sheen and a deep shadow, layered over an animated grain overlay. When everything is "special", nothing is, and the borders read as tired. | "Looks worn." |
| I-4 | **Movies show test-pattern frames, not posters.** `mediaCard.js` prefers the ffmpeg `thumbnailPath` frame over `posterPath`, and the cards are 16:9. The one thing that gives a media library soul — the artwork — is missing. | Soulless |
| I-5 | Home "Recently Added" mixes 1:1, 16:9 and 2:3 cards in one grid, leaving ragged gaps. | Feels unfinished |
| I-6 | The hero uses theme text colours over a darkened image, so it is unreadable in light themes (1.02:1). | WCAG 1.4.3 fail |
| I-7 | Settings theme chips carry `data-theme="light"` etc. That attribute *re-scopes all theme tokens* onto the chip, producing labels at 1.0:1. | WCAG 1.4.3 fail |
| I-8 | Light themes: the search field, filter chips and segmented controls have ≈1.2:1 boundaries. | WCAG 1.4.11 fail |
| I-9 | Redundancy: "Home" appears in both the breadcrumb and the H1 on every page; the sidebar has two collapse controls (header chevron + footer toggle). | Clutter |
| I-10 | Mobile: the bottom nav can cover the focused element (WCAG 2.2 **2.4.11 Focus Not Obscured**), the hero button row wraps awkwardly, and the topbar search pill is an empty capsule. | AA fail + polish |
| I-11 | Typography is flat: 700 weight is used for brand, H1, H2, card titles, settings headings and buttons alike, so nothing leads. | No hierarchy |
| I-12 | Motion is generic: one `pageEnter` fade and a card scale that moves the whole card, including its text. There is no motion vocabulary (tokens exist but are applied inconsistently), and the grain layer animates constantly. | Presence vs. noise |
| I-13 | Auth screen inline CSS hard-codes reds and ambers; white text on the light error colour fails contrast. | Consistency, a11y |
| I-14 | Console noise on load (`ERR_INVALID_URL`, "Store listener error", a 404). | Quality signal |

---

## 2. Peer research

Six products were studied because they are what Vault users compare against: **Plex** (new 2024–25 experience), **Jellyfin**, **Emby**, **Plexamp**, **Infuse**, and the **Navidrome clients** (Feishin, Symfonium).

### 2.1 What each one does

| Product | Praised for | Criticised for | Source themes |
|---|---|---|---|
| **Plex (New Experience)** | Polish, consistent artwork, a "premium" feel | Personal library buried under promoted/streaming content; more clicks to reach your own media; playlists hidden; **unlabeled icon-only buttons**; image-heavy pages that load slowly; continue-watching split per library; theme music autoplay; grainy upscaled posters | Plex forum backlash threads, piunikaweb coverage 2025–26, r/PleX |
| **Jellyfin** | Free, private, flexible | "Clunky / unfinished"; slow tile loading with visible placeholder flicker; a home page with little actionable browsing; deep nested settings; "no single front-end vision" (many clients, each different) | HN thread Feb 2025, r/selfhosted, r/jellyfin |
| **Emby** | Faster and more cohesive than Jellyfin | Dated, dense, "corporate" look; feature gating | r/selfhosted comparisons |
| **Plexamp** | **Huge hi-res artwork** on now-playing, an uncluttered home, artwork-driven ambient colour, mixes and radios; considered "gorgeous" | Settings density | r/plexamp |
| **Infuse** | **Poster wall** with excellent metadata artwork; elegant, poster-first library; native feel | Posters can crowd out information; limited customisation | XDA review 2026, App Store reviews |
| **Feishin / Symfonium** | Streaming-style home with a featured carousel, many themes, snappy | Theme sprawl; some layouts feel cloned from Spotify | r/navidrome, r/selfhosted |

### 2.2 What they get wrong, and the lesson for Vault

| Pitfall seen in peers | Lesson for Vault |
|---|---|
| Plex promotes *their* content over *yours* | Vault's home stays 100% personal: continue → next up → recently added. No upsell surfaces. |
| Plex icon-only buttons with no labels | Keep **visible labels** on primary actions (Play / Details / My list); icon-only controls keep `aria-label` + tooltip. |
| Plex and Jellyfin slow image-heavy pages and placeholder flicker | Poster-first, but with fixed aspect-ratio boxes (no layout shift), a warm tonal placeholder instead of a grey shimmer flash, and a **fade-in on load only** (no skeleton → image pop). |
| Jellyfin's "many visions" | One design language with one display face, one accent family and one motion vocabulary, applied everywhere. |
| Infuse posters crowding out information | Titles stay *under* the artwork on a solid surface, never on top of it. |
| Feishin theme sprawl | Keep the existing six themes (users have them saved), but make all six belong to one family instead of six unrelated looks. |
| Plex theme music autoplay | Presence comes from type, colour and art, never from unsolicited sound or motion. |

### 2.3 What applies directly

1. **Artwork is the soul** (Plexamp, Infuse): use the 2:3 poster for films and series, square art for albums, and a backdrop for the hero.
2. **Quiet chrome** (Plexamp): the sidebar and header should recede into calm tonal surfaces. Glass is reserved for elements floating over content (player dock, modals).
3. **Library first** (anti-Plex): no navigation changes that add clicks.
4. **Speed is a feature** (anti-Jellyfin): fonts are self-hosted, subset and preloaded (~141 KB, cached by the service worker); no new JS dependencies.

---

## 3. UI/UX research

### 3.1 Why it feels "soulless": emotional design

Don Norman's three levels of emotional design — **visceral** (immediate look and feel), **behavioural** (use), **reflective** (meaning and identity) — map neatly onto the brief. Vault's *behaviour* is rich (EQ, SyncPlay, DVR, offline mode…), but the *visceral* layer is generic and the *reflective* layer (a brand you would recognise) is absent. The **aesthetic-usability effect** (NN/g) also says users perceive attractive products as easier to use and are more forgiving of their flaws. The revamp therefore targets the visceral and reflective levels without touching working behaviour.

### 3.2 Colour

| Finding | Source | Decision |
|---|---|---|
| Avoid pure black in dark UIs (halation, smearing on OLED); use ≈#121212–#1E1E1E with a slight tint | Material dark theme guidance, UXPin | Base `#15110E` — a warm, tinted near-black ("hearth" rather than "void") |
| Express elevation with *lighter surfaces*, not shadows or white borders | Material | Tonal steps: base → raised `#221C18` → overlay `#2C2520`; borders become optional and quiet |
| Desaturate accents 10–30% in dark mode; saturated hues vibrate | Material, UXPin | Accent: soft ember `#F2A877` (desaturated orange) instead of neon violet |
| Off-white text instead of #FFF | Material | Cream `#F6EEE4` primary text |
| 2025–26 trend: a **return of warmth** — creams, earth tones and *subtle* tactile texture — as a reaction to sterile SaaS | Trend round-ups (Figma/Creative Bloq-style 2026 forecasts) | Warm-neutral system; grain kept but static and faint by default |
| APCA: WCAG 2 over-states contrast for light-on-dark pairs; thin weights at small sizes on dark backgrounds read poorly | APCA / Myndex | Body text ≥ 400 weight, secondary text ≥ 8:1 under WCAG 2 (≈ Lc 75+), no weight < 400 under 16px |

### 3.3 Accessibility (WCAG 2.2)

| SC | Requirement | How Vault will meet it |
|---|---|---|
| 1.4.3 Contrast (AA) | 4.5:1 text, 3:1 large text | All theme text tokens are ≥ 7:1 (AAA gate). Text never sits directly on artwork; the hero uses a fixed dark scrim with fixed light text in every theme. |
| 1.4.11 Non-text contrast (AA) | 3:1 for control boundaries, icons, focus indicators | New `--border-control` token, ≥ 3:1 against both base and raised surfaces, used on inputs, chips and segmented controls. |
| 2.4.7 / 2.4.13 Focus | Visible focus; AAA recommends ≥ 2px solid at 3:1 | 2px solid `--focus-ring` (accent family) with 2px offset everywhere. |
| 2.4.11 Focus Not Obscured (AA, new in 2.2) | Sticky headers and bottom nav must not hide focus | `scroll-padding-top/bottom` on the scroller equal to the header and bottom-nav heights. |
| 2.3.3 / `prefers-reduced-motion` | Motion must be optional | All new motion is behind `@media (prefers-reduced-motion: no-preference)` or is disabled by the existing reduce block. |
| 4.1.2 Name, role, value | Every control named; no nested interactive roles | Labels added to the 8 unnamed controls; card restructured (see §5 C-11). |
| Reduced transparency | Liquid Glass critiques measured text on blur at **1.5:1** (Infinum, MacStories 2025) | No body text on blur; `prefers-reduced-transparency` turns all glass solid. |

### 3.4 Typography

| Finding | Decision |
|---|---|
| Expressive type is *the* single most effective personality lever in 2025–26, as long as only **one** face is expressive and the other is quiet | **Fraunces** (display) + **Figtree** (UI/body) |
| Fraunces is a variable "soft serif" (wght 100–900, opsz 9–144, **SOFT** 0–100, WONK 0–1) inspired by 1920s–30s Windsor-style old-style faces. Its SOFT axis rounds the terminals — literally a "cozy" serif. OFL licensed. | Display headings and the wordmark at `opsz` auto, `SOFT 50–100`, weight 560–640 |
| Figtree (Erik Kennedy) is a friendly geometric sans with open apertures, high x-height and a double-storey g; "warmth without losing neutrality". Variable 300–900, OFL. | All UI and body text, weights 400 / 500 / 650 |
| Hierarchy: use ~3 weights; never the same weight on adjacent levels; keep bold under ~20% of a screen | Body 400, labels/meta 500, emphasis 650; headings get their weight from the serif, not from 700 |
| Self-host for privacy and speed; subset to Latin; `font-display: swap`; preload | `docs/fonts/*.woff2` (Latin + Latin-Ext), preloaded, cached by the service worker. CSP already allows `font-src 'self'`. |
| Tracking: tighten display sizes slightly, loosen small caps / overlines | `letter-spacing: -0.015em` on display, `+0.08em` on overlines |
| Numerals: tabular figures for times and durations | `font-variant-numeric: tabular-nums` on durations, timers and stats |

### 3.5 Motion

| Finding (NN/g, Material motion, Apple HIG) | Token / rule |
|---|---|
| Micro-interactions 100–150ms | `--dur-1: 140ms` |
| Show/hide 200–300ms | `--dur-2: 240ms` |
| Screen transitions 300–400ms | `--dur-3: 360ms` |
| Ease-out for entering, ease-in for leaving; never linear | `--ease-enter: cubic-bezier(0.16, 1, 0.3, 1)`, `--ease-exit: cubic-bezier(0.4, 0, 1, 1)`, `--ease-standard: cubic-bezier(0.2, 0, 0, 1)` |
| Stagger 20–60ms, total under ~1s | Grid stagger 30ms, capped at 12 items (≈ 360ms) |
| Animate only `transform` and `opacity` | Hover lifts the *artwork*, not the whole card (text stays still, so it doesn't blur) |
| Always honour `prefers-reduced-motion` | Existing global reduce block plus new rules gated on `no-preference` |
| Constant ambient motion is noise | The grain `grainShift` animation is removed (static grain) |

### 3.6 Logo

Principles: simple, one idea, recognisable at 16px, works in one colour on both dark and light, metaphor rather than literal, and designed small-first.

**Concept — "the arch":** an arched doorway, which reads as *a vault door*, *a home* and *a hearth opening*, with a play triangle cut out of it. One idea (*your media, at home*), two shapes. At 16px it degrades to "arch with a notch", which is still distinctive, unlike a letter V. Rendered in-app with `currentColor` and theme tokens, so it is correct in every theme.

### 3.7 What works and what doesn't (synthesis)

| Works | Doesn't |
|---|---|
| One expressive element (type) over a calm system | Everything glowing, blurred and bordered at once |
| Warm, tinted neutrals with a single desaturated accent | Saturated neon on near-black |
| Artwork-led layouts with text on solid ground | Text on blur or busy imagery |
| Short, purposeful, ease-out motion | Perpetual ambient animation and bouncy springs on everything |
| Visible labels on primary actions | Icon-only mystery meat |
| Fixed aspect ratios per media type | Mixed ratios in one grid |

---

## 4. Compare & contrast with the current UI

| Dimension | Current Vault | Research / peers say | Gap → Action |
|---|---|---|---|
| Identity | Letter "V", system font | One recognisable mark plus one expressive face | New arch mark, Fraunces wordmark |
| Base colour | `#08080B` blue-black | Tinted near-black, warm for cozy | `#15110E` hearth |
| Accent | Neon violet `#7C5CFF` | Desaturated, warm, single accent | Ember `#F2A877` (dark) / terracotta `#8A3614` (light) |
| Atmosphere | Purple/cyan/pink aurora, animated grain | Subtle tactile warmth | One soft lamp-glow gradient, static faint grain |
| Materials | Glass on every surface | Glass only where things float; elevation by tone | Sidebar and header become tonal; glass stays for dock, modals, menus |
| Artwork | ffmpeg frames, 16:9 for films | Poster-first (Infuse/Plexamp) | 2:3 posters for movies/series; per-type rows |
| Hero | Unreadable in light themes | Text on solid scrim | Fixed dark scrim + fixed light text in all themes |
| Type hierarchy | 700 everywhere | 3 weights, serif display | Fraunces headings; Figtree 400/500/650 |
| Motion | Generic fades, whole-card scale | Tokenised, ease-out, transform/opacity only | Motion tokens; art-only lift; page enter; stagger cap |
| A11y | 306 axe nodes, 43 contrast fails | AA minimum | Zero of both is the target |
| Controls in light themes | ≈1.2:1 boundaries | 1.4.11 needs 3:1 | `--border-control` token |
| Navigation | Duplicated H1/breadcrumb, two collapse buttons | Short, labelled sidebar | Breadcrumb hidden at root; single collapse control |

---

## 5. Consolidated improvement list & execution methods

Priority: **P0** = accessibility or broken, **P1** = the brief (soul, coziness, identity), **P2** = polish.

| ID | Pri | Improvement | Execution method (files) | Acceptance |
|---|---|---|---|---|
| **C-1** | P1 | **"Hearth" palette** across all six themes. Same theme IDs (saved prefs keep working), new display names: Hearth (dark, default), Linen (light), Parchment (warm), Dusk (cold), Ember (midnight, OLED), Daylight (white). | Rewrite theme blocks in `css/variables.css`. Every pair was computed before writing (see §6.2). | `contrast-check.js` 48/48 AAA |
| **C-2** | P1 | **Typography system**: Fraunces display + Figtree UI, 3-weight scale, display tracking, tabular numerals. | `docs/fonts/*.woff2` (Latin + Latin-Ext subsets); `docs/css/fonts.css` holds `@font-face` (the bundle forbids it) linked and preloaded in `index.html`; `--font-display`, `--font-sans`, `--fw-*`, `--text-*` tokens; heading rules in `v3.css` (last in cascade). | Fonts load from `self`; headings render in Fraunces; no 700 on body UI |
| **C-3** | P1 | **New logo** — the arch mark — plus the Fraunces wordmark. | `favicon.svg`; inline SVG in auth screen (`index.html`) and sidebar (`sidebar.js`) using `currentColor` + tokens; `manifest.json` colours; `theme-color` meta. | Legible at 16px; ≥3:1 non-text contrast in all themes |
| **C-4** | P1 | **Calmer materials**: sidebar and header become tonal surfaces; glass is reserved for floating layers; grain is static and fainter by default; the ambient aurora becomes one warm lamp glow. | `themes.css` (ambient), `layout.css`/`v3.css` (surfaces), `grain.css` (drop `grainShift` animation, keep marker keyframes), `store.js` defaults (glass 20→12, grain 15→8). | No text on blur in sidebar/header; screenshots read calm |
| **C-5** | P1 | **Poster-first artwork**: movies/series use the poster endpoint at 2:3; music 1:1; videos 16:9. | `mediaCard.js` (prefer `posterPath`/`coverArtPath` → cover endpoint; thumbnail only as fallback), `data-art` attribute → aspect ratio in CSS. | Fixture films show posters, not test patterns |
| **C-6** | P1 | **Hero rebuilt**: backdrop with a fixed warm-dark scrim; fixed cream text and dedicated hero buttons that don't depend on theme tokens; Fraunces title. | `home.js` (use backdrop endpoint, overline, button classes), `v3.css` hero rules. | ≥4.5:1 in all 6 themes (pixel audit) |
| **C-7** | P1 | **Motion vocabulary**: duration/easing tokens, art-only hover lift, page-enter, capped stagger, press feedback, no perpetual animation. | `variables.css` tokens, `animations.css`, `components.css` card rules; all gated by reduced motion. | No layout-affecting animation; reduce-motion respected |
| **C-8** | P0 | **Theme chips readable**: replace `data-theme` on buttons with `data-theme-option`, labelled names and a small swatch. | `settings.js` + CSS. | Pixel audit: 0 fails on /settings |
| **C-9** | P0 | **Control boundaries 3:1** in all themes. | `--border-control` token; applied to `.form-input`, `.form-select`, `.btn-secondary`, `.filter-chips .btn`, `.view-toggle`, `.search-trigger`. | Computed ≥3:1 vs base and raised |
| **C-10** | P0 | **Label every control**: now-playing slider, sort select, 4 settings sliders, API URL, remote URL. | `index.html`, `movies.js`, `music.js`, `settings.js`, `settingsExtras.js` (`<label for>` or `aria-label`). | axe `label`/`select-name` = 0 |
| **C-11** | P0 | **No nested interactive cards**: the card changes from `role="button"` to `role="group"` (still `tabindex=0`, Enter/Space still open details, grid arrow-nav unchanged) and keeps its real `<button>` for play. | `mediaCard.js`; update the one assertion in `scripts/music-view-check.js` that pinned the old role. | axe `nested-interactive` = 0; keyboard-check 25/25 |
| **C-12** | P0 | **Keyboard-scrollable modal body**. | `tabindex="0"` + `role="region"` + label on `.modal-body` where it is created. | axe `scrollable-region-focusable` = 0 |
| **C-13** | P0 | **Focus never obscured, and a consistent focus ring** (2.4.11 / 2.4.13). | `scroll-padding` on `html`; 2px `--focus-ring` with 2px offset in `accessibility.css`. | Manual tab-through on mobile |
| **C-14** | P0 | **Text over artwork**: duration and quality badges sit on solid chips; titles and meta always below the art. | `components.css`. | Pixel audit: 0 fails on cards |
| **C-15** | P2 | **De-duplicate chrome**: hide the breadcrumb on root pages (where it duplicates the H1); remove the duplicate sidebar collapse button. | `index.html` breadcrumb script, `sidebar.js`/CSS. | Single collapse control |
| **C-16** | P2 | **Auth screen on tokens**: logo, Fraunces title, token-based error/warning colours. | Inline `<style>` in `index.html`. | Pixel audit: 0 fails on auth |
| **C-17** | P2 | **Service worker**: cache fonts + `fonts.css`; bump the cache name so clients pick up the new shell. | `sw.js` `CACHE_NAME = 'vault-v2-shell-v5'`. | Offline load keeps fonts |
| **C-18** | P2 | **Console hygiene**: find and fix the `ERR_INVALID_URL`, store listener error and 404 seen on load. | Investigate during execution. | Clean console on load |
| **C-19** | P2 | **Empty states and placeholders** in the warm tone (tonal shimmer, serif title). | `components.css`. | Visual |

### Guard-rails during execution

- Edit only source sheets in `docs/css/*.css`; regenerate `vault.css` with `node scripts/build-css.js` (CI fails on a stale bundle).
- Preserve every build marker (`box-sizing`, `--font-sans:`, `no-theme-transition`, `glass-island`, `grainShift`, `detail-layout`, `skeletonShimmer`, `countdownSpin`, `search-modal-backdrop`, `eq-panel`, `pageEnter`, `skip-link`, `queue-panel`).
- No `@font-face` in the bundle.
- Run `syntax-check`, `import-check`, `contrast-check`, `keyboard-check`, `music-view-check` and `server npm test` after the changes.

---

## 6. Execution log & results

### 6.1 Key results

| Metric | Before | After |
|---|---|---|
| axe-core violating nodes (30 page × theme combos, WCAG 2.2 A + AA) | **306** | **0** |
| Pixel-true contrast: text boxes below AA | **43** / 1 372 | **0** / 1 224 |
| Pixel contrast: minimum ratio | 1.00 | **6.34** |
| Pixel contrast: median ratio | 9.16 | 11.47 |
| Pixel contrast: boxes below 7:1 (AAA) | 171 | 41 |
| Token gate `contrast-check.js` (AAA 7:1) | 48/48 | 48/48 |
| Control boundaries (WCAG 1.4.11) in light themes | ≈1.2:1 | 3.06 – 4.01:1 |
| Console errors on load | 3 | 0 |
| `keyboard-check` / `music-view-check` | 25/25 · 17/17 | 25/25 · 17/17 |
| Server tests | 60/60 | 60/60 |
| CSS bundle (gzip) | 22.0 KB | 21.6 KB (+ fonts.css; ~141 KB of Latin woff2 preloaded and cached by the SW) |

**WCAG AA met everywhere we measured.** Every text box clears 4.5:1 *after* compositing over real artwork, gradients and blur, so the true minimum is 6.34:1.

Screenshots: `design/screenshots/` (`before-*.jpg` / `after-*.jpg`; desktop 1440×900 and mobile 390×844).

### 6.2 Final palettes (variables.css)

Each value set reads: bg · raised · overlay · text-primary · text-secondary · text-tertiary · accent-text · accent-solid · on-accent · border-control.

| Theme (id) | Values |
|---|---|
| **Hearth** (`dark`, default) | #15110E · #221C18 · #332B25 · #F6EEE4 · #D9CCBD · #B6A796 · #F5B184 · #F2A877 · #1C0F07 · #7A6A5C |
| **Linen** (`light`) | #F5EFE6 · #FFFBF5 · #FFFBF5 · #211A15 · #3D332C · #51463D · #873413 · #8F3815 · #FFF · #8C7B6C |
| **Parchment** (`warm`) | #F3E6CF · #FCF5E8 · #FCF5E8 · #33231A · #46342A · #54412F · #7A3209 · #7E340B · #FFF · #8E7556 |
| **Dusk** (`cold`) | #10151C · #1A222D · #283342 · #EAF0F5 · #C3CED9 · #A2B0BE · #8FD3C9 · #8FD3C9 · #0B1A18 · #5D6E80 |
| **Ember** (`midnight`) | #0B0908 · #171310 · #28221D · #F3EBDF · #D1C4B4 · #AA9C8B · #EFC77A · #EFC77A · #1A1204 · #6E6253 |
| **Daylight** (`white`) | #FFFFFF · #FFFFFF · #FFFFFF · #1A1714 · #3A3530 · #544D46 · #1F4AA8 · #1F4AA8 · #FFF · #8A847D |

Status colours are defined in OKLCH per theme family. Dark themes use light status colours with dark text (`--text-inverse`) on top. All status/text pairs are ≥7:1.

### 6.3 What was done, per item

| ID | Status | Notes |
|---|---|---|
| C-1 | ✅ | Six palettes above; theme IDs unchanged so saved preferences keep working. |
| C-2 | ✅ | Fraunces (display, opsz/SOFT axes) + Figtree (UI), self-hosted woff2 with Latin + Latin-Ext subsets and OFL licences; `--fw-*` roles; h1/h2 display, h3/h4 strong. |
| C-3 | ✅ | Arch mark (a doorway/vault arch with a play notch), in `favicon.svg`, `icon-maskable.svg`, `utils/brand.js` (sidebar) and the auth screen. Legible at 16px. |
| C-4 | ✅ | Tonal sidebar, header and settings cards. Header is transparent until scroll (`body.is-scrolled`), then near-opaque. Single warm ambient glow. Grain static (SVG turbulence) and fainter by default (8); glass 12. |
| C-5 | ✅ | Poster-first cards (`data-art` = poster / square / wide). The home "Recently Added → All" view is split into shelves by artwork shape (Films & Series / Music / Books & Podcasts / Videos), so ragged mixed grids are gone (I-5). |
| C-6 | ✅ | Hero: fixed warm-dark scrim, cream text and dedicated hero buttons in every theme. The seed prefers continue-watching, then a film with a backdrop. The "kind" label uses season/episode, not `seriesKey` (which every film carries). "My list" now shows `aria-pressed`, an "On my list" state and a toast. |
| C-7 | ✅ | `--dur-*` / `--ease-*` / `--stagger` tokens; 30ms capped stagger (<1s total); hero curtain-up; art-only hover lift; everything collapses under `prefers-reduced-motion`. |
| C-8 | ✅ | Theme picker uses `data-theme-option` with names + swatches (settings and onboarding). |
| C-9 | ✅ | `--border-control` applied to inputs, selects, secondary buttons, chips, view toggle, search trigger and slider tracks. |
| C-10 | ✅ | Seek slider, sort selects (sr-only labels), settings sliders, API/remote URL. |
| C-11 | ✅ | Cards are `role="group"` (still focusable, Enter/Space opens) in mediaCard, music album cards, mediaList rows and artist rows. |
| C-12 | ✅ | `.modal-body` keyboard-scrollable. |
| C-13 | ✅ | `scroll-padding` for sticky header and bottom nav; 2px focus ring at ≥3:1 with offset. |
| C-14 | ✅ | Duration and quality badges on solid chips; titles and meta below the art. Pixel audit: 0 card failures. |
| C-15 | ✅ | Breadcrumb hidden on root pages; header collapse chevron removed (footer toggle is the single control); dead `.sidebar-collapse-btn` CSS deleted. |
| C-16 | ✅ | Auth screen on tokens, arch logo, Fraunces title; footer text raised to text-secondary. |
| C-17 | ✅ | SW `vault-v2-shell-v5` precaches `fonts.css` + the two Latin woff2 files (`service-worker.test.js` updated). |
| C-18 | ✅ | (1) The grain's broken base64 PNG (`ERR_INVALID_URL`) was replaced with an SVG noise. (2) Infinite "Store listener error" recursion fixed: the glass/grain setters are now idempotent. (3) A music thumbnail 404 fixed with a `pickArtUrl()` helper that uses the cover endpoint for audio. |
| C-19 | ✅ | Empty states: tonal icon disc in the accent colour and a Fraunces title. Skeletons: tonal shimmer on the raised surface. |

Also fixed along the way: the mobile top-bar search trigger now shows its icon instead of an empty capsule (I-10), and the header no longer carries the glass blur while transparent.

### 6.4 Known leftovers (not blocking)

- A few legacy `rgba(var(--glass-tint), …)` fills remain in the sidebar footer and some deep components; they pass contrast but could move to tonal tokens.
- Some `font-weight: 700` remains in `eq.css`, `player.css` and `v3.css` (player/EQ chrome); a candidate for `--fw-strong`.
- `themes.css` still carries per-theme `.btn-primary` gradient overrides that could fold into tokens.
- Contrast is AA everywhere; 41 text boxes (mostly small meta text over artwork-adjacent surfaces) sit between 6.3 and 7:1, so they are not AAA.

### 6.5 How it was verified

- `node scripts/build-css.js` (bundle regenerated), then `syntax-check`, `import-check`, `contrast-check`, `keyboard-check` and `music-view-check`, plus `cd server && npm test`. All pass.
- axe-core 4.10 and the pixel-contrast harness (§0) over the auth screen, `/`, `/movies`, `/music` and `/settings` in all 6 themes.
- Visual review of all 30 desktop shots and the mobile shots.
