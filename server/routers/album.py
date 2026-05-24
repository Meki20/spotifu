from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session
from database import get_session
from deps import get_current_user
from models import User
from services.providers import MetadataService
from services.providers import musicbrainz
from services.track_cache_status import annotate_tracks_is_cached
from schemas import TrackOut

router = APIRouter(prefix="/album", tags=["album"])


@router.get("/{album_id}")
async def get_album(
    album_id: str,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    from services.covers import attach_cached_covers_only, lookup_cached_cover_best_effort

    svc = MetadataService(session)
    async with musicbrainz.mb_interactive_calls():
        data = await svc.get_album(album_id, light=True)
    if not data:
        raise HTTPException(status_code=404, detail="Album not found")

    if not data.get("cover"):
        rg_id = data.get("mb_release_group_id")
        rel_id = data.get("mbid")
        cached = lookup_cached_cover_best_effort(
            session,
            release_id=str(rel_id).strip() if rel_id else None,
            release_group_id=str(rg_id).strip() if rg_id else None,
        )
        if cached:
            data["cover"] = cached

    tracks = data.get("tracks")
    if isinstance(tracks, list):
        annotate_tracks_is_cached(session, tracks, artist_fallback=data.get("artist"))
        attach_cached_covers_only(session, tracks)
        album_cover = data.get("cover")
        data["tracks"] = [
            TrackOut(
                mb_id=t.get("mbid", ""),
                title=t.get("title", ""),
                artist=t.get("artist", data.get("artist", "")),
                artist_credit=t.get("artist_credit"),
                album=t.get("album", data.get("title", "")),
                album_cover=t.get("album_cover") or t.get("cover") or album_cover,
                duration=t.get("duration", 0),
                is_cached=bool(t.get("is_cached")),
                mb_release_id=t.get("mb_release_id"),
                mb_release_group_id=t.get("mb_release_group_id"),
                mb_artist_id=t.get("mb_artist_id"),
            )
            for t in tracks
        ]
    return data