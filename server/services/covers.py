from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import text
from sqlmodel import Session, select

from database import engine

logger = logging.getLogger(__name__)

EntityKind = Literal["recording", "release", "release_group"]

_POS_TTL = timedelta(days=180)
_NEG_TTL = timedelta(hours=24)


@dataclass(frozen=True)
class CoverResult:
    url: str | None
    hit: bool


def _now_utc() -> datetime:
    return datetime.utcnow()


def _read_cached_cover(session: Session, *, entity_kind: EntityKind, entity_id: str) -> CoverResult | None:
    row = session.exec(
        text(
            """
            SELECT
                cl.found AS found,
                cl.fetched_at AS fetched_at,
                ca.url AS url
            FROM cover_links cl
            LEFT JOIN cover_assets ca ON ca.id = cl.asset_id
            WHERE cl.entity_kind = :kind AND cl.entity_id = :eid
            LIMIT 1
            """
        ),
        params={"kind": entity_kind, "eid": entity_id},
    ).first()

    if not row:
        return None

    found, fetched_at, url = row
    try:
        age = _now_utc() - fetched_at
    except Exception:
        age = _POS_TTL

    if bool(found):
        if age <= _POS_TTL:
            return CoverResult(url=str(url) if url else None, hit=True)
        # stale positive: return stale but treat as miss to refresh
        return None

    # negative cached miss
    if age <= _NEG_TTL:
        return CoverResult(url=None, hit=True)
    return None


def _upsert_asset(session: Session, *, url: str) -> int:
    row = session.exec(
        text(
            """
            INSERT INTO cover_assets (url, created_at)
            VALUES (:url, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
            ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
            RETURNING id
            """
        ),
        params={"url": url},
    ).first()
    if row:
        return int(row[0])
    # Fallback path: select
    row2 = session.exec(
        text("SELECT id FROM cover_assets WHERE url = :url LIMIT 1"),
        params={"url": url},
    ).first()
    if not row2:
        raise RuntimeError("failed to upsert cover asset")
    return int(row2[0])


def _upsert_link(
    session: Session,
    *,
    entity_kind: EntityKind,
    entity_id: str,
    asset_id: int | None,
    found: bool,
    fetched_at: datetime | None = None,
) -> None:
    session.exec(
        text(
            """
            INSERT INTO cover_links (entity_kind, entity_id, asset_id, found, fetched_at)
            VALUES (:kind, :eid, :asset_id, :found, :fetched_at)
            ON CONFLICT (entity_kind, entity_id) DO UPDATE SET
                asset_id = EXCLUDED.asset_id,
                found = EXCLUDED.found,
                fetched_at = EXCLUDED.fetched_at
            """
        ),
        params={
            "kind": entity_kind,
            "eid": entity_id,
            "asset_id": asset_id,
            "found": bool(found),
            "fetched_at": fetched_at or _now_utc(),
        },
    )


async def _fetch_cover_url(kind: EntityKind, entity_id: str) -> tuple[str | None, dict[str, str] | None]:
    """
    Fetch cover for the requested entity.

    Returns:
      (url, meta_ids)
        - url: cover url or None
        - meta_ids: optional mapping of discovered ids: {release, release_group}
    """
    from services.providers import musicbrainz

    if kind == "release_group":
        # Uses existing provider helper (may still touch legacy MBEntityCache; ok for now).
        from services.providers.musicbrainz import _caa_release_group_front_url, CAA_SIZE_LIST

        async with musicbrainz.mb_interactive_calls():
            url = await _caa_release_group_front_url(entity_id, CAA_SIZE_LIST)
        return (url if isinstance(url, str) and url else None), None

    if kind == "release":
        from services.providers.musicbrainz import _caa_front_url, CAA_SIZE_LIST

        async with musicbrainz.mb_interactive_calls():
            url = await _caa_front_url(entity_id, CAA_SIZE_LIST)
        return (url if isinstance(url, str) and url else None), None

    # recording
    async with musicbrainz.mb_interactive_calls():
        meta = await musicbrainz.get_track(entity_id)
    url = (meta or {}).get("album_cover")
    url_str = url if isinstance(url, str) and url else None
    meta_ids: dict[str, str] = {}
    rid = (meta or {}).get("mb_release_id")
    rgid = (meta or {}).get("mb_release_group_id")
    if isinstance(rid, str) and rid:
        meta_ids["release"] = rid
    if isinstance(rgid, str) and rgid:
        meta_ids["release_group"] = rgid

    # If MB didn't give us release IDs (e.g. no official_pick), derive them from raw recording payload.
    if not meta_ids.get("release") and not meta_ids.get("release_group"):
        try:
            from services.providers.musicbrainz import _get_recording_with_releases, official_releases_latest_first

            async with musicbrainz.mb_interactive_calls():
                raw = await _get_recording_with_releases(entity_id)
            release_list = (raw or {}).get("releases") or []
            if isinstance(release_list, list) and release_list:
                official = official_releases_latest_first(release_list)
                primary = official[0] if official else (release_list[0] if isinstance(release_list[0], dict) else {})
                if isinstance(primary, dict):
                    rid2 = primary.get("id")
                    if isinstance(rid2, str) and rid2:
                        meta_ids["release"] = rid2
                    rg = primary.get("release-group") or {}
                    if isinstance(rg, dict):
                        rgid2 = rg.get("id")
                        if isinstance(rgid2, str) and rgid2:
                            meta_ids["release_group"] = rgid2
        except Exception:
            pass

    # Fallback: if recording cover is missing, try album cover via RG/release.
    if not url_str:
        try:
            from services.providers.musicbrainz import (
                _caa_front_url,
                _caa_release_group_front_url,
                CAA_SIZE_LIST,
            )

            async with musicbrainz.mb_interactive_calls():
                if meta_ids.get("release_group"):
                    u = await _caa_release_group_front_url(meta_ids["release_group"], CAA_SIZE_LIST)
                    if isinstance(u, str) and u:
                        url_str = u
                if not url_str and meta_ids.get("release"):
                    u = await _caa_front_url(meta_ids["release"], CAA_SIZE_LIST)
                    if isinstance(u, str) and u:
                        url_str = u
        except Exception:
            pass
    return url_str, (meta_ids or None)


async def get_cover_url(entity_kind: EntityKind, entity_id: str) -> CoverResult:
    entity_id = (entity_id or "").strip()
    if not entity_id:
        return CoverResult(url=None, hit=True)

    with Session(engine) as session:
        cached = _read_cached_cover(session, entity_kind=entity_kind, entity_id=entity_id)
        if cached is not None:
            return cached

    url, meta_ids = await _fetch_cover_url(entity_kind, entity_id)

    with Session(engine) as session:
        if url:
            asset_id = _upsert_asset(session, url=url)
            _upsert_link(session, entity_kind=entity_kind, entity_id=entity_id, asset_id=asset_id, found=True)
            # Opportunistic linking for discovered IDs improves future hit rates.
            if meta_ids:
                if meta_ids.get("release"):
                    _upsert_link(
                        session,
                        entity_kind="release",
                        entity_id=meta_ids["release"],
                        asset_id=asset_id,
                        found=True,
                    )
                if meta_ids.get("release_group"):
                    _upsert_link(
                        session,
                        entity_kind="release_group",
                        entity_id=meta_ids["release_group"],
                        asset_id=asset_id,
                        found=True,
                    )
        else:
            _upsert_link(session, entity_kind=entity_kind, entity_id=entity_id, asset_id=None, found=False)
        session.commit()

    return CoverResult(url=url, hit=False)


async def get_cover_urls_batch(entity_kind: EntityKind, ids: list[str]) -> dict[str, str | None]:
    # Basic sequential batch (keeps logic simple; can be optimized later).
    out: dict[str, str | None] = {}
    for raw in ids or []:
        k = (raw or "").strip()
        if not k:
            continue
        try:
            res = await get_cover_url(entity_kind, k)
            out[k] = res.url
        except Exception:
            logger.debug("cover batch fetch failed kind=%s id=%s", entity_kind, k, exc_info=True)
            out[k] = None
    return out


def lookup_cached_cover_best_effort(
    session: Session,
    *,
    recording_id: str | None,
    release_id: str | None,
    release_group_id: str | None,
) -> str | None:
    """Single-query lookup for best cached cover URL by priority.

    Priority: recording → release → release_group.
    Only considers positive hits (found=true).
    """
    clauses: list[str] = []
    params: dict[str, str] = {}

    if recording_id:
        clauses.append("(cl.entity_kind = 'recording' AND cl.entity_id = :rec)")
        params["rec"] = recording_id
    if release_id:
        clauses.append("(cl.entity_kind = 'release' AND cl.entity_id = :rel)")
        params["rel"] = release_id
    if release_group_id:
        clauses.append("(cl.entity_kind = 'release_group' AND cl.entity_id = :rg)")
        params["rg"] = release_group_id

    if not clauses:
        return None

    where = " OR ".join(clauses)
    row = session.exec(
        text(
            f"""
            SELECT ca.url
            FROM cover_links cl
            JOIN cover_assets ca ON ca.id = cl.asset_id
            WHERE cl.found = TRUE AND ({where})
            ORDER BY CASE cl.entity_kind
                WHEN 'recording' THEN 1
                WHEN 'release' THEN 2
                WHEN 'release_group' THEN 3
                ELSE 9
            END,
            cl.fetched_at DESC
            LIMIT 1
            """
        ),
        params=params,
    ).first()
    if not row:
        return None
    url = row[0]
    return str(url) if url else None


def attach_playlist_style_covers_mbentity_cache(session: Session, rows: list[Any]) -> None:
    """Fill ``album_cover`` in-memory like playlist GET: MBEntityCache ``cover_release`` / ``cover_rg`` only (no network).

    Accepts row dicts (hybrid/search) or ORM objects (``PlaylistItem``) with ``album_cover``, ``mb_release_id``,
    ``mb_release_group_id``.
    """
    from models import MBEntityCache

    def _cover(r: Any) -> Any:
        return r.get("album_cover") if isinstance(r, dict) else getattr(r, "album_cover", None)

    def _rel(r: Any) -> str | None:
        v = r.get("mb_release_id") if isinstance(r, dict) else getattr(r, "mb_release_id", None)
        return str(v).strip() if v else None

    def _rg(r: Any) -> str | None:
        v = r.get("mb_release_group_id") if isinstance(r, dict) else getattr(r, "mb_release_group_id", None)
        return str(v).strip() if v else None

    def _set_cover(r: Any, url: str) -> None:
        if isinstance(r, dict):
            r["album_cover"] = url
        else:
            r.album_cover = url

    want_release: dict[str, list[Any]] = {}
    want_rg: dict[str, list[Any]] = {}
    for r in rows:
        if not r or _cover(r):
            continue
        rel, rg = _rel(r), _rg(r)
        if rel:
            want_release.setdefault(rel, []).append(r)
        elif rg:
            want_rg.setdefault(rg, []).append(r)

    keys: list[str] = []
    keys.extend([f"cover_release:{rid}" for rid in want_release.keys()])
    keys.extend([f"cover_rg:{rgid}" for rgid in want_rg.keys()])
    if not keys:
        return
    try:
        rows_cache = session.exec(select(MBEntityCache).where(MBEntityCache.key.in_(keys))).all()
        payload_by_key: dict[str, dict] = {}
        for ent in rows_cache:
            try:
                payload_by_key[ent.key] = json.loads(ent.payload)
            except Exception:
                continue

        for rid, its in want_release.items():
            p = payload_by_key.get(f"cover_release:{rid}") or {}
            if p.get("found") is True and p.get("url"):
                u = str(p["url"])
                for it in its:
                    _set_cover(it, u)

        for rgid, its in want_rg.items():
            p = payload_by_key.get(f"cover_rg:{rgid}") or {}
            if p.get("found") is True and p.get("url"):
                u = str(p["url"])
                for it in its:
                    _set_cover(it, u)
    except Exception:
        pass
