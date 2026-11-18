# Vendored stand-ins

## webrtc-polyfill-stub

WebTorrent (used by the optional **Torrents** feature) depends on
`simple-peer` → `webrtc-polyfill` → `node-datachannel`, a native module whose
prebuilt download fails on many systems and breaks `npm install`.

Vault only talks to regular BitTorrent peers (TCP, uTP, DHT, trackers); it
never uses WebRTC/browser peers. So `package.json` points `webrtc-polyfill` at
this empty package via `overrides`, which keeps installs pure-JavaScript and
working with `--ignore-scripts`.

`uint8-util` is pinned to 2.2.6 in the same `overrides` block: 2.3.x breaks
WebTorrent 2.x (`arr2hex` crashes on string info-hashes).
