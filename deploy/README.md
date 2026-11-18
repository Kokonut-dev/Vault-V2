# Deploying Vault

Three supported ways to run the server so it survives a reboot
(IMPROVEMENTS item 50). Pick one — they all run the same `server/index.js`.

## 1. Docker Compose (recommended)

```bash
git clone https://github.com/Kokonut-dev/Vault-V2 && cd Vault-V2
docker compose up -d --build
```

Point the media volumes at your own folders (or set them in a `.env` next to
`docker-compose.yml`):

```bash
MEDIA_MOVIES=/srv/media/movies MEDIA_TV=/srv/media/tv docker compose up -d
```

- State lives in the `vault-data`, `vault-cache` and `vault-logs` volumes.
- The image installs **ffmpeg** so transcoding, thumbnails, trickplay and HLS
  work without any host setup.
- `docker compose logs -f` follows the log; `docker compose down` stops it.

To expose the mDNS name inside the container, add `network_mode: host` — the
service then binds the host network directly (Linux only). Without it the
server is still reachable on the mapped port.

## 2. systemd (Linux, bare metal)

```bash
sudo useradd -r -s /usr/sbin/nologin vault
sudo git clone https://github.com/Kokonut-dev/Vault-V2 /opt/vault
cd /opt/vault/server && sudo -u vault npm ci --omit=dev --ignore-scripts
sudo cp /opt/vault/deploy/vault.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vault
journalctl -u vault -f
```

Edit `User`, `WorkingDirectory` and `ReadWritePaths` in
[`vault.service`](vault.service) if you installed somewhere other than
`/opt/vault`. The unit is pre-hardened (`ProtectSystem=full`, `NoNewPrivileges`).

## 3. launchd (macOS)

```bash
cp deploy/com.vault.server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vault.server.plist
tail -f /opt/vault/server/logs/vault.out.log
```

Fix the `node` path (`which node`) and `WorkingDirectory` first.

The Mac must not sleep, or Vault pauses with it. Vault keeps the Mac awake while it runs (`server.keepAwake`, on by default; check it with `pmset -g assertions`). Closing a MacBook's lid still forces sleep unless it's on power with an external display. For a dedicated server, also run `sudo pmset -c sleep 0`.

## Moving to another machine

`npm run export -- <folder> [--zip] [--no-media]` on the old machine and `npm run import -- <package> --media-dir <dir>` on the new one move the media, library, history, accounts and settings, and relink every path. Run them from the repo root, or use **Settings → Move to another server** in the app. An import is staged and takes effect at the next start, so it's safe while Vault runs. For the freshest export, stop Vault first or use the in-app button, which saves everything before packing. For Docker, run the import inside the container (`docker compose exec vault npm run import -- …`) with `--media-dir` set to a mounted volume, then restart the container. Details are in the main README under *Moving to a new computer*.

## After it starts

1. Open `http://<host>:4000` and complete the first-run wizard (password +
   grid pattern).
2. **Settings → Devices → Pair a device** shows a QR code; scanning it on a
   phone signs that device in with a 6-digit code — no grid drawing on the TV.
3. In **Settings → Server** set the media paths, then run a scan.

## Reverse proxy (optional)

Vault speaks plain HTTP/HTTPS and streams with byte-range requests; nginx,
Caddy and Traefik all work. If you proxy it under a sub-path, keep websockets
and SSE enabled — the live-updates channel (`/api/events`) uses SSE.

```nginx
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_buffering off;        # SSE + video streaming
    proxy_read_timeout 1h;      # long transcodes
}
```
