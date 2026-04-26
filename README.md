# SpotiFU

Soulseek music player with Spotify-like UI. Search and stream music from the Soulseek network.

## Architecture

- **Client** — React + TypeScript + TailwindCSS + Vite, runs on port 1984
- **Server** — FastAPI + SQLModel + aioslsk (Soulseek protocol), runs on port 1985
- **Database** — PostgreSQL 16 (docker-managed)

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
- Soulseek credentials in `server/.env`

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
| `SECRETS_FILE` | `/home/lukaarch/Documents/src/SpotiFU/.secrets` | Path to `.secrets` file (Docker: `/app/.secrets`) |

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
