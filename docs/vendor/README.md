# Vendored libraries

These are copied verbatim from npm so Vault keeps its zero-build promise (no
bundler, no CDN dependency at runtime — important for a self-hosted app that may
be used offline).

| File | Package | Version | License | Loaded |
|---|---|---|---|---|
| `hls.light.min.js` | [`hls.js`](https://www.npmjs.com/package/hls.js) | 1.7.3 | Apache-2.0 | lazily, only when an HLS stream is played |
| `qrcode.mjs` | [`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) | 2.0.4 | MIT (see `qrcode-generator-LICENSE.txt`) | lazily, only for QR pairing screens |

`hls.js` provides MSE-based HLS playback in Chrome/Firefox/Edge (Safari plays
HLS natively). Without it the adaptive-streaming option in the player falls back
to the progressive transcode endpoint, so nothing breaks if it fails to load.
