# SpotiFU

<p align="center">
  <img src="client/public/assets/brand/polly_512x512.png" alt="Polly mascot" width="128" height="128" />
</p>

Soulseek music player with Spotify-like UI. Search and stream music from the Soulseek network.

## Architecture (high-level)

- **Client** — React + TypeScript + TailwindCSS + Vite, runs on port 1984
- **Server** — FastAPI + SQLModel + aioslsk (Soulseek protocol), runs on port 1985
- **Database** — PostgreSQL 16 (docker-managed)

### How data flows

- **Search**: the client queries the server, which merges metadata/provider results and local library state.
- **Playback**: the server queues downloads/streams local files when available.
- **Playlists**: playlist items store MusicBrainz IDs (`mb_recording_id`, plus optional `mb_release_id` / `mb_release_group_id`) so the UI can hydrate consistent metadata later.

## Quick Start

### One-command startup (everything in Docker)

```bash
docker compose up -d
```

Access:
- App: http://localhost:1984
- API: http://localhost:1985

### Stop

```bash
docker compose down        # keep data
docker compose down -v     # delete data volume
```

---

## Development

### Prerequisites

- Python 3.12+
- Node.js 20+
- PostgreSQL 16 (or Docker)
- Soulseek credentials (env vars or `.env`)

### Manual setup

**1. Clone and install server dependencies**

```bash
cd server
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**2. Configure Soulseek credentials**

```bash
cp .env.example .env
# Edit .env and add your Soulseek username/password
```

**3. Start PostgreSQL**

```bash
# Option A: Docker
docker run -d \
  --name spotifu-postgres \
  -e POSTGRES_USER=spotifu \
  -e POSTGRES_PASSWORD=spotifu \
  -e POSTGRES_DB=spotifu \
  -p 5432:5432 \
  postgres:16-alpine

# Option B: Docker Compose (from project root)
docker compose up -d postgres
```

**4. Start server**

```bash
cd server
source venv/bin/activate
uvicorn main:app --reload --port 1985
```

**5. Install client dependencies**

```bash
cd client
npm install
```

**6. Start client dev server**

```bash
npm run dev
```

App runs at http://localhost:1984. API at http://localhost:1985.

---

## Docker

### Build images

```bash
docker compose build
```

### View logs

```bash
docker compose logs -f        # all services
docker compose logs -f server # server only
```

### Recreate from scratch

```bash
docker compose down -v
docker compose up -d
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://spotifu:spotifu@localhost:5432/spotifu` | PostgreSQL connection string |
| `SOULSEEK_USERNAME` | — | Soulseek username |
| `SOULSEEK_PASSWORD` | — | Soulseek password |
| `SECRETS_FILE` | `.secrets` | Path to secrets file (Docker: `/app/.secrets`) |
| `VITE_API_URL` | `http://localhost:1985` | Client → server base URL |

**Docker**: Create a `.env` file in the project root:
```bash
SOULSEEK_USERNAME=your_username
SOULSEEK_PASSWORD=your_password
```
Then run `docker compose up -d`. Credentials are loaded from env vars inside the container.

---

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

---

## FAQ / Troubleshooting

### “CSV import matched the wrong song”

- This typically happens only in the looser passes (3/4), especially for compilation albums with shared credited artists.
- Use the import modal’s unmatched tools to correct a row by pasting the correct MusicBrainz recording MBID.

### “CSV import is slow / stalls”

- MusicBrainz can rate-limit (429) or intermittently 503. The importer retries on these with a short delay.

### “Some tracks are consistently unmatched”

Common reasons:

- the playlist artist string doesn’t match the credited artist (e.g. synth voicebank credited as `可不` while CSV says `Kafu`)
- the album name differs between Spotify and MusicBrainz (localized titles / punctuation)

### “Album cover / release is ‘wrong’ after resolving”

MusicBrainz recordings can appear on many releases. SpotiFU resolves a recording MBID first, then selects the best release using official-release preference + album-hint matching. If you care about a specific release, use the release IDs stored on playlist items (`mb_release_id`, `mb_release_group_id`) to hydrate consistently.
