#!/usr/bin/env bash
# SpotiFU installer wrapper. Subcommands:
#   install           run wizard then up (default)
#   install wizard    interactive setup wizard -> writes ./.secrets
#   install up        start containers (requires valid .secrets)
#   install down      stop containers (keep volumes)
#   install reset     stop containers AND delete volumes
#   install logs      tail server logs
#   install ps        show container status
#
# Single supported deploy mode is docker compose. No native Python.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "[install] docker not found in PATH." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "[install] docker compose plugin / docker-compose not found." >&2
  exit 1
fi

cmd_wizard() {
  echo "[install] launching setup wizard in container..."
  "${COMPOSE[@]}" run --rm --build server python -m setup_wizard
}

cmd_up() {
  # Gate: refuse to start without a populated .secrets.
  if ! "${COMPOSE[@]}" run --rm server python -m setup_wizard --check >/dev/null 2>&1; then
    echo "[install] .secrets missing or invalid." >&2
    echo "[install] run: bash scripts/install.sh wizard" >&2
    exit 1
  fi
  echo "[install] starting services..."
  "${COMPOSE[@]}" up -d --build --wait
  echo
  echo "[install] up. Try:"
  echo "  curl -fsS http://localhost:1985/health/ready"
  echo "  docker compose logs -f server"
}

cmd_down() {
  "${COMPOSE[@]}" down
}

cmd_reset() {
  echo "[install] deleting all volumes (DB + cache)..."
  "${COMPOSE[@]}" down -v
}

cmd_logs() {
  "${COMPOSE[@]}" logs -f server
}

cmd_ps() {
  "${COMPOSE[@]}" ps
}

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-install}" in
  wizard) cmd_wizard ;;
  up)     cmd_up ;;
  down)   cmd_down ;;
  reset)  cmd_reset ;;
  logs)   cmd_logs ;;
  ps)     cmd_ps ;;
  -h|--help|help) usage ;;
  install|"")
    cmd_wizard
    cmd_up
    ;;
  *)
    usage
    exit 1
    ;;
esac
