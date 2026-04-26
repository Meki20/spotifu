"""Shared httpx clients for MB and CAA — one TLS handshake, then keep-alive."""
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlmodel import Session

from database import engine
from models import MBEntityCache

logger = logging.getLogger(__name__)

_UA = "SpotiFU/1.0 (contact: luka.meklin@proton.me)"

MB_CLIENT = httpx.AsyncClient(
    base_url="https://musicbrainz.org",
    timeout=httpx.Timeout(8.0, connect=3.0),
    limits=httpx.Limits(max_keepalive_connections=10, max_connections=20, keepalive_expiry=60),
    headers={"User-Agent": _UA, "Accept": "application/json"},
)

CAA_CLIENT = httpx.AsyncClient(
    base_url="https://coverartarchive.org",
    timeout=httpx.Timeout(2.5, connect=1.5),
    limits=httpx.Limits(max_keepalive_connections=20, max_connections=40, keepalive_expiry=60),
    follow_redirects=True,
    headers={"User-Agent": _UA},
)


FANART_CLIENT = httpx.AsyncClient(
    base_url="https://webservice.fanart.tv/v3.2",
    timeout=httpx.Timeout(5.0, connect=2.0),
    limits=httpx.Limits(max_keepalive_connections=5, max_connections=10, keepalive_expiry=30),
    headers={"User-Agent": _UA},
)

AUDIODB_CLIENT = httpx.AsyncClient(
    base_url="https://www.theaudiodb.com/api/v1/json/123",
    timeout=httpx.Timeout(5.0, connect=2.0),
    limits=httpx.Limits(max_keepalive_connections=5, max_connections=10, keepalive_expiry=30),
    headers={"User-Agent": _UA},
)

LASTFM_CLIENT = httpx.AsyncClient(
    base_url="https://ws.audioscrobbler.com/2.0",
    timeout=httpx.Timeout(6.0, connect=3.0),
    limits=httpx.Limits(max_keepalive_connections=10, max_connections=20, keepalive_expiry=60),
    headers={"User-Agent": _UA, "Accept": "application/json"},
)

# Re-export DB helpers so providers can import from _http without circular deps
_DB_SOFT_TTL = timedelta(days=7)


def _db_get(kind: str, mbid: str) -> Any | None:
    key = f"{kind}:{mbid}"
    try:
        with Session(engine) as session:
            row = session.get(MBEntityCache, key)
            if row is None:
                return None
            return json.loads(row.payload)
    except Exception as e:
        logger.warning("MBEntityCache read failed for %s: %s", key, e)
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
    except Exception as e:
        logger.warning("MBEntityCache write failed for %s: %s", key, e)


async def async_entity_cache_fetch(
    kind: str,
    key: str,
    factory: Callable[[], Awaitable[Any]],
    *,
    use_cached: Callable[[Any], bool] = lambda c: c is not None,
) -> Any:
    """DB-backed entity cache: return cached when ``use_cached`` passes, else await and persist."""
    cached = _db_get(kind, key)
    if use_cached(cached):
        return cached
    out = await factory()
    _db_set(kind, key, out)
    return out


async def aclose_all() -> None:
    await MB_CLIENT.aclose()
    await CAA_CLIENT.aclose()
    await FANART_CLIENT.aclose()
    await AUDIODB_CLIENT.aclose()
    await LASTFM_CLIENT.aclose()
