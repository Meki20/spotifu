import difflib
import json
import asyncio
import logging
import time
from fastapi import APIRouter, Query, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select
from database import get_session
from deps import get_current_user
from models import Track, TrackStatus, User
from schemas import TrackOut
from services.providers.musicbrainz import official_releases_latest_first

router = APIRouter(prefix="/search", tags=["search"])
logger = logging.getLogger(__name__)

_TYPE_FILTER = 'type:"Album" OR type:"EP" OR type:"Single"'


def _lucene_escape_phrase(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace('"', '\\"')


def _norm(s: str) -> str:
    return " ".join((s or "").lower().strip().split())


def _sim(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def _pick_best_for_candidate(rows: list[dict], *, artist: str, title: str) -> dict | None:
    """Pick best MB parsed row for (artist,title) from a shared pool."""
    want = f"{artist} {title}".strip()
    best: tuple[float, dict] | None = None
    for r in rows:
        a = r.get("artist") or ""
        t = r.get("title") or ""
        if not a or not t:
            continue
        score = _sim(want, f"{a} {t}".strip())
        if best is None or score > best[0]:
            best = (score, r)
    if best is None:
        return None
    # Conservative floor: avoid totally unrelated picks from a broad OR query.
    return best[1] if best[0] >= 0.78 else None


class SearchResponse(BaseModel):
    tracks: list[TrackOut]


class TrackSection(BaseModel):
    type: str
    label: str
    tracks: list[TrackOut]


class HybridSearchResponse(BaseModel):
    intent: str
    sections: list[TrackSection]


def _track_to_out(t: dict, is_cached: bool = False) -> TrackOut:
    mb_release_id = t.get("mb_release_id")
    if not mb_release_id:
        releases = t.get("releases", [])
        official_latest = official_releases_latest_first(releases)
        if official_latest:
            mb_release_id = official_latest[0].get("id")
    return TrackOut(
        mb_id=t.get("mbid", ""),
        title=t.get("title", ""),
        artist=t.get("artist", ""),
        artist_credit=t.get("artist_credit"),
        album=t.get("album", ""),
        album_cover=t.get("album_cover"),
        preview_url=t.get("preview_url"),
        is_cached=is_cached,
        mb_release_id=mb_release_id,
        mb_release_group_id=t.get("mb_release_group_id"),
        mb_artist_id=t.get("mb_artist_id"),
    )


@router.get("/hybrid", response_model=HybridSearchResponse)
async def hybrid_search(
    q: str = Query(..., min_length=1, max_length=500),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    from services.hybrid_search import HybridSearchService
    from services.track_cache_status import annotate_tracks_is_cached
    svc = HybridSearchService()
    raw = await svc.search(q)

    all_tracks = [t for sec in raw["sections"] for t in sec["tracks"]]
    annotate_tracks_is_cached(session, all_tracks)

    sections = [
        TrackSection(type=sec["type"], label=sec["label"], tracks=[_track_to_out(t, t.get("is_cached", False)) for t in sec["tracks"]])
        for sec in raw["sections"]
    ]
    return HybridSearchResponse(intent=raw["intent"], sections=sections)


@router.get("", response_model=SearchResponse)
async def search(
    q: str = Query(..., min_length=1, max_length=500),
    local: bool = Query(False),
    local_limit: int = Query(20, ge=1, le=1000, description="Max results for local library search"),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    if local:
        return await _local_search(q, session, local_limit)

    from services.providers import MetadataService
    svc = MetadataService(session)
    results = await svc.search(q)

    mb_ids = [r["mbid"] for r in results if r.get("mbid")]
    cached_mb: set[str] = set()
    if mb_ids:
        stmt = select(Track.mb_id).where(Track.mb_id.in_(mb_ids), Track.status == TrackStatus.READY)
        cached_mb = {row for row in session.exec(stmt) if row}

    tracks = []
    for r in results:
        mbid = r.get("mbid", "")
        is_cached = mbid in cached_mb
        mb_release_id = r.get("mb_release_id")
        if not mb_release_id:
            releases = r.get("releases", [])
            official_latest = official_releases_latest_first(releases)
            if official_latest:
                mb_release_id = official_latest[0].get("id")
        tracks.append(TrackOut(
            mb_id=mbid,
            title=r.get("title", ""),
            artist=r.get("artist", ""),
            artist_credit=r.get("artist_credit"),
            album=r.get("album", ""),
            album_cover=r.get("album_cover"),
            preview_url=r.get("preview_url"),
            is_cached=is_cached,
            mb_release_id=mb_release_id,
            mb_artist_id=r.get("mb_artist_id"),
        ))
    return SearchResponse(tracks=tracks)


@router.get("/similar/{mbid}/stream")
async def stream_similar_tracks(
    mbid: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Stream similar tracks for a MusicBrainz recording MBID as NDJSON.

    Non-blocking for the client: yields tracks as they finalize (Last.fm → MB resolve → cover hydrate).
    """
    from services.providers import lastfm
    from services.providers import musicbrainz
    from services.track_cache_status import annotate_tracks_is_cached
    import services.providers as providers

    async def _resolve_one(sim: dict) -> dict | None:
        sim_mbid = (sim.get("mbid") or "").strip()
        title = (sim.get("name") or sim.get("title") or "").strip()
        artist = (sim.get("artist") or "").strip()
        if isinstance(sim.get("artist"), dict):
            artist = (sim["artist"].get("name") or "").strip()

        try:
            if sim_mbid:
                logger.debug("[similar] resolve via MBID %s", sim_mbid)
                row = await musicbrainz.get_track(sim_mbid, include_cover=True)
                return row
        except Exception:
            row = None

        if not title or not artist:
            logger.debug("[similar] skip: missing title/artist (title=%r artist=%r mbid=%r)", title, artist, sim_mbid)
            return None
        try:
            logger.debug("[similar] resolve via text %r / %r", artist, title)
            meta = await musicbrainz.resolve_recording_metadata(title, artist, None)
        except Exception:
            meta = None
        if not meta or not meta.get("mbid"):
            logger.debug("[similar] no MB resolve for %r / %r", artist, title)
            return None
        try:
            logger.debug("[similar] hydrate track %s for %r / %r", meta["mbid"], artist, title)
            return await musicbrainz.get_track(str(meta["mbid"]), include_cover=True)
        except Exception:
            return None

    async def ndjson():
        logger.debug("[similar] stream start mbid=%s", mbid)
        t0 = time.monotonic()

        # ------------------------------------------------------------------
        # Cache: return previously resolved similar tracks immediately.
        # ------------------------------------------------------------------
        cache_kind = "similar_tracks"
        cached = None
        try:
            cached = providers._db_get(cache_kind, mbid)  # type: ignore[attr-defined]
        except Exception:
            cached = None
        if isinstance(cached, dict) and isinstance(cached.get("tracks"), list) and cached["tracks"]:
            cached_tracks: list[dict] = cached["tracks"]
            logger.debug("[similar] cache hit mbid=%s tracks=%d", mbid, len(cached_tracks))
            # Cache entries from older versions may lack artist_credit; treat as stale and rebuild.
            try:
                if any(isinstance(t, dict) and t.get("mbid") and not t.get("artist_credit") for t in cached_tracks):
                    cached = None
                    cached_tracks = []
                    logger.debug("[similar] cache stale (missing artist_credit); rebuilding mbid=%s", mbid)
            except Exception:
                pass
            # Refresh cached 'is_cached' flags on-demand (cheap DB check).
            for t in cached_tracks:
                try:
                    annotate_tracks_is_cached(session, [t])
                except Exception:
                    pass
                out = _track_to_out(t, bool(t.get("is_cached", False)))
                yield (json.dumps({"type": "track", "track": out.model_dump()}) + "\n").encode("utf-8")
            yield (json.dumps({"type": "done", "cached": True}) + "\n").encode("utf-8")
            return
        logger.debug("[similar] cache miss mbid=%s", mbid)

        seed_title = ""
        seed_artist = ""
        # Prefer local DB track row if it exists (fast + works for downloaded/cached tracks).
        try:
            trow = session.exec(
                select(Track).where(Track.mb_id == mbid).where(Track.status == TrackStatus.READY).limit(1)
            ).first()
            if trow:
                seed_title = (trow.title or "").strip()
                seed_artist = (trow.artist or "").strip()
                logger.debug("[similar] seed from DB track row title=%r artist=%r", seed_title, seed_artist)
        except Exception:
            logger.debug("[similar] seed from DB failed (ignored)", exc_info=True)

        try:
            seed = await musicbrainz.get_track(mbid, include_cover=False)
            if seed:
                seed_title = seed_title or str(seed.get("title") or "").strip()
                seed_artist = seed_artist or str(seed.get("artist") or "").strip()
        except Exception:
            seed = None
        if seed_title and seed_artist:
            logger.debug("[similar] seed for fallback artist=%r title=%r", seed_artist, seed_title)
        else:
            logger.debug("[similar] missing seed title/artist (title=%r artist=%r) — lastfm may return 0", seed_title, seed_artist)

        target_yields = 9
        try:
            # Ask for more than we need because not all will resolve via MB.
            # Only use the plain-text lookup (track + artist). MBID-based lookup is unreliable on Last.fm.
            logger.debug("[similar] lastfm lookup via text artist=%r track=%r", seed_artist or None, seed_title or None)
            sims = await lastfm.track_similar(track=seed_title or None, artist=seed_artist or None, limit=20)
        except Exception:
            sims = []
        logger.debug("[similar] lastfm returned %d candidates for mbid=%s", len(sims or []), mbid)

        yielded: set[str] = set()
        yielded_count = 0
        resolved_ok = 0
        resolved_none = 0
        yielded_rows_for_cache: list[dict] = []

        # ------------------------------------------------------------------
        # Fast path: batch MusicBrainz queries (9 candidates per Lucene OR).
        # ------------------------------------------------------------------
        def _sim_text_candidates() -> list[tuple[str, str, dict]]:
            out: list[tuple[str, str, dict]] = []
            for s in sims or []:
                title = (s.get("name") or s.get("title") or "").strip()
                artist = (s.get("artist") or "").strip()
                if isinstance(s.get("artist"), dict):
                    artist = (s["artist"].get("name") or "").strip()
                if title and artist:
                    out.append((artist, title, s))
            return out

        text_candidates = _sim_text_candidates()

        # Next: batch text candidates in chunks of 9.
        chunk_size = 9
        for i in range(0, len(text_candidates), chunk_size):
            if yielded_count >= target_yields:
                break
            chunk = text_candidates[i : i + chunk_size]
            clauses = [
                f'(artist:"{_lucene_escape_phrase(a)}" AND recording:"{_lucene_escape_phrase(t)}")'
                for (a, t, _s) in chunk
            ]
            lucene = (
                f'status:official AND ({_TYPE_FILTER}) AND NOT comment:live AND '
                f"({' OR '.join(clauses)})"
            )
            logger.debug("[similar] MB batch query (%d/%d): %s", i // chunk_size + 1, (len(text_candidates) + chunk_size - 1) // chunk_size, lucene)
            try:
                rows = await musicbrainz.recording_search(lucene, limit=120)
            except Exception as e:
                logger.debug("[similar] MB batch query failed: %s", e)
                rows = []

            # Pick best row per candidate from the shared pool.
            picked: list[dict] = []
            for artist, title, _s in chunk:
                if yielded_count + len(picked) >= target_yields:
                    break
                best_row = _pick_best_for_candidate(rows, artist=artist, title=title)
                if not best_row or not best_row.get("mbid"):
                    continue
                mb = str(best_row["mbid"])
                if mb in yielded or any(str(r.get("mbid")) == mb for r in picked):
                    continue
                picked.append(best_row)

            # Hydrate covers for picked rows in parallel (CAA).
            try:
                if picked:
                    await musicbrainz._hydrate_release_covers(picked, size=musicbrainz.CAA_SIZE_LIST)
            except Exception:
                pass

            # Now yield picked rows.
            for row in picked:
                if yielded_count >= target_yields:
                    break
                mb = str(row.get("mbid") or "")
                if not mb or mb in yielded:
                    continue
                try:
                    annotate_tracks_is_cached(session, [row])
                except Exception:
                    pass
                out = _track_to_out(row, bool(row.get("is_cached", False)))
                logger.debug("[similar] yield(batch) mbid=%s title=%r artist=%r", out.mb_id, out.title, out.artist)
                yield (json.dumps({"type": "track", "track": out.model_dump()}) + "\n").encode("utf-8")
                yielded.add(mb)
                yielded_count += 1
                yielded_rows_for_cache.append(row)

        # ------------------------------------------------------------------
        # Slow fallback: per-track resolve for anything we didn't get yet.
        # ------------------------------------------------------------------
        if yielded_count < target_yields:
            sem = asyncio.Semaphore(4)

            async def _guarded(sim: dict) -> dict | None:
                async with sem:
                    return await _resolve_one(sim)

            tasks = [asyncio.create_task(_guarded(sim)) for sim in (sims or [])]
            for fut in asyncio.as_completed(tasks):
                if yielded_count >= target_yields:
                    for t in tasks:
                        if not t.done():
                            t.cancel()
                    break
                try:
                    row = await fut
                except Exception:
                    row = None
                if not row or not row.get("mbid"):
                    resolved_none += 1
                    continue
                mb = str(row["mbid"])
                if mb in yielded:
                    continue
                yielded.add(mb)
                yielded_count += 1
                resolved_ok += 1

                try:
                    annotate_tracks_is_cached(session, [row])
                except Exception:
                    pass

                out = _track_to_out(row, bool(row.get("is_cached", False)))
                logger.debug("[similar] yield(fallback) mbid=%s title=%r artist=%r", out.mb_id, out.title, out.artist)
                yield (json.dumps({"type": "track", "track": out.model_dump()}) + "\n").encode("utf-8")
                yielded_rows_for_cache.append(row)

        logger.debug(
            "[similar] stream done mbid=%s yielded=%d resolved_ok=%d resolved_none=%d",
            mbid,
            yielded_count,
            resolved_ok,
            resolved_none,
        )
        logger.debug("[similar] total stream time mbid=%s %.2fs", mbid, time.monotonic() - t0)
        # Persist cache for instant next-time results.
        try:
            if yielded_rows_for_cache:
                providers._db_set(cache_kind, mbid, {"tracks": yielded_rows_for_cache})  # type: ignore[attr-defined]
                logger.debug("[similar] cache saved mbid=%s tracks=%d", mbid, len(yielded_rows_for_cache))
        except Exception:
            logger.debug("[similar] cache save failed", exc_info=True)
        yield (json.dumps({"type": "done"}) + "\n").encode("utf-8")

    return StreamingResponse(ndjson(), media_type="application/x-ndjson")


async def _local_search(q: str, session: Session, local_limit: int) -> SearchResponse:
    q_lower = q.lower()
    q_pattern = f"%{q_lower}%"
    stmt = (
        select(Track)
        .where(Track.status == TrackStatus.READY)
        .where((Track.title.ilike(q_pattern)) | (Track.artist.ilike(q_pattern)))
        .limit(1000)
    )
    all_tracks = list(session.exec(stmt))
    scored = []
    for track in all_tracks:
        candidate = f"{track.title} {track.artist}".lower()
        ratio = difflib.SequenceMatcher(None, q_lower, candidate).ratio()
        if ratio > 0.3:
            scored.append((ratio, track))
    scored.sort(key=lambda x: x[0], reverse=True)
    return SearchResponse(tracks=[
        TrackOut(
            mb_id=t.mb_id or "",
            track_id=t.id,
            title=t.title,
            artist=t.artist,
            artist_credit=t.artist_credit,
            album=t.album,
            album_cover=t.album_cover,
            preview_url=None,
            is_cached=True,
            local_stream_url=f"/stream/{t.id}" if t.local_file_path else None,
        )
        for _, t in scored[:local_limit]
    ])