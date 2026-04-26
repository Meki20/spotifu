"""User JSON preferences (stored on ``User.preferences_json``)."""

from __future__ import annotations

import json
from typing import Any

from sqlmodel import Session

from models import User

PREFETCH_DEFAULTS: dict[str, bool] = {
    "enabled": True,
    "hover_metadata": True,
    "album_tracklists": True,
    "artist_idle": True,
    "hybrid_stale_refresh": True,
}


def load_preferences_dict(user: User | None) -> dict[str, Any]:
    if not user or not (user.preferences_json or "").strip():
        return {}
    try:
        return json.loads(user.preferences_json)
    except Exception:
        return {}


def save_preferences_dict(session: Session, user: User, data: dict[str, Any]) -> None:
    user.preferences_json = json.dumps(data)
    session.add(user)
    session.commit()


def get_stored_prefetch_prefs(user: User | None) -> dict[str, bool]:
    """DB values merged with defaults (no master switch cascade)."""
    raw = load_preferences_dict(user).get("prefetch")
    if not isinstance(raw, dict):
        raw = {}
    out = dict(PREFETCH_DEFAULTS)
    for k in PREFETCH_DEFAULTS:
        if k in raw:
            try:
                out[k] = bool(raw[k])
            except Exception:
                pass
    return out


def get_prefetch_prefs(user: User | None) -> dict[str, bool]:
    """Effective prefetch flags for server enforcement (master off disables all)."""
    out = get_stored_prefetch_prefs(user)
    if not out["enabled"]:
        for k in list(out.keys()):
            if k != "enabled":
                out[k] = False
    return out


def merge_prefetch_into_user(session: Session, user: User, patch: dict[str, Any]) -> None:
    """Merge ``patch`` into user.preferences_json under ``prefetch``."""
    base = load_preferences_dict(user)
    prev_pf = base.get("prefetch")
    if not isinstance(prev_pf, dict):
        prev_pf = {}
    merged_pf = {**prev_pf}
    for k, v in patch.items():
        if k in PREFETCH_DEFAULTS:
            merged_pf[k] = bool(v)
    base["prefetch"] = merged_pf
    save_preferences_dict(session, user, base)
