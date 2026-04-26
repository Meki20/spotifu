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
from services.providers import musicbrainz

logger = logging.getLogger(__name__)

# Bound work per request: client chains multiple POSTs for large discographies.
_PREFETCH_ALBUMS_PER_REQUEST = 4

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
    """Prefetch album tracklists only (light: no CAA), low MB priority.

    Does **not** repeat artist head / discography fetches — the client should
    warm those via ``GET /artist/{id}`` and ``GET /artist/{id}/albums`` so
    this endpoint only pays for ``get_album`` (MusicBrainz release + tracks).

    At most ``_PREFETCH_ALBUMS_PER_REQUEST`` albums per call; client batches the rest.
    """
    artist_id = body.artist_id
    album_ids = body.album_ids
    logger.debug("prefetch artist_id=%r album_ids=%s", artist_id, album_ids)

    album_ids_to_fetch = (album_ids or [])[:_PREFETCH_ALBUMS_PER_REQUEST]
    if not album_ids_to_fetch:
        return {"artist": None, "albums": []}

    svc = MetadataService(session)

    async with musicbrainz.mb_prefetch_calls():
        album_results = await asyncio.gather(
            *[svc.get_album(aid, light=True) for aid in album_ids_to_fetch]
        )
    valid_albums = [
        {"id": aid, "data": alb}
        for aid, alb in zip(album_ids_to_fetch, album_results)
        if alb
    ]

    logger.debug("prefetch albums done artist_id=%r count=%d", artist_id, len(valid_albums))

    return {
        "artist": None,
        "albums": valid_albums,
    }
