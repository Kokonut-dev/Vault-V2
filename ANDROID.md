# An Android app for Vault — is it possible?

**Short answer: yes.** It is a well-understood, medium-sized project. The
server already has everything the app needs, including the single-use QR
sign-in it must start with, so **no server changes are required**. This
document describes how it would work, the one rule it is designed around
(*you scan the QR code on the server first — there is no other way in*), what
is hard, and what it would take.

Status: **feasibility study only** — no Android code exists in this repository yet.

---

## 1. The rule: scan the server's QR code first

The app opens to one thing: a camera viewfinder. There is no "type a server
address" box, no username/password form and no account to create. You only
get into the app by scanning a sign-in QR code that **your own Vault shows,
while you are signed in to it**:

- **Settings → Account → Pair a device**, or
- **Use on another device → Same network** with *"Sign the other device in"* ticked.

That QR code already exists today and encodes:

```
http://192.168.1.20:4000/?pair=<token>
```

- `<token>` is 18 random bytes (144 bits), made by `POST /api/auth/pair` on a
  signed-in device (`server/routes/auth.js`).
- It is **pre-approved** (the person who showed it is signed in), **works
  once**, and **expires after 5 minutes**.
- Redeeming it (`POST /api/auth/pair/exchange {token}`) creates a normal,
  revocable session labelled "Device added with a QR code". It shows up under
  **Settings → Signed-in devices** and can be signed out from there.
- Wrong guesses are rate-limited per address and server-wide.

Since the desktop-apps change, the QR code always uses the computer's **network**
address, even when it is shown in the desktop app or a browser on the server
computer itself (`reachableBaseUrl()` in `docs/js/components/qrPair.js`). A
code that says `127.0.0.1` would be useless to a phone.

### Why QR-only is a good gate

| Property | How the QR gate gives it |
|---|---|
| Only people the owner chooses get in | The code is only shown on a screen where someone is already signed in. |
| Nothing to brute-force from the app | The app has no password form; the token is 144-bit and single-use. |
| Physical presence (normally) | You have to see the screen within 5 minutes. |
| The app can't be pointed at a fake server | The server address comes *from* the code, and the app refuses to go anywhere else (§3). |
| Revocable | Each phone is its own session; sign it out on the server and the app returns to the scanner. |

One consequence to accept: a photo of the QR code is a sign-in for 5 minutes,
until it is used. That is the same as today in a browser, and the pairing panel
already says so (`securityNotes('pair')`).

---

## 2. Which kind of app

| Option | Can it enforce "scan first"? | Works with a home server over plain HTTP? | Verdict |
|---|---|---|---|
| **PWA / "Add to Home screen"** | No. The page *is* the server, so there is nothing to gate before it. | Yes | Already works today, but it is not the app asked for. |
| **Trusted Web Activity (TWA)** | No. | **No.** A TWA needs an HTTPS origin with Digital Asset Links. A home IP like `192.168.1.20` can't have them. | ✗ |
| **Capacitor / Cordova with the web UI bundled** | Yes | Only with cleartext enabled. The bundled UI drifts out of date with each server's version. | Possible, but it ships a second copy of the UI. |
| **Small native shell (Kotlin): native scanner + WebView of the server's own UI** | **Yes** | Yes, with a scoped network-security config | **✓ Recommended first version** |
| **Fully native app (Compose + Media3) on the Vault/Subsonic API** | Yes | Yes | Best experience, but months of work. A possible phase 2. |

**Recommendation:** a native Kotlin shell. The scanner and the gate are native.
After pairing, the app shows **the server's own web UI** in a locked-down
WebView, so every feature Vault has (and every future one) works on day one.
It always matches the server's version, and there is only one UI to maintain.

---

## 3. How the recommended app works

```
┌───────────── first launch / after "Forget server" / after sign-out ─────────────┐
│  Scanner (CameraX + barcode scanning, on-device)                                │
│     │ QR text                                                                   │
│     ▼                                                                           │
│  Validate:  http(s) URL · no user:pass@ · has ?pair=<24-char base64url>         │
│             host is a private/LAN IP, *.local, or https (e.g. a tunnel)         │
│     │                                                                           │
│     ▼                                                                           │
│  GET {origin}/api/health  → must be {"status":"ok","version":…} (it's Vault)    │
│     │                                                                           │
│     ▼                                                                           │
│  POST {origin}/api/auth/pair/exchange {token} → access token + profile          │
│     │   (token stored in Android Keystore-backed storage, origin pinned)        │
│     ▼                                                                           │
│  WebView(origin)  — vault_token injected at document start, origin only         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Details:

1. **Scanner.** CameraX with an on-device barcode model (ML Kit's *bundled*
   model, or ZXing for a Google-free/F-Droid build). The camera permission is
   requested on the first screen and used for nothing else. Without camera
   permission the app explains why and stays on that screen; by design there
   is no typed fallback.
2. **Validation before any network request.** Anything that isn't a Vault
   pairing link is rejected: other URLs, `javascript:`/`intent:` schemes,
   embedded credentials, or a missing or oddly shaped token. Plain HTTP is
   accepted only for private ranges (10/8, 172.16/12, 192.168/16, link-local)
   and `*.local`. Public hosts must be HTTPS (e.g. a Cloudflare tunnel).
3. **Is it Vault?** `GET /api/health` returns only `{status, version,
   timestamp}` (redacted since the security hardening work), which is enough to
   recognise Vault and show "Vault 3.0.0 at 192.168.1.20".
4. **Exchange natively, not in the page.** The app redeems the token itself.
   That way it knows whether pairing worked (expired, already used, or
   rate-limited each get a clear message and "scan a new code"). It also keeps
   the session token out of URLs and history.
5. **WebView locked to that origin.** JavaScript is on (it's Vault's UI), but
   there are no JS bridges (`addJavascriptInterface`), file access is off, and
   `shouldOverrideUrlLoading` keeps the WebView on the scanned origin. Any
   other link opens in the browser. The token is placed in `localStorage` with
   `WebViewCompat.addDocumentStartJavaScript`, restricted to that one origin.
6. **Leaving.** "Forget this server" in the app's menu clears the token and
   WebView storage and returns to the scanner. If the server ever answers
   `401` (session revoked from Settings → Signed-in devices, or expired), the
   app does the same.

### Android platform rules that apply

- **Plain HTTP on a home network.** Android blocks cleartext HTTP by default.
  The app needs a Network Security Configuration that allows cleartext. Since
  IP ranges can't be listed there, it is app-wide, and §3.2 above does the
  real scoping. Google is moving away from the old `usesCleartextTraffic`
  flag toward these config files [4](https://bayton.org/android/android-17-enterprise-features/).
- **Local network permission (Android 17).** Apps that target API level 37
  or higher need the new runtime permission `ACCESS_LOCAL_NETWORK` to talk to
  devices on the LAN. It covers TCP connections to local addresses and mDNS
  [1](https://blog.isec7.com/en/android-17-for-enterprise-policies-to-review-before-rollout).
  It is part of the Nearby devices group, and apps targeting 36 or lower keep
  implicit access for now
  [5](https://ecorpit.com/android-17-api-37-behavior-changes-migration-guide-2026/).
  The app should ask for it right after a successful scan, at the moment it
  is obviously needed ("Allow Vault to reach your server at 192.168.1.20?").
- **Certificate Transparency is on by default for API 37 targets**
  [3](https://cybersecurefox.com/en/android-17-network-security-ech-local-network-ct-2g/).
  Vault's self-signed certificate (`npm run generate-cert`) would be
  rejected. To support HTTPS at home, the QR code could carry the
  certificate's SHA-256 fingerprint (`&fp=…`, a small server change) and the
  app would pin exactly that certificate instead.

---

## 4. The hard parts (honestly)

| Topic | Problem | Plan |
|---|---|---|
| **Music in the background** | WebView audio stops when the app is backgrounded or the screen turns off. There is no lock-screen or Bluetooth control. | Phase 1.5: a small native **Media3** foreground service with a `MediaSession`. The web UI hands it the current queue (stream URLs + token). Subsonic-compatible endpoints already exist for this. |
| **Downloads / offline** | Vault's offline mode uses the service worker and Cache Storage. That works in WebView, but storage can be evicted. | Use the web offline mode first. A native download manager comes later if needed. |
| **Casting / TV** | The web UI's casting relies on browser APIs. | Keep the web behaviour. Native Cast SDK is out of scope for v1. |
| **Away from home** | Quick-tunnel URLs (`*.trycloudflare.com`) change every time the tunnel starts, so a phone paired over a tunnel would need a new scan each time. | v1: pair on the home network. Remote use means scanning the Anywhere QR code again. A named tunnel or fixed domain makes it permanent. |
| **Changing IP** | DHCP may give the server a new address. | Re-scan, or turn on mDNS (`server.mdns`) so the QR code can use `vault.local`. |
| **Play Store** | It needs a developer account, a privacy policy, a data-safety form, and yearly target-SDK bumps. | You can also ship the APK on GitHub Releases or F-Droid (with the ZXing build). |

---

## 5. Effort

| Piece | Rough size |
|---|---|
| Scanner + validation + exchange + secure storage | 2–3 days |
| Locked WebView shell, forget/sign-out handling, 401 → scanner | 2 days |
| Network-security config, local-network permission flow, Android 12–17 testing | 2 days |
| Native background audio (Media3 service + small web↔native hand-off) | 4–6 days |
| CI build (GitHub Actions, signed APK/AAB), icons, store listing | 1–2 days |
| **Total for a solid v1** | **≈ 2–3 weeks** for one developer |

A fully native client (phase 2) would be a multi-month project and isn't
needed to get a good Android app.

## 6. Server changes

- **None required.** The pairing endpoints, single-use tokens, revocable
  sessions and redacted health check are already in `main`.
- **Done in the desktop-apps change:** the pairing QR code uses the LAN
  address when shown on the server computer itself.
- **Nice to have later:**
  - `&fp=` certificate fingerprint in QR codes for HTTPS servers.
  - An optional `&name=` so the app can show "Kitchen PC's Vault".
  - A `device: android` label hint so Signed-in devices reads "Android phone".
