import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session
from database import get_session
from deps import get_current_user
from models import User
from services.providers import MetadataService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/prefetch", tags=["prefetch"])


class PrefetchArtistRequest(BaseModel):
    artist_id: str
    album_ids: Optional[list[str]] = None


@router.post("/artist")
async def prefetch_artist(
    body: PrefetchArtistRequest,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Batch prefetch: artist head, discography, and album tracklists in one call.

    All data is served from in-memory + DB cache — no MusicBrainz API calls needed
    for cached artists.
    """
    artist_id = body.artist_id
    album_ids = body.album_ids
    logger.debug("prefetch artist_id=%r album_ids=%s", artist_id, album_ids)

    svc = MetadataService(session)

    # Phase 1: artist head + albums (concurrent)
    artist_task = svc.get_artist_head(artist_id)
    albums_task = svc.get_artist_albums(artist_id)

    artist_data, albums_list = await asyncio.gather(artist_task, albums_task)

    logger.debug("artist head cached=%s, albums cached=%s count=%s", artist_data is not None, albums_list is not None, len(albums_list) if albums_list else 0)

    # Phase 2: album tracklists (concurrent, top 10 to limit payload)
    album_ids_to_fetch = (album_ids or [])[:10]

    async def fetch_album(alb_id: str):
        result = await svc.get_album(alb_id)
        logger.debug("album %r cached=%s", alb_id, result is not None)
        return result

    album_results = []
    if album_ids_to_fetch:
        album_results = await asyncio.gather(*[
            fetch_album(aid) for aid in album_ids_to_fetch
        ])

    valid_albums = [{"id": aid, "data": alb} for aid, alb in zip(album_ids_to_fetch, album_results) if alb]

    logger.debug("returning artist=%s albums=%d", artist_data is not None, len(valid_albums))

    return {
        "artist": artist_data,
        "albums": valid_albums,
    }