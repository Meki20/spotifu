"""TheAudioDB artist image provider.

API docs: https://www.theaudiodb.com/free_music_api
Endpoint: GET /artist-mb.php?i={mb_artist_id}
Response fields used: strArtistThumb, strArtistBanner
No API key required for free tier.
"""
import logging
from typing import Any

from services.providers._http import AUDIODB_CLIENT, async_entity_cache_fetch

__all__ = ["get_artist_images"]

logger = logging.getLogger(__name__)

_AUDIODB_BANNER_FIELDS = ("strArtistBanner",)
_AUDIODB_THUMB_FIELDS = ("strArtistThumb",)


async def get_artist_images(mb_artist_id: str) -> dict[str, Any] | None:
    """Fetch artist images from theaudiodb by MusicBrainz artist ID.

    Returns:
        {
            "banners": [url, ...],
            "thumbs": [url, ...],
            "banner": str | None,
            "thumb": str | None,
        }
    or None if no images found or API error.
    Cached in DB with kind "cover_audiodb_artist".
    """

    async def fetch() -> dict[str, Any] | None:
        try:
            resp = await AUDIODB_CLIENT.get("/artist-mb.php", params={"i": mb_artist_id})
            logger.debug(f"[audiodb] get_artist_images {mb_artist_id}: status={resp.status_code}")
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            data: dict[str, Any] = resp.json()
        except Exception as e:
            logger.warning(f"[audiodb] get_artist_images {mb_artist_id}: exception={e}")
            return None

        artists = data.get("artists")
        if not artists or not isinstance(artists, list):
            return None

        artist = artists[0]
        banners: list[str] = []
        thumbs: list[str] = []

        for field in _AUDIODB_BANNER_FIELDS:
            val = artist.get(field)
            if val:
                banners.append(val)

        for field in _AUDIODB_THUMB_FIELDS:
            val = artist.get(field)
            if val:
                thumbs.append(val)

        logger.debug(
            f"[audiodb] get_artist_images {mb_artist_id}: banners={len(banners)} thumbs={len(thumbs)}"
        )
        if not banners and not thumbs:
            return None
        return {
            "banners": banners,
            "thumbs": thumbs,
            "banner": banners[0] if banners else None,
            "thumb": thumbs[0] if thumbs else None,
        }

    return await async_entity_cache_fetch("cover_audiodb_artist", mb_artist_id, fetch)

