import asyncio

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel
from sqlmodel import Session, select, delete, func
from database import get_session
from deps import get_current_user, require_admin, require_permission, CurrentUser
from models import User, Track, TrackStatus, MBLookupCache, MBEntityCache, PlaylistItem, CoverLink, CoverAsset
from schemas.track import DownloadedTrackListItem, DownloadedTracksListResponse
from services.user_preferences import get_stored_prefetch_prefs, merge_prefetch_into_user, PREFETCH_DEFAULTS

router = APIRouter(prefix="/settings", tags=["settings"])


class SoulseekCredentials(BaseModel):
    username: str
    password: str


class FanartTVKey(BaseModel):
    api_key: str


class LastFMKey(BaseModel):
    api_key: str


class SettingsResponse(BaseModel):
    soulseek_username: str | None
    soulseek_connected: bool
    soulseek_has_credentials: bool = False
    fanarttv_key_configured: bool = False
    lastfm_key_configured: bool = False


class PrefetchPreferencesPatch(BaseModel):
    enabled: bool | None = None
    hover_metadata: bool | None = None
    album_tracklists: bool | None = None
    artist_idle: bool | None = None
    hybrid_stale_refresh: bool | None = None


class PreferencesResponse(BaseModel):
    prefetch: dict[str, bool]


@router.get("/preferences", response_model=PreferencesResponse)
def get_preferences(user: User = Depends(get_current_user)):
    return PreferencesResponse(prefetch=get_stored_prefetch_prefs(user))


@router.patch("/preferences", response_model=PreferencesResponse)
def patch_preferences(
    body: PrefetchPreferencesPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in PREFETCH_DEFAULTS}
    if patch:
        merge_prefetch_into_user(session, user, patch)
    return PreferencesResponse(prefetch=get_stored_prefetch_prefs(user))


@router.get("", response_model=SettingsResponse)
def get_settings(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from services.soulseek import (
        is_connected,
        get_logged_in_username,
        get_configured_username,
        has_stored_credentials,
        get_secrets_data,
    )
    username = get_logged_in_username() or get_configured_username()
    fan = (get_secrets_data().get("fanarttv_api_key") or "").strip()
    lastfm = (get_secrets_data().get("lastfm_api_key") or "").strip()

    return SettingsResponse(
        soulseek_username=username,
        soulseek_connected=is_connected(),
        soulseek_has_credentials=has_stored_credentials(),
        fanarttv_key_configured=bool(fan),
        lastfm_key_configured=bool(lastfm),
    )


@router.post("/soulseek")
def save_soulseek_credentials(body: SoulseekCredentials, admin: CurrentUser = Depends(require_admin)):
    """Save credentials to .secrets file (does not connect). Admin only."""
    import services.soulseek as slsk
    slsk.set_credentials(body.username, body.password)
    return {"status": "ok"}


@router.post("/fanart")
def set_fanarttv_api_key(body: FanartTVKey, admin: CurrentUser = Depends(require_admin)):
    """Save fanart.tv API key to .secrets file. Admin only."""
    import services.soulseek as slsk
    data = slsk.get_secrets_data()
    data["fanarttv_api_key"] = body.api_key
    slsk.save_secrets_data(data)
    return {"status": "ok"}


@router.post("/lastfm")
def set_lastfm_api_key(body: LastFMKey, admin: CurrentUser = Depends(require_admin)):
    """Save Last.fm API key to .secrets file. Admin only."""
    import services.soulseek as slsk
    data = slsk.get_secrets_data()
    data["lastfm_api_key"] = body.api_key
    slsk.save_secrets_data(data)
    return {"status": "ok"}


@router.post("/soulseek/connect")
async def connect_soulseek(background_tasks: BackgroundTasks, user: CurrentUser = Depends(require_permission("can_use_soulseek"))):
    """Connect using stored credentials. Requires can_use_soulseek permission."""
    import services.soulseek as slsk
    if not slsk.has_stored_credentials():
        raise HTTPException(status_code=400, detail="No stored credentials")
    background_tasks.add_task(connect_soulseek_bg)
    return {"status": "ok"}


@router.post("/soulseek/disconnect")
async def disconnect_soulseek(user: CurrentUser = Depends(require_permission("can_use_soulseek"))):
    """Disconnect Soulseek (credentials remain stored). Requires can_use_soulseek permission."""
    import services.soulseek as slsk
    await slsk.disconnect()
    return {"status": "ok"}


@router.post("/soulseek/clear")
def clear_soulseek_credentials(admin: CurrentUser = Depends(require_admin)):
    """Clear stored credentials and disconnect. Admin only."""
    import services.soulseek as slsk
    slsk.clear_credentials()
    return {"status": "ok"}


@router.get("/tracks", response_model=DownloadedTracksListResponse)
def get_downloaded_tracks(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    rows = session.exec(
        select(Track).order_by(Track.id.desc()).limit(limit).offset(offset)
    ).all()
    return DownloadedTracksListResponse(
        tracks=[
            DownloadedTrackListItem(
                id=t.id,
                title=t.title,
                artist=t.artist,
                artist_credit=t.artist_credit,
                album=t.album,
                status=t.status,
                local_file_path=t.local_file_path,
                mb_id=t.mb_id,
            )
            for t in rows
        ],
    )


@router.delete("/tracks/{track_id}")
def delete_downloaded_track(
    track_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    track = session.get(Track, track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    if track.local_file_path:
        import os
        if os.path.isfile(track.local_file_path):
            os.remove(track.local_file_path)

    if track.mb_id:
        existing = session.exec(
            select(MBLookupCache).where(MBLookupCache.mb_id == track.mb_id)
        ).all()
        for row in existing:
            session.delete(row)

    for pi in session.exec(select(PlaylistItem).where(PlaylistItem.track_id == track_id)).all():
        pi.track_id = None
        session.add(pi)
    session.flush()

    session.delete(track)
    session.commit()
    return {"status": "ok"}


async def reconnect_soulseek_bg():
    from services.soulseek import restart_client
    from main import ws_manager
    try:
        ok = await restart_client()
        if ok:
            await ws_manager.broadcast({"type": "soulseek_connected"})
        else:
            await ws_manager.broadcast({"type": "soulseek_error", "error": "connect failed"})
    except Exception as e:
        await ws_manager.broadcast({"type": "soulseek_error", "error": str(e)})


async def connect_soulseek_bg():
    from services.soulseek import connect
    from main import ws_manager
    try:
        ok = await connect()
        if ok:
            await ws_manager.broadcast({"type": "soulseek_connected"})
        else:
            await ws_manager.broadcast({"type": "soulseek_error", "error": "connect failed"})
    except Exception as e:
        await ws_manager.broadcast({"type": "soulseek_error", "error": str(e)})


@router.post("/cache/searches")
def clear_search_cache(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Clear hybrid + similar caches: MBLookupCache rows and MBEntityCache recording entries."""
    mb_count = session.exec(select(func.count()).select_from(MBLookupCache)).one()
    sim_count = session.exec(
        select(func.count()).select_from(MBEntityCache).where(MBEntityCache.kind == "recording")
    ).one()
    session.exec(delete(MBLookupCache))
    session.exec(delete(MBEntityCache).where(MBEntityCache.kind == "recording"))
    session.commit()
    return {"status": "ok", "cleared": mb_count, "similar_tracks_cleared": sim_count}


@router.post("/cache/discography")
def clear_discography_cache(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Clear artist/discography memory caches and MBEntityCache entries."""
    from services.providers import clear_memory_caches
    counts = clear_memory_caches()

    kinds = ("artist", "artist_head", "artist_albums", "rg_ordered")
    for kind in kinds:
        session.exec(delete(MBEntityCache).where(MBEntityCache.kind == kind))
    session.commit()

    return {"status": "ok", "memory_cleared": counts}


@router.post("/cache/thumbnails")
def clear_thumbnail_cache(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Clear cached thumbnails (covers + artist images).

    Covers are now stored in normalized cover tables (cover_links/cover_assets),
    but older installs may still have MBEntityCache cover_* entries.
    """
    from services.providers import clear_memory_caches
    clear_memory_caches()
    kinds = ("cover_rg", "cover_release", "cover_artist", "cover_artist_banner", "cover_fanart_artist", "cover_audiodb_artist", "cover_ddg_thumb", "cover_ddg_banner")
    for kind in kinds:
        session.exec(delete(MBEntityCache).where(MBEntityCache.kind == kind))
    # Normalized cover cache
    session.exec(delete(CoverLink))
    session.exec(delete(CoverAsset))
    session.commit()
    return {"status": "ok"}


@router.post("/cache/covers")
def clear_covers_cache(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Clear normalized cover cache tables (cover_links + cover_assets)."""
    # Delete links first (FK), then assets.
    session.exec(delete(CoverLink))
    session.exec(delete(CoverAsset))
    session.commit()
    return {"status": "ok"}


# Reconciliation endpoint models
class ReconciliationTrackItem(BaseModel):
    id: int
    title: str
    artist: str
    artist_credit: str | None = None
    album: str
    mb_id: str | None = None
    mb_artist_id: str | None = None
    mb_release_id: str | None = None
    mb_release_group_id: str | None = None
    missing_fields: list[str]


class ReconciliationTracksResponse(BaseModel):
    tracks: list[ReconciliationTrackItem]
    total: int
    page: int
    page_size: int
    total_pages: int


class ResolveRequest(BaseModel):
    track_ids: list[int]


class MatchResult(BaseModel):
    track_id: int
    original_title: str
    original_artist: str
    original_album: str
    matched_title: str | None = None
    matched_artist: str | None = None
    matched_artist_credit: str | None = None
    matched_album: str | None = None
    mb_id: str | None = None
    mb_artist_id: str | None = None
    mb_release_id: str | None = None
    mb_release_group_id: str | None = None
    mb_score: int | None = None
    phase: str | None = None
    matched: bool


class ResolveResponse(BaseModel):
    results: list[MatchResult]


class ApplyRequest(BaseModel):
    track_id: int
    title: str
    artist: str
    artist_credit: str | None = None
    album: str
    mb_id: str
    mb_artist_id: str | None = None
    mb_release_id: str | None = None
    mb_release_group_id: str | None = None
    release_date: str | None = None
    genre: str | None = None


class ApplyResponse(BaseModel):
    status: str


def _get_missing_fields(track: Track) -> list[str]:
    missing = []
    if not track.mb_id:
        missing.append("mb_id")
    if not track.mb_artist_id:
        missing.append("mb_artist_id")
    if not track.mb_release_id:
        missing.append("mb_release_id")
    if not track.mb_release_group_id:
        missing.append("mb_release_group_id")
    return missing


@router.get("/reconciliation/tracks", response_model=ReconciliationTracksResponse)
def get_reconciliation_tracks(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    # Get total count
    total = session.exec(
        select(func.count(Track.id)).where(
            Track.status == TrackStatus.READY,
            (Track.mb_id == None) | (Track.mb_artist_id == None) | (Track.mb_release_id == None),  # noqa: E711
        )
    ).one()

    offset = (page - 1) * page_size
    rows = session.exec(
        select(Track)
        .where(
            Track.status == TrackStatus.READY,
            (Track.mb_id == None) | (Track.mb_artist_id == None) | (Track.mb_release_id == None),  # noqa: E711
        )
        .order_by(Track.id)
        .limit(page_size)
        .offset(offset)
    ).all()

    return ReconciliationTracksResponse(
        tracks=[
            ReconciliationTrackItem(
                id=t.id,
                title=t.title,
                artist=t.artist,
                artist_credit=t.artist_credit,
                album=t.album,
                mb_id=t.mb_id,
                mb_artist_id=t.mb_artist_id,
                mb_release_id=t.mb_release_id,
                mb_release_group_id=t.mb_release_group_id,
                missing_fields=_get_missing_fields(t),
            )
            for t in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size if total > 0 else 1,
    )


@router.post("/reconciliation/resolve", response_model=ResolveResponse)
async def resolve_reconciliation_tracks(
    body: ResolveRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from services.providers import musicbrainz
    from services.playlist_import import (
        _resolve_batch_verbatim,
        ImportInputRow,
        ResolveOutcome,
        _query_normalized,
        _retry_mb_forever_503_429,
    )

    results: list[MatchResult] = []
    track_map: dict[str, Track] = {}  # query_normalized -> Track
    results_map: dict[str, MatchResult] = {}  # query_normalized -> MatchResult
    memo: dict[str, ResolveOutcome] = {}
    stats: dict[str, int] = {"memo_hit": 0, "db_cache_hit": 0, "live_lookup": 0, "matched": 0, "unmatched": 0}

    # Fetch all tracks first
    all_tracks = [session.get(Track, tid) for tid in body.track_ids]
    all_tracks = [t for t in all_tracks if t]

    # Split into full (have artist+title+album) and incomplete
    full_rows: list[ImportInputRow] = []
    incomplete_tracks: list[Track] = []

    row_idx = 0
    for track in all_tracks:
        artist = track.artist or ""
        title = track.title or ""
        album = track.album or ""

        # Check if we have all three fields
        if artist and title and album:
            qn = _query_normalized(artist, title, album)
            row = ImportInputRow(
                row_index=row_idx,
                title=title,
                artist=artist,
                album=album,
                duration_ms=0,
                query_normalized=qn,
            )
            full_rows.append(row)
            track_map[qn] = track
            row_idx += 1
        else:
            incomplete_tracks.append(track)

    # Process full rows using 4-pass batch resolver
    # Process in batches of 5 with throttling
    batch_size = 5
    for i in range(0, len(full_rows), batch_size):
        batch = full_rows[i : i + batch_size]
        await _resolve_batch_verbatim(session, batch, memo=memo, stats=stats)
        await asyncio.sleep(1.2)  # Throttle to respect MB rate limits

    # Convert memo results to MatchResult for full tracks
    for qn, outcome in memo.items():
        track = track_map.get(qn)
        if not track:
            continue

        if outcome.state.name == "MATCHED" and outcome.meta:
            meta = outcome.meta
            results_map[qn] = MatchResult(
                track_id=track.id,
                original_title=track.title,
                original_artist=track.artist,
                original_album=track.album,
                matched_title=meta.get("title"),
                matched_artist=meta.get("artist"),
                matched_artist_credit=meta.get("artist_credit"),
                matched_album=meta.get("album"),
                mb_id=meta.get("mbid"),
                mb_artist_id=meta.get("mb_artist_id"),
                mb_release_id=meta.get("mb_release_id"),
                mb_release_group_id=meta.get("mb_release_group_id"),
                mb_score=int(outcome.confidence * 100) if outcome.confidence else None,
                phase=outcome.phase,
                matched=True,
            )
        else:
            results_map[qn] = MatchResult(
                track_id=track.id,
                original_title=track.title,
                original_artist=track.artist,
                original_album=track.album,
                matched=False,
            )

    # Handle incomplete tracks with simple lucene query
    async def resolve_incomplete(track: Track) -> MatchResult:
        title = track.title or ""
        artist = track.artist or ""
        album = track.album or ""

        parts = []
        if artist:
            parts.append(f'artist:"{artist}"')
        if album:
            parts.append(f'release:"{album}"')
        if title:
            parts.append(title)
        lucene = " AND ".join(parts) if parts else title

        if not lucene:
            return MatchResult(
                track_id=track.id,
                original_title=track.title,
                original_artist=track.artist,
                original_album=track.album,
                matched=False,
            )

        try:
            cand = await _retry_mb_forever_503_429(
                lambda: musicbrainz.recording_query_raw(lucene, limit=20)
            )
            if cand and len(cand) > 0:
                best = cand[0]
                meta = musicbrainz.recording_to_playlist_meta(best, album_hint=album)
                if meta and meta.get("mbid"):
                    score = best.get("score", 0)
                    return MatchResult(
                        track_id=track.id,
                        original_title=track.title,
                        original_artist=track.artist,
                        original_album=track.album,
                        matched_title=meta.get("title"),
                        matched_artist=meta.get("artist"),
                        matched_artist_credit=meta.get("artist_credit"),
                        matched_album=meta.get("album"),
                        mb_id=meta.get("mbid"),
                        mb_artist_id=meta.get("mb_artist_id"),
                        mb_release_id=meta.get("mb_release_id"),
                        mb_release_group_id=meta.get("mb_release_group_id"),
                        mb_score=int(score * 100) if score else None,
                        phase=meta.get("_resolve_phase"),
                        matched=True,
                    )
        except Exception:
            pass

        return MatchResult(
            track_id=track.id,
            original_title=track.title,
            original_artist=track.artist,
            original_album=track.album,
            matched=False,
        )

    # Process incomplete tracks with throttling
    incomplete_qn_map: dict[int, str] = {}  # track_id -> query_normalized
    for track in incomplete_tracks:
        qn = _query_normalized(track.artist or "", track.title or "", track.album or "")
        result = await resolve_incomplete(track)
        results_map[qn] = result
        incomplete_qn_map[track.id] = qn
        await asyncio.sleep(1.2)

    # Build final results list in original order
    track_id_to_qn: dict[int, str] = {}
    for qn, track in track_map.items():
        track_id_to_qn[track.id] = qn
    for track in incomplete_tracks:
        track_id_to_qn[track.id] = incomplete_qn_map[track.id]

    # If we have results from resolve (full rows processed first), add them
    for track in all_tracks:
        qn = track_id_to_qn.get(track.id)
        if qn and qn in results_map:
            results.append(results_map[qn])
        else:
            # Fallback - shouldn't happen but include all tracks
            results.append(MatchResult(
                track_id=track.id,
                original_title=track.title,
                original_artist=track.artist,
                original_album=track.album,
                matched=False,
            ))

    return ResolveResponse(results=results)


@router.post("/reconciliation/resolve/stream")
async def resolve_reconciliation_tracks_stream(
    body: ResolveRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from services.providers import musicbrainz
    from services.playlist_import import (
        _resolve_batch_verbatim,
        ImportInputRow,
        ResolveOutcome,
        _query_normalized,
        _retry_mb_forever_503_429,
    )

    import json
    from fastapi.responses import StreamingResponse

    async def event_stream():
        track_map: dict[str, Track] = {}
        memo: dict[str, ResolveOutcome] = {}
        stats: dict[str, int] = {"memo_hit": 0, "db_cache_hit": 0, "live_lookup": 0, "matched": 0, "unmatched": 0}

        # Fetch all tracks first
        all_tracks = [session.get(Track, tid) for tid in body.track_ids]
        all_tracks = [t for t in all_tracks if t]

        # Split into full (have artist+title+album) and incomplete
        full_rows: list[ImportInputRow] = []
        incomplete_tracks: list[Track] = []

        row_idx = 0
        for track in all_tracks:
            artist = track.artist or ""
            title = track.title or ""
            album = track.album or ""

            if artist and title and album:
                qn = _query_normalized(artist, title, album)
                row = ImportInputRow(
                    row_index=row_idx,
                    title=title,
                    artist=artist,
                    album=album,
                    duration_ms=0,
                    query_normalized=qn,
                )
                full_rows.append(row)
                track_map[qn] = track
                row_idx += 1
            else:
                incomplete_tracks.append(track)

        # Send initial count
        yield f"data: {json.dumps({'type': 'start', 'total': len(all_tracks)})}\n\n"

        # Process full rows using 4-pass batch resolver
        batch_size = 5
        processed = 0

        for i in range(0, len(full_rows), batch_size):
            batch = full_rows[i : i + batch_size]
            await _resolve_batch_verbatim(session, batch, memo=memo, stats=stats)
            await asyncio.sleep(1.2)

            # Yield results from this batch
            for qn, outcome in memo.items():
                track = track_map.get(qn)
                if not track:
                    continue

                if outcome.state.name == "MATCHED" and outcome.meta:
                    meta = outcome.meta
                    result = MatchResult(
                        track_id=track.id,
                        original_title=track.title,
                        original_artist=track.artist,
                        original_album=track.album,
                        matched_title=meta.get("title"),
                        matched_artist=meta.get("artist"),
                        matched_artist_credit=meta.get("artist_credit"),
                        matched_album=meta.get("album"),
                        mb_id=meta.get("mbid"),
                        mb_artist_id=meta.get("mb_artist_id"),
                        mb_release_id=meta.get("mb_release_id"),
                        mb_release_group_id=meta.get("mb_release_group_id"),
                        mb_score=int(outcome.confidence * 100) if outcome.confidence else None,
                        phase=outcome.phase,
                        matched=True,
                    )
                else:
                    result = MatchResult(
                        track_id=track.id,
                        original_title=track.title,
                        original_artist=track.artist,
                        original_album=track.album,
                        matched=False,
                    )
                processed += 1
                yield f"data: {json.dumps({'type': 'result', 'result': result.model_dump(), 'processed': processed})}\n\n"

        # Handle incomplete tracks with simple lucene query
        for track in incomplete_tracks:
            result = await resolve_incomplete_stream(track)
            processed += 1
            yield f"data: {json.dumps({'type': 'result', 'result': result.model_dump(), 'processed': processed})}\n\n"
            await asyncio.sleep(1.2)

        yield f"data: {json.dumps({'type': 'done', 'processed': processed})}\n\n"

    async def resolve_incomplete_stream(track: Track) -> MatchResult:
        from services.providers import musicbrainz
        from services.playlist_import import _retry_mb_forever_503_429

        title = track.title or ""
        artist = track.artist or ""
        album = track.album or ""

        parts = []
        if artist:
            parts.append(f'artist:"{artist}"')
        if album:
            parts.append(f'release:"{album}"')
        if title:
            parts.append(title)
        lucene = " AND ".join(parts) if parts else title

        if not lucene:
            return MatchResult(
                track_id=track.id,
                original_title=track.title,
                original_artist=track.artist,
                original_album=track.album,
                matched=False,
            )

        try:
            cand = await _retry_mb_forever_503_429(
                lambda: musicbrainz.recording_query_raw(lucene, limit=20)
            )
            if cand and len(cand) > 0:
                best = cand[0]
                meta = musicbrainz.recording_to_playlist_meta(best, album_hint=album)
                if meta and meta.get("mbid"):
                    score = best.get("score", 0)
                    return MatchResult(
                        track_id=track.id,
                        original_title=track.title,
                        original_artist=track.artist,
                        original_album=track.album,
                        matched_title=meta.get("title"),
                        matched_artist=meta.get("artist"),
                        matched_artist_credit=meta.get("artist_credit"),
                        matched_album=meta.get("album"),
                        mb_id=meta.get("mbid"),
                        mb_artist_id=meta.get("mb_artist_id"),
                        mb_release_id=meta.get("mb_release_id"),
                        mb_release_group_id=meta.get("mb_release_group_id"),
                        mb_score=int(score * 100) if score else None,
                        phase=meta.get("_resolve_phase"),
                        matched=True,
                    )
        except Exception:
            pass

        return MatchResult(
            track_id=track.id,
            original_title=track.title,
            original_artist=track.artist,
            original_album=track.album,
            matched=False,
        )

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/reconciliation/apply", response_model=ApplyResponse)
async def apply_reconciliation_match(
    body: ApplyRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from services.covers import upsert_local_cover

    track = session.get(Track, body.track_id)
    if not track:
        raise HTTPException(status_code=404, detail="Track not found")

    # Update track with matched metadata
    track.title = body.title
    track.artist = body.artist
    track.artist_credit = body.artist_credit
    track.album = body.album
    track.mb_id = body.mb_id
    track.mb_artist_id = body.mb_artist_id
    track.mb_release_id = body.mb_release_id
    track.mb_release_group_id = body.mb_release_group_id
    track.release_date = body.release_date
    track.genre = body.genre

    session.add(track)
    session.commit()

    # Upsert cover art if we have release_id or release_group_id
    if (body.mb_release_id or body.mb_release_group_id) and track.local_file_path:
        try:
            await upsert_local_cover(
                local_file_path=track.local_file_path,
                track_id=track.id,
                recording_id=body.mb_id,
                release_id=body.mb_release_id,
                release_group_id=body.mb_release_group_id,
            )
        except Exception:
            pass

    return ApplyResponse(status="ok")