from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel
from sqlmodel import Session, select, delete, func
from database import get_session
from deps import get_current_user
from models import User, Track, MBLookupCache, MBEntityCache, PlaylistItem
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
def save_soulseek_credentials(body: SoulseekCredentials, user: User = Depends(get_current_user)):
    """Save credentials to .secrets file (does not connect)."""
    import services.soulseek as slsk
    slsk.set_credentials(body.username, body.password)
    return {"status": "ok"}


@router.post("/fanart")
def set_fanarttv_api_key(body: FanartTVKey, user: User = Depends(get_current_user)):
    """Save fanart.tv API key to .secrets file."""
    import services.soulseek as slsk
    data = slsk.get_secrets_data()
    data["fanarttv_api_key"] = body.api_key
    slsk.save_secrets_data(data)
    return {"status": "ok"}


@router.post("/lastfm")
def set_lastfm_api_key(body: LastFMKey, user: User = Depends(get_current_user)):
    """Save Last.fm API key to .secrets file."""
    import services.soulseek as slsk
    data = slsk.get_secrets_data()
    data["lastfm_api_key"] = body.api_key
    slsk.save_secrets_data(data)
    return {"status": "ok"}


@router.post("/soulseek/connect")
async def connect_soulseek(background_tasks: BackgroundTasks, user: User = Depends(get_current_user)):
    """Connect using stored credentials."""
    import services.soulseek as slsk
    if not slsk.has_stored_credentials():
        raise HTTPException(status_code=400, detail="No stored credentials")
    background_tasks.add_task(connect_soulseek_bg)
    return {"status": "ok"}


@router.post("/soulseek/disconnect")
async def disconnect_soulseek(user: User = Depends(get_current_user)):
    """Disconnect Soulseek (credentials remain stored)."""
    import services.soulseek as slsk
    await slsk.disconnect()
    return {"status": "ok"}


@router.post("/soulseek/clear")
def clear_soulseek_credentials(user: User = Depends(get_current_user)):
    """Clear stored credentials and disconnect."""
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
    """Clear all cached search results (MBLookupCache table)."""
    count = session.exec(select(func.count()).select_from(MBLookupCache)).one()
    session.exec(delete(MBLookupCache))
    session.commit()
    return {"status": "ok", "cleared": count}


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
    """Clear cached cover art (cover_rg, cover_release, cover_artist, cover_artist_banner, cover_fanart_artist from MBEntityCache)."""
    from services.providers import clear_memory_caches
    clear_memory_caches()
    kinds = ("cover_rg", "cover_release", "cover_artist", "cover_artist_banner", "cover_fanart_artist", "cover_audiodb_artist", "cover_ddg_thumb", "cover_ddg_banner")
    for kind in kinds:
        session.exec(delete(MBEntityCache).where(MBEntityCache.kind == kind))
    session.commit()
    return {"status": "ok"}