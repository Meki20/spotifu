import asyncio
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
from services.artist_alias_cache import rewrite_query_with_cached_aliases

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

_ALBUM_CACHE_VERSION = 2  # bump when album track schema changes


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
    # Covers for releases/recordings/RGs have moved to normalized cover tables (cover_links/cover_assets).
    # Keep these MBEntityCache-backed cover kinds disabled so stale negative entries cannot block lookups.
    if kind in ("cover_release", "cover_rg", "cover_recording"):
        return False, None
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
    # Covers for releases/recordings/RGs have moved to normalized cover tables (cover_links/cover_assets).
    # Do not write these kinds into MBEntityCache.
    if kind in ("cover_release", "cover_rg", "cover_recording"):
        return
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
        q = rewrite_query_with_cached_aliases(query)
        results = await provider.search(q)
        return results if results else []

    def _detect_provider(self, id: str) -> tuple[str, Any] | None:
        if "-" in id and len(id) > 20:
            return ("musicbrainz", PROVIDER_REGISTRY["musicbrainz"])
        return None

    async def get_album(self, album_id: str, *, light: bool = False) -> dict[str, Any] | None:
        """``light=True`` fetches tracklist without CAA cover HTTP; result is not persisted in album cache."""
        if not light:
            cached = _cache_get(_album_cache, "album", album_id)
            if isinstance(cached, dict) and cached.get("_v") == _ALBUM_CACHE_VERSION:
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
            result["_v"] = _ALBUM_CACHE_VERSION
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
        """Return artist identity and empty ``top_tracks`` from one MB call; no fanart/DDG (use ``load_artist_visuals``)."""
        cached = _cache_get(_artist_head_cache, "artist_head", artist_id)
        if cached is not None:
            logger.debug(f"[providers] get_artist_head {artist_id}: cache hit")
            return cached
        logger.debug(f"[providers] get_artist_head {artist_id}: cache miss, fetching from provider")

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

        if "top_tracks" not in result or not isinstance(result.get("top_tracks"), list):
            result["top_tracks"] = []
        _cache_set(_artist_head_cache, "artist_head", artist_id, result)
        _cache_set(_artist_cache, "artist", artist_id, result)
        return result

    async def load_artist_visuals(self, artist_id: str, *, artist_name: str | None) -> dict[str, Any]:
        """Fetch fanart, TheAudioDB, and DDG in parallel; fills entity caches. Returns best banner + thumb."""
        return await self._get_fanart_fallback(artist_id, artist_name=artist_name)

    async def _get_fanart_fallback(self, artist_id: str, *, artist_name: str | None = None) -> dict[str, Any]:
        """Fetch artist images: fanart, TheAudioDB, and DDG run in parallel (no MusicBrainz).

        Each provider writes its own DB cache. Primary ``banner``/``thumb`` follow fanart →
        theaudiodb → DDG. ``artist_name`` is used for DDG; if missing, one lite ``get_artist_head``
        call on the provider resolves the name.
        """
        try:
            name = (artist_name or "").strip() or None
            if not name:
                try:
                    detected = self._detect_provider(artist_id)
                    if detected:
                        _, provider = detected
                        fn = getattr(provider, "get_artist_head", None) or getattr(provider, "get_artist", None)
                        if fn:
                            mb_result = await fn(artist_id)
                            name = (mb_result.get("name") or "").strip() or None if mb_result else None
                except Exception:
                    logger.debug("_get_fanart_fallback get_artist_head (ignored)", exc_info=True)

            from services.soulseek import get_secrets_data
            api_key = get_secrets_data().get("fanarttv_api_key", "")
            logger.debug(f"[providers] _get_fanart_fallback {artist_id}: api_key present={bool(api_key)}")

            async def do_fanart() -> Any:
                if not api_key:
                    return None
                return await fanarttv.get_artist_images(artist_id, api_key)

            async def do_audiodb() -> Any:
                return await audiodb.get_artist_images(artist_id)

            async def do_ddg_thumb() -> Any:
                if not name:
                    return None
                return await ddg.search_artist_thumb(name)

            async def do_ddg_banner() -> Any:
                if not name:
                    return None
                return await ddg.search_artist_banner(name)

            f_r, a_r, dt_r, db_r = await asyncio.gather(
                do_fanart(),
                do_audiodb(),
                do_ddg_thumb(),
                do_ddg_banner(),
                return_exceptions=True,
            )

            def _unwrap(x: Any) -> Any:
                if isinstance(x, Exception):
                    logger.debug("_get_fanart_fallback subtask: %s", x)
                    return None
                return x

            f_r, a_r, dt_r, db_r = _unwrap(f_r), _unwrap(a_r), _unwrap(dt_r), _unwrap(db_r)

            banner: str | None = None
            thumb: str | None = None
            if f_r and isinstance(f_r, dict):
                banner = f_r.get("banner")
                thumb = f_r.get("thumb")
            if a_r and isinstance(a_r, dict):
                banner = banner or a_r.get("banner")
                thumb = thumb or a_r.get("thumb")
            if isinstance(dt_r, dict) and dt_r.get("thumb") and not thumb:
                thumb = dt_r.get("thumb")
            if isinstance(db_r, dict) and db_r.get("thumb") and not banner:
                banner = db_r.get("thumb")
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
