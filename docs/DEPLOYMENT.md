# SpotiFU deployment guide

Docker Compose is the single supported deploy mode. The wizard handles all credentials.

## Topology

```text
localhost:1985     →  FastAPI server (Docker)
localhost:5432     →  PostgreSQL (loopback-only publish for host tools)
LAN clients        →  Connect to http://<server-ip>:1985 or via mDNS
```

## Install

```bash
git clone https://github.com/<org>/SpotiFU.git
cd SpotiFU
bash scripts/install.sh
```

This runs the wizard (Soulseek + optional API keys) then `docker compose up -d --build`.

## LAN deployment

Copy `docker-compose.override.example.yml` to `docker-compose.override.yml` and set `API_BASE_URL` to this host's LAN IP:

```yaml
services:
  server:
    environment:
      API_BASE_URL: http://192.168.1.100:1985
      MDNS_ENABLED: "true"
```

Then `docker compose up -d --build`. Remote clients on the same LAN can now discover via `spotifu.local` (mDNS) or connect manually to `http://192.168.1.100:1985`.

mDNS note: in default Docker bridge mode, mDNS multicast often doesn't propagate. If `spotifu.local` doesn't resolve from a remote client, set a manual URL in the client's Settings → Server connection.

## Configuration

### `.secrets` (wizard-managed)

| Key | Purpose |
|---|---|
| `jwt_secret` | JWT signing (auto-generated, ≥32 chars) |
| `soulseek_username` / `soulseek_password` | Soulseek login |
| `lastfm_api_key` | optional |
| `fanarttv_api_key` | optional |

Bind-mounted to `/app/.secrets` in the server container, mode `0600`. Re-run `bash scripts/install.sh wizard` to update.

### `.env` (optional host overrides)

Copy `.env.example` to `.env` and uncomment anything you want to override. Common:

- `API_BASE_URL` — LAN IP for remote clients (or use the override file above)
- `ALLOWED_ORIGINS` — restrict CORS (default `*`)
- `ALLOW_REGISTRATION` — set `false` after creating the first admin
- `LOG_LEVEL` / `LOG_LEVEL_*` — debug logging per module
- `MDNS_ENABLED` / `MDNS_HOSTNAME` / `MDNS_PORT` — LAN discovery (auto-off in Docker)

`DATABASE_URL`, `CACHE_DIR`, `SECRETS_FILE`, and the JWT secret are owned by compose / the wizard and should not be set in `.env`.

## Volumes

- `spotifu-db` — PostgreSQL data.
- `spotifu-cache` — downloaded audio, cover art, artist images. Stored under `/data/spotifu/cache` in the container.

Both persist across `docker compose down`. `bash scripts/install.sh reset` removes them.

## Upgrading from an older version

If you previously ran SpotiFU with a root-owned `spotifu-cache` volume (pre-UID-1000), fix ownership once:

```bash
docker run --rm -v spotifu_spotifu-cache:/cache alpine chown -R 1000:1000 /cache
bash scripts/install.sh up
```

## Backup

- **Database:** `docker run --rm -v spotifu-db:/from -v $PWD:/to alpine tar czf /to/spotifu-db.tgz /from`
- **Cache:** same pattern with `spotifu-cache`.

## TLS (optional, beyond LAN)

Terminate TLS with Caddy or nginx in front of the API. Set the client server URL to `https://…` and (if needed) override `VITE_WS_URL=wss://…` in `client/.env`.

## Troubleshooting

| Problem | Check |
|---------|-------|
| `docker compose ps` shows server unhealthy | `docker compose logs server --tail=200`. Most often: Soulseek login failed. Re-run `bash scripts/install.sh wizard`. |
| Server won't start: `.secrets invalid` | Run `bash scripts/install.sh wizard` (it pre-fills valid fields and only re-prompts invalid ones). |
| `curl localhost:1985/health/ready` returns 503 | DB unreachable. Check `docker compose ps` for `spotifu-postgres (healthy)`. |
| Covers/streams use `localhost` URLs | Set `API_BASE_URL` to your LAN IP via override file. |
| Remote client can't find server | Use manual URL in client Settings → Server connection. mDNS is unreliable in Docker bridge mode. |
| WebSocket disconnects | Login required; WS uses JWT via `?token=` query param. |
| Port 5432 already in use on host | Loopback-only publish should not collide unless you run local Postgres on 5432. Override: `ports: ["127.0.0.1:5433:5432"]`. |
