"""SpotiFU first-run setup wizard.

Runs inside the server container via `docker compose run --rm server python -m setup_wizard`.
Pure stdlib — does NOT import `main.py`, `auth.py`, or `services.*` so it has no
FastAPI/aioslsk transitive imports.

Writes `./.secrets` (bind-mounted to `/app/.secrets` in compose) atomically with mode 0600.

Modes:
  python -m setup_wizard            interactive wizard
  python -m setup_wizard --check    non-interactive: exit 0 if .secrets valid, else 1
  python -m setup_wizard --print-only  report missing/valid fields, write nothing

Named `setup_wizard.py` (not `setup.py`) to avoid Python's setuptools collision
on `python -m setup`.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import secrets
import sys
from pathlib import Path

SECRETS_PATH = Path(os.environ.get("SECRETS_FILE", "/app/.secrets"))
MIN_SECRET_LEN = 32
FORBIDDEN_JWT = {"", "change-me-in-production", "changeme", "secret"}

PROMPT = "SpotiFU first-time setup"
RULE = "=" * len(PROMPT)


def _read_existing() -> dict:
    if not SECRETS_PATH.exists():
        return {}
    try:
        with open(SECRETS_PATH) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _atomic_write(data: dict) -> None:
    tmp = SECRETS_PATH.with_suffix(SECRETS_PATH.suffix + ".tmp")
    try:
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, SECRETS_PATH)
        os.chmod(SECRETS_PATH, 0o600)
    except Exception:
        if tmp.exists():
            try:
                tmp.unlink()
            except Exception:
                pass
        raise


def _validate_jwt(value: str) -> str | None:
    v = value.strip()
    if not v:
        return "JWT secret cannot be empty"
    if v in FORBIDDEN_JWT:
        return "JWT secret is a known placeholder; generate a fresh one"
    if len(v) < MIN_SECRET_LEN:
        return f"JWT secret must be at least {MIN_SECRET_LEN} chars (got {len(v)})"
    return None


def _validate_required(value: str, field: str) -> str | None:
    v = value.strip()
    if not v:
        return f"{field} cannot be empty"
    return None


def _check(data: dict) -> list[str]:
    """Return a list of human-readable problems; empty list = valid."""
    problems: list[str] = []
    if err := _validate_required(data.get("soulseek_username", ""), "soulseek_username"):
        problems.append(err)
    if err := _validate_required(data.get("soulseek_password", ""), "soulseek_password"):
        problems.append(err)
    if err := _validate_jwt(data.get("jwt_secret", "")):
        problems.append(err)
    return problems


def _print_only(data: dict) -> int:
    problems = _check(data)
    print("SpotiFU .secrets status")
    print("-" * 24)
    print(f"  path:                  {SECRETS_PATH}")
    print(f"  exists:                {SECRETS_PATH.exists()}")
    print(f"  jwt_secret:            {'present' if data.get('jwt_secret') else 'MISSING'}")
    print(f"  soulseek_username:     {data.get('soulseek_username') or 'MISSING'}")
    print(f"  soulseek_password:     {'set' if data.get('soulseek_password') else 'MISSING'}")
    print(f"  lastfm_api_key:        {'set' if data.get('lastfm_api_key') else 'unset (optional)'}")
    print(f"  fanarttv_api_key:      {'set' if data.get('fanarttv_api_key') else 'unset (optional)'}")
    if problems:
        print()
        print("Problems:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print()
    print("OK: .secrets is valid.")
    return 0


def _prompt(label: str, default: str = "", secret: bool = False) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        try:
            if secret:
                value = getpass.getpass(f"{label}{suffix}: ")
            else:
                value = input(f"{label}{suffix}: ")
        except (EOFError, KeyboardInterrupt):
            print("\n[setup] aborted.")
            sys.exit(130)
        value = value.strip()
        if not value and default:
            return default
        if value:
            return value
        print("  value cannot be empty (Ctrl-C to abort).")


def _wizard() -> int:
    if not sys.stdin.isatty():
        print(
            "[setup] no TTY available — run via:\n"
            "  docker compose run --rm server python -m setup_wizard\n"
            "or use --check / --print-only for non-interactive use.",
            file=sys.stderr,
        )
        return 2

    existing = _read_existing()

    print(PROMPT)
    print(RULE)
    print()
    print(f"This writes {SECRETS_PATH} (bind-mounted into the server container).")
    if SECRETS_PATH.exists():
        print("Existing .secrets detected — values will be preserved unless overwritten.")
    print()

    # 1. Soulseek
    print("[1/4] Soulseek credentials (required)")
    sl_user = _prompt(
        "Soulseek username",
        default=existing.get("soulseek_username", ""),
    )
    sl_pass = _prompt(
        "Soulseek password",
        default=existing.get("soulseek_password", ""),
        secret=True,
    )
    print()

    # 2. Last.fm (optional)
    print("[2/4] Last.fm API key (optional, Enter to skip)")
    print("       Get one at: https://www.last.fm/api/account/create")
    lastfm = _prompt("Last.fm API key", default=existing.get("lastfm_api_key", ""))
    print()

    # 3. fanart.tv (optional)
    print("[3/4] fanart.tv API key (optional, Enter to skip)")
    print("       Get one at: https://fanart.tv/get-an-api-key/")
    fanart = _prompt("fanart.tv API key", default=existing.get("fanarttv_api_key", ""))
    print()

    # 4. JWT secret
    print("[4/4] JWT signing secret")
    print("       A fresh random secret will be generated.")
    print("       Press Enter to accept, or paste your own (min 32 chars).")
    while True:
        raw = _prompt("JWT secret", default="(generate)", secret=True)
        if raw == "(generate)":
            jwt_secret = secrets.token_urlsafe(48)
            print(f"       generated ({len(jwt_secret)} chars).")
            break
        err = _validate_jwt(raw)
        if err is None:
            jwt_secret = raw
            break
        print(f"  {err}")

    data = {
        "jwt_secret": jwt_secret,
        "soulseek_username": sl_user,
        "soulseek_password": sl_pass,
        "lastfm_api_key": lastfm,
        "fanarttv_api_key": fanart,
    }

    # Merge any keys we didn't prompt for (forward compat).
    for k, v in existing.items():
        data.setdefault(k, v)

    _atomic_write(data)
    print()
    print(f"[setup] wrote {SECRETS_PATH} (mode 0600).")
    print("[setup] run `bash scripts/deploy.sh up` (or `bash scripts/deploy.sh dev` for live-reload) to start.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="setup", description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="exit 0 if .secrets is valid")
    group.add_argument("--print-only", action="store_true", help="report status, write nothing")
    args = parser.parse_args(argv)

    data = _read_existing()

    if args.print_only:
        return _print_only(data)
    if args.check:
        problems = _check(data)
        if problems:
            for p in problems:
                print(f"[setup] {p}", file=sys.stderr)
            return 1
        return 0
    return _wizard()


if __name__ == "__main__":
    raise SystemExit(main())
