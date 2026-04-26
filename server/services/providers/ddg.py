"""DuckDuckGo image search for extra artist images.

Search query: "{artist_name} artist square" for thumbnails, "{artist_name} artist banner" for banners.
Results are cached for the image picker; primary artist head also uses DDG when other sources
have no art.
"""
import logging
from typing import Any

from services.providers._http import _db_get, async_entity_cache_fetch

logger = logging.getLogger(__name__)

__all__ = ["search_artist_thumb", "search_artist_banner"]

try:
    from ddgs import DDGS
    _DDGS_AVAILABLE = True
except ImportError:
    _DDGS_AVAILABLE = False


def _ddg_cache_is_usable(c: Any) -> bool:
    if c is None or not isinstance(c, dict):
        return False
    urls = c.get("urls")
    if isinstance(urls, list) and urls:
        return True
    if c.get("thumb"):
        return True
    return False


async def search_artist_thumb(artist_name: str) -> dict[str, Any] | None:
    """Search DDG Images for artist thumbnail (square)."""
    return await _ddg_search(artist_name, "square", "cover_ddg_thumb")


async def search_artist_banner(artist_name: str) -> dict[str, Any] | None:
    """Search DDG Images for artist banner."""
    return await _ddg_search(artist_name, "banner", "cover_ddg_banner")


async def _ddg_search(artist_name: str, variant: str, cache_kind: str) -> dict[str, Any] | None:
    """Run DDG image search, cache and return result dict."""
    if not _DDGS_AVAILABLE:
        c = _db_get(cache_kind, artist_name)
        if _ddg_cache_is_usable(c):
            logger.debug("DDG search %s (%s): cache hit (ddgs unavailable)", artist_name, variant)
            return c
        return None

    async def fetch() -> dict[str, Any] | None:
        query = f"{artist_name} artist square" if variant == "square" else f"{artist_name} artist banner"
        try:
            with DDGS() as ddgs:
                results = ddgs.images(query, max_results=5)
                urls = [r["image"] for r in results if r.get("image")]
        except Exception as e:
            logger.warning("DDG search %s (%s): exception=%s", artist_name, variant, e)
            return None
        logger.debug("DDG search %s (%s): found %d urls", artist_name, variant, len(urls))
        if not urls:
            return None
        return {"urls": urls, "thumb": urls[0]}

    return await async_entity_cache_fetch(
        cache_kind, artist_name, fetch, use_cached=_ddg_cache_is_usable
    )
