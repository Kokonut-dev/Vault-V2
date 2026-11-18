# Vault — Settings Revamp Plan (+ link sources & page transitions)

Scope: the **Settings page** (`docs/js/views/settings.js`, `settingsExtras.js`), the
**URL/"link insert" features** the server already supports but the UI never exposed
(M3U channel playlists, XMLTV guides, playlist import from a link, notification
webhooks), and **page-transition motion** for the whole SPA.

Same process as `UI_REVAMP_PLAN.md`: §1 issues → §2 peer research → §3 UX research →
§4 comparison → §5 consolidated list with execution method → §6 results.
WCAG 2.2 AA is the floor; the repo's AAA token gate (`scripts/contrast-check.js`) stays green.

---

## §1 — Current issues (audited 2026-11-18, before any change)

Measured with headless Chromium + axe-core 4 on `/settings` (Hearth dark & Linen light, 1440 px & 390 px).
Before screenshots: `design/screenshots/settings-before-*.jpg`.

| # | Issue | Evidence |
|---|---|---|
| S-1 | **One 4,007 px column of 10 equal cards, no grouping or navigation.** Desktop is 4,007 px tall and mobile is 4,527 px. The only way to find anything is to scroll. | Page-height metric |
| S-2 | **Related things are split apart.** Playback and *Playback Quality* are separate cards five cards apart. The same goes for *Security* and *Two-factor*, and for *Server* and *Remote access*. *About* sits in the middle of the page. | Card order (cards appended by `settingsExtras.js` after the base five) |
| S-3 | **There's no scope.** Browser-only preferences (theme, volume) sit next to server-wide ones (scan library), with nothing saying which is which. | — |
| S-4 | **The Live TV page links to "Settings → Live TV", which doesn't exist.** The server has `livetv.{enabled,m3uUrl,epgUrl,hdhrDiscover}` and `PUT /api/livetv/settings`, but there is zero UI, so Live TV can't be configured without hand-editing `config.json`. | `views/livetv.js:45`, `grep m3uUrl docs/js` → 0 hits |
| S-5 | **Other link-based features are hidden too.** Notification targets (webhook, ntfy, Discord, Telegram) are only reachable through `config.json`. Playlist import accepts a *file* but not a link. | `grep webhookUrl docs/js` → 0 hits |
| S-6 | **Credentials form uses placeholders as labels.** 4 inputs have no accessible name (`current-pass`, `new-user`, `new-pass`, `new-grid`), which fails WCAG 1.3.1, 3.3.2 and 4.1.2. | Label audit |
| S-7 | **The grid pattern is typed as "8 numbers 0–15 comma-separated"**, which is hostile for a pattern you *tap* at login. | `settings.js` |
| S-8 | **The "Gapless Playback" checkbox does nothing.** It has no listener, and nothing reads `vault_gapless`. | `grep gapless` |
| S-9 | **Every visit to Settings mints a pairing token**, renders a 220 px QR code and polls every 4 s, whether or not you want to pair. The QR then dominates the page, and on mobile the 6-digit code wraps onto two lines. | `qrPair.js:renderPairingPanel`, screenshot |
| S-10 | **Save behaviour is inconsistent.** Sliders apply instantly with no feedback, API URL needs *Save*, credentials need *Update*, and toggles are plain checkboxes. | — |
| S-11 | **Server info is a raw JSON dump** (`{"status":"ok","uptime":86.80…}`) in monospace. | Screenshot |
| S-12 | **Ad-hoc modals.** The Equalizer opens a hand-built backdrop with no focus trap or Escape. TOTP uses `window.prompt()` twice. | `settings.js`, `settingsExtras.js` |
| S-13 | **Stale and off-brand content.** About lists "Themes: Dark, Light, Warm, Cold" (there are six, with new names). The subtitle "Accent tint" is the old violet `rgba(124,108,255)`. The page subtitle "Customize your Vault experience" is generic. US and UK spelling are mixed. | — |
| S-14 | **48 inline `style=""` attributes** bypass tokens, which is why spacing and type sizes drift (11 px help text, 12 px info box). | Metric |
| S-15 | **The text-colour `<input type=color>` renders as a full-width white bar** with no visible value. | Screenshot |
| S-16 | **axe: `heading-order`.** Cards use `h3` straight after the page `h1`. | axe |
| S-17 | **Duplicate Logout.** The sidebar has *Logout* and the Security card has another one. | Screenshot |
| S-18 | **Page transitions effectively don't exist.** `.page { animation: pageEnter }` only fires the first time, because every view sets the *same* class on the same `#view-container`. After that, navigation is a hard cut, and the old content blanks before the new view's data arrives. | `animations.css:8`, router |

---

## §2 — Peer research (settings & IPTV setup)

| Product | What works | What fails | Takeaway |
|---|---|---|---|
| **Jellyfin 10.11 / v12 web** | Dashboard → Live TV puts *Tuner devices* and *Guide data providers* on one page. An M3U tuner is "paste a URL", and XMLTV is a separate provider ([OttOcean](https://ottocean.in/jellyfin-iptv-integration/), [Grapevine](https://store.grapevine.is/blogs/news/jellyfin-live-tv-iptv-setup)) | v12 moved server settings into an unlabeled user menu, so users "were super confused… where are my settings gone". It also mixes personal and server settings ([GitHub #18019](https://github.com/orgs/jellyfin/discussions/18019)). Channels with no guide data are a common support issue ("map channels by hand") | Keep server config discoverable, and **separate "my preferences" from "server settings"**. Show whether guide IDs match channels. |
| **Plex "New Experience"** | Clean visuals | "Chief complaint… how many clicks/how buried the settings are" ([r/PleX](https://www.reddit.com/r/PleX/comments/1j4zl9z/how_we_feeling_about_the_new_ui/)). Users report settings spread across multiple menus and lost preferences ([r/PleX](https://www.reddit.com/r/PleX/comments/1x4gvct/dear_plex_consider_rolling_back_this_update/), [XDA](https://www.xda-developers.com/plexs-classic-app-is-better-than-its-modern-redesign-so-i-went-back/)) | Avoid deep nesting. Every section should be **one click from anywhere** in Settings. |
| **TiviMate** | *Add playlist* → choose type → paste URL → it **"will fetch it and show a channel count when done"**. The EPG source is separate, and some M3Us carry the guide URL themselves ([Vivimate](https://vivimate.co/blog/best-iptv-for-tivimate/), [tivimate.me](https://tivimate.me/add-playlist-to-tivimate)) | Typos in long URLs are the #1 failure ("a single missing character… can cause the playlist to fail") | **Test before save, show a channel count**, and **auto-detect the guide URL** from `url-tvg`. |
| **Channels DVR — Custom Channels** | A single form: nickname, stream format, URL, "refresh daily", XMLTV URL plus refresh interval ([Dispatcharr docs](https://dispatcharr.github.io/Dispatcharr-Docs/getting-started/)) | Lots of options up front | One compact form; keep advanced options out of the way. |
| **Threadfin / xTeVe** | Setup wizard: playlist → XMLTV → filter → map ([Grapevine](https://store.grapevine.is/blogs/news/plex-iptv-bridge-compared)) | Mapping is manual when names differ ("BBC ONE UK HD" vs "BBC One") ([iptvsetupguide](https://iptvsetupguide.com/iptv-on-plex/)) | Report **how many channels the guide will match** so mismatch is visible *before* the grid shows "No information". |
| **Jellyfin Enhanced** (plugin) | Clear split: "admin controls features, users control their personal preferences" ([n00bcodr #81](https://github.com/n00bcodr/Jellyfin-Enhanced/discussions/81)) | — | Label scope on every section. |

Common IPTV pitfalls, i.e. what the UI must catch:
- An HTML login page pasted instead of the playlist link.
- A guide whose `tvg-id`s don't match the channels.
- Playlist credentials in the URL (`get.php?username=…&password=…`), which must not be echoed back in clear ([tivimateplayer](https://tivimateplayer.us/blog/how-to-add-playlist-to-tivimate/), [m3u.codes](https://m3u.codes/guides/m3u-format/)).

---

## §3 — UX & engineering research

**Information architecture**
- Group by task and fit navigation to the count. Use **a sidebar for many groups** and turn it into collapsible or horizontal navigation on mobile. Search is a fallback, not a crutch ([Eleken](https://www.eleken.co/blog-posts/settings-page-ui), [saasui](https://www.saasui.design/blog/saas-settings-page-ux-patterns)).
- Aim for roughly 5–7 settings per group, with progressive disclosure for advanced options ([boundev](https://www.boundev.ai/blog/settings-screen-ux-design-best-practices)).
- Give "a visible save state, an obvious scope label", and set risky actions apart. "The failure mode to avoid is a silent change with no feedback" ([saasui](https://www.saasui.design/blog/saas-settings-page-ux-patterns)).
- Android guidance: version and licence info doesn't belong among the settings themselves, so keep About at the end. Use the same term for a nav label and its section title ([Android Developers](https://developer.android.com/design/ui/mobile/guides/patterns/settings)).

**Controls & saving**
- Use a **switch only when the change applies immediately**. Inside a form with a Save button, use a checkbox. Keep the label static; it describes what the switch controls ([NN/g via uxpickle](https://uxpickle.com/effective-toggle-buttons/), [UX.SE](https://ux.stackexchange.com/questions/126522/avoid-toggle-switch-on-any-page-with-save-button)).
- Autosave suits toggles and appearance. Explicit save suits multi-field forms ([Eleken](https://www.eleken.co/blog-posts/settings-page-ui)).

**Validation (WCAG 3.3.1 / 3.3.3 / 4.1.3)**
- Validate on submit or blur, never per keystroke.
- Tie errors to fields with `aria-invalid` and `aria-describedby`.
- Messages say *how to fix*, and colour is never the only cue.
- Use one polite live region for status, not double announcements ([accessibility.build](https://accessibility.build/guides/accessible-form-validation), [Deque](https://dequeuniversity.com/checklists/web/form-validation-feedback)).

**Secrets in forms**
- Never put a saved secret back into the DOM. Show "Configured" plus a redacted hint.
- Leave the input empty. A blank field keeps the current value, and replacing needs a non-empty value. Removing is a separate, explicit action ([truecms #8](https://github.com/truecms/sentinel_connector/issues/8)).
- The pre-filled-mask anti-pattern silently wiped real keys ([nalarupa #75](https://github.com/naddrzz/nalarupa/issues/75)).

**Server-side fetch of user URLs (SSRF)**
- Allow http and https only.
- Resolve DNS and **validate the IP actually connected to**, so DNS rebinding can't slip through.
- **Re-validate every redirect hop.**
- Block link-local and cloud-metadata ranges, cap size and time, and don't reflect raw responses ([OWASP SSRF / Webhook cheat sheets](https://cheatsheetseries.owasp.org/cheatsheets/Webhook_Security_Cheat_Sheet.html), [nhimg](https://nhimg.org/ssrf-prevention-guide)).
- *Deliberate exception:* LAN and loopback addresses stay allowed, because the primary use is a tuner or proxy on the home network (HDHomeRun, Threadfin, Dispatcharr on `192.168.x.x`). The feature is admin-only.

**M3U format**
- `#EXTM3U` header, optionally carrying `url-tvg` / `x-tvg-url` (the guide).
- `#EXTINF:-1` marks a live entry. `tvg-id` maps to XMLTV `<channel id>`, plus `tvg-logo`, `group-title` and `tvg-chno` ([m3u.codes](https://m3u.codes/guides/m3u-format/), [vibeviso](https://vibeviso.com/what-is-m3u-playlist-iptv/)).

**Page-transition motion**
- Material: enter 225 ms, exit 195 ms, full-screen up to 375 ms; ">400 ms may feel too slow"; **exits faster than entrances** ([ShotCanvas](https://shotcanvas.app/blog/animation-duration)). Transform and opacity only, with no `transition: all` ([aura.build](https://www.aura.build/skills/98324192-a4e1-4a97-9250-d0a7b039f875/ui-animation-guidelines)).
- Pattern by relationship. Unrelated top-level destinations get **fade-through**. Hierarchy (list → detail) gets a **shared X-axis slide**, retraced on the way back ("exit the way it entered", [Astryx](https://astryx.atmeta.com/sandbox/pages/motion-lab/published/)).
- Never block input on an animation or wait on data for it. Angular declines to delay transitions for content because "the page is frozen" ([angular.dev](https://angular.dev/guide/routing/route-transition-animations)).
- The View Transitions API is Baseline for same-document since Firefox 144. A second transition snaps the first, so guard against that. It freezes input during the snapshot ([botmonster](https://botmonster.com/web-dev/smooth-page-animations-with-the-view-transitions-api/)).
- *Decision:* use WAAPI on `#view-container` rather than View Transitions. Our views render asynchronously, and a snapshot would freeze the page while data loads. WAAPI leaves no lingering `transform` (no containing block for fixed children after it finishes), can be cancelled, and works everywhere.
- Reduced motion ≠ no motion; offer subtler options ([angular.dev](https://angular.dev/guide/routing/route-transition-animations)). So: system reduce → opacity-only, and a user setting can turn transitions off entirely.

---

## §4 — Comparison: Vault today vs research & peers

| Dimension | Vault today | Research / peers | Gap |
|---|---|---|---|
| Navigation within Settings | Scroll a 4,007 px column | Sidebar groups, ≤7 items each, deep-linkable; search as fallback | **Large** |
| Scope | None | Personal vs server separated and labelled | **Large** |
| Live TV setup | Impossible without editing JSON; dead link from the Live TV page | Paste URL → test → channel count → guide auto-detected → match report | **Missing** |
| Other link features | Playlist from file only; notifications in JSON | One "paste a link" entry point that recognises what it is (TiviMate "choose type") | **Missing** |
| Feedback | Silent sliders, mixed save models | Switch = instant + "Saved" status; forms = explicit Save + inline errors | Medium |
| Secrets | Plain-text credential fields; no secret handling for URLs | Write-only, redacted hint, blank keeps | **New risk** with the URL features |
| Accessibility | 4 unlabeled inputs, heading-order, prompt() | Labels, aria-describedby errors, real dialogs | Medium |
| Pairing | Token minted on every visit | On demand | Medium |
| Page motion | Hard cut after the first load | Fade-through for siblings, shared-axis for hierarchy, ≤ 300 ms, exits shorter, never blocks | **Missing** |

---

## §5 — Consolidated improvement list & execution method

| ID | Change | Fixes | Method |
|---|---|---|---|
| **SR-1** | **Sectioned Settings with a sticky section rail.** Three scope groups: *This device* (Appearance, Playback, Subtitles), *Server* (Live TV, Links & imports, Notifications, Connection) and *Account* (Sign-in & security, Devices), plus About. One section is visible at a time, deep-linked by `#hash` (so `/settings#live-tv` works from the Live TV page). The rail becomes a horizontally scrolling chip bar under 900 px. | S-1, S-2, S-4 link, S-13 | Rewrite `settings.js` as a shell (rail + panel host) with each section as a function in `views/settings/*.js`. Tablist semantics with roving arrows, `aria-controls`, Home/End. |
| **SR-2** | **Scope labels.** Each section header gets a chip: "Saved in this browser" / "Applies to the whole server" / "Your account". | S-3 | Section metadata. |
| **SR-3** | **Settings search.** A filter box matches section and row keywords and jumps to the matching section with the row highlighted. | S-1 | A keyword index built from `data-keywords` on rows. |
| **SR-4** | **One row pattern + switch component.** `.setting-row` = label + help on the left, control on the right, stacked on mobile. `.switch` is a native checkbox with `role="switch"` for instant settings, with a polite "Saved" status in the section header. Checkboxes are kept inside Save forms. | S-10, S-14 | CSS in `settings.css`; remove the inline styles. |
| **SR-5** | **Live TV section.** Enable switch. M3U URL plus XMLTV URL with **Test** → channel count, groups, guide detected from `url-tvg` (one-click "Use this guide"), guide match % and sample channels. HDHomeRun discovery checkbox. Explicit Save with inline errors. Saved URLs are **write-only with a redacted hint**: blank keeps the current value, and *Remove* is explicit. | S-4 | Server: `GET/PUT /api/livetv/settings` (hardened), `POST /api/livetv/test`. |
| **SR-6** | **Links & imports: "Paste a link".** One input recognises **M3U channel list / audio playlist / XMLTV guide / podcast RSS / web page** and offers the right actions: *Use as Live TV source*, *Use as TV guide*, *Import as playlist*, *Subscribe to podcast*. A web page gets a "you've probably copied the login page" hint. Playlist import by link is also added to the Playlists page. | S-5 | Server: `POST /api/links/inspect`, `POST /api/links/import-playlist`. |
| **SR-7** | **Safe fetcher.** `utils/safeFetch.js`: http(s) only; DNS-validated **at connect time** via a custom `lookup`; link-local, metadata, multicast and unspecified addresses blocked; every redirect re-validated (max 3); byte cap (truncate or reject); timeout; transparent gzip (`.xml.gz` guides). Used by inspect, import, the Live TV test, and channel/guide loading. | Security | Node `http`/`https` + `dns.lookup`. |
| **SR-8** | **Notifications section.** Webhook, ntfy and Discord URLs, plus Telegram bot token and chat ID. All are write-only with redacted hints, validated at save time (scheme and address), with **Send test notification** showing a per-target result. | S-5 | `GET/PUT /api/settings/notifications`, `POST …/test`. |
| **SR-9** | **Admin-only gate** on all new server-mutating and fetching endpoints. Non-admin profiles see the Server sections read-only with an explanation. | Security | `requireAdmin` middleware using the profile's `isAdmin`. |
| **SR-10** | **Sign-in & security.** Labelled fields with autocomplete hints. A **4×4 tap grid** replaces the number list (order shown when order matters). 2FA lives in the same section, and its `prompt()` calls become real dialogs. The duplicate Logout becomes "Sign out of this device" in the Devices sessions list. | S-6, S-7, S-12, S-17 | Grid picker component; `promptModal`. |
| **SR-11** | **Playback** merges the two cards. Gapless is wired to next-track preloading. The Equalizer opens in the shared modal with focus trap and Escape. | S-2, S-8, S-12 | `audioPlayer.preloadNext` checks `vault_gapless`. |
| **SR-12** | **Subtitles.** A compact swatch colour field, a warm-token "Accent tint", and a live preview over a still frame. | S-13, S-15 | — |
| **SR-13** | **Devices.** Pairing is **on demand** (*Show pairing code*). Codes expire, polling stops on unmount, and the code never wraps. Sessions list and install sit here too. | S-9 | `qrPair.js` is unchanged apart from its call site; the timer is cleared via `onUnmount`. |
| **SR-14** | **Connection.** The API URL becomes a URL-validated field with Copy, a human-readable server status (version, uptime, item counts) instead of JSON, a library scan action, and the remote-access guide folded in. | S-11 | — |
| **SR-15** | **Page transitions.** `utils/pageTransition.js`: <ul><li>A **fade-through** between sibling destinations: old view out at 90 ms, new view in at 210 ms (opacity plus 0.985→1 scale).</li><li>A **shared X-axis** when going deeper (list → detail): the new view enters from +24 px; Back retraces from −24 px.</li><li>Built on WAAPI, interruptible, so a new navigation cancels the running one.</li><li>Skipped on first paint, on same-route re-renders and in hidden tabs.</li><li>`prefers-reduced-motion` → opacity-only at 120 ms.</li><li>An Appearance → *Motion* setting (System / Full / Reduced / Off).</li><li>The exit never waits on data, and scroll restore and focus are unchanged.</li></ul> | S-18 | Router records direction (push/pop) and depth; `mount()` in `index.html` calls `swapView()`. |
| **SR-16** | **Copy & tokens.** Page subtitle "Your home for how Vault looks, plays and connects." Accurate About (six named themes), UK spelling consistently (the app already says "Favourites", "colour"), and a correct heading order (h1 → h2 section → h3 group). | S-13, S-16 | — |
| **SR-17** | **Tests & gates.** Server tests: classify, redact, safeFetch (blocked ranges, redirect re-validation, byte cap, gzip), livetv settings/test routes, links routes, notifications masking, admin gate. Browser: axe = 0, all inputs labelled, keyboard rail, transitions honour the setting. | — | `node --test`; puppeteer + axe harness. |

Out of scope (noted, not changed): `PUT /api/settings` (whole-config save) predates profiles and is not admin-gated. It should get the same `requireAdmin` in a follow-up, once non-admin profile flows are reviewed.

---

## §6 — Results

Measured with the same harness as §1: headless Chromium plus axe-core 4 (WCAG 2.0/2.1/2.2 A+AA and best-practice), run on all 10 sections × Hearth dark and Linen light × 1440 px and 390 px. That is 40 page loads.
After screenshots: `design/screenshots/settings-after-*.jpg`.

| Metric | Before | After |
|---|---|---|
| axe violations (Settings) | 1 (`heading-order`) | **0** in all 40 combinations |
| Inputs with no accessible name | 4 | **0** |
| Console errors on Settings | 0 | 0 |
| Height to reach any setting (desktop) | 4,007 px scroll | **≤ 1,430 px.** One section at a time, with a rail, search and `#deep-links` |
| Height (mobile) | 4,527 px | ≤ 1,799 px per section (Notifications is the longest), with a sticky chip bar |
| Inline `style=""` | 48 rendered (30 in source) | 3 in source, all data-driven (theme and subtitle swatch colours, meter width, the live subtitle preview). There are no layout or spacing inline styles. |
| Settings code | 704 lines in 2 files | 2,052 lines in 5 modules (ui / device / server / account / shell). The increase is the new Live TV, Links, Notifications, Devices and Security features. |
| Server tests | 64 | **88** (`links`, `settings-routes` and `page-transition` suites added) |
| Contrast gate | 48/48 AAA | 48/48 AAA |
| Minified `vault.css` | 121 KB | 142 KB (25.1 KB gzip). This adds `settings.css` plus Live TV grid styles. |

### What each item became

- **S-1 / S-2 / S-3 → SR-1, SR-2, SR-3.** There are three scope groups plus About, and one panel shows at a time. The rail uses `aria-current` with arrow, Home and End keys, and becomes a sticky chip bar below 900 px. Search filters by keyword and announces the match count. Every section has a scope chip.
- **S-4 → SR-5.** `/settings#live-tv` (also `#m3u`, `#epg`, `#iptv`) gives Live TV real setup:
  - Test reports channels, groups and samples;
  - "This list names its own guide → Use this guide", from the playlist's `url-tvg`;
  - the share of channels matched to the guide (100 % with the test fixtures);
  - field-level errors.

  Saved links come back only as redacted hints (`password=•••`). Blank keeps the saved value; *Remove* clears it.
  - The Live TV page's empty states now link straight to this section.
  - `parseM3U` reads `tvg-chno`, and channels are sorted by it.
  - The channel grid, which had no CSS at all, now has a layout and a logo fallback.
  - A latent bug where a comma inside `group-title="News, UK"` cut channel names short is fixed in both parsers.
- **S-5 → SR-6 / SR-8.** *Links & imports* takes any pasted link and works out what it is (TV channel list, music playlist, XMLTV guide, podcast feed, sign-in page or single HLS stream). It then offers only the actions that make sense. Importing `songs.m3u` gave: *"Created 'songs' with 2 of 3 songs found in your library. 1 was a web link and can't be matched."* Playlists also gained *Import from link*. Notifications covers ntfy, Discord, Telegram and generic webhooks, with a per-target test report.
- **SR-7.** `safeFetch` only fetches http(s) links and checks addresses when it connects. It blocks metadata, link-local, multicast and the IPv4-mapped / NAT64 / decimal / hex spellings of those addresses, and re-checks every redirect. It also enforces a byte cap, a timeout and gzip. All of this is covered by tests.
- **SR-9.** The new server-mutating and link-fetching endpoints return 403 `ADMIN_REQUIRED` for non-admin profiles (tested), and the UI shows those sections read-only.
- **S-6 / S-7 → SR-10.** Fields have labels and autocomplete. A 4×4 tap grid with numbered steps replaces typing the pattern as numbers. **A wrong current password now returns 400, not 401.** Before, any 401 signed the user out mid-form. This is verified in the browser and covered by a test.
- **S-8 → SR-11.** Gapless playback now actually works. In the browser, with gapless on, the next track's stream is fetched straight away and handed over when the current track ends, with no request at the track boundary. With it off, preloading stops (each stream is fetched only when the previous track ends).
- **S-9 → SR-13.** Pairing only starts when you ask for it (*Show pairing code*). Polling stops when the panel closes.
- **SR-15 page transitions.**
  - Sibling destinations fade through (90 ms out, 210 ms in).
  - Going deeper enters from +24 px; going back enters from −24 px.
  - Reduced motion is a 120 ms opacity change only. *Off* disables animation.
  - Appearance → Motion offers Match system, Full, Reduced and Off.
  - Navigations can interrupt each other.
  - **A bug found during browser verification is fixed.** The exit animation's `fill: forwards` stopped being tracked once it finished, so it was never cancelled and left every new page at opacity 0. A regression test fails without the fix.
  - Each swap now also sets a per-page `document.title` (WCAG 2.4.2) and makes a polite "<Page> page" screen-reader announcement. Neither existed before.
- **Server fixes found along the way:**
  - `PUT /api/settings` without `media` used to return 500 and now returns 200 (tested).
  - Disabling TOTP with a wrong code returned 401 and now returns 400.
  - Notification failures now give a reason a person can act on ("The connection was refused") instead of "fetch failed".

### Still open

- `PUT /api/settings` (the old whole-config save) is still not admin-gated; see "Out of scope" above.
- Cover art for the test fixtures returns 404. This comes from the fixture MP3s having no embedded art, not from this work.
