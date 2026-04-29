"""Startup reconciliation: fix tracks stuck in FETCHING after crash/restart.

Also backfills missing mb_ids for all READY tracks.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Optional

from sqlmodel import Session, select

from database import engine
from models import Track, TrackStatus
from services.soulseek import CACHE_DIR

logger = logging.getLogger(__name__)

_AUDIO_EXTS = {".flac", ".mp3", ".m4a", ".ogg", ".opus", ".wav", ".aac"}


def _normalize(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def _tokens(s: str) -> set[str]:
    return {t for t in _normalize(s).split() if len(t) > 1}


_MAX_CACHE_WALK = 200_000


def _list_cache_files() -> list[str]:
    if not os.path.isdir(CACHE_DIR):
        return []
    out: list[str] = []
    for root, _dirs, files in os.walk(CACHE_DIR):
        for f in files:
            if len(out) >= _MAX_CACHE_WALK:
                logger.warning(
                    "Cache walk hit cap (%d files); some orphans may be missed this run",
                    _MAX_CACHE_WALK,
                )
                return out
            if os.path.splitext(f)[1].lower() in _AUDIO_EXTS:
                out.append(os.path.join(root, f))
    return out


def _find_match(artist: str, title: str, files: list[str]) -> Optional[str]:
    title_toks = _tokens(title)
    artist_toks = _tokens(artist)
    if not title_toks:
        return None

    # Require at least 1 artist token hit to be considered
    MIN_ARTIST_HITS = 1
    # Minimum composite score to accept a match (leave FETCHING otherwise)
    MIN_SCORE = 2

    # Sort by specificity: longer path = more specific = processed first
    sorted_files = sorted(files, key=lambda p: len(os.path.basename(p)), reverse=True)

    best: tuple[int, str] | None = None
    for path in sorted_files:
        name_toks = _tokens(os.path.basename(path))
        if not title_toks.issubset(name_toks):
            continue
        artist_hits = len(artist_toks & name_toks)
        if artist_hits < MIN_ARTIST_HITS:
            continue
        score = artist_hits * 10 + len(name_toks & title_toks)
        if score < MIN_SCORE:
            continue
        if best is None or score > best[0]:
            best = (score, path)
    return best[1] if best else None


def reconcile_stuck_tracks() -> None:
    """Runs at startup. Claims orphan files, else demotes FETCHING → ERROR."""
    files = _list_cache_files()
    claimed: set[str] = set()
    claimed_count = 0
    demoted_count = 0

    with Session(engine) as session:
        rows = session.exec(
            select(Track).where(Track.status == TrackStatus.FETCHING)
        ).all()

        for track in rows:
            match = _find_match(track.artist, track.title, [f for f in files if f not in claimed])
            if match:
                track.status = TrackStatus.READY
                track.local_file_path = match
                claimed.add(match)
                claimed_count += 1
                logger.info(
                    "Reconciled track %s (%s - %s) → %s",
                    track.id, track.artist, track.title, match,
                )
            else:
                track.status = TrackStatus.ERROR
                demoted_count += 1
                logger.info(
                    "Demoted stuck track %s (%s - %s) to ERROR",
                    track.id, track.artist, track.title,
                )
        if rows:
            session.commit()

        missing = 0
        _BATCH = 100
        last_id = 0
        while True:
            ready_batch = session.exec(
                select(Track)
                .where(Track.status == TrackStatus.READY, Track.id > last_id)
                .order_by(Track.id)
                .limit(_BATCH)
            ).all()
            if not ready_batch:
                break
            last_id = ready_batch[-1].id
            changed = False
            for track in ready_batch:
                if not track.local_file_path or not os.path.isfile(track.local_file_path):
                    track.status = TrackStatus.ERROR
                    track.local_file_path = None
                    missing += 1
                    changed = True
            if changed:
                session.commit()
            if len(ready_batch) < _BATCH:
                break

    logger.info(
        "Reconcile: claimed=%d demoted=%d missing_files=%d",
        claimed_count, demoted_count, missing,
    )


def _fetch_ready_no_mb_batch(after_id: int, limit: int) -> list[Track]:
    with Session(engine) as session:
        return list(
            session.exec(
                select(Track)
                .where(
                    Track.status == TrackStatus.READY,
                    Track.mb_id == None,  # noqa: E711
                    Track.id > after_id,
                )
                .order_by(Track.id)
                .limit(limit)
            ).all()
        )


def _apply_mb_ids(updates: list[tuple[int, str]]) -> None:
    with Session(engine) as session:
        for tid, mb in updates:
            t = session.get(Track, tid)
            if t is not None and t.mb_id is None:
                t.mb_id = mb
                session.add(t)
        session.commit()


MIN_MB_SCORE = 70


async def reconcile_provider_ids() -> None:
    """Backfill missing mb_ids for all READY tracks.

    Runs once at startup. For each READY track without an mb_id, ask
    MusicBrainz to resolve it. MusicBrainz limits to ~1 req/sec per IP —
    we throttle to 1.5s between calls.

    Only backfills for 100% sure matches: requires "full" mode (artist + title + album)
    and high MB score (>= MIN_MB_SCORE).
    """
    from services.providers import musicbrainz

    logger.info("Starting provider ID reconciliation (strict: full mode + score >= %d)...", MIN_MB_SCORE)

    filled_count = 0
    skipped_not_strict = 0
    _BATCH = 100
    after_id = 0
    while True:
        batch = await asyncio.to_thread(_fetch_ready_no_mb_batch, after_id, _BATCH)
        if not batch:
            break
        after_id = batch[-1].id
        updates: list[tuple[int, str]] = []
        for track in batch:
            logger.debug(
                "Processing track %s: artist=%r, title=%r, album=%r",
                track.id, track.artist, track.title, track.album,
            )
            mb_id = None
            try:
                async with musicbrainz.mb_prefetch_calls():
                    meta = await musicbrainz.resolve_recording_metadata(
                        track.title, track.artist, track.album
                    )
                if meta:
                    phase = meta.get("_resolve_phase", "")
                    score = meta.get("mb_score", 0)
                    if phase == "full" and score >= MIN_MB_SCORE:
                        mb_id = meta.get("mbid")
                        logger.debug(
                            "Track %s matched: phase=%s score=%d",
                            track.id, phase, score,
                        )
                    else:
                        logger.debug(
                            "Track %s skipped: phase=%r score=%d (need 'full' + score >= %d)",
                            track.id, phase, score, MIN_MB_SCORE,
                        )
                        skipped_not_strict += 1
            except Exception as e:
                logger.warning("mb resolve ERROR: %s", e)
            if mb_id:
                updates.append((track.id, mb_id))
                filled_count += 1
            await asyncio.sleep(1.5)
        if updates:
            await asyncio.to_thread(_apply_mb_ids, updates)

    logger.info("Provider ID reconciliation done. Filled %d mb_ids, skipped %d (not strict enough).", filled_count, skipped_not_strict)