import difflib
import json
import logging
import time
import asyncio
from fastapi import APIRouter, Query, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select
from database import get_session
from deps import get_current_user, require_permission, CurrentUser
from models import SearchHistory
from models import Track, TrackStatus, User
from schemas import TrackOut
from services.covers import attach_playlist_style_covers_mbentity_cache
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
    request: Request,
    q: str = Query(..., min_length=1, max_length=500),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    from services.hybrid_search import HybridSearchService
    from services.providers import musicbrainz
    from services.track_cache_status import annotate_tracks_is_cached
    from services.user_preferences import get_prefetch_prefs

    svc = HybridSearchService()
    pf = get_prefetch_prefs(user)
    try:
        async with musicbrainz.mb_interactive_calls():
            raw = await svc.search(q, prefetch_prefs=pf, is_cancelled=request.is_disconnected)
    except asyncio.CancelledError:
        return HybridSearchResponse(intent="track", sections=[])

    all_tracks = [t for sec in raw["sections"] for t in sec["tracks"]]
    annotate_tracks_is_cached(session, all_tracks)
    attach_playlist_style_covers_mbentity_cache(session, all_tracks)

    sections = [
        TrackSection(type=sec["type"], label=sec["label"], tracks=[_track_to_out(t, t.get("is_cached", False)) for t in sec["tracks"]])
        for sec in raw["sections"]
    ]

    search_history = SearchHistory(user_id=user.id, query=q)
    session.add(search_history)
    session.commit()

    return HybridSearchResponse(intent=raw["intent"], sections=sections)


@router.get("/history", response_model=list[str])
async def get_search_history(
    limit: int = Query(20, ge=1, le=100, description="Max number of recent searches"),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Get current user's recent search history."""
    results = (
        session.query(SearchHistory)
        .filter(SearchHistory.user_id == user.id)
        .order_by(SearchHistory.searched_at.desc())
        .limit(limit)
        .all()
    )
    return [r.query for r in results]


@router.delete("/history", response_model=dict)
async def clear_search_history(
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Clear current user's search history."""
    session.query(SearchHistory).filter(SearchHistory.user_id == user.id).delete()
    session.commit()
    return {"ok": True}


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
    from services.providers import musicbrainz
    svc = MetadataService(session)
    async with musicbrainz.mb_interactive_calls():
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
    user: CurrentUser = Depends(require_permission("can_access_apis")),
):
    """Stream similar tracks for a MusicBrainz recording MBID as NDJSON.

    Uses cache, then Last.fm candidates resolved only via a fast MusicBrainz
    batch (Lucene OR). Per-track / import-style resolution is not used.
    Requires can_access_apis permission.
    """
    from services.providers import lastfm
    from services.providers import musicbrainz
    from services.track_cache_status import annotate_tracks_is_cached
    from services.hybrid_search import _get_cache_with_meta, _save_to_cache

    cache_key = f"sim:{mbid}"

    async def _ndjson_core():
        logger.debug("[similar] stream start mbid=%s", mbid)
        t0 = time.monotonic()

        # ------------------------------------------------------------------
        # Cache: related MBIDs in mb_lookup_cache.related_mb_ids; rows in mb_entity_cache.
        # ------------------------------------------------------------------
        try:
            _cached_top, cached_related, _fetched_at = _get_cache_with_meta(cache_key)
        except Exception:
            cached_related = []
        if cached_related:
            logger.debug("[similar] cache hit mbid=%s tracks=%d", mbid, len(cached_related))
            attach_playlist_style_covers_mbentity_cache(session, cached_related)
            for t in cached_related:
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

            if picked:
                attach_playlist_style_covers_mbentity_cache(session, picked)

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

        logger.debug("[similar] stream done mbid=%s yielded=%d", mbid, yielded_count)
        logger.debug("[similar] total stream time mbid=%s %.2fs", mbid, time.monotonic() - t0)
        # Persist: seed row in mb_lookup_cache + each related recording in mb_entity_cache.
        try:
            if yielded_rows_for_cache:
                seed_top = [{
                    "mbid": mbid,
                    "artist": seed_artist,
                    "title": seed_title,
                    "album": "",
                    "artist_credit": None,
                    "album_cover": None,
                    "mb_artist_id": None,
                    "mb_release_id": None,
                    "mb_release_group_id": None,
                }]
                _save_to_cache(cache_key, seed_top, yielded_rows_for_cache)
                logger.debug("[similar] cache saved mbid=%s tracks=%d", mbid, len(yielded_rows_for_cache))
        except Exception:
            logger.debug("[similar] cache save failed", exc_info=True)
        done: dict = {"type": "done"}
        if yielded_count == 0:
            done["notice"] = (
                "No related tracks — suggestions only use a fast catalogue batch match, "
                "and none were found for this result."
            )
        yield (json.dumps(done) + "\n").encode("utf-8")

    async def ndjson():
        async with musicbrainz.mb_interactive_calls():
            async for chunk in _ndjson_core():
                yield chunk

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


@router.get("/mb/recording/{mbid}")
async def get_mb_recording_by_id(
    mbid: str,
    user: User = Depends(get_current_user),
):
    from fastapi import HTTPException
    from services.providers.musicbrainz import _get_recording_with_releases, recording_to_playlist_meta

    data = await _get_recording_with_releases(mbid)
    if not data:
        raise HTTPException(status_code=404, detail="Recording not found")

    meta = recording_to_playlist_meta(data, album_hint=None)
    if not meta:
        raise HTTPException(status_code=500, detail="Failed to parse recording")

    release_date = None
    if data.get("releases") and len(data["releases"]) > 0:
        first_release = data["releases"][0]
        release_date = first_release.get("date")

    return {
        "mbid": meta.get("mbid"),
        "title": meta.get("title"),
        "artist": meta.get("artist"),
        "artist_credit": meta.get("artist_credit"),
        "album": meta.get("album"),
        "mb_artist_id": meta.get("mb_artist_id"),
        "mb_release_id": meta.get("mb_release_id"),
        "mb_release_group_id": meta.get("mb_release_group_id"),
        "release_date": release_date,
    }