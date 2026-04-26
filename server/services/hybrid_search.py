import asyncio
import logging
import re
import time
from datetime import datetime, timedelta
from typing import Optional

from difflib import SequenceMatcher

from services.providers import musicbrainz

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

class RateLimiter:
    def __init__(self, interval_ms: float):
        self._interval = interval_ms / 1000
        self._last = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            wait = self._interval - (time.monotonic() - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()


_mb_limiter = RateLimiter(interval_ms=100)


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

_FEAT_RE = re.compile(
    r'\s*[\(\[]?\s*(feat(?:uring)?\.?|ft\.?)\s+[^\)\]]+[\)\]]?',
    re.IGNORECASE,
)
_PARENS_RE = re.compile(r'\s*[\(\[][^\)\]]*[\)\]]')


def _normalize(s: str) -> str:
    s = _FEAT_RE.sub('', s)
    s = _PARENS_RE.sub('', s)
    return s.lower().strip()


def lucene_escape_phrase(s: str) -> str:
    if not s:
        return s
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _sim(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _word_set(text: str) -> set[str]:
    return {w for w in re.split(r'\W+', text.lower()) if w}


def _word_overlap(tokens: list[str], text: str) -> float:
    if not tokens:
        return 0.0
    text_words = _word_set(text)
    return sum(1 for t in tokens if t in text_words) / len(tokens)


def _query_match_row(query: str, artist: str, title: str) -> float:
    text = f"{artist} {title}".strip()
    tokens = [t for t in re.split(r'\W+', query.lower()) if t]
    overlap = _word_overlap(tokens, text) if tokens else 0.0
    return overlap * 0.55 + _sim(query, text) * 0.45


# ---------------------------------------------------------------------------
# All-split Lucene query building (from test.py ideas)
# ---------------------------------------------------------------------------

def get_artist_recording_pairs(query: str) -> list[tuple[str, str]]:
    """All (artist, recording) splits from query words in both orders."""
    words = query.split()
    n = len(words)
    pairs: list[tuple[str, str]] = []
    for i in range(1, n):
        part_a = " ".join(words[:i])
        part_b = " ".join(words[i:])
        pairs.append((part_a, part_b))
        pairs.append((part_b, part_a))
    return pairs


def build_lucene_query_for_pairs(pairs: list[tuple[str, str]]) -> str:
    e = lucene_escape_phrase
    clauses = [
        f'(artist:"{e(artist)}" AND recording:"{e(recording)}")'
        for artist, recording in pairs
    ]
    return " OR ".join(clauses)


# ---------------------------------------------------------------------------
# Recording picker (no extra API calls)
# ---------------------------------------------------------------------------

_TYPE_PRIO = {"Album": 0, "EP": 1, "Single": 2}


def _pick_best_recording(results: list[dict], query: str) -> dict:
    """Pick best recording using text+MB score, with Album>EP>Single tiebreaker."""
    scored = sorted(
        results,
        key=lambda r: (
            -_score_row(query, r),
            _TYPE_PRIO.get(r.get("_rg_primary_type") or "", 3),
        ),
    )
    return scored[0]


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------

_SOFT_TTL = timedelta(days=7)
_hybrid_bg_inflight: set[str] = set()


def _row_to_result_dict(r) -> dict:
    return {
        "mbid": r.mb_id, "artist": r.artist, "title": r.title, "album": r.album,
        "artist_credit": r.artist_credit,
        "album_cover": r.album_cover, "source": "musicbrainz", "preview_url": None,
        "mb_artist_id": r.mb_artist_id, "mb_release_id": r.mb_release_id,
        "mb_release_group_id": r.mb_release_group_id
    }


def _get_cache_with_meta(query_normalized: str) -> tuple[list[dict], Optional[datetime]]:
    from sqlmodel import Session, select
    from database import engine
    from models import MBLookupCache
    with Session(engine) as session:
        row = session.exec(
            select(MBLookupCache).where(MBLookupCache.query_normalized == query_normalized)
        ).first()
        if not row:
            return [], None
        return ([_row_to_result_dict(row)], row.fetched_at)


def _lookup_cache(query_normalized: str) -> list[dict]:
    items, _ = _get_cache_with_meta(query_normalized)
    return items


def _save_to_cache(query_normalized: str, results: list[dict]) -> None:
    if not results:
        return
    r = results[0]
    mbid = r.get("mbid")
    if not mbid:
        return
    from sqlmodel import Session, select
    from database import engine
    from models import MBLookupCache
    with Session(engine) as session:
        now = datetime.utcnow()
        row = session.exec(
            select(MBLookupCache).where(MBLookupCache.query_normalized == query_normalized)
        ).first()
        if row is None:
            session.add(MBLookupCache(
                query_normalized=query_normalized,
                artist=r.get("artist", ""),
                artist_credit=r.get("artist_credit"),
                title=r.get("title", ""),
                album=r.get("album", ""),
                mb_id=mbid,
                album_cover=r.get("album_cover"),
                mb_artist_id=r.get("mb_artist_id"),
                mb_release_id=r.get("mb_release_id"),
                mb_release_group_id=r.get("mb_release_group_id"),
                fetched_at=now,
            ))
        else:
            row.artist = r.get("artist", "")
            row.artist_credit = r.get("artist_credit")
            row.title = r.get("title", "")
            row.album = r.get("album", "")
            row.mb_id = mbid
            row.album_cover = r.get("album_cover")
            row.mb_artist_id = r.get("mb_artist_id")
            row.mb_release_id = r.get("mb_release_id")
            row.mb_release_group_id = r.get("mb_release_group_id")
            row.fetched_at = now
            session.add(row)
        session.commit()


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _score_row(query: str, r: dict) -> float:
    qm = _query_match_row(query, r.get("artist", ""), r.get("title", ""))
    mb = r.get("mb_score", 50) / 100.0
    return qm * 0.55 + mb * 0.45


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class HybridSearchService:
    def _response_from_tracks(self, label: str, tracks: list[dict]) -> dict:
        return {"intent": "track", "sections": [
            {"type": "best_match", "label": label, "tracks": tracks[:1]}
        ]}

    async def _search_live(self, query: str, query_normalized: str) -> dict:
        # Resolve artist aliases (e.g. "Ye" → "Kanye West")
        canonical = await musicbrainz.fix_artist_alias(query)

        pairs = get_artist_recording_pairs(canonical)
        type_filter = 'type:"Album" OR type:"EP" OR type:"Single"'
        if pairs:
            lucene = (
                f'status:official AND ({type_filter}) AND NOT comment:live AND '
                f'({build_lucene_query_for_pairs(pairs)})'
            )
        else:
            lucene = (
                f'status:official AND ({type_filter}) AND NOT comment:live AND '
                f'recording:"{lucene_escape_phrase(canonical)}"'
            )

        logger.debug("query: %r", lucene)

        await _mb_limiter.acquire()
        try:
            results = await musicbrainz.recording_search(lucene, limit=20)
        except Exception as exc:
            logger.warning("MB search failed: %s", exc)
            cached = _lookup_cache(query_normalized)
            if cached:
                return self._response_from_tracks("Best Match (cached)", cached)
            return {"intent": "track", "sections": []}

        if not results:
            return {"intent": "track", "sections": []}

        best = _pick_best_recording(results, canonical)

        if not best.get("album_cover"):
            await musicbrainz._hydrate_release_covers([best], size=musicbrainz.CAA_SIZE_LIST)

        _save_to_cache(query_normalized, [best])

        return self._response_from_tracks("Best Match", [best])

    async def _background_refresh(self, query: str, query_normalized: str) -> None:
        try:
            async with musicbrainz.mb_prefetch_calls():
                await self._search_live(query, query_normalized)
        except Exception as e:
            logger.debug("background hybrid refresh failed: %s", e)
        finally:
            _hybrid_bg_inflight.discard(query_normalized)

    async def search(self, query: str, *, prefetch_prefs: dict[str, bool] | None = None) -> dict:
        query = query.strip()
        if not query:
            return {"intent": "track", "sections": []}

        pf = prefetch_prefs or {}
        allow_stale_bg = bool(pf.get("enabled", True)) and bool(pf.get("hybrid_stale_refresh", True))

        query_normalized = query.lower()
        cached, fetched_at = _get_cache_with_meta(query_normalized)
        if cached:
            now = datetime.utcnow()
            stale = (
                fetched_at is None
                or (now - fetched_at > _SOFT_TTL)
            )
            if stale and allow_stale_bg and query_normalized not in _hybrid_bg_inflight:
                _hybrid_bg_inflight.add(query_normalized)
                asyncio.create_task(self._background_refresh(query, query_normalized))
            return self._response_from_tracks("Best Match", cached)

        return await self._search_live(query, query_normalized)
