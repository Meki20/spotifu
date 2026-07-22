#!/usr/bin/env bash
# SpotiFU deploy wrapper. Subcommands:
#   deploy            run wizard then up (default)
#   deploy wizard     interactive setup wizard -> writes ./.secrets
#   deploy up         start containers (requires valid .secrets)
#   deploy dev        start containers with live code mount + auto-reload
#   deploy down       stop containers (keep volumes)
#   deploy reset      stop containers AND delete volumes
#   deploy logs       tail server logs
#   deploy ps         show container status
#
# Single supported deploy mode is docker compose. No native Python.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] docker not found in PATH." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[deploy] docker compose plugin / docker-compose not found." >&2
  exit 1
fi

cmd_wizard() {
  echo "[deploy] launching setup wizard in container..."
  "${COMPOSE[@]}" run --rm --build server python -m setup_wizard
}

cmd_up() {
  # Gate: refuse to start without a populated .secrets.
  if ! "${COMPOSE[@]}" run --rm server python -m setup_wizard --check >/dev/null 2>&1; then
    echo "[deploy] .secrets missing or invalid." >&2
    echo "[deploy] run: bash scripts/deploy.sh wizard" >&2
    exit 1
  fi
  echo "[deploy] starting services..."
  "${COMPOSE[@]}" up -d --build --wait
  echo
  echo "[deploy] up. Try:"
  echo "  curl -fsS http://localhost:1985/health/ready"
  echo "  docker compose logs -f server"
}

cmd_dev() {
  if ! "${COMPOSE[@]}" run --rm server python -m setup_wizard --check >/dev/null 2>&1; then
    echo "[deploy] .secrets missing or invalid." >&2
    echo "[deploy] run: bash scripts/deploy.sh wizard" >&2
    exit 1
  fi
  echo "[deploy] starting dev services with live code mount + auto-reload..."
  "${COMPOSE[@]}" -f docker-compose.yml -f docker-compose.dev.yml up -d --wait
  echo
  echo "[deploy] dev server up. Edit server/ code and it auto-reloads."
}

cmd_down() {
  "${COMPOSE[@]}" down
}

cmd_reset() {
  echo "[deploy] deleting all volumes (DB + cache)..."
  "${COMPOSE[@]}" down -v
}

cmd_logs() {
  "${COMPOSE[@]}" logs -f server
}

cmd_ps() {
  "${COMPOSE[@]}" ps
}

usage() {
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-deploy}" in
  wizard) cmd_wizard ;;
  up)     cmd_up ;;
  dev)    cmd_dev ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  logs)   cmd_logs ;;
  ps)     cmd_ps ;;
  -h|--help|help) usage ;;
  deploy|install|"")
    cmd_wizard
    cmd_up
    ;;
  *)
    usage
    exit 1
    ;;
esac
