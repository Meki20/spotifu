import asyncio
import contextvars
import httpx
import itertools
import logging
import re
import random
import time
import unicodedata
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Any
from difflib import SequenceMatcher

from services.providers._http import MB_CLIENT, CAA_CLIENT
from services.artist_alias_cache import (
    norm_alias,
    rewrite_query_with_cached_aliases,
    upsert_from_fix_artist_alias,
    upsert_from_mb_artist_json,
)

logger = logging.getLogger(__name__)


MUSICBRAINZ_API = "/ws/2"
MB_USER_AGENT = "SpotiFU/1.0 (contact: luka.meklin@proton.me)"
COVER_ART_RELEASE = "/release"
COVER_ART_RELEASE_GROUP = "/release-group"
CAA_SIZE_LIST = "250"
CAA_SIZE_DETAIL = "500"

_MB_BROWSE_PAGE = 100
_MB_BROWSE_MAX_PAGES = 50
_ARTIST_RG_COVER_CONCURRENCY = 8
_CAA_RETRIES = 1           # one retry on transient errors; persistent misses cached in DB
_CAA_SEARCH_SEM = asyncio.Semaphore(12)   # bound hydration concurrency vs MB pool
_MAX_OFFICIAL_RELEASES_TRY_CAA = 24
_ARTIST_RG_BROWSE_PAGE = 100
_ARTIST_RG_BROWSE_MAX_PAGES = 10
_ARTIST_DISCOGRAPHY_MAX_RGS = 50
# Release-group Lucene search: few pages even for huge catalogs (count is small vs /release crawl).
_ARTIST_DISCOGRAPHY_RG_SEARCH_LIMIT = 100
_ARTIST_DISCOGRAPHY_RG_SEARCH_MAX_PAGES = 15

_MB_PAGE_SIZE = 100

_FEAT_PATTERN = re.compile(
    r"\s*(?:[\(\[]?\s*(?:featuring|feat\.?|ft\.?|with|vs\.?|vs|pres\.?|pres)\s+[^)\]]+[\)\]]?\s*)+$",
    re.IGNORECASE,
)

_FEAT_JOINPHRASE = re.compile(r"\b(feat|ft|featuring|with|vs|pres)\b", re.IGNORECASE)


def _strip_featuring(title: str) -> str:
    return _FEAT_PATTERN.sub("", title).strip()


def _artist_discography_rg_search_query(artist_mbid: str) -> str:
    """Lucene query for album / EP / single release groups, no secondary types (live, compilation, …)."""
    return (
        f"arid:{artist_mbid} AND "
        f"(primarytype:album OR primarytype:ep OR primarytype:single) AND "
        f"-secondarytype:*"
    )


def _rg_search_embeds_only_non_official(rg: dict) -> bool:
    """True if MB embedded release stubs and none are Official (then skip this RG)."""
    rels = rg.get("releases")
    if not isinstance(rels, list) or len(rels) == 0:
        return False
    return not any(isinstance(r, dict) and r.get("status") == "Official" for r in rels)


def _artist_is_primary_credit(entity: dict, artist_mbid: str) -> bool:
    """True if artist_mbid is a primary (non-featured) credit on entity."""
    credits = entity.get("artist-credit") or []
    for i, credit in enumerate(credits):
        if not isinstance(credit, dict):
            continue
        art = credit.get("artist")
        if not isinstance(art, dict) or art.get("id") != artist_mbid:
            continue
        if i == 0:
            return True
        prev = credits[i - 1]
        if not isinstance(prev, dict):
            return True
        prev_join = prev.get("joinphrase") or ""
        return not _FEAT_JOINPHRASE.search(prev_join)
    return False


def _parse_mb_date(date_str: str | None) -> tuple[int, int, int]:
    """Converts MB date strings (YYYY-MM-DD, YYYY-MM, or YYYY) into sortable tuple."""
    if not date_str:
        return (0, 0, 0)
    parts = [int(p) for p in date_str.split("-")]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


_MB_GET_MAX_ATTEMPTS = 5
_MB_MAX_BACKOFF_S = 8.0
_MB_PAGE_GAP_S = 0.25  # spacing between paginated /ws/2 calls (etiquette + fewer 429s)

_MB_RETRY_STATUS = frozenset({408, 429, 500, 502, 503, 504})

# MusicBrainz etiquette: per-IP throttling is ~1 req/sec (see MB wiki rate limiting).
# This server is deployed single-instance per IP, so this gate is globally sufficient.
_MB_GLOBAL_GAP_S = 0.6
_mb_gap_lock = asyncio.Lock()
_mb_last_call_at = 0.0
_mb_cooldown_until = 0.0

# Lower tuple field = higher priority (asyncio.PriorityQueue is a min-heap).
# Keep a large gap so future mid-tiers can slot between user and background.
_MB_PRIO_INTERACTIVE = 0
_MB_PRIO_PREFETCH = 1_000_000
_mb_call_priority: contextvars.ContextVar[int] = contextvars.ContextVar(
    "mb_call_priority", default=_MB_PRIO_INTERACTIVE
)
_mb_req_seq = itertools.count()
_mb_pq: asyncio.PriorityQueue | None = None
_mb_queue_worker: asyncio.Task[None] | None = None


@asynccontextmanager
async def mb_interactive_calls():
    """User-facing MB work (search, artist/album pages, play, similar stream).

    Nested inside ``mb_prefetch_calls()`` this temporarily overrides back to
    interactive priority until the block exits.
    """
    tok = _mb_call_priority.set(_MB_PRIO_INTERACTIVE)
    try:
        yield
    finally:
        _mb_call_priority.reset(tok)


@asynccontextmanager
async def mb_prefetch_calls():
    """Lowest-priority MB: hover prefetch, CSV import resolve, startup reconcile, hybrid stale refresh."""
    tok = _mb_call_priority.set(_MB_PRIO_PREFETCH)
    try:
        yield
    finally:
        _mb_call_priority.reset(tok)


def _ensure_mb_queue_worker() -> None:
    global _mb_pq, _mb_queue_worker
    if _mb_pq is None:
        _mb_pq = asyncio.PriorityQueue()
    if _mb_queue_worker is None or _mb_queue_worker.done():
        _mb_queue_worker = asyncio.create_task(_mb_queue_worker_loop(), name="musicbrainz-mb-queue")


async def _mb_queue_worker_loop() -> None:
    assert _mb_pq is not None
    while True:
        prio, seq, path, params, fut = await _mb_pq.get()
        try:
            resp = await _mb_get_serial(path, params)
            if not fut.done():
                fut.set_result(resp)
        except Exception as exc:
            if not fut.done():
                fut.set_exception(exc)


def _jitter_s(base: float, pct: float = 0.15) -> float:
    if base <= 0:
        return 0.0
    return base * random.uniform(1.0 - pct, 1.0 + pct)


def _mb_retry_sleep_s(resp: httpx.Response, attempt: int) -> float:
    h = (resp.headers.get("Retry-After") or "").strip()
    if h.isdigit():
        return min(_jitter_s(float(h), pct=0.10), _MB_MAX_BACKOFF_S)
    base = min(0.55 * (2**attempt), _MB_MAX_BACKOFF_S)
    if resp.status_code == 429:
        base = max(1.0, base)
    return _jitter_s(base, pct=0.20)


async def _mb_get_serial(path: str, params: dict[str, Any]) -> httpx.Response:
    """Single MB GET with gap + retries (runs under the global queue worker)."""
    last: httpx.Response | None = None
    for attempt in range(_MB_GET_MAX_ATTEMPTS):
        async with _mb_gap_lock:
            global _mb_last_call_at, _mb_cooldown_until
            now = time.monotonic()
            wait_gap = _MB_GLOBAL_GAP_S - (now - _mb_last_call_at)
            wait_cool = _mb_cooldown_until - now
            wait = max(wait_gap, wait_cool)
            if wait > 0:
                await asyncio.sleep(_jitter_s(wait, pct=0.10))
            _mb_last_call_at = time.monotonic()
        try:
            r = await MB_CLIENT.get(path, params=params)
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
            if attempt + 1 >= _MB_GET_MAX_ATTEMPTS:
                raise
            await asyncio.sleep(_jitter_s(0.4 * (attempt + 1), pct=0.20))
            continue
        last = r
        if r.status_code == 200 or r.status_code not in _MB_RETRY_STATUS:
            return r

        if r.status_code == 503:
            cool = min(2.0 * (attempt + 1), _MB_MAX_BACKOFF_S)
            _mb_cooldown_until = max(_mb_cooldown_until, time.monotonic() + _jitter_s(cool, pct=0.20))
        await asyncio.sleep(_mb_retry_sleep_s(r, attempt))
    assert last is not None
    return last


async def _mb_get(path: str, params: dict[str, Any]) -> httpx.Response:
    """GET from MusicBrainz (queued, priority-aware) with transient-error retries."""
    _ensure_mb_queue_worker()
    assert _mb_pq is not None
    loop = asyncio.get_running_loop()
    fut: asyncio.Future[httpx.Response] = loop.create_future()
    prio = int(_mb_call_priority.get())
    seq = next(_mb_req_seq)
    await _mb_pq.put((prio, seq, path, params, fut))
    return await fut


def _artist_is_strict_lead(entity: dict, target_mbid: str) -> bool:
    """
    STRICT CHECK: Returns True ONLY if the target_mbid is the VERY FIRST
    artist in the credit list. Kills 'Artist X, Target Artist' hijackers.
    """
    credits = entity.get("artist-credit") or []
    if not credits:
        return False
    first_credit = credits[0]
    if not isinstance(first_credit, dict):
        return False
    artist_node = first_credit.get("artist", {})
    return artist_node.get("id") == target_mbid


async def get_latest_primary_official_releases(artist_mbid: str, max_pages: int = 10) -> list[dict]:
    """
    Crawls all releases, keeping only official studio work where the artist
    is the FIRST credited artist, returning the latest version of each RG.
    Caps at max_pages to avoid long loops for prolific artists.
    """
    rg_latest_map: dict[str, dict] = {}
    offset = 0
    page = 0

    while page < max_pages:
        try:
            resp = await _mb_get(
                f"{MUSICBRAINZ_API}/release",
                params={
                    "artist": artist_mbid,
                    "inc": "release-groups+artist-credits",
                    "fmt": "json",
                    "limit": _MB_PAGE_SIZE,
                    "offset": offset,
                },
            )
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError) as e:
            logger.debug(
                f"[mb] discography {artist_mbid!r} offset={offset} network error, partial map: {e!r}",
            )
            break

        if resp.status_code != 200:
            logger.warning(
                f"[mb] discography {artist_mbid!r} offset={offset} status={resp.status_code} after retries",
            )
            break

        data = resp.json()
        releases = data.get("releases", [])
        if not releases:
            break

        for rel in releases:
            if rel.get("status") != "Official":
                continue

            rg = rel.get("release-group")
            if not rg:
                continue

            p_type = rg.get("primary-type")
            s_types = rg.get("secondary-types") or []
            if p_type not in ("Album", "Single", "EP") or len(s_types) > 0:
                continue

            if not _artist_is_strict_lead(rel, artist_mbid):
                continue

            rg_id = rg["id"]
            rel_date_str = rel.get("date") or ""
            rel_date_val = _parse_mb_date(rel_date_str)

            if rg_id not in rg_latest_map:
                rg_latest_map[rg_id] = rel
            else:
                existing_date_str = rg_latest_map[rg_id].get("date") or ""
                if rel_date_val > _parse_mb_date(existing_date_str):
                    rg_latest_map[rg_id] = rel

        total = data.get("release-count", 0)
        offset += len(releases)
        page += 1
        await asyncio.sleep(_MB_PAGE_GAP_S)

        if offset >= total:
            break

    return list(rg_latest_map.values())


def _only_official_releases(release_list: list[dict]) -> list[dict]:
    return [r for r in release_list if r.get("status") == "Official"]


def _strict_album_or_single_rg(rg: dict) -> bool:
    primary = rg.get("primary-type") or ""
    secondaries = rg.get("secondary-types") or []
    if primary not in ("Album", "Single", "EP"):
        return False
    if primary == "Album" and secondaries == ["Live"]:
        return True
    return len(secondaries) == 0


def _release_matches_strict_album_single(release: dict) -> bool:
    rg = release.get("release-group")
    if not isinstance(rg, dict):
        return True
    primary = rg.get("primary-type")
    secondaries = rg.get("secondary-types") or []
    if primary is None and not secondaries:
        return True
    return _strict_album_or_single_rg(rg)


_DIGITAL_FORMATS = frozenset({"Digital Media"})
_VINYL_FORMATS = frozenset({"Vinyl", '7" Vinyl', '10" Vinyl', '12" Vinyl'})


def _release_event_date(release: dict) -> str:
    d = release.get("date")
    if d:
        return d
    for ev in release.get("release-events") or []:
        ed = ev.get("date")
        if ed:
            return ed
    return ""


def _release_rg_primary_type(release: dict) -> str | None:
    rg = release.get("release-group")
    if not isinstance(rg, dict):
        return None
    p = rg.get("primary-type")
    return str(p) if p else None


def _is_digital(release: dict) -> bool:
    return any(m.get("format") in _DIGITAL_FORMATS for m in (release.get("media") or []))


def _is_vinyl_only(release: dict) -> bool:
    media = release.get("media") or []
    return bool(media) and all(m.get("format") in _VINYL_FORMATS for m in media)


def _release_score(release: dict) -> int:
    score = 0

    if _is_digital(release):
        score += 100
    elif _is_vinyl_only(release):
        score -= 200

    rg_type = _release_rg_primary_type(release)
    if rg_type in ("Album", "EP"):
        score += 20

    disambiguation = (release.get("disambiguation") or "").lower()
    if "explicit" in disambiguation:
        score += 10
    elif "clean" in disambiguation:
        score -= 10

    country = release.get("country") or ""
    if country == "XW":
        score += 5
    elif country == "US":
        score += 3

    return score


def official_releases_latest_first(release_list: list[dict]) -> list[dict]:
    eligible = [r for r in release_list if _release_matches_strict_album_single(r)]
    official = _only_official_releases(eligible)

    non_vinyl = [r for r in official if not _is_vinyl_only(r)]
    pool = non_vinyl if non_vinyl else official

    _TYPE_ORDER = {"Album": 0, "EP": 1, "Single": 2}
    return sorted(
        pool,
        key=lambda r: (
            _release_score(r),
            _release_event_date(r),
            _TYPE_ORDER.get(_release_rg_primary_type(r) or "", 3),
        ),
        reverse=True,
    )


def _release_groups_discography_order(rgs: list[dict]) -> list[dict]:
    albums = [rg for rg in rgs if rg.get("primary-type") == "Album"]
    eps = [rg for rg in rgs if rg.get("primary-type") == "EP"]
    singles = [rg for rg in rgs if rg.get("primary-type") == "Single"]
    rest = [rg for rg in rgs if rg.get("primary-type") not in ("Album", "EP", "Single")]

    def by_rg_date_desc(items: list[dict]) -> list[dict]:
        return sorted(items, key=lambda rg: rg.get("first-release-date") or "", reverse=True)

    return (
        by_rg_date_desc(albums)
        + by_rg_date_desc(eps)
        + by_rg_date_desc(singles)
        + by_rg_date_desc(rest)
    )


def _release_groups_albums_then_singles(rgs: list[dict]) -> list[dict]:
    return _release_groups_discography_order(rgs)


def _rg_mbid_from_release(release: dict) -> str | None:
    rg = release.get("release-group")
    if isinstance(rg, dict) and rg.get("id"):
        return str(rg["id"])
    return None


def _first_artist_mbid_from_recording(recording: dict) -> str | None:
    ac = recording.get("artist-credit") or []
    if not ac:
        return None
    first = ac[0]
    if not isinstance(first, dict):
        return None
    art = first.get("artist")
    if isinstance(art, dict) and art.get("id"):
        return str(art["id"])
    return None


def _artist_credit_names(recording: dict) -> list[str]:
    """Ordered credited artist names (best-effort; no extra HTTP calls).

    Uses artist-credit[].name (display name) and falls back to artist.name.
    De-dupes exact repeats while preserving order.
    """
    out: list[str] = []
    seen: set[str] = set()
    for c in recording.get("artist-credit") or []:
        if not isinstance(c, dict):
            continue
        name = (c.get("name") or "").strip()
        if not name:
            art = c.get("artist")
            if isinstance(art, dict):
                name = (art.get("name") or "").strip()
        if not name:
            continue
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


def _artist_credit_string(recording: dict) -> str:
    """Comma-separated artist credit display string (names only)."""
    names = _artist_credit_names(recording)
    if names:
        return ", ".join(names)
    return (
        recording.get("artist-credit", [{}])[0].get("name", "Unknown")
        if recording.get("artist-credit")
        else "Unknown"
    )


def _parse_recordings(
    data: dict, *, min_score: int = 45, require_official_release: bool = True
) -> list[dict[str, Any]]:
    results = []
    for recording in data.get("recordings", []):
        if recording.get("score") is None or recording["score"] < min_score:
            continue
        artist_name = (
            recording.get("artist-credit", [{}])[0].get("name", "Unknown")
            if recording.get("artist-credit")
            else "Unknown"
        )
        artist_credit = _artist_credit_string(recording)
        mb_artist_id = _first_artist_mbid_from_recording(recording)
        release_list = recording.get("releases", [])
        official_pick = official_releases_latest_first(release_list)
        if require_official_release and release_list and not official_pick:
            continue
        primary_release = official_pick[0] if official_pick else {}
        album_title = primary_release.get("title", "") if primary_release else ""
        mb_release_id = primary_release.get("id") if primary_release else None
        mb_release_group_id = _rg_mbid_from_release(primary_release)
        rg_primary_type = _release_rg_primary_type(primary_release)
        caa_try_ids = [r["id"] for r in official_pick if r.get("id")]
        row: dict[str, Any] = {
            "mbid": recording["id"],
            "title": recording.get("title", ""),
            "artist": artist_name,
            "artist_credit": artist_credit,
            "album": album_title,
            "duration_ms": recording.get("length"),
            "mb_release_id": mb_release_id,
            "mb_release_group_id": mb_release_group_id,
            "album_cover": None,
            "preview_url": None,
            "source": "musicbrainz",
            "mb_score": recording.get("score", 50),
            "_caa_release_ids": caa_try_ids,
            "_rg_primary_type": rg_primary_type,
        }
        if mb_artist_id:
            row["mb_artist_id"] = mb_artist_id
        results.append(row)
    return results


# ---------------------------------------------------------------------------
# CAA cover fetching — backed by persistent DB cache
# ---------------------------------------------------------------------------

async def _caa_front_url(release_mbid: str, size: str = CAA_SIZE_LIST) -> str | None:
    """Fetch cover for release MBID. Check DB cache first; write result back."""
    if not release_mbid:
        return None

    from services.providers import get_cached_cover, set_cached_cover
    found, cached_url = get_cached_cover("cover_release", release_mbid)
    if found:
        return cached_url  # None means known miss

    path = f"{COVER_ART_RELEASE}/{release_mbid}/front-{size}"
    for attempt in range(_CAA_RETRIES + 1):
        try:
            resp = await CAA_CLIENT.get(path)
            if resp.status_code == 200:
                content_type = resp.headers.get("content-type", "")
                if "image" in content_type:
                    url = str(resp.url)
                    set_cached_cover("cover_release", release_mbid, url)
                    return url
                set_cached_cover("cover_release", release_mbid, None)
                return None
            if resp.status_code == 404:
                set_cached_cover("cover_release", release_mbid, None)
                return None
            if resp.status_code in (429, 502, 503, 504) and attempt < _CAA_RETRIES:
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
            set_cached_cover("cover_release", release_mbid, None)
            return None
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError):
            if attempt < _CAA_RETRIES:
                await asyncio.sleep(0.3)
                continue
            return None
        except Exception:
            return None
    return None


async def _caa_release_group_front_url(release_group_mbid: str, size: str = CAA_SIZE_LIST) -> str | None:
    """Fetch cover for release-group MBID. Check DB cache first."""
    if not release_group_mbid:
        return None

    from services.providers import get_cached_cover, set_cached_cover
    found, cached_url = get_cached_cover("cover_rg", release_group_mbid)
    if found:
        return cached_url

    path = f"{COVER_ART_RELEASE_GROUP}/{release_group_mbid}/front-{size}"
    for attempt in range(_CAA_RETRIES + 1):
        try:
            resp = await CAA_CLIENT.get(path)
            if resp.status_code == 200:
                content_type = resp.headers.get("content-type", "")
                if "image" in content_type:
                    url = str(resp.url)
                    set_cached_cover("cover_rg", release_group_mbid, url)
                    return url
                set_cached_cover("cover_rg", release_group_mbid, None)
                return None
            if resp.status_code == 404:
                set_cached_cover("cover_rg", release_group_mbid, None)
                return None
            if resp.status_code in (429, 502, 503, 504) and attempt < _CAA_RETRIES:
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
            set_cached_cover("cover_rg", release_group_mbid, None)
            return None
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError):
            if attempt < _CAA_RETRIES:
                await asyncio.sleep(0.3)
                continue
            return None
        except Exception:
            return None
    return None


async def cover_url_for_release_or_rg(
    *,
    mb_release_id: str | None,
    mb_release_group_id: str | None,
    size: str = CAA_SIZE_LIST,
) -> str | None:
    """Best-effort cover URL for a release/release-group, backed by DB cache."""
    rid = (mb_release_id or "").strip()
    rgid = (mb_release_group_id or "").strip()
    if rid:
        url = await _caa_front_url(rid, size=size)
        if url:
            return url
    if rgid:
        url = await _caa_release_group_front_url(rgid, size=size)
        if url:
            return url
    return None


async def _first_cover_among_releases(
    ordered_release_mbids: list[str],
    size: str,
    memo: dict[str, str | None],
) -> str | None:
    """Try CAA in order; memo-cache per request so duplicates don't re-fetch."""
    for rid in ordered_release_mbids:
        if not rid:
            continue
        if rid in memo:
            if memo[rid]:
                return memo[rid]
            continue
        url = await _caa_front_url(rid, size)
        memo[rid] = url
        if url:
            return url
    return None


async def _hydrate_release_covers(
    results: list[dict[str, Any]],
    *,
    size: str = CAA_SIZE_LIST,
) -> None:
    """Fill album_cover via CAA — deduplicate MBIDs before fetching."""
    memo: dict[str, str | None] = {}

    async def cover_for_row(r: dict[str, Any]) -> None:
        async with _CAA_SEARCH_SEM:
            candidates = r.pop("_caa_release_ids", None) or []
            if not candidates and r.get("mb_release_id"):
                candidates = [r["mb_release_id"]]
            url = await _first_cover_among_releases(candidates, size, memo)
            if url:
                r["album_cover"] = url

    await asyncio.gather(*[cover_for_row(r) for r in results])


# ---------------------------------------------------------------------------
# MB API helpers (all use shared MB_CLIENT)
# ---------------------------------------------------------------------------

async def recording_search(lucene_query: str, limit: int = 20) -> list[dict[str, Any]]:
    """MB recording search + parse only (no CAA — hydrate later)."""
    logger.debug(f"[musicbrainz] recording_search: {lucene_query!r}")
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/recording",
        {"query": lucene_query, "fmt": "json", "limit": limit},
    )
    resp.raise_for_status()
    return _parse_recordings(resp.json(), min_score=45, require_official_release=True)


async def batch_recording_search_verbatim(
    phrases: list[str],
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Batch recording search using a single OR-query over verbatim phrases.

    Example lucene: ("Artist - Title") OR ("Artist2 - Title2")
    """
    parts: list[str] = []
    for p in phrases:
        t = (p or "").strip()
        if not t:
            continue
        parts.append(f'"{_lucene_escape_phrase(t)}"')
    if not parts:
        return []
    lucene = " OR ".join(parts)
    logger.debug(f"[musicbrainz] batch_recording_search_verbatim: {lucene!r}")
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/recording",
        {"query": lucene, "fmt": "json", "limit": limit},
    )
    resp.raise_for_status()
    # Verbatim phrase OR queries can yield lower MB scores; keep more and score locally.
    return _parse_recordings(resp.json(), min_score=1, require_official_release=True)


async def batch_recording_search_artist_title(
    pairs: list[tuple[str, str]],
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Batch recording search using a single OR-query over (artist,title) pairs.

    Lucene shape:
      (artist:"A" AND recording:"T") OR (artist:"B" AND recording:"U")
    """
    clauses: list[str] = []
    for artist, title in pairs:
        a = (artist or "").strip()
        t = (title or "").strip()
        if not a or not t:
            continue
        clauses.append(
            f'(artist:"{_lucene_escape_phrase(a)}" AND recording:"{_lucene_escape_phrase(t)}")'
        )
    if not clauses:
        return []
    lucene = " OR ".join(clauses)
    logger.debug(f"[musicbrainz] batch_recording_search_artist_title: {lucene!r}")
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/recording",
        {"query": lucene, "fmt": "json", "limit": limit},
    )
    resp.raise_for_status()
    # Pair OR queries can also yield low MB scores; keep more and score locally.
    return _parse_recordings(resp.json(), min_score=1, require_official_release=True)


async def recording_title_search_first(title: str) -> dict[str, Any] | None:
    """Optimistic title-only lookup: recording:\"title\" and take first parsed hit.

    Keeps low scores and does NOT require an official release.
    """
    t = _strip_featuring((title or "").replace("\ufeff", "").strip())
    if not t:
        return None
    lucene = f'recording:"{_lucene_escape_phrase(t)}"'
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/recording",
        {"query": lucene, "fmt": "json", "limit": 1},
    )
    if resp.status_code != 200:
        return None
    rows = _parse_recordings(resp.json(), min_score=1, require_official_release=False)
    return rows[0] if rows else None


async def recording_query_first(query: str) -> dict[str, Any] | None:
    """Optimistic search like the MB website box: pass raw query string, take first hit.

    Keeps low scores and does NOT require an official release.
    """
    q = (query or "").replace("\ufeff", "").strip()
    if not q:
        return None
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/recording",
        {"query": q, "fmt": "json", "limit": 1},
    )
    if resp.status_code != 200:
        return None
    rows = _parse_recordings(resp.json(), min_score=1, require_official_release=False)
    return rows[0] if rows else None


async def recording_query(query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """Recording search using raw query string, returning parsed hits.

    Keeps low scores and does NOT require an official release (used for optimistic import suggestions).
    """
    q = (query or "").replace("\ufeff", "").strip()
    if not q:
        return []
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/recording",
        {"query": q, "fmt": "json", "limit": limit},
    )
    if resp.status_code != 200:
        return []
    return _parse_recordings(resp.json(), min_score=1, require_official_release=False)


async def artist_candidate_mbids(name: str, *, limit: int = 5) -> list[str]:
    """Find likely artist MBIDs for a name (used for import fallbacks)."""
    q = (name or "").replace("\ufeff", "").strip()
    if not q:
        return []
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/artist",
        {"query": q, "fmt": "json", "limit": limit},
    )
    if resp.status_code != 200:
        return []
    out: list[str] = []
    for a in resp.json().get("artists", []) or []:
        if isinstance(a, dict) and a.get("id"):
            out.append(str(a["id"]))
    return out


async def canonical_artist_name(query: str) -> str:
    """Return the canonical MusicBrainz artist name for a query string.

    Unlike ``fix_artist_alias`` (which only considers the top hit), this tries a small set of
    candidate artists and prefers the one whose aliases/names actually match the query.
    """
    q = (query or "").replace("\ufeff", "").strip()
    if not q:
        return ""
    try:
        resp = await _mb_get(f"{MUSICBRAINZ_API}/artist", {"query": q, "fmt": "json", "limit": 8})
        if resp.status_code != 200:
            return q
        artists = [a for a in (resp.json().get("artists", []) or []) if isinstance(a, dict)]
        if not artists:
            return q

        # If any search hit already matches closely on name/sort-name, take the best.
        best_direct: tuple[float, str] | None = None
        for a in artists[:8]:
            n = (a.get("name") or "").strip()
            sn = (a.get("sort-name") or "").strip()
            cand = n or sn
            if not cand:
                continue
            s = SequenceMatcher(None, q.lower(), cand.lower()).ratio()
            if best_direct is None or s > best_direct[0]:
                best_direct = (s, n or cand)
        if best_direct and best_direct[0] >= 0.92:
            return best_direct[1]

        # Otherwise, fetch aliases for a few candidates and prefer an alias match.
        async def aliases_for(a: dict) -> tuple[dict, list[str]]:
            mid = (a.get("id") or "").strip()
            if not mid:
                return (a, [])
            try:
                r2 = await _mb_get(
                    f"{MUSICBRAINZ_API}/artist/{mid}",
                    {"fmt": "json", "inc": "aliases"},
                )
                if r2.status_code != 200:
                    return (a, [])
                data = r2.json()
                als = []
                for al in data.get("aliases") or []:
                    if isinstance(al, dict) and al.get("name"):
                        als.append(str(al["name"]).strip())
                # also include primary names for matching
                for k in ("name", "sort-name"):
                    v = (data.get(k) or "").strip()
                    if v:
                        als.append(v)
                return (a, [x for x in als if x])
            except Exception:
                return (a, [])

        cand_sets = await asyncio.gather(*[aliases_for(a) for a in artists[:5]])
        qlow = q.lower()
        for a, names in cand_sets:
            if any(n.lower() == qlow for n in names):
                n = (a.get("name") or "").strip()
                return n or q
        for a, names in cand_sets:
            if any(qlow in n.lower() for n in names):
                n = (a.get("name") or "").strip()
                return n or q

        # Fall back to top hit.
        top = artists[0]
        name = (top.get("name") or "").strip()
        return name or q
    except Exception:
        return q


async def release_track_search_artist_album(
    *,
    artist: str,
    album: str,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Search releases by artist+album and return parsed track rows.

    Uses the release endpoint with inc=recordings+artist-credits+media.
    """
    a = (artist or "").strip()
    alb = (album or "").strip()
    if not a or not alb:
        return []
    aq = _lucene_escape_phrase(a)
    alq = _lucene_escape_phrase(alb)
    lucene = f'artist:"{aq}" AND release:"{alq}"'
    return await release_search_tracks_loose(lucene, limit=limit)


async def release_track_search_arids_album(
    *,
    artist_mbids: list[str],
    album: str,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Search releases by artist MBIDs + album, then return parsed track rows."""
    alb = (album or "").strip()
    mbids = [m for m in artist_mbids if m]
    if not mbids or not alb:
        return []
    alq = _lucene_escape_phrase(alb)
    ar_or = " OR ".join(f"arid:{m}" for m in mbids[:5])
    lucene = f"({ar_or}) AND release:\"{alq}\""
    return await release_search_tracks_loose(lucene, limit=limit)


def _release_date(release: dict) -> str:
    return release.get("date") or ""


def _parse_releases_for_tracks(data: dict, *, require_official: bool = True) -> list[dict[str, Any]]:
    eligible = []
    for release in data.get("releases", []):
        if require_official:
            if release.get("status") != "Official":
                continue
            rg = release.get("release-group")
            if isinstance(rg, dict):
                primary = rg.get("primary-type") or ""
                secondaries = rg.get("secondary-types") or []
                if primary not in ("Album", "EP", "Single"):
                    continue
                if secondaries:
                    continue
        eligible.append(release)

    if not eligible:
        return []

    def _rk(r: dict) -> tuple[int, str]:
        score = 0
        try:
            score = int(r.get("score") or 0)
        except Exception:
            score = 0
        return (score, _release_date(r))

    eligible.sort(key=_rk, reverse=True)
    release = eligible[0]

    results = []
    for medium in release.get("media", []):
        for track in medium.get("tracks", []):
            rec = track.get("recording", {})
            if not rec:
                continue
            artist_name = (
                rec.get("artist-credit", [{}])[0].get("name", "Unknown")
                if rec.get("artist-credit")
                else "Unknown"
            )
            mb_artist_id = None
            ac = rec.get("artist-credit") or []
            if ac and isinstance(ac[0], dict):
                art = ac[0].get("artist")
                if isinstance(art, dict) and art.get("id"):
                    mb_artist_id = str(art["id"])
            artist_credit = _artist_credit_string(rec)
            row: dict[str, Any] = {
                "mbid": rec.get("id") or track.get("id"),
                "title": rec.get("title", "") or track.get("title", ""),
                "artist": artist_name,
                "artist_credit": artist_credit,
                "album": release.get("title", ""),
                "duration_ms": rec.get("length") or track.get("length"),
                "mb_release_id": release.get("id"),
                "mb_release_group_id": _rg_mbid_from_release(release),
                "album_cover": None,
                "preview_url": None,
                "source": "musicbrainz",
                "mb_score": rec.get("score", 50),
                "_caa_release_ids": [release.get("id")],
            }
            if mb_artist_id:
                row["mb_artist_id"] = mb_artist_id
            results.append(row)
    return results


async def _search_releases_for_track(lucene_query: str, limit: int = 20) -> list[dict[str, Any]]:
    type_filter = " OR ".join(f'type:"{t}"' for t in ("album", "ep", "single"))
    release_query = f"({lucene_query}) AND ({type_filter}) AND status:official"
    logger.debug(f"[musicbrainz] release-search: {release_query!r}")
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/release",
        {"query": release_query, "fmt": "json", "limit": limit, "inc": "recordings+artist-credits+media"},
    )
    resp.raise_for_status()
    return _parse_releases_for_tracks(resp.json(), require_official=True)


async def release_search_tracks_loose(lucene_query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """Loose release search for imports: no status/type constraints, parse first release."""
    logger.debug(f"[musicbrainz] release-search-loose: {lucene_query!r}")
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/release",
        {"query": lucene_query, "fmt": "json", "limit": limit, "inc": "recordings+artist-credits+media"},
    )
    if resp.status_code != 200:
        return []
    return _parse_releases_for_tracks(resp.json(), require_official=False)


async def raw_search(lucene_query: str, limit: int = 20) -> list[dict[str, Any]]:
    results = await recording_search(lucene_query, limit)
    await _hydrate_release_covers(results, size=CAA_SIZE_LIST)
    return results


async def search(query: str, artist: str | None = None) -> list[dict[str, Any]]:
    clean_title = _strip_featuring(query)
    if artist:
        a = artist.strip()
        canon = (await fix_artist_alias(a)).strip()
        artist = canon or a
        lucene_query = f'recording:"{clean_title}" AND artist:"{artist}"'
    else:
        lucene_query = f'recording:{clean_title}'
    results = await _search_releases_for_track(lucene_query)
    await _hydrate_release_covers(results, size=CAA_SIZE_LIST)
    return results


def _lucene_escape_phrase(s: str) -> str:
    if not s:
        return s
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _norm_cmp(s: str) -> str:
    s = (s or "").lower().strip()
    return re.sub(r"\s+", " ", s)


def _names_close(a: str, b: str, *, thresh: float = 0.78) -> bool:
    an, bn = _norm_cmp(a), _norm_cmp(b)
    if not an or not bn:
        return False
    if an == bn:
        return True
    shorter, longer = (an, bn) if len(an) <= len(bn) else (bn, an)
    if len(shorter) >= 2 and shorter in longer:
        return True
    return SequenceMatcher(None, an, bn).ratio() >= thresh


def _iter_recording_artist_credits(recording: dict) -> list[tuple[str | None, str]]:
    out: list[tuple[str | None, str]] = []
    for c in recording.get("artist-credit") or []:
        if not isinstance(c, dict):
            continue
        name = (c.get("name") or "").strip()
        amb = c.get("artist")
        mid = None
        disp2 = ""
        if isinstance(amb, dict):
            if amb.get("id"):
                mid = str(amb["id"])
            disp2 = (amb.get("name") or "").strip()
        display = name or disp2
        if mid or display:
            out.append((mid, display))
    return out


_ARTIST_NAMES_CACHE: OrderedDict[str, frozenset[str]] = OrderedDict()
_MAX_ARTIST_ALIAS_CACHE_ENTRIES = 400


async def _artist_all_names(artist_mbid: str) -> frozenset[str]:
    if artist_mbid in _ARTIST_NAMES_CACHE:
        _ARTIST_NAMES_CACHE.move_to_end(artist_mbid)
        return _ARTIST_NAMES_CACHE[artist_mbid]
    frozen: frozenset[str] = frozenset()
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/artist/{artist_mbid}",
            {"fmt": "json", "inc": "aliases"},
        )
        if resp.status_code == 200:
            data = resp.json()
            names: set[str] = set()
            for key in ("name", "sort-name"):
                v = (data.get(key) or "").strip()
                if v:
                    names.add(v)
            for al in data.get("aliases") or []:
                if isinstance(al, dict) and al.get("name"):
                    n = str(al["name"]).strip()
                    if n:
                        names.add(n)
            frozen = frozenset(names)
    except Exception:
        frozen = frozenset()
    _ARTIST_NAMES_CACHE[artist_mbid] = frozen
    while len(_ARTIST_NAMES_CACHE) > _MAX_ARTIST_ALIAS_CACHE_ENTRIES:
        _ARTIST_NAMES_CACHE.popitem(last=False)
    return frozen


async def _import_artist_candidate_mbids(wanted_artist: str, *, limit: int = 20) -> list[str]:
    """MB artist search for the import string; preserves score order (best match first)."""
    w = (wanted_artist or "").strip().replace("\ufeff", "")
    if not w:
        return []
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/artist",
            {"query": w, "fmt": "json", "limit": limit},
        )
        if resp.status_code != 200:
            return []
        return [
            str(a["id"])
            for a in resp.json().get("artists", [])
            if isinstance(a, dict) and a.get("id")
        ]
    except Exception:
        return []


def _embedded_artist_strings(artist_node: dict) -> list[str]:
    """Name / sort-name / aliases on an ``artist`` object from a recording search payload (no extra GET)."""
    if not isinstance(artist_node, dict):
        return []
    out: list[str] = []
    for k in ("name", "sort-name"):
        v = (artist_node.get(k) or "").strip()
        if v:
            out.append(v)
    for al in artist_node.get("aliases", []) or []:
        if isinstance(al, dict) and al.get("name"):
            n = str(al["name"]).strip()
            if n:
                out.append(n)
    return out


async def recording_wanted_artist_matches(
    recording: dict,
    wanted_artist: str,
    *,
    import_artist_mbids: list[str] | None = None,
) -> bool:
    """True if *wanted_artist* matches credits (fuzzy), MB aliases, or artist-search MBIDs."""
    w = (wanted_artist or "").strip().replace("\ufeff", "")
    if not w:
        return True
    mb_set = set(import_artist_mbids) if import_artist_mbids else set()

    for c in recording.get("artist-credit") or []:
        if not isinstance(c, dict):
            continue
        node = c.get("artist")
        if isinstance(node, dict) and node.get("id") and mb_set and str(node["id"]) in mb_set:
            return True

    for c in recording.get("artist-credit") or []:
        if not isinstance(c, dict):
            continue
        node = c.get("artist")
        if isinstance(node, dict):
            for cand in _embedded_artist_strings(node):
                if cand and _names_close(w, cand):
                    return True

    credits = _iter_recording_artist_credits(recording)
    for mid, display in credits:
        if mid and mb_set and mid in mb_set:
            return True
        if display and _names_close(w, display):
            return True
    if not credits:
        return False
    seen: set[str] = set()
    fetches = 0
    for mid, _display in credits:
        if not mid or mid in seen:
            continue
        if fetches >= 6:
            break
        seen.add(mid)
        fetches += 1
        alln = await _artist_all_names(mid)
        if any(_names_close(w, n) for n in alln):
            return True
    return False


def _recording_has_close_album_release(recording: dict, album_hint: str | None, thresh: float) -> bool:
    if not album_hint or not str(album_hint).strip():
        return True
    rels = recording.get("releases") or []
    if not rels:
        # Search results often omit releases; Lucene already matched release:"…" when applicable.
        return True
    ah = _norm_cmp(album_hint)
    if not ah:
        return True
    for rel in rels:
        rt = _norm_cmp(rel.get("title") or "")
        if not rt:
            continue
        if SequenceMatcher(None, ah, rt).ratio() >= thresh:
            return True
    return False


_TRAIL_TITLE_PUNCT = re.compile(r"[\s。．、，,\.!?！？…]+$")


def _normalize_title_for_match(s: str) -> str:
    s = unicodedata.normalize("NFC", (s or "").replace("\ufeff", "").strip()).lower()
    s = _TRAIL_TITLE_PUNCT.sub("", s).strip()
    return re.sub(r"\s+", " ", s)


def _recording_match_title(recording: dict, clean_title: str) -> bool:
    mb_title = recording.get("title", "") or ""
    a = _normalize_title_for_match(clean_title)
    b = _normalize_title_for_match(mb_title)
    if not a or not b:
        return False
    if a == b:
        return True
    return SequenceMatcher(None, a, b).ratio() > 0.75


def _pick_primary_release_for_playlist(recording: dict, album_hint: str | None) -> dict:
    release_list = recording.get("releases") or []
    if not release_list:
        return {}
    official_pick = official_releases_latest_first(release_list)
    candidates = official_pick if official_pick else _only_official_releases(release_list)
    if not candidates:
        candidates = list(release_list)
    if album_hint:
        best: dict | None = None
        best_s = 0.0
        for r in candidates:
            rt = (r.get("title") or "").strip()
            s = SequenceMatcher(None, album_hint.lower(), rt.lower()).ratio()
            if s > best_s:
                best_s = s
                best = r
        if best is not None and best_s > 0.72:
            return best
    return candidates[0]


def _metadata_dict_from_recording(recording: dict, album_hint: str | None) -> dict[str, Any]:
    rid = recording.get("id")
    if not rid:
        raise ValueError("recording has no id")
    artist_name = (
        recording.get("artist-credit", [{}])[0].get("name", "Unknown")
        if recording.get("artist-credit")
        else "Unknown"
    )
    artist_credit = _artist_credit_string(recording)
    mb_artist_id = _first_artist_mbid_from_recording(recording)
    primary = _pick_primary_release_for_playlist(recording, album_hint)
    album_title = primary.get("title", "") if primary else ""
    mb_release_id = primary.get("id") if primary else None
    mb_release_group_id = _rg_mbid_from_release(primary) if primary else None
    return {
        "mbid": str(rid),
        "title": recording.get("title", ""),
        "artist": artist_name,
        "artist_credit": artist_credit,
        "album": album_title,
        "mb_artist_id": mb_artist_id,
        "mb_release_id": str(mb_release_id) if mb_release_id else None,
        "mb_release_group_id": mb_release_group_id,
    }


_RESOLVE_MODE_PHASE: dict[str, str] = {
    "full": "MB: artist + title + album",
    "title_album": "MB: title + album",
    "artist_title": "MB: artist + title",
    "title_only": "MB: title only",
}


def _with_resolve_phase(meta: dict[str, Any], phase: str) -> dict[str, Any]:
    out = dict(meta)
    out["_resolve_phase"] = phase
    return out


async def resolve_artist_string_via_mb_search(raw_artist: str) -> str:
    """Resolve a Last.fm-style artist string to MusicBrainz's canonical ``name`` when the top
    ``/artist`` search hit matches the input (primary name or any alias, normalized).

    Upserts alias rows from the hit JSON and, when matched via an alias, persists the raw string
    via ``upsert_from_fix_artist_alias``. Does not rewrite the input through the local alias cache
    first — callers should try DB cache before calling this.
    """
    artist = (raw_artist or "").strip()
    if not artist:
        return artist
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/artist",
            {"query": artist, "fmt": "json", "limit": 1},
        )
        if resp.status_code != 200:
            return artist
        artists = resp.json().get("artists", [])
        if not artists:
            return artist
        hit = artists[0]
        try:
            upsert_from_mb_artist_json(hit, source="musicbrainz_resolve_artist_string")
        except Exception:
            logger.debug("resolve_artist_string upsert failed (ignored)", exc_info=True)
        canon = (hit.get("name") or "").strip()
        if not canon:
            return artist
        aid = (hit.get("id") or "").strip()
        n0 = norm_alias(artist)
        if norm_alias(canon) == n0:
            return canon
        for al in hit.get("aliases") or []:
            if not isinstance(al, dict):
                continue
            an = (al.get("name") or "").strip()
            if an and norm_alias(an) == n0:
                try:
                    if aid:
                        upsert_from_fix_artist_alias(
                            alias_raw=artist,
                            artist_mbid=aid,
                            canonical_name=canon,
                        )
                except Exception:
                    logger.debug("resolve_artist_string persist alias failed (ignored)", exc_info=True)
                return canon
        return artist
    except Exception:
        return artist


async def fix_artist_alias(query: str) -> str:
    """Resolve MB artist aliases in *query* to the artist's primary name (e.g. Ye → Kanye West).

    Runs a single artist search; if the top hit lists an alias that appears as a whole token in
    *query*, replaces that alias with the canonical name. Used before recording search.
    """
    query = (query or "").strip()
    if not query:
        return query
    query = rewrite_query_with_cached_aliases(query)
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/artist",
            {"query": query, "fmt": "json", "limit": 1},
        )
        if resp.status_code != 200:
            return query
        artists = resp.json().get("artists", [])
        if not artists:
            return query
        artist = artists[0]
        try:
            upsert_from_mb_artist_json(artist, source="musicbrainz_fix_artist_alias")
        except Exception:
            logger.debug("artist alias upsert (fix_artist_alias) failed (ignored)", exc_info=True)
        qnorm = f" {query.lower()} "
        for alias in artist.get("aliases", []):
            alias_name = alias.get("name")
            if alias_name and f" {alias_name.lower()} " in qnorm:
                out = query.lower().replace(alias_name.lower(), (artist.get("name") or "").lower())
                try:
                    aid = (artist.get("id") or "").strip()
                    canon = (artist.get("name") or "").strip()
                    if aid and canon and alias_name:
                        upsert_from_fix_artist_alias(alias_raw=str(alias_name), artist_mbid=aid, canonical_name=canon)
                except Exception:
                    logger.debug("fix_artist_alias persist failed (ignored)", exc_info=True)
                return out
        return query
    except Exception:
        return query


async def _recording_search_results(lucene_query: str, limit: int = 10) -> list[dict]:
    resp = await _mb_get(
        f"{MUSICBRAINZ_API}/recording",
        {"query": lucene_query, "fmt": "json", "limit": limit},
    )
    if resp.status_code != 200:
        return []
    return resp.json().get("recordings", []) or []


async def recording_query_raw(
    query: str,
    *,
    limit: int = 20,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Recording search returning raw MusicBrainz recording objects.

    Includes artist-credits + releases so callers can match against all credited artists and all
    release titles (important for playlist import batching). *query* is sent verbatim (no alias
    rewrite); callers pass Lucene or plain text as appropriate.
    """
    q = (query or "").replace("\ufeff", "").strip()
    if not q:
        return []
    # Caller-built Lucene (e.g. playlist import batch) must not go through free-text alias rewrite.
    params: dict[str, Any] = {
        "query": q,
        "fmt": "json",
        "limit": limit,
        "inc": "artist-credits+releases",
    }
    if offset > 0:
        params["offset"] = int(offset)
    resp = await _mb_get(f"{MUSICBRAINZ_API}/recording", params)
    if resp.status_code != 200:
        return []
    recs = resp.json().get("recordings", []) or []
    return [r for r in recs if isinstance(r, dict)]


def recording_to_playlist_meta(recording: dict[str, Any], *, album_hint: str | None) -> dict[str, Any] | None:
    """Convert a raw MB recording object to the import metadata dict (mbid + release ids)."""
    try:
        return _metadata_dict_from_recording(recording, album_hint)
    except Exception:
        return None


async def _resolve_via_hybrid_pairs_search(
    clean_title: str,
    artist: str,
    album: str | None,
    import_artist_mbids: list[str],
) -> dict[str, Any] | None:
    """Same Lucene shape as in-app hybrid search (split artist/title + official types)."""
    if not artist or not clean_title:
        return None
    from services.hybrid_search import (
        _pick_best_recording,
        build_lucene_query_for_pairs,
        get_artist_recording_pairs,
    )

    # Do not run fix_artist_alias() on "artist + title" — MB artist search is unreliable on
    # multi-token strings and can break CJK / romaji pair queries. Artist is already normalized
    # earlier in resolve_recording_metadata.
    combined = f"{artist} {clean_title}".strip()
    pairs = get_artist_recording_pairs(combined)
    type_filter = 'type:"Album" OR type:"EP" OR type:"Single"'
    if pairs:
        lucene = (
            f'status:official AND ({type_filter}) AND NOT comment:live AND '
            f"({build_lucene_query_for_pairs(pairs)})"
        )
    else:
        lucene = (
            f'status:official AND ({type_filter}) AND NOT comment:live AND '
            f'recording:"{_lucene_escape_phrase(combined)}"'
        )
    logger.debug(f"[musicbrainz] resolve_recording_metadata hybrid-pairs: {lucene!r}")
    try:
        results = await recording_search(lucene, limit=25)
    except Exception:
        return None
    if not results:
        return None

    def row_ok(row: dict[str, Any]) -> bool:
        if not _recording_match_title({"title": row.get("title", "")}, clean_title):
            return False
        if not import_artist_mbids:
            art = row.get("artist")
            return bool(art and _names_close(artist, str(art)))
        # Lucene OR-clauses already tied artist+recording; mb_artist_id is first credit only
        # (feat. / join order), and romaji vs ヨルシカ often fails _names_close — trust title match.
        return True

    filtered = [r for r in results if row_ok(r)]
    if not filtered:
        return None
    best = _pick_best_recording(filtered, combined)
    return {
        "mbid": str(best["mbid"]),
        "title": best.get("title") or clean_title,
        "artist": best.get("artist") or artist,
        "album": best.get("album") or (album or ""),
        "mb_artist_id": best.get("mb_artist_id"),
        "mb_release_id": str(best["mb_release_id"]) if best.get("mb_release_id") else None,
        "mb_release_group_id": best.get("mb_release_group_id"),
        "_resolve_phase": "MB: hybrid pair search",
    }


async def _resolve_via_release_track_search(
    clean_title: str,
    artist: str,
    album: str | None,
    aq: str,
    art_q: str,
    import_artist_mbids: list[str],
) -> dict[str, Any] | None:
    """Same path as user search (`search`): release API + embedded recordings — better MB recall."""
    if not artist:
        return None
    try:
        rows = await _search_releases_for_track(f'recording:"{aq}" AND artist:"{art_q}"')
    except Exception:
        return None
    for row in rows:
        mbid = row.get("mbid")
        if not mbid:
            continue
        if not _recording_match_title({"title": row.get("title", "")}, clean_title):
            continue
        if import_artist_mbids:
            ok_artist = True
        else:
            ok_artist = bool(row.get("artist") and _names_close(artist, str(row["artist"])))
        if not ok_artist:
            continue
        return {
            "mbid": str(mbid),
            "title": row.get("title") or clean_title,
            "artist": row.get("artist") or artist,
            "album": row.get("album") or (album or ""),
            "mb_artist_id": row.get("mb_artist_id"),
            "mb_release_id": str(row["mb_release_id"]) if row.get("mb_release_id") else None,
            "mb_release_group_id": row.get("mb_release_group_id"),
            "_resolve_phase": "MB: release + track search",
        }
    return None


async def _resolve_via_arid_recording(
    clean_title: str,
    artist: str,
    album: str | None,
    aq: str,
    import_artist_mbids: list[str],
) -> dict[str, Any] | None:
    """Per import artist MBID from /artist search: arid + recording (tight recall for messy Lucene)."""
    if not import_artist_mbids or not clean_title:
        return None
    for aid in import_artist_mbids[:8]:
        lucene = f'arid:{aid} AND recording:"{aq}"'
        logger.debug(f"[musicbrainz] resolve_recording_metadata arid+recording: {lucene!r}")
        try:
            raw_recs = await _recording_search_results(lucene, limit=25)
        except Exception:
            continue
        for rec in sorted(
            raw_recs,
            key=lambda r: (bool(r.get("video")), -float(r.get("score") or 0)),
        ):
            if not rec.get("id"):
                continue
            if float(rec.get("score") or 0) < 38:
                continue
            if not _recording_match_title(rec, clean_title):
                continue
            if artist:
                if not await recording_wanted_artist_matches(
                    rec, artist, import_artist_mbids=import_artist_mbids
                ):
                    continue
            try:
                return _with_resolve_phase(
                    _metadata_dict_from_recording(rec, album),
                    "MB: artist MBID + recording",
                )
            except ValueError:
                continue
    return None


async def _resolve_via_title_search_verify_artist(
    clean_title: str,
    artist: str,
    album: str | None,
    aq: str,
    import_artist_mbids: list[str],
) -> dict[str, Any] | None:
    """Title-only /recording search (same filters as hybrid without artist in Lucene), then verify artist on raw JSON."""
    if not clean_title:
        return None
    type_filter = 'type:"Album" OR type:"EP" OR type:"Single"'
    attempts: list[tuple[str, str, int]] = [
        (
            f'status:official AND ({type_filter}) AND NOT comment:live AND recording:"{aq}"',
            "title_official",
            40,
        ),
        (f'recording:"{aq}"', "title_loose", 32),
    ]
    for lucene, label, min_score in attempts:
        phase = (
            "MB: title search (official releases)"
            if label == "title_official"
            else "MB: title search (broader)"
        )
        logger.debug(f"[musicbrainz] resolve_recording_metadata {label}: {lucene!r}")
        try:
            raw_recs = await _recording_search_results(lucene, limit=55)
        except Exception:
            continue
        for rec in sorted(
            raw_recs,
            key=lambda r: (bool(r.get("video")), -float(r.get("score") or 0)),
        ):
            if not rec.get("id"):
                continue
            if float(rec.get("score") or 0) < min_score:
                continue
            if not _recording_match_title(rec, clean_title):
                continue
            if artist:
                if not await recording_wanted_artist_matches(
                    rec, artist, import_artist_mbids=import_artist_mbids
                ):
                    continue
            try:
                return _with_resolve_phase(_metadata_dict_from_recording(rec, album), phase)
            except ValueError:
                continue
    return None


async def resolve_recording_metadata(
    title: str, artist: str, album: str | None = None,
) -> dict[str, Any] | None:
    """MB recording search: stricter paths first, then hybrid/release fallbacks, arid+title, title-only.

    End chain: hybrid pair Lucene → release search → ``arid:`` + recording → title-only (official then
    loose) with ``recording_wanted_artist_matches`` on raw hits.
    """
    clean_title = _strip_featuring((title or "").replace("\ufeff", "").strip())
    artist_raw = (artist or "").strip().replace("\ufeff", "")
    artist = artist_raw
    if artist:
        canon = (await fix_artist_alias(artist)).strip()
        if canon:
            artist = canon
    album = ((album or "").replace("\ufeff", "").strip() or None) or None

    m_canon = await _import_artist_candidate_mbids(artist) if artist else []
    m_raw = await _import_artist_candidate_mbids(artist_raw) if artist_raw and artist_raw != artist else []
    import_artist_mbids = list(dict.fromkeys([*m_canon, *m_raw]))

    aq = _lucene_escape_phrase(clean_title)
    art_q = _lucene_escape_phrase(artist) if artist else ""
    alb_q = _lucene_escape_phrase(album) if album else ""

    query_attempts: list[tuple[str, str]] = []
    if artist and album:
        query_attempts.append(
            (
                f'artist:"{art_q}" AND recording:"{aq}" AND release:"{alb_q}"',
                "full",
            )
        )
    if album:
        query_attempts.append((f'recording:"{aq}" AND release:"{alb_q}"', "title_album"))
    if artist:
        query_attempts.append((f'artist:"{art_q}" AND recording:"{aq}"', "artist_title"))
    if not artist:
        query_attempts.append((f'recording:"{aq}"', "title_only"))

    seen: set[str] = set()
    for lucene_query, mode in query_attempts:
        if lucene_query in seen:
            continue
        seen.add(lucene_query)
        logger.debug(f"[musicbrainz] resolve_recording_metadata: {lucene_query!r} ({mode})")
        try:
            recordings = await _recording_search_results(lucene_query, limit=15)
        except Exception:
            continue
        for recording in recordings:
            if not recording.get("id"):
                continue
            if recording.get("score", 0) < 45:
                continue
            if not _recording_match_title(recording, clean_title):
                continue
            if artist:
                if not await recording_wanted_artist_matches(
                    recording, artist, import_artist_mbids=import_artist_mbids
                ):
                    continue
            if mode == "full" and album:
                if not _recording_has_close_album_release(recording, album, 0.62):
                    continue
            if mode == "title_album" and album:
                if not _recording_has_close_album_release(recording, album, 0.54):
                    continue
            try:
                return _with_resolve_phase(
                    _metadata_dict_from_recording(recording, album),
                    _RESOLVE_MODE_PHASE.get(mode, "MB: recording search"),
                )
            except ValueError:
                continue
    hybrid_meta = await _resolve_via_hybrid_pairs_search(
        clean_title, artist, album, import_artist_mbids
    )
    if hybrid_meta:
        return hybrid_meta
    rel_meta = await _resolve_via_release_track_search(
        clean_title, artist, album, aq, art_q, import_artist_mbids
    )
    if rel_meta:
        return rel_meta
    arid_meta = await _resolve_via_arid_recording(
        clean_title, artist, album, aq, import_artist_mbids
    )
    if arid_meta:
        return arid_meta
    title_meta = await _resolve_via_title_search_verify_artist(
        clean_title, artist, album, aq, import_artist_mbids
    )
    if title_meta:
        return title_meta
    return None


async def resolve_id(title: str, artist: str, album: str | None = None) -> str | None:
    meta = await resolve_recording_metadata(title, artist, album)
    return meta["mbid"] if meta else None


async def hydrate_track_album_cover_from_releases(track_id: int, release_mbids: list[str]) -> None:
    """Backfill ``Track.album_cover`` from CAA after the hot path (play/resolve) has returned."""
    if not release_mbids:
        return
    from database import engine
    from models import Track
    from sqlmodel import Session

    with Session(engine) as session:
        track = session.get(Track, track_id)
        if not track or track.album_cover:
            return

    memo: dict[str, str | None] = {}
    url = await _first_cover_among_releases(release_mbids, CAA_SIZE_DETAIL, memo)
    if not url:
        return
    with Session(engine) as session:
        track = session.get(Track, track_id)
        if not track or track.album_cover:
            return
        track.album_cover = url
        session.add(track)
        session.commit()


async def get_track(mbid: str, *, include_cover: bool = True) -> dict[str, Any] | None:
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/recording/{mbid}",
            params={"fmt": "json", "inc": "artist-credits+releases+release-groups"},
        )
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            return None
        data = resp.json()
        artist_name = (
            data.get("artist-credit", [{}])[0].get("name", "Unknown")
            if data.get("artist-credit")
            else "Unknown"
        )
        artist_credit = _artist_credit_string(data)
        release_list = data.get("releases", [])
        official_pick = official_releases_latest_first(release_list)
        primary = official_pick[0] if official_pick else {}
        album_title = (
            primary.get("title", "")
            if primary
            else (release_list[0].get("title", "") if release_list else "")
        )
        ids = [r["id"] for r in official_pick if r.get("id")]
        memo: dict[str, str | None] = {}
        cover_url: str | None = None
        if include_cover and ids:
            cover_url = await _first_cover_among_releases(ids, CAA_SIZE_DETAIL, memo)
        rg = primary.get("release-group") if primary else {}
        out: dict[str, Any] = {
            "mbid": data["id"],
            "title": data.get("title", ""),
            "artist": artist_name,
            "artist_credit": artist_credit,
            "album": album_title,
            "album_cover": cover_url,
            "preview_url": None,
            "source": "musicbrainz",
        }
        if not include_cover and ids:
            out["_caa_release_mbids"] = ids
        amb = _first_artist_mbid_from_recording(data)
        if amb:
            out["mb_artist_id"] = amb
        if primary:
            out["mb_release_id"] = primary.get("id")
            if isinstance(rg, dict) and rg.get("id"):
                out["mb_release_group_id"] = str(rg["id"])
            out["release_date"] = primary.get("date") or data.get("date") or ""
        return out
    except Exception:
        return None


async def get_artist_head(artist_mbid: str) -> dict | None:
    """One MB ``/artist`` request: id, name, empty ``top_tracks``. Used for fast artist page load."""
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/artist/{artist_mbid}",
            params={"fmt": "json", "inc": "aliases"},
        )
        if resp.status_code != 200:
            logger.warning(f"[mb] get_artist_head {artist_mbid} → {resp.status_code}: {resp.text[:200]}")
            return None
        data = resp.json()
        try:
            upsert_from_mb_artist_json(data, source="musicbrainz_get_artist_head")
        except Exception:
            logger.debug("artist alias upsert (head) failed (ignored)", exc_info=True)
        return {
            "mbid": data["id"],
            "name": data.get("name", "Unknown"),
            "picture": None,
            "banner": None,
            "nb_fans": 0,
            "top_tracks": [],
        }
    except Exception as exc:
        logger.warning(f"[mb] get_artist_head {artist_mbid} exception: {exc}")
        return None


async def get_artist(artist_mbid: str) -> dict | None:
    artist_data = await _get_artist_head_data(artist_mbid)
    if artist_data is not None:
        return artist_data

    recording = await _get_recording_with_releases(artist_mbid)
    if recording is not None:
        artist_credit = recording.get("artist-credit", [{}])
        if artist_credit:
            extracted_artist_mbid = artist_credit[0].get("artist", {}).get("id")
            if extracted_artist_mbid:
                artist_data = await _get_artist_head_data(extracted_artist_mbid)
                if artist_data is not None:
                    return artist_data

    return None


async def get_artist_albums(artist_mbid: str) -> list[dict]:
    """Artist discography (album / EP / single release groups).

    Uses MusicBrainz **release-group search** (Lucene) so we do not paginate thousands of
    ``/release`` rows. Results are still filtered with the same credit / VA / title rules as
    before (applied to each RG). Sorting uses ``first-release-date`` on the RG. Choosing the
    canonical **release** inside a group remains the job of ``get_album`` / album routes.
    """
    try:
        rg_first: dict[str, tuple[tuple[int, int, int], dict]] = {}

        query = _artist_discography_rg_search_query(artist_mbid)
        offset = 0
        page = 0

        while page < _ARTIST_DISCOGRAPHY_RG_SEARCH_MAX_PAGES:
            if page:
                await asyncio.sleep(_MB_PAGE_GAP_S)
            try:
                resp = await _mb_get(
                    f"{MUSICBRAINZ_API}/release-group",
                    params={
                        "query": query,
                        "fmt": "json",
                        "limit": _ARTIST_DISCOGRAPHY_RG_SEARCH_LIMIT,
                        "offset": offset,
                    },
                )
            except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
                break
            if resp.status_code != 200:
                break
            data = resp.json()
            rgs = data.get("release-groups") or []
            if not rgs:
                break

            total_hits = int(data.get("count") or 0)

            for rg in rgs:
                if not isinstance(rg, dict) or not rg.get("id"):
                    continue
                if _rg_search_embeds_only_non_official(rg):
                    continue

                p_type = rg.get("primary-type")
                s_types = rg.get("secondary-types") or []
                if p_type not in ("Album", "Single", "EP") or len(s_types) > 0:
                    continue

                if p_type == "Album":
                    if not _artist_is_primary_credit(rg, artist_mbid):
                        continue
                else:
                    if not _artist_is_strict_lead(rg, artist_mbid):
                        continue

                _VA_ID = "89ad4ac3-39f7-470e-963a-56509c546377"
                ac = rg.get("artist-credit") or []
                if (
                    isinstance(ac, list)
                    and len(ac) == 1
                    and isinstance(ac[0], dict)
                    and isinstance(ac[0].get("artist"), dict)
                    and str(ac[0]["artist"].get("id") or "") == _VA_ID
                ):
                    continue

                title_norm = str(rg.get("title") or "").strip().lower()
                if "presents good music" in title_norm or "presents g.o.o.d." in title_norm:
                    continue
                if title_norm.startswith("g.o.o.d. morning"):
                    continue

                rg_id = str(rg["id"])
                date_str = (rg.get("first-release-date") or "").strip()
                if not date_str:
                    continue
                date_val = _parse_mb_date(date_str)
                payload = {
                    "mb_release_group_id": rg_id,
                    "title": rg.get("title") or "",
                    "cover": None,
                    "release_date": date_str,
                    "type": p_type or "",
                }
                if rg_id not in rg_first or date_val < rg_first[rg_id][0]:
                    rg_first[rg_id] = (date_val, payload)

            offset += len(rgs)
            page += 1
            if total_hits and offset >= total_hits:
                break
            if len(rgs) < _ARTIST_DISCOGRAPHY_RG_SEARCH_LIMIT:
                break

        items = [v for (_d, v) in rg_first.values()]

        albums = [it for it in items if str(it.get("type") or "").lower() == "album"]
        eps = [it for it in items if str(it.get("type") or "").lower() == "ep"]
        singles = [it for it in items if str(it.get("type") or "").lower() == "single"]

        def sort_by_date_desc(rows: list[dict]) -> list[dict]:
            return sorted(rows, key=lambda r: _parse_mb_date(r.get("release_date")), reverse=True)

        albums = sort_by_date_desc(albums)[:_ARTIST_DISCOGRAPHY_MAX_RGS]
        eps = sort_by_date_desc(eps)[:_ARTIST_DISCOGRAPHY_MAX_RGS]
        singles = sort_by_date_desc(singles)[: (_ARTIST_DISCOGRAPHY_MAX_RGS * 4)]

        return albums + eps + singles
    except Exception:
        return []


async def _caa_artist_image_url(artist_mbid: str) -> str | None:
    """Fetch artist image from CAA. Check DB cache first.

    CAA artist endpoint returns {"images": [{"image": "...", "thumbnails": {...}, ...]}.
    For artist images there is no front/back — just pick the first image's largest thumbnail.
    """
    if not artist_mbid:
        return None

    from services.providers import get_cached_cover, set_cached_cover
    found, cached_url = get_cached_cover("cover_artist", artist_mbid)
    logger.debug(f"[caa] _caa_artist_image_url {artist_mbid}: cache found={found} url={cached_url}")
    if found:
        return cached_url  # None = known miss

    path = f"/artist/{artist_mbid}"
    for attempt in range(_CAA_RETRIES + 1):
        try:
            resp = await CAA_CLIENT.get(path)
            if resp.status_code == 200:
                data = resp.json()
                images = data.get("images") or []
                logger.debug(f"[caa] _caa_artist_image_url {artist_mbid}: got {len(images)} images")
                # For artist images: no front/back, just use first image's thumbnails
                if images:
                    img = images[0]
                    thumbs = img.get("thumbnails") or {}
                    # Prefer 500, then large, then original
                    url = thumbs.get("500") or thumbs.get("large") or thumbs.get("original")
                    if url:
                        logger.debug(f"[caa] _caa_artist_image_url {artist_mbid}: found url={url}")
                        set_cached_cover("cover_artist", artist_mbid, url)
                        return url
                set_cached_cover("cover_artist", artist_mbid, None)
                return None
            if resp.status_code == 404:
                logger.warning(f"[caa] _caa_artist_image_url {artist_mbid}: 404 not found")
                set_cached_cover("cover_artist", artist_mbid, None)
                return None
            if resp.status_code in (429, 502, 503, 504) and attempt < _CAA_RETRIES:
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
            logger.warning(f"[caa] _caa_artist_image_url {artist_mbid}: status={resp.status_code}")
            set_cached_cover("cover_artist", artist_mbid, None)
            return None
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError):
            if attempt < _CAA_RETRIES:
                await asyncio.sleep(0.3)
                continue
            return None
        except Exception as e:
            logger.warning(f"[caa] _caa_artist_image_url {artist_mbid}: exception={e}")
            return None
    return None


async def _caa_artist_banner_url(artist_mbid: str, fallback_release_mbids: list[str]) -> str | None:
    """Fetch artist banner from CAA. Tries artist page for largest image, then release group covers."""
    from services.providers import get_cached_cover, set_cached_cover
    found, cached_url = get_cached_cover("cover_artist_banner", artist_mbid)
    logger.debug(f"[caa] _caa_artist_banner_url {artist_mbid}: cache found={found} url={cached_url}")
    if found and cached_url:
        return cached_url

    # Try artist page — pick largest thumbnail available (1200 > 500 > large > original)
    path = f"/artist/{artist_mbid}"
    for attempt in range(_CAA_RETRIES + 1):
        try:
            resp = await CAA_CLIENT.get(path)
            if resp.status_code == 200:
                data = resp.json()
                images = data.get("images") or []
                logger.debug(f"[caa] _caa_artist_banner_url {artist_mbid}: got {len(images)} images")
                if images:
                    img = images[0]
                    thumbs = img.get("thumbnails") or {}
                    # Banner: want the largest available
                    url = thumbs.get("1200") or thumbs.get("500") or thumbs.get("large") or thumbs.get("original") or img.get("image")
                    if url:
                        logger.debug(f"[caa] _caa_artist_banner_url {artist_mbid}: found banner={url}")
                        set_cached_cover("cover_artist_banner", artist_mbid, url)
                        return url
            if resp.status_code == 404:
                pass  # fall through to release covers
            elif resp.status_code in (429, 502, 503, 504) and attempt < _CAA_RETRIES:
                await asyncio.sleep(0.3 * (attempt + 1))
                continue
            break  # don't retry non-retryable errors, go to fallback
        except Exception as e:
            logger.warning(f"[caa] _caa_artist_banner_url {artist_mbid}: exception={e}")
            break

    # Fallback: use first release group cover
    for rg_mbid in fallback_release_mbids:
        if not rg_mbid:
            continue
        cover = await _caa_release_group_front_url(rg_mbid, CAA_SIZE_DETAIL)
        if cover:
            set_cached_cover("cover_artist_banner", artist_mbid, cover)
            return cover
    set_cached_cover("cover_artist_banner", artist_mbid, None)
    return None


async def _get_artist_head_data(artist_mbid: str) -> dict | None:
    try:
        resp, recording_resp = await asyncio.gather(
            _mb_get(
                f"{MUSICBRAINZ_API}/artist/{artist_mbid}",
                params={"fmt": "json", "inc": "aliases"},
            ),
            _mb_get(
                f"{MUSICBRAINZ_API}/recording",
                params={"query": f"arid:{artist_mbid}", "fmt": "json", "limit": 10, "sort": "desc"},
            ),
        )
        if resp.status_code != 200:
            logger.warning(f"[mb] get_artist_head {artist_mbid} → {resp.status_code}: {resp.text[:200]}")
            return None
        data = resp.json()
        try:
            upsert_from_mb_artist_json(data, source="musicbrainz_get_artist")
        except Exception:
            logger.debug("artist alias upsert (get_artist) failed (ignored)", exc_info=True)

        top_cover_memo: dict[str, str | None] = {}

        async def _top_track_row(rec: dict) -> dict[str, Any]:
            release_list = rec.get("releases", [])
            official_pick = official_releases_latest_first(release_list)
            primary = official_pick[0] if official_pick else {}
            album_title = (
                primary.get("title", "")
                if primary
                else (release_list[0].get("title", "") if release_list else "")
            )
            ids = [r["id"] for r in official_pick[:2] if r.get("id")]
            cover = await _first_cover_among_releases(ids, CAA_SIZE_LIST, top_cover_memo)
            rg = primary.get("release-group", {}) if primary else {}
            return {
                "mbid": rec["id"],
                "mb_id": rec["id"],
                "title": rec.get("title", ""),
                "album": album_title,
                "album_cover": cover,
                "mb_release_id": primary.get("id") if primary else None,
                "mb_release_group_id": rg.get("id") if rg else None,
                "mb_artist_id": artist_mbid,
                "source": "musicbrainz",
            }

        recs = recording_resp.json().get("recordings", [])[:10] if recording_resp.is_success else []
        top_recordings = list(await asyncio.gather(*[_top_track_row(rec) for rec in recs]))

        # Artist images come from fanart.tv, populated in MetadataService.get_artist_head
        return {
            "mbid": data["id"],
            "name": data.get("name", "Unknown"),
            "picture": None,
            "banner": None,
            "nb_fans": 0,
            "top_tracks": top_recordings,
        }
    except Exception as exc:
        logger.warning(f"[mb] get_artist_head {artist_mbid} exception: {exc}")
        return None


async def _browse_release_groups_for_artist(artist_mbid: str) -> list[dict]:
    """Paginated /release-group?artist=… (sequential pages with retries; avoids MB rate spikes).

    Requests artist-credits so we can exclude RGs where this artist is only a feature.
    """
    params_base = {
        "artist": artist_mbid,
        "fmt": "json",
        "limit": _ARTIST_RG_BROWSE_PAGE,
        "inc": "artist-credits",
    }
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/release-group",
            params={**params_base, "offset": 0},
        )
    except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
        return []
    if resp.status_code != 200:
        return []
    data = resp.json()
    all_rgs: list[dict] = list(data.get("release-groups", []))
    try:
        total = int(data.get("release-group-count", len(all_rgs)))
    except (TypeError, ValueError):
        total = len(all_rgs)

    if len(all_rgs) < total:
        max_fetch = min(total, _ARTIST_RG_BROWSE_MAX_PAGES * _ARTIST_RG_BROWSE_PAGE)
        offsets = list(range(_ARTIST_RG_BROWSE_PAGE, max_fetch, _ARTIST_RG_BROWSE_PAGE))
        for off in offsets:
            try:
                await asyncio.sleep(_MB_PAGE_GAP_S)
                r = await _mb_get(
                    f"{MUSICBRAINZ_API}/release-group",
                    params={**params_base, "offset": off},
                )
            except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
                break
            if r.status_code == 200:
                all_rgs.extend(r.json().get("release-groups", []))

    return [rg for rg in all_rgs if _artist_is_primary_credit(rg, artist_mbid)]


async def _official_rg_ids_for_artist(artist_mbid: str) -> set[str]:
    """Return RG IDs that have at least one Official release by this artist."""
    rg_ids: set[str] = set()
    offset = 0
    max_releases = _MB_BROWSE_MAX_PAGES * _MB_BROWSE_PAGE
    while offset < max_releases:
        if offset:
            await asyncio.sleep(_MB_PAGE_GAP_S)
        try:
            resp = await _mb_get(
                f"{MUSICBRAINZ_API}/release",
                params={"artist": artist_mbid, "fmt": "json",
                        "limit": _MB_BROWSE_PAGE, "offset": offset, "inc": "release-groups"},
            )
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
            break
        if resp.status_code != 200:
            break
        data = resp.json()
        releases = data.get("releases", [])
        for r in releases:
            if r.get("status") == "Official":
                rg = r.get("release-group")
                if isinstance(rg, dict) and rg.get("id"):
                    rg_ids.add(str(rg["id"]))
        total = int(data.get("release-count", 0))
        offset += len(releases)
        if offset >= total or not releases:
            break
    return rg_ids


async def _browse_releases_in_group(rg_mbid: str) -> list[dict]:
    """Paginated /release?release-group=… (sequential pages with retries)."""
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/release",
            params={"release-group": rg_mbid, "fmt": "json",
                    "limit": _MB_BROWSE_PAGE, "offset": 0, "inc": "media"},
        )
    except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
        return []
    if resp.status_code != 200:
        return []
    data = resp.json()
    all_releases: list[dict] = list(data.get("releases", []))
    try:
        total = int(data.get("release-count", len(all_releases)))
    except (TypeError, ValueError):
        total = len(all_releases)

    if len(all_releases) >= total:
        return all_releases

    max_fetch = min(total, _MB_BROWSE_MAX_PAGES * _MB_BROWSE_PAGE)
    offsets = list(range(_MB_BROWSE_PAGE, max_fetch, _MB_BROWSE_PAGE))
    for off in offsets:
        try:
            await asyncio.sleep(_MB_PAGE_GAP_S)
            r = await _mb_get(
                f"{MUSICBRAINZ_API}/release",
                params={"release-group": rg_mbid, "fmt": "json",
                        "limit": _MB_BROWSE_PAGE, "offset": off, "inc": "media"},
            )
        except (httpx.TimeoutException, httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
            break
        if r.status_code == 200:
            all_releases.extend(r.json().get("releases", []))

    return all_releases


async def _releases_for_release_group(rg_mbid: str) -> list[dict]:
    browsed = await _browse_releases_in_group(rg_mbid)
    if official_releases_latest_first(browsed):
        return browsed

    resp = await _mb_get(f"{MUSICBRAINZ_API}/release-group/{rg_mbid}", params={"fmt": "json", "inc": "releases"})
    embedded: list[dict] = []
    if resp.is_success and resp.status_code != 404:
        embedded = resp.json().get("releases", [])
    if official_releases_latest_first(embedded):
        return embedded
    if browsed:
        return browsed
    return embedded


async def _ordered_official_release_mbids_for_group(rg_mbid: str) -> list[str]:
    """Official releases newest-first for a RG. Cached in DB with 30-day TTL."""
    from services.providers import _db_get, _db_set
    from datetime import timedelta, datetime

    cache_kind = "rg_ordered"
    cached = _db_get(cache_kind, rg_mbid)
    if cached is not None:
        # Check 30-day TTL
        from database import engine
        from models import MBEntityCache
        from sqlmodel import Session
        try:
            with Session(engine) as session:
                row = session.get(MBEntityCache, f"{cache_kind}:{rg_mbid}")
                if row and (datetime.utcnow() - row.fetched_at) <= timedelta(days=30):
                    return cached
        except Exception:
            return cached

    rg_head = await _mb_get(f"{MUSICBRAINZ_API}/release-group/{rg_mbid}", params={"fmt": "json"})
    if rg_head.status_code != 200:
        return []
    if not _strict_album_or_single_rg(rg_head.json()):
        return []
    releases = await _releases_for_release_group(rg_mbid)
    result = [r["id"] for r in official_releases_latest_first(releases) if r.get("id")]
    _db_set(cache_kind, rg_mbid, result)
    return result


async def _resolve_release_from_release_group(rg_mbid: str) -> str | None:
    try:
        ordered = await _ordered_official_release_mbids_for_group(rg_mbid)
        return ordered[0] if ordered else None
    except Exception:
        return None


async def get_album(release_mbid: str, *, light: bool = False) -> dict | None:
    """Fetch a MusicBrainz release by MBID. Accepts release, recording, or release-group MBIDs.

    ``light=True`` skips CAA cover HTTP (tracklist/metadata only) — use for background prefetch.
    """
    recording_data = await _get_recording_with_releases(release_mbid)
    if recording_data is not None:
        release_list = recording_data.get("releases", [])
        official_pick = official_releases_latest_first(release_list)
        if not official_pick:
            return None
        actual_release_mbid = official_pick[0].get("id")
        if actual_release_mbid:
            return await _get_release_with_tracks(actual_release_mbid, light=light)

    direct = await _get_release_with_tracks(release_mbid, light=light)
    if direct is not None:
        return direct

    from_rg = await _resolve_release_from_release_group(release_mbid)
    if from_rg:
        return await _get_release_with_tracks(from_rg, light=light)
    return None


async def _get_recording_with_releases(recording_mbid: str) -> dict | None:
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/recording/{recording_mbid}",
            params={"fmt": "json", "inc": "artist-credits+releases+release-groups"},
        )
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            return None
        return resp.json()
    except Exception:
        return None


async def _get_release_with_tracks(release_mbid: str, *, light: bool = False) -> dict | None:
    """Fetch release with full tracklist.

    Upgrade to newest official release in the same RG is intentionally
    disabled on the hot path to avoid extra API calls. Users arrive here
    via a specific MBID they clicked — trust it.
    """
    try:
        resp = await _mb_get(
            f"{MUSICBRAINZ_API}/release/{release_mbid}",
            params={"fmt": "json", "inc": "recordings+artists+release-groups"},
        )
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            return None
        data = resp.json()

        rg = data.get("release-group")
        cover_url = None
        if not light and data.get("status") == "Official":
            memo: dict[str, str | None] = {}
            cover_url = await _first_cover_among_releases([data["id"]], CAA_SIZE_DETAIL, memo)
            if not cover_url and isinstance(rg, dict) and rg.get("id"):
                cover_url = await _caa_release_group_front_url(str(rg["id"]), CAA_SIZE_DETAIL)

        artist_credit = data.get("artist-credit", [{}])
        artist_mbid = artist_credit[0].get("artist", {}).get("id") if artist_credit else None
        track_rows = [
            {
                "mbid": r.get("recording", {}).get("id") or r.get("id"),
                "title": r.get("title", "") or r.get("recording", {}).get("title", ""),
                "duration": r.get("length", 0) // 1000 if r.get("length") else 0,
                "position": r.get("position", 0),
                "preview_url": None,
                "source": "musicbrainz",
            }
            for r in data.get("media", [{}])[0].get("tracks", [])
            if r.get("recording", {}).get("id") or r.get("id")
        ]
        return {
            "mbid": data["id"],
            "title": data.get("title", ""),
            "artist": artist_credit[0].get("name", "") if artist_credit else "",
            "artist_mb_id": artist_mbid,
            "cover": cover_url,
            "release_date": data.get("date"),
            "nb_tracks": len(track_rows),
            "genres": [],
            "tracks": track_rows,
        }
    except Exception:
        return None
