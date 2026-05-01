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
    svc = MetadataService(session)
    async with musicbrainz.mb_interactive_calls():
        data = await svc.get_album(album_id)
    if not data:
        raise HTTPException(status_code=404, detail="Album not found")
    tracks = data.get("tracks")
    if isinstance(tracks, list):
        annotate_tracks_is_cached(session, tracks, artist_fallback=data.get("artist"))
        data["tracks"] = [
            TrackOut(
                mb_id=t.get("mbid", ""),
                title=t.get("title", ""),
                artist=t.get("artist", data.get("artist", "")),
                artist_credit=t.get("artist_credit"),
                album=t.get("album", data.get("title", "")),
                album_cover=t.get("cover") or t.get("album_cover"),
                duration=t.get("duration", 0),
                is_cached=bool(t.get("is_cached")),
                mb_release_id=t.get("mb_release_id"),
                mb_release_group_id=t.get("mb_release_group_id"),
                mb_artist_id=t.get("mb_artist_id"),
            )
            for t in tracks
        ]
    return data