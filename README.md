# SpotiFU

<p align="center">
  <img src="client/public/assets/brand/polly_512x512.png" alt="Polly mascot" width="128" height="128" />
</p>

Soulseek music player with Spotify-like UI. Search and stream music from the Soulseek network.

## Quick Start

Requirements: **Docker** (with the `compose` plugin) and **Git**.

```bash
git clone https://github.com/<org>/SpotiFU.git
cd SpotiFU
bash scripts/deploy.sh
```

`scripts/deploy.sh` runs two steps:

1. **Wizard** — prompts for Soulseek credentials (and optionally Last.fm / fanart.tv API keys) and writes `./.secrets`. Auto-generates a JWT signing secret.
2. **Up** — starts PostgreSQL + the API container via `docker compose up -d --build`.

When it finishes, the API is on http://localhost:1985.

If you want to build the in-browser UI (the desktop clients are distributed separately on the Releases page):

```bash
cd client
npm install
npm run dev
```

Open http://localhost:1984 — it talks to the dockerized API.

## Verifying the install

```bash
docker compose ps
# spotifu-postgres (healthy)   spotifu-server (healthy)

curl -fsS http://localhost:1985/health
# {"status":"ok"}

curl -fsS http://localhost:1985/health/ready
# {"ready":true,"soulseek_connected":true}

PGPASSWORD=spotifu psql -h 127.0.0.1 -U spotifu -d spotifu -c '\dt'
# list of tables

ls -l .secrets
# -rw-------  1 you  you  ...  .secrets
```

Soulseek connectivity: `docker compose logs server | grep -i soulseek`. The wizard saves credentials but does not connect until the API starts; the lifespan hook logs in automatically once the server is up.

## Stop / restart

```bash
bash scripts/deploy.sh down    # stop, keep volumes
bash scripts/deploy.sh up      # restart
bash scripts/deploy.sh reset   # stop AND delete volumes (DB + cache)
bash scripts/deploy.sh logs    # tail server logs
```

## Re-running the wizard

The wizard pre-fills from any existing `.secrets`, so re-running only changes fields you edit:

```bash
bash scripts/deploy.sh wizard
```

## Architecture (high-level)

- **Client** — React + TypeScript + TailwindCSS + Vite. Distributed as separate binaries (desktop) or runnable in the browser for development.
- **Server** — FastAPI + SQLModel + aioslsk (Soulseek protocol), runs on port 1985 inside Docker as non-root UID 1000.
- **Database** — PostgreSQL 16, internal to the compose network; published on loopback only (`127.0.0.1:5432`) for `psql`/host-tool debugging.

### How data flows

- **Search**: the client queries the server, which merges metadata/provider results and local library state.
- **Playback**: the server queues downloads/streams local files when available.
- **Playlists**: playlist items store MusicBrainz IDs (`mb_recording_id`, plus optional `mb_release_id` / `mb_release_group_id`) so the UI can hydrate consistent metadata later.

## Configuration

### Credentials (wizard-managed)

`.secrets` holds everything sensitive:

| Key | Purpose |
|---|---|
| `jwt_secret` | JWT signing key (auto-generated, ≥32 chars) |
| `soulseek_username` / `soulseek_password` | Soulseek login |
| `lastfm_api_key` | optional, for similar-artist enrichment |
| `fanarttv_api_key` | optional, for high-quality artist images |

Permissions: `chmod 600` enforced by the wizard. File is bind-mounted to `/app/.secrets` in the server container.

### Optional host overrides (`.env`)

`./.env` (copy from `.env.example`) overrides non-secret settings at the compose level:

- `API_BASE_URL` — public URL for cover/stream links (set to LAN IP for remote clients)
- `ALLOWED_ORIGINS` — CORS allow-list
- `ALLOW_REGISTRATION` — set `false` after creating the first admin
- `MDNS_ENABLED` / `MDNS_HOSTNAME` / `MDNS_PORT` — LAN service discovery (off in Docker)
- `LOG_LEVEL` and per-module `LOG_LEVEL_*`
- `SOULSEEK_USERNAME` / `SOULSEEK_PASSWORD` / `LASTFM_API_KEY` / `FANARTTV_API_KEY` — overrides for what the wizard wrote (rare)

### LAN deployment

Copy `docker-compose.override.example.yml` to `docker-compose.override.yml` and set `API_BASE_URL` to this host's LAN IP. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full LAN notes.

## Upgrading from an older version

If you previously had SpotiFU running with a root-owned `spotifu_spotifu-cache` volume (pre-UID-1000), fix ownership once:

```bash
docker run --rm -v spotifu_spotifu-cache:/cache alpine chown -R 1000:1000 /cache
bash scripts/deploy.sh up
```

The wizard also detects pre-existing `.secrets` and pre-fills prompts from it.

## Tech Stack

**Server**
- FastAPI — web framework
- SQLModel — ORM
- aioslsk — Soulseek protocol
- PostgreSQL — database
- Uvicorn — ASGI server

**Client**
- React 19 + TypeScript
- Vite — build tool
- TailwindCSS — styling
- React Router — routing
- Zustand — state management
- TanStack Query — data fetching

## FAQ / Troubleshooting

### "Wizard says .secrets is invalid"

Re-run: `bash scripts/deploy.sh wizard`. It reads the current `.secrets` and only re-prompts fields that fail validation.

### "Server keeps restarting / Soulseek won't connect"

`docker compose logs server --tail=200`. Wrong Soulseek password is the most common cause — re-run the wizard.

### "CSV import matched the wrong song"

This typically happens only in the looser passes (3/4), especially for compilation albums with shared credited artists. Use the import modal's unmatched tools to correct a row by pasting the correct MusicBrainz recording MBID.

### "CSV import is slow / stalls"

MusicBrainz can rate-limit (429) or intermittently 503. The importer retries on these with a short delay.

### "Some tracks are consistently unmatched"

Common reasons:

- the playlist artist string doesn't match the credited artist (e.g. synth voicebank credited as `可不` while CSV says `Kafu`)
- the album name differs between Spotify and MusicBrainz (localized titles / punctuation)

### "Album cover / release is 'wrong' after resolving"

MusicBrainz recordings can appear on many releases. SpotiFU resolves a recording MBID first, then selects the best release using official-release preference + album-hint matching. If you care about a specific release, use the release IDs stored on playlist items (`mb_release_id`, `mb_release_group_id`) to hydrate consistently.
