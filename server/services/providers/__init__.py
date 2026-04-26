import copy
import json
import logging
import time
from collections import OrderedDict
from datetime import datetime, timedelta
from typing import Any

from sqlmodel import Session, select

from database import engine
from models import MBEntityCache
from services.providers import audiodb, ddg, fanarttv, musicbrainz

logger = logging.getLogger(__name__)

_MEM_TTL = 600.0          # hot-tier memory TTL (seconds)
_DB_SOFT_TTL = timedelta(days=7)   # DB soft TTL — return stale + revalidate in bg
_COVER_NEG_TTL = timedelta(hours=24)  # how long to cache a cover miss

# In-memory hot-tier caches: key → (timestamp, value) — LRU capped per tier
_MAX_MEM_PER_TIER = 500
_album_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_artist_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_artist_head_cache: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_artist_albums_cache: OrderedDict[str, tuple[float, list]] = OrderedDict()


def clear_memory_caches() -> dict[str, int]:
    """Clear all in-memory caches. Returns count of items cleared per cache."""
    counts = {
        "album": len(_album_cache),
        "artist": len(_artist_cache),
        "artist_head": len(_artist_head_cache),
        "artist_albums": len(_artist_albums_cache),
    }
    _album_cache.clear()
    _artist_cache.clear()
    _artist_head_cache.clear()
    _artist_albums_cache.clear()
    return counts


def _mem_get(store: OrderedDict[str, tuple[float, Any]], key: str) -> Any | None:
    entry = store.get(key)
    if entry and (time.monotonic() - entry[0]) < _MEM_TTL:
        store.move_to_end(key)  # LRU: recently used
        return copy.deepcopy(entry[1])
    if entry:
        del store[key]
    return None


def _mem_set(store: OrderedDict[str, tuple[float, Any]], key: str, value: Any) -> None:
    store[key] = (time.monotonic(), copy.deepcopy(value))
    while len(store) > _MAX_MEM_PER_TIER:
        store.popitem(last=False)


def _db_get(kind: str, mbid: str) -> Any | None:
    key = f"{kind}:{mbid}"
    try:
        with Session(engine) as session:
            row = session.get(MBEntityCache, key)
            if row is None:
                return None
            age = datetime.utcnow() - row.fetched_at
            if age > _DB_SOFT_TTL:
                return json.loads(row.payload)
            return json.loads(row.payload)
    except Exception:
        return None


def _db_set(kind: str, mbid: str, value: Any) -> None:
    key = f"{kind}:{mbid}"
    try:
        with Session(engine) as session:
            row = session.get(MBEntityCache, key)
            payload = json.dumps(value, default=str)
            if row is None:
                session.add(MBEntityCache(key=key, kind=kind, payload=payload))
            else:
                row.payload = payload
                row.fetched_at = datetime.utcnow()
                session.add(row)
            session.commit()
    except Exception:
        logger.exception("MBEntityCache _db_set path failed (kind=%s)", kind)


def _db_is_fresh(kind: str, mbid: str) -> bool:
    """True if DB entry exists and is within soft TTL."""
    key = f"{kind}:{mbid}"
    try:
        with Session(engine) as session:
            row = session.get(MBEntityCache, key)
            if row is None:
                return False
            return (datetime.utcnow() - row.fetched_at) <= _DB_SOFT_TTL
    except Exception:
        return False


def _cache_get(mem_store: OrderedDict[str, tuple[float, Any]], kind: str, key: str) -> Any | None:
    v = _mem_get(mem_store, key)
    if v is not None:
        return v
    v = _db_get(kind, key)
    if v is not None:
        _mem_set(mem_store, key, v)
        return _mem_get(mem_store, key)
    return None


def _cache_set(mem_store: OrderedDict[str, tuple[float, Any]], kind: str, key: str, value: Any) -> None:
    _mem_set(mem_store, key, value)
    _db_set(kind, key, value)


def get_cached_cover(kind: str, mbid: str) -> tuple[bool, str | None]:
    """Return (found_in_cache, url_or_None). found_in_cache=True even for known misses."""
    v = _db_get(kind, mbid)
    if v is None:
        return False, None
    if v.get("found") is False:
        key = f"{kind}:{mbid}"
        try:
            with Session(engine) as session:
                row = session.get(MBEntityCache, key)
                if row and (datetime.utcnow() - row.fetched_at) > _COVER_NEG_TTL:
                    return False, None
        except Exception:
            logger.debug("get_cached_cover neg_ttl check (ignored)", exc_info=True)
        return True, None
    return True, v.get("url")


def set_cached_cover(kind: str, mbid: str, url: str | None) -> None:
    if url:
        _db_set(kind, mbid, {"found": True, "url": url})
    else:
        _db_set(kind, mbid, {"found": False})


PROVIDER_REGISTRY: dict[str, Any] = {
    "musicbrainz": musicbrainz,
}


class MetadataService:
    """Provider-agnostic metadata using MusicBrainz."""

    def __init__(self, session: Session):
        self.session = session

    def _get_provider(self) -> Any:
        return PROVIDER_REGISTRY["musicbrainz"]

    async def search(self, query: str) -> list[dict[str, Any]]:
        provider = self._get_provider()
        results = await provider.search(query)
        return results if results else []

    def _detect_provider(self, id: str) -> tuple[str, Any] | None:
        if "-" in id and len(id) > 20:
            return ("musicbrainz", PROVIDER_REGISTRY["musicbrainz"])
        return None

    async def get_album(self, album_id: str, *, light: bool = False) -> dict[str, Any] | None:
        """``light=True`` fetches tracklist without CAA cover HTTP; result is not persisted in album cache."""
        if not light:
            cached = _cache_get(_album_cache, "album", album_id)
            if cached is not None:
                return cached
        logger.debug(f"[get_album] album_id={album_id!r} light={light}")
        detected = self._detect_provider(album_id)
        result: dict[str, Any] | None = None
        if detected:
            name, provider = detected
            fn = getattr(provider, "get_album", None)
            if fn:
                result = await fn(album_id, light=light)  # type: ignore[call-arg]
        else:
            provider = self._get_provider()
            fn = getattr(provider, "get_album", None)
            if fn:
                result = await fn(album_id, light=light)  # type: ignore[call-arg]
        if result and not light:
            _cache_set(_album_cache, "album", album_id, result)
        return result

    async def get_artist(self, artist_id: str) -> dict[str, Any] | None:
        cached = _cache_get(_artist_cache, "artist", artist_id)
        if cached is not None:
            return cached
        detected = self._detect_provider(artist_id)
        result: dict[str, Any] | None = None
        if detected:
            name, provider = detected
            result = await provider.get_artist(artist_id)
        else:
            provider = self._get_provider()
            if hasattr(provider, "get_artist"):
                result = await provider.get_artist(artist_id)
        if result:
            _cache_set(_artist_cache, "artist", artist_id, result)
        return result

    async def get_artist_head(self, artist_id: str) -> dict[str, Any] | None:
        cached = _cache_get(_artist_head_cache, "artist_head", artist_id)
        if cached is not None:
            logger.debug(f"[providers] get_artist_head {artist_id}: cache hit")
            # artist_head is persisted; DDG (and other) rows may exist in mb_entity_cache while head still has nulls.
            # Only re-run fallback when something is worth reading (avoids fanart HTTP for artists with no visuals).
            if not cached.get("picture") and not cached.get("banner"):
                name = cached.get("name")
                has_visual_cache = bool(
                    _db_get("cover_fanart_artist", artist_id)
                    or _db_get("cover_audiodb_artist", artist_id)
                    or (
                        name
                        and (
                            _db_get("cover_ddg_thumb", name)
                            or _db_get("cover_ddg_banner", name)
                        )
                    )
                )
                if has_visual_cache:
                    fanart = await self._get_fanart_fallback(artist_id)
                    if fanart.get("thumb") or fanart.get("banner"):
                        merged = {
                            **cached,
                            "picture": fanart.get("thumb") or cached.get("picture"),
                            "banner": fanart.get("banner") or cached.get("banner"),
                        }
                        _cache_set(_artist_head_cache, "artist_head", artist_id, merged)
                        return merged
            return cached
        logger.debug(f"[providers] get_artist_head {artist_id}: cache miss, fetching from provider")

        # Get artist data from MusicBrainz (name, top_tracks)
        detected = self._detect_provider(artist_id)
        result: dict[str, Any] | None = None
        if detected:
            name, provider = detected
            fn = getattr(provider, "get_artist_head", None) or getattr(provider, "get_artist", None)
            if fn:
                result = await fn(artist_id)
        else:
            provider = self._get_provider()
            fn = getattr(provider, "get_artist_head", None) or getattr(provider, "get_artist", None)
            if fn:
                result = await fn(artist_id)

        if not result:
            logger.debug(f"[providers] get_artist_head {artist_id}: provider returned nothing")
            return None

        # Get artist images from fanart.tv
        fanart = await self._get_fanart_fallback(artist_id)
        result["picture"] = fanart.get("thumb")
        result["banner"] = fanart.get("banner")
        logger.debug(f"[providers] get_artist_head {artist_id}: fanart thumb={result['picture'] is not None} banner={result['banner'] is not None}")

        _cache_set(_artist_head_cache, "artist_head", artist_id, result)
        return result

    async def _get_fanart_fallback(self, artist_id: str) -> dict[str, Any]:
        """Fetch artist images from fanart.tv, then theaudiodb, then default thumb/banner from DDG as needed.

        DDG is always run when we have a MusicBrainz artist name so results are cached for the
        image picker pool (banners/thumbs in ``/artist/{id}/images``), not only when other sources
        are empty.
        """
        try:
            artist_name: str | None = None
            try:
                detected = self._detect_provider(artist_id)
                if detected:
                    _, provider = detected
                    mb_result = await provider.get_artist(artist_id)
                    artist_name = mb_result.get("name") if mb_result else None
            except Exception:
                logger.debug("_get_fanart_fallback get_artist (ignored)", exc_info=True)

            from services.soulseek import get_secrets_data
            api_key = get_secrets_data().get("fanarttv_api_key", "")
            logger.debug(f"[providers] _get_fanart_fallback {artist_id}: api_key present={bool(api_key)}")

            banner: str | None = None
            thumb: str | None = None
            if api_key:
                result = await fanarttv.get_artist_images(artist_id, api_key)
                if result:
                    banner = result.get("banner")
                    thumb = result.get("thumb")

            if not (banner or thumb):
                result = await audiodb.get_artist_images(artist_id)
                if result:
                    banner = banner or result.get("banner")
                    thumb = thumb or result.get("thumb")

            if artist_name:
                ddg_thumb = await ddg.search_artist_thumb(artist_name)
                ddg_banner = await ddg.search_artist_banner(artist_name)
                if not thumb and ddg_thumb:
                    thumb = ddg_thumb.get("thumb")
                if not banner and ddg_banner:
                    banner = ddg_banner.get("thumb")
            return {"banner": banner, "thumb": thumb}
        except Exception as e:
            logger.warning(f"[providers] _get_fanart_fallback {artist_id}: exception={e}")
            return {}

    async def get_artist_albums(self, artist_id: str) -> list[dict[str, Any]]:
        cached = _cache_get(_artist_albums_cache, "artist_albums", artist_id)
        if cached is not None:
            return cached
        detected = self._detect_provider(artist_id)
        result: list[dict[str, Any]] = []
        if detected:
            name, provider = detected
            if hasattr(provider, "get_artist_albums"):
                result = await provider.get_artist_albums(artist_id)
        else:
            provider = self._get_provider()
            if hasattr(provider, "get_artist_albums"):
                result = await provider.get_artist_albums(artist_id)
        if result:
            _cache_set(_artist_albums_cache, "artist_albums", artist_id, result)
        return result
