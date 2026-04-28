from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Awaitable

import httpx

from services.providers._http import LASTFM_CLIENT

logger = logging.getLogger(__name__)

# Last.fm public API: default limit is often 50, but we keep our own defaults small.
_LASTFM_FORMAT = "json"
_LASTFM_MAX_ATTEMPTS = 5
_LASTFM_MAX_BACKOFF_S = 8.0
_LASTFM_RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504})

# At most 5 requests per second, everything else queues.
_MAX_RPS = 5.0
_MIN_SPACING_S = 1.0 / _MAX_RPS


def _norm(s: str) -> str:
    return " ".join((s or "").lower().strip().split())


def _api_key() -> str:
    """Return the configured Last.fm API key (env overrides secrets)."""
    env = (os.environ.get("LASTFM_API_KEY") or "").strip()
    if env:
        return env
    try:
        from services.soulseek import get_secrets_data

        return (get_secrets_data().get("lastfm_api_key") or "").strip()
    except Exception:
        return ""


def _retry_sleep_s(resp: httpx.Response, attempt: int) -> float:
    h = (resp.headers.get("Retry-After") or "").strip()
    if h.isdigit():
        return min(float(h), _LASTFM_MAX_BACKOFF_S)
    base = min(0.55 * (2**attempt), _LASTFM_MAX_BACKOFF_S)
    if resp.status_code == 429:
        return max(1.0, base)
    return base


class LastFMError(RuntimeError):
    pass


@dataclass(frozen=True)
class LastfmTrack:
    name: str
    artist: str
    url: str | None = None
    mbid: str | None = None
    playcount: int | None = None
    listeners: int | None = None
    match: float | None = None  # used by getSimilar
    album: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "artist": self.artist,
            "album": self.album,
            "url": self.url,
            "mbid": self.mbid,
            "playcount": self.playcount,
            "listeners": self.listeners,
            "match": self.match,
        }


@dataclass(frozen=True)
class LastfmTag:
    name: str
    count: int | None = None
    url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "count": self.count, "url": self.url}


@dataclass(frozen=True)
class LastfmArtist:
    name: str
    mbid: str | None = None
    url: str | None = None
    match: float | None = None


def _extract_artists(raw: Any) -> list[LastfmArtist]:
    out: list[LastfmArtist] = []
    if not raw:
        return out
    if not isinstance(raw, list):
        raw = [raw]
    for a in raw:
        if not isinstance(a, dict):
            continue
        name = (a.get("name") or "").strip()
        if not name:
            continue
        out.append(
            LastfmArtist(
                name=name,
                mbid=(a.get("mbid") or "").strip() or None,
                url=(a.get("url") or "").strip() or None,
                match=_as_float(a.get("match")),
            )
        )
    return out


class _RequestQueue:
    """Single-worker queue that enforces fixed spacing between request starts."""

    def __init__(self) -> None:
        self._q: asyncio.Queue[tuple[Callable[[], Awaitable[Any]], asyncio.Future[Any]]] = asyncio.Queue()
        self._worker: asyncio.Task | None = None
        self._last_start: float = 0.0
        self._lock = asyncio.Lock()
        self._loop: asyncio.AbstractEventLoop | None = None

    def _ensure_loop(self) -> None:
        """pytest-asyncio may run tests on different loops; rebuild queue per loop."""
        loop = asyncio.get_running_loop()
        if self._loop is loop:
            return
        self._loop = loop
        self._q = asyncio.Queue()
        self._worker = None
        self._last_start = 0.0

    async def _run(self) -> None:
        while True:
            fn, fut = await self._q.get()
            try:
                now = time.monotonic()
                wait = _MIN_SPACING_S - (now - self._last_start)
                if wait > 0:
                    await asyncio.sleep(wait)
                self._last_start = time.monotonic()
                out = await fn()
                if not fut.cancelled():
                    fut.set_result(out)
            except Exception as e:
                if not fut.cancelled():
                    fut.set_exception(e)
            finally:
                self._q.task_done()

    async def submit(self, fn: Callable[[], Awaitable[Any]]) -> Any:
        self._ensure_loop()
        async with self._lock:
            if self._worker is None or self._worker.done():
                self._worker = asyncio.create_task(self._run())
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[Any] = loop.create_future()
        await self._q.put((fn, fut))
        return await fut


_queue = _RequestQueue()


def _as_int(v: Any) -> int | None:
    try:
        if v is None:
            return None
        if isinstance(v, int):
            return v
        s = str(v).strip()
        if not s:
            return None
        return int(float(s))
    except Exception:
        return None


def _as_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        if isinstance(v, float):
            return v
        if isinstance(v, int):
            return float(v)
        s = str(v).strip()
        if not s:
            return None
        return float(s)
    except Exception:
        return None


def _norm_cmp(s: str) -> str:
    return _norm(s)


def _pick_artist_name(node: Any) -> str:
    if isinstance(node, dict):
        v = node.get("name") or node.get("#text") or ""
        return str(v).strip()
    if node is None:
        return ""
    return str(node).strip()


def _pick_album_title(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, dict):
        v = node.get("#text") or node.get("name") or ""
        return str(v).strip()
    return str(node).strip()


def _extract_tracks(raw: Any, *, default_artist: str = "") -> list[LastfmTrack]:
    out: list[LastfmTrack] = []
    if not raw:
        return out
    if not isinstance(raw, list):
        raw = [raw]
    for t in raw:
        if not isinstance(t, dict):
            continue
        name = (t.get("name") or t.get("title") or "").strip()
        if not name:
            continue
        artist = _pick_artist_name(t.get("artist")) or default_artist
        album_raw = _pick_album_title(t.get("album")) or None
        mbid = (t.get("mbid") or "").strip() or None
        url = (t.get("url") or "").strip() or None
        playcount = _as_int(t.get("playcount"))
        listeners = _as_int(t.get("listeners"))
        match = _as_float(t.get("match"))
        out.append(
            LastfmTrack(
                name=name,
                artist=artist,
                mbid=mbid,
                url=url,
                playcount=playcount,
                listeners=listeners,
                match=match,
                album=album_raw,
            )
        )
    return out


async def track_search(*, query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Search tracks by user query (Last.fm `track.search`).

    Returns a list of dicts with at least: {name, artist, album?, mbid?, url?, listeners?}.
    """
    q = (query or "").strip()
    if not q:
        return []
    p: dict[str, Any] = {
        "method": "track.search",
        "track": q,
        "limit": max(1, min(int(limit), 50)),
    }
    try:
        payload = await _get(p)
    except LastFMError as e:
        logger.debug("[lastfm] track_search failed (%s): %s", p, e)
        return []
    results = payload.get("results") or {}
    matches = (results.get("trackmatches") if isinstance(results, dict) else None) or {}
    tracks = _extract_tracks((matches.get("track") if isinstance(matches, dict) else None))
    return [t.to_dict() for t in tracks]


def _extract_tags(raw: Any) -> list[LastfmTag]:
    out: list[LastfmTag] = []
    if not raw:
        return out
    if not isinstance(raw, list):
        raw = [raw]
    for t in raw:
        if not isinstance(t, dict):
            continue
        name = (t.get("name") or "").strip()
        if not name:
            continue
        out.append(LastfmTag(name=name, count=_as_int(t.get("count")), url=(t.get("url") or "").strip() or None))
    return out


def _looks_like_lastfm_not_found(payload: dict[str, Any]) -> bool:
    # API returns: {"error": 6, "message": "The artist you supplied could not be found", ...}
    err = payload.get("error")
    if err is None:
        return False
    try:
        return int(err) in (6, 7)  # 6 = invalid parameters / not found, 7 = invalid resource
    except Exception:
        return True


async def _get(params: dict[str, Any]) -> dict[str, Any]:
    key = _api_key()
    if not key:
        raise LastFMError("Last.fm API key not configured")

    logger.debug("[lastfm] request %s", {k: v for k, v in params.items() if k != "api_key"})

    async def _do() -> httpx.Response:
        last: httpx.Response | None = None
        for attempt in range(_LASTFM_MAX_ATTEMPTS):
            try:
                r = await LASTFM_CLIENT.get(
                    "",
                    params={
                        **params,
                        "api_key": key,
                        "format": _LASTFM_FORMAT,
                    },
                )
            except (
                httpx.TimeoutException,
                httpx.ConnectError,
                httpx.ReadError,
                httpx.RemoteProtocolError,
            ):
                if attempt + 1 >= _LASTFM_MAX_ATTEMPTS:
                    raise
                await asyncio.sleep(0.4 * (attempt + 1))
                continue
            last = r
            if r.status_code == 200 or r.status_code not in _LASTFM_RETRY_STATUS:
                return r
            await asyncio.sleep(_retry_sleep_s(r, attempt))
        assert last is not None
        return last

    resp: httpx.Response = await _queue.submit(_do)
    if resp.status_code != 200:
        # still include body in logs (limited)
        body = (resp.text or "")[:300]
        raise LastFMError(f"Last.fm HTTP {resp.status_code}: {body}")
    try:
        payload = resp.json()
    except Exception as e:
        raise LastFMError(f"Last.fm invalid JSON: {e}") from e
    if isinstance(payload, dict) and payload.get("error") is not None:
        # treat as "soft" not found for the mbid fallback logic
        raise LastFMError(f"Last.fm API error: {payload.get('error')}: {payload.get('message')}")
    if not isinstance(payload, dict):
        raise LastFMError("Last.fm response not a JSON object")
    return payload


async def artist_top_tracks(*, artist: str | None = None, artist_mbid: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    """Top tracks for an artist. Prefer MBID when available, fall back to artist name."""
    base_params: dict[str, Any] = {"method": "artist.gettoptracks", "limit": max(1, min(int(limit), 200))}
    attempts: list[dict[str, Any]] = []
    if artist_mbid:
        attempts.append({**base_params, "mbid": artist_mbid})
    if artist:
        attempts.append({**base_params, "artist": artist})

    for p in attempts:
        try:
            payload = await _get(p)
        except LastFMError as e:
            logger.debug("[lastfm] artist_top_tracks failed (%s): %s", p, e)
            continue
        top = payload.get("toptracks") or {}
        tracks = _extract_tracks((top.get("track") if isinstance(top, dict) else None), default_artist=artist or "")
        if tracks:
            return [t.to_dict() for t in tracks]
        if _looks_like_lastfm_not_found(payload):
            continue
    return []


async def artist_similar(*, artist: str | None = None, artist_mbid: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    """Similar artists. Prefer MBID when available, fall back to artist name."""
    base_params: dict[str, Any] = {"method": "artist.getsimilar", "limit": max(1, min(int(limit), 200)), "autocorrect": 1}
    attempts: list[dict[str, Any]] = []
    if artist_mbid:
        attempts.append({**base_params, "mbid": artist_mbid})
    if artist:
        attempts.append({**base_params, "artist": artist})

    for p in attempts:
        try:
            payload = await _get(p)
        except LastFMError as e:
            logger.debug("[lastfm] artist_similar failed (%s): %s", p, e)
            continue
        sim = payload.get("similarartists") or {}
        artists = _extract_artists((sim.get("artist") if isinstance(sim, dict) else None))
        if artists:
            return [
                {"name": a.name, "mbid": a.mbid, "url": a.url, "match": a.match}
                for a in artists
            ]
        if _looks_like_lastfm_not_found(payload):
            continue
    return []


async def tag_top_tracks(*, tag: str, limit: int = 20) -> list[dict[str, Any]]:
    """Top tracks for a tag/genre."""
    p: dict[str, Any] = {"method": "tag.gettoptracks", "tag": tag, "limit": max(1, min(int(limit), 200))}
    try:
        payload = await _get(p)
    except LastFMError as e:
        logger.debug("[lastfm] tag_top_tracks failed (%s): %s", p, e)
        return []
    top = payload.get("tracks") or payload.get("toptracks") or {}
    tracks = _extract_tracks((top.get("track") if isinstance(top, dict) else None))
    return [t.to_dict() for t in tracks]


async def track_similar(
    *,
    track: str | None = None,
    artist: str | None = None,
    track_mbid: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Similar tracks. Prefer MBID when available, fall back to plain text (track + artist)."""
    base_params: dict[str, Any] = {
        "method": "track.getsimilar",
        "limit": max(1, min(int(limit), 200)),
        "autocorrect": 1,
    }
    attempts: list[dict[str, Any]] = []
    if track_mbid:
        attempts.append({**base_params, "mbid": track_mbid})
    if track and artist:
        attempts.append({**base_params, "track": track, "artist": artist})
    elif track:
        # As a last resort: Last.fm usually expects both, but try track-only if user didn't supply artist.
        attempts.append({**base_params, "track": track})

    for p in attempts:
        try:
            payload = await _get(p)
        except LastFMError as e:
            logger.debug("[lastfm] track_similar failed (%s): %s", p, e)
            continue
        sim = payload.get("similartracks") or {}
        tracks = _extract_tracks((sim.get("track") if isinstance(sim, dict) else None))
        if tracks:
            return [t.to_dict() for t in tracks]
        logger.debug(
            "[lastfm] track_similar empty (%s): keys=%s similartracks_keys=%s",
            p,
            list(payload.keys()) if isinstance(payload, dict) else None,
            list(sim.keys()) if isinstance(sim, dict) else None,
        )
        try:
            raw_track = sim.get("track") if isinstance(sim, dict) else None
            snippet = json.dumps(raw_track, ensure_ascii=False, default=str)[:800]
            logger.debug("[lastfm] track_similar empty raw similartracks.track=%s", snippet)
        except Exception:
            pass
        if _looks_like_lastfm_not_found(payload):
            continue

    # Fallbacks: Last.fm sometimes has the track but no similarity graph. Build a "similar" set
    # from related artists and/or top tags.
    if track and artist:
        try:
            sim_artists = await artist_similar(artist=artist, limit=6)
        except Exception:
            sim_artists = []
        out: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for a in sim_artists:
            aname = (a.get("name") or "").strip()
            if not aname or _norm_cmp(aname) == _norm_cmp(artist):
                continue
            try:
                tops = await artist_top_tracks(artist=aname, limit=4)
            except Exception:
                tops = []
            for t in tops:
                key = (_norm_cmp(t.get("artist") or ""), _norm_cmp(t.get("name") or ""))
                if not key[0] or not key[1] or key in seen:
                    continue
                seen.add(key)
                out.append(t)
                if len(out) >= limit:
                    return out[:limit]

        try:
            tags = await track_top_tags(track=track, artist=artist)
        except Exception:
            tags = []
        for tg in (tags or [])[:3]:
            tag_name = (tg.get("name") or "").strip()
            if not tag_name:
                continue
            try:
                tops = await tag_top_tracks(tag=tag_name, limit=10)
            except Exception:
                tops = []
            for t in tops:
                key = (_norm_cmp(t.get("artist") or ""), _norm_cmp(t.get("name") or ""))
                if not key[0] or not key[1] or key in seen:
                    continue
                if key[0] == _norm_cmp(artist) and key[1] == _norm_cmp(track):
                    continue
                seen.add(key)
                out.append(t)
                if len(out) >= limit:
                    return out[:limit]
        if out:
            return out[:limit]

    return []


async def track_top_tags(
    *,
    track: str | None = None,
    artist: str | None = None,
    track_mbid: str | None = None,
) -> list[dict[str, Any]]:
    """Top tags/genres for a track. Prefer MBID, then (track + artist) fallback."""
    base_params: dict[str, Any] = {"method": "track.gettoptags", "autocorrect": 1}
    attempts: list[dict[str, Any]] = []
    if track_mbid:
        attempts.append({**base_params, "mbid": track_mbid})
    if track and artist:
        attempts.append({**base_params, "track": track, "artist": artist})

    for p in attempts:
        try:
            payload = await _get(p)
        except LastFMError as e:
            logger.debug("[lastfm] track_top_tags failed (%s): %s", p, e)
            continue
        top = payload.get("toptags") or payload.get("tags") or {}
        tags = _extract_tags((top.get("tag") if isinstance(top, dict) else None))
        if tags:
            return [t.to_dict() for t in tags]
        logger.debug(
            "[lastfm] track_top_tags empty (%s): keys=%s top_keys=%s",
            p,
            list(payload.keys()) if isinstance(payload, dict) else None,
            list(top.keys()) if isinstance(top, dict) else None,
        )
        if _looks_like_lastfm_not_found(payload):
            continue
    return []

