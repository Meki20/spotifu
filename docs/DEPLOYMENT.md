# SpotiFU deployment guide

This document covers running SpotiFU on a home LAN: server on one machine, clients (web browser or Tauri desktop) on the same or another device.

## Topologies

### A — Same machine (development)

```text
localhost:1984  →  Vite dev server (client)
localhost:1985  →  FastAPI server
localhost:5432  →  PostgreSQL
```

```bash
docker compose up -d postgres   # or local Postgres
cd server && uvicorn main:app --reload --port 1985
cd client && npm run dev
```

### B — Dedicated LAN server + remote clients

```text
192.168.x.x:1985  →  SpotiFU server (Docker or systemd)
192.168.x.x:1984  →  Web UI (optional, compose profile `full`)
Clients           →  Discover via mDNS (spotifu.local) or manual URL in Settings
```

## Docker Compose

### Server only (default)

Starts PostgreSQL and the API. Cache and database persist in named volumes.

```bash
cp .env.example .env
cp .secrets.example .secrets   # edit with real credentials
docker compose up -d --build
```

**Important:** use `--build` after git pull so the container runs current server code.

API: http://localhost:1985

### Full stack (server + web UI)

```bash
docker compose --profile full up -d
```

- Web UI: http://localhost:1984
- API: http://localhost:1985

The web client uses **runtime server discovery** — users can point at a remote API from the connect screen or Settings. `VITE_API_URL` at build time is optional (seeds the default only).

### LAN deployment notes

1. Set `API_BASE_URL` to the LAN-reachable URL (not `localhost`) so cover/stream URLs work for remote clients:

   ```bash
   API_BASE_URL=http://192.168.1.100:1985
   ```

   See [`docker-compose.override.example.yml`](../docker-compose.override.example.yml).

2. **mDNS** — The server registers `_spotifu._tcp.local.` as `spotifu.local` on port 1985 when `MDNS_ENABLED=true`. In default Docker bridge mode, mDNS often does not propagate. Options:
   - Run the server on bare metal or with `network_mode: host` (Linux)
   - Use manual server URL in the client (Settings → Server connection)

3. **Persistent cache** — `spotifu-cache` volume stores downloads and cover art at `/data/spotifu/cache` inside the server container.

## Environment variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | Server | PostgreSQL connection string |
| `JWT_SECRET` | Server | JWT signing (≥32 chars) or use `.secrets` |
| `CACHE_DIR` | Server | Download/cover storage (Docker: `/data/spotifu/cache`) |
| `API_BASE_URL` | Server | Public URL for self-referential links |
| `SOULSEEK_USERNAME` / `SOULSEEK_PASSWORD` | Server / `.secrets` | Soulseek account |
| `MDNS_ENABLED` | Server | Register LAN service (default: off in Docker) |
| `MDNS_HOSTNAME` | Server | mDNS name without `.local` (default: `spotifu`) |
| `ALLOWED_ORIGINS` | Server | Comma-separated CORS origins (default: `*`) |
| `ALLOW_REGISTRATION` | Server | `false` disables signup after first user exists |
| `VITE_API_URL` | Client build | Optional seed URL (runtime override in Settings) |
| `VITE_WS_URL` | Client build | Optional WebSocket override |

## Secrets file

Copy [`.secrets.example`](../.secrets.example) to `.secrets` at the repo root:

```json
{
  "jwt_secret": "...",
  "soulseek_username": "...",
  "soulseek_password": "...",
  "lastfm_api_key": "",
  "fanarttv_api_key": ""
}
```

Docker mounts `./.secrets` read-only at `/app/.secrets`.

## Bare-metal server (systemd)

Example unit file: [`deploy/spotifu-server.service`](../deploy/spotifu-server.service)

```bash
sudo cp deploy/spotifu-server.service /etc/systemd/system/
# Edit paths and EnvironmentFile
sudo systemctl enable --now spotifu-server
```

mDNS works best on bare metal (`MDNS_ENABLED=true` by default outside Docker).

## Desktop client (Tauri)

Build for your platform from `client/`:

```bash
npm run tauri:build:linux      # AppImage / deb
npm run tauri:build:windows
npm run tauri:build:macos      # Intel
npm run tauri:build:macos-arm  # Apple Silicon
```

On first launch, use **Connect to SpotiFU server** to find the LAN server or enter `http://host:1985` manually. No rebuild required when the server address changes.

## Backup

- **Database:** Docker volume `spotifu-db` (or your Postgres data directory)
- **Cache:** Docker volume `spotifu-cache` or `CACHE_DIR` on disk

## TLS (optional, beyond LAN)

For HTTPS/WSS, terminate TLS with Caddy or nginx in front of the API. Set the client server URL to `https://…` and ensure `VITE_WS_URL` or runtime connection uses `wss://…` if auto-derivation from `http` is insufficient.

## Troubleshooting

| Problem | Check |
|---------|--------|
| Client cannot find server | Manual URL in Settings; verify `curl http://host:1985/health` |
| Covers/streams use localhost URLs | Set `API_BASE_URL` to LAN IP |
| Downloads lost after restart | Ensure `CACHE_DIR` volume is mounted |
| mDNS not found | Enable `MDNS_ENABLED`, use host networking, or manual URL |
| WebSocket disconnects | Login required; WS uses JWT via `?token=` query param |
