"""Fanart.tv artist image provider.

API docs: https://fanart.tv/fanart-api/
Endpoint: GET /music/{mb_artist_id}?api_key=...
Response fields used: artistbackground, artist4kbackground, artistthumb,
  hdmusiclogo, musiclogo, musicbanner
"""
import logging
from typing import Any

from services.providers._http import FANART_CLIENT, _db_get, _db_set

__all__ = ["get_artist_images"]

logger = logging.getLogger(__name__)

_FANART_BANNER_KINDS = ("artistbackground", "artist4kbackground", "musicbanner")
_FANART_THUMB_KINDS = ("artistthumb", "hdmusiclogo", "musiclogo")


async def get_artist_images(mb_artist_id: str, api_key: str) -> dict[str, Any] | None:
    """Fetch all artist images from fanart.tv by MusicBrainz artist ID.

    Returns:
        {
            "banners": [url, ...],   # all banner URLs
            "thumbs": [url, ...],    # all thumb URLs
            "banner": str | None,     # active banner (index 0)
            "thumb": str | None,      # active thumb (index 0)
        }
    or None if no images found or API error.
    Cached in DB with kind "cover_fanart_artist".
    (No API key: do not fetch, but return existing cache if any.)
    """
    cached = _db_get("cover_fanart_artist", mb_artist_id)
    if cached:
        logger.debug(f"[fanarttv] get_artist_images {mb_artist_id}: cache hit")
        return cached
    if not api_key:
        logger.debug(f"[fanarttv] get_artist_images {mb_artist_id}: no api key")
        return None

    try:
        resp = await FANART_CLIENT.get(f"/music/{mb_artist_id}", params={"api_key": api_key})
        logger.warning(f"[fanarttv] get_artist_images {mb_artist_id}: status={resp.status_code}")
        if resp.status_code == 404:
            _db_set("cover_fanart_artist", mb_artist_id, None)
            return None
        resp.raise_for_status()
        data: dict[str, Any] = resp.json()
    except Exception as e:
        logger.warning(f"[fanarttv] get_artist_images {mb_artist_id}: exception={e}")
        return None

    banners: list[str] = []
    thumbs: list[str] = []

    for kind in _FANART_BANNER_KINDS:
        for item in data.get(kind) or []:
            url = item.get("url")
            if url:
                banners.append(url)

    for kind in _FANART_THUMB_KINDS:
        for item in data.get(kind) or []:
            url = item.get("url")
            if url:
                thumbs.append(url)

    logger.debug(f"[fanarttv] get_artist_images {mb_artist_id}: banners={len(banners)} thumbs={len(thumbs)}")

    if not banners and not thumbs:
        _db_set("cover_fanart_artist", mb_artist_id, None)
        return None

    result = {
        "banners": banners,
        "thumbs": thumbs,
        "banner": banners[0] if banners else None,
        "thumb": thumbs[0] if thumbs else None,
    }
    _db_set("cover_fanart_artist", mb_artist_id, result)
    return result
