import asyncio
import json
import logging
import re
import time
from datetime import datetime, timedelta
from typing import Any, Optional

from difflib import SequenceMatcher

from services.providers import musicbrainz, lastfm
from services.artist_alias_cache import map_cached_artists_to_canonical

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

# Hybrid MB recording search: merge up to this many pages (with offset), dedupe by id, then
# ``_pick_best_unique_matches`` ranks rows against the combined pool.
_HYBRID_MB_PAGE_SIZE = 100
_HYBRID_MB_MAX_PAGES = 3


async def _hybrid_recording_candidates_paged(lucene: str, *, is_cancelled=None) -> list[dict[str, Any]]:
    """Fetch up to ``_HYBRID_MB_MAX_PAGES`` MB ``/recording`` pages; dedupe by recording ``id``; preserve order."""
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for page in range(_HYBRID_MB_MAX_PAGES):
        if is_cancelled and await is_cancelled():
            raise asyncio.CancelledError("client disconnected")
        off = page * _HYBRID_MB_PAGE_SIZE
        await _mb_limiter.acquire()
        chunk = await musicbrainz.recording_query_raw(
            lucene, limit=_HYBRID_MB_PAGE_SIZE, offset=off
        )
        if not chunk:
            break
        for r in chunk:
            if not isinstance(r, dict):
                continue
            rid = str(r.get("id") or "").strip()
            if rid:
                if rid in seen:
                    continue
                seen.add(rid)
            merged.append(r)
        if len(chunk) < _HYBRID_MB_PAGE_SIZE:
            break
    return merged


# Last.fm artist credits: same split order as ``playlist_import._artist_tokens`` (feat first, then ;,&,…).
_LASTFM_ARTIST_SPLIT_RE = re.compile(r"\s*(?:;|,|&|/|\+| and )\s*", re.IGNORECASE)
_LASTFM_FEAT_SPLIT_RE = re.compile(
    r"\s*(?:feat\.?|ft\.?|featuring|with)\s*",
    re.IGNORECASE,
)


def _primary_artist_from_lastfm(raw: str) -> str:
    """First credited name from a Last.fm artist string (e.g. ``A & B`` → ``A``)."""
    s = (raw or "").strip()
    if not s:
        return ""
    s = _LASTFM_FEAT_SPLIT_RE.split(s, maxsplit=1)[0].strip()
    parts = [p.strip() for p in _LASTFM_ARTIST_SPLIT_RE.split(s) if p and p.strip()]
    return (parts[0] if parts else s).strip() or s


_LASTFM_SEARCH_POOL = 24
_LASTFM_SIMILAR_POOL = 32

# ``dedupe_lastfm_tracks_by_title_album``: merge rows when normalized title/album string similarity
# is at least these ratios (lower = more aggressive dedupe). Applies to track.search and track.getsimilar pools.
_LASTFM_DEDUPE_TITLE_SIM_THRESHOLD = 0.74
_LASTFM_DEDUPE_ALBUM_SIM_THRESHOLD = 0.68


def _sim(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _lastfm_norm_field(s: str | None) -> str:
    return " ".join(((s or "").replace("\ufeff", "")).lower().strip().split())


def _lastfm_track_key(t: dict) -> tuple[str, str] | None:
    title = (t.get("name") or t.get("title") or "").strip()
    if not title:
        return None
    alb = t.get("album")
    if alb is None:
        album_s = ""
    elif isinstance(alb, str):
        album_s = alb.strip()
    elif isinstance(alb, dict):
        album_s = (alb.get("#text") or alb.get("name") or "").strip()
    else:
        album_s = str(alb).strip()
    return (_lastfm_norm_field(title), _lastfm_norm_field(album_s))


def _lastfm_safe_int(v: object) -> int:
    try:
        if v is None:
            return 0
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return 0


def _lastfm_match_float(t: dict) -> float:
    try:
        m = float(t.get("match") or 0.0)
    except (TypeError, ValueError):
        return 0.0
    if m > 1.0:
        m /= 100.0
    return m


def _lastfm_pick_richer_duplicate(a: dict, b: dict) -> dict:
    """Between two Last.fm rows with the same (title, album), prefer popularity then strong match."""
    la, lb = _lastfm_safe_int(a.get("listeners")), _lastfm_safe_int(b.get("listeners"))
    if la != lb:
        return a if la > lb else b
    pa, pb = _lastfm_safe_int(a.get("playcount")), _lastfm_safe_int(b.get("playcount"))
    if pa != pb:
        return a if pa > pb else b
    ma, mb = _lastfm_match_float(a), _lastfm_match_float(b)
    sa, sb = (1 if ma > 0.8 else 0), (1 if mb > 0.8 else 0)
    if sa != sb:
        return a if sa > sb else b
    return a if ma >= mb else b


def _lastfm_similar_track_keys(k: tuple[str, str], k2: tuple[str, str]) -> bool:
    """True if Last.fm rows with keys ``k`` and ``k2`` should share one dedupe bucket."""
    t1, a1 = k
    t2, a2 = k2
    if _sim(t1, t2) < _LASTFM_DEDUPE_TITLE_SIM_THRESHOLD:
        return False
    if not a1 and not a2:
        return True
    if bool(a1) != bool(a2):
        return False
    return _sim(a1, a2) >= _LASTFM_DEDUPE_ALBUM_SIM_THRESHOLD


def dedupe_lastfm_tracks_by_title_album(tracks: list[dict]) -> list[dict]:
    """One row per similar (title, album) cluster: keep the best row per ``_lastfm_pick_richer_duplicate``."""
    buckets: dict[tuple[str, str], dict] = {}
    order_keys: list[tuple[str, str]] = []
    for t in tracks:
        if not isinstance(t, dict):
            continue
        k = _lastfm_track_key(t)
        if k is None:
            continue
        canon: tuple[str, str] | None = None
        for ek in order_keys:
            if k == ek or _lastfm_similar_track_keys(k, ek):
                canon = ek
                break
        if canon is None:
            order_keys.append(k)
            buckets[k] = t
        else:
            buckets[canon] = _lastfm_pick_richer_duplicate(buckets[canon], t)
    return [buckets[k] for k in order_keys]


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


def _hybrid_mb_batch_dedupe_key(artist_resolved: str, title: str) -> tuple[str, str]:
    """Collapse near-duplicate Last.fm titles (feat./parens variants) under one MB OR-clause."""
    return (artist_resolved.casefold(), _normalize(title))


def lucene_escape_phrase(s: str) -> str:
    if not s:
        return s
    return s.replace("\\", "\\\\").replace('"', '\\"')


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


_RECORDING_KIND = "recording"


def _recording_payload(r: dict) -> dict:
    """Compact mb_entity_cache payload for a resolved recording row."""
    return {
        "artist": r.get("artist", ""),
        "artist_credit": r.get("artist_credit"),
        "title": r.get("title", ""),
        "album": r.get("album", ""),
        "mb_artist_id": r.get("mb_artist_id"),
        "mb_release_id": r.get("mb_release_id"),
        "mb_release_group_id": r.get("mb_release_group_id"),
    }


def _payload_to_result_dict(mbid: str, p: dict) -> dict:
    return {
        "mbid": mbid,
        "artist": p.get("artist", ""),
        "artist_credit": p.get("artist_credit"),
        "title": p.get("title", ""),
        "album": p.get("album", ""),
        "album_cover": None,
        "source": "musicbrainz",
        "preview_url": None,
        "mb_artist_id": p.get("mb_artist_id"),
        "mb_release_id": p.get("mb_release_id"),
        "mb_release_group_id": p.get("mb_release_group_id"),
    }


def _upsert_recordings(session, results: list[dict]) -> None:
    """Upsert each result into mb_entity_cache (kind=recording). Dedupes across queries."""
    from models import MBEntityCache
    now = datetime.utcnow()
    for r in results:
        mbid = (r.get("mbid") or "").strip()
        if not mbid:
            continue
        key = f"{_RECORDING_KIND}:{mbid}"
        payload = json.dumps(_recording_payload(r), default=str)
        row = session.get(MBEntityCache, key)
        if row is None:
            session.add(MBEntityCache(key=key, kind=_RECORDING_KIND, payload=payload, fetched_at=now))
        else:
            row.payload = payload
            row.fetched_at = now
            session.add(row)


def _load_recordings_ordered(session, mbids: list[str]) -> list[dict]:
    """Fetch mb_entity_cache rows for the given recording MBIDs and return result dicts in ``mbids`` order."""
    from sqlmodel import select
    from models import MBEntityCache
    if not mbids:
        return []
    keys = [f"{_RECORDING_KIND}:{m}" for m in mbids]
    rows = session.exec(select(MBEntityCache).where(MBEntityCache.key.in_(keys))).all()
    by_key: dict[str, dict] = {}
    for ent in rows:
        try:
            by_key[ent.key] = json.loads(ent.payload)
        except Exception:
            continue
    out: list[dict] = []
    for m in mbids:
        p = by_key.get(f"{_RECORDING_KIND}:{m}")
        if p is None:
            continue
        out.append(_payload_to_result_dict(m, p))
    return out


def _get_cache_with_meta(query_normalized: str) -> tuple[list[dict], list[dict], Optional[datetime]]:
    """Return (top, related, fetched_at) for a cached query. Both lists reconstructed from mb_entity_cache."""
    from sqlmodel import Session, select
    from database import engine
    from models import MBLookupCache

    def _decode_ids(s: Optional[str]) -> list[str]:
        if not s:
            return []
        try:
            ids = json.loads(s)
        except Exception:
            return []
        return [str(x) for x in ids if x] if isinstance(ids, list) else []

    with Session(engine) as session:
        row = session.exec(
            select(MBLookupCache).where(MBLookupCache.query_normalized == query_normalized)
        ).first()
        if not row:
            return [], [], None
        top_ids = _decode_ids(row.top_mb_ids)
        if top_ids:
            top = _load_recordings_ordered(session, top_ids)
        else:
            # Legacy rows pre-`top_mb_ids` column: only the single mb_id field is set.
            top = [_row_to_result_dict(row)]
        related = _load_recordings_ordered(session, _decode_ids(row.related_mb_ids))
        return top, related, row.fetched_at


def _save_to_cache(query_normalized: str, top: list[dict], related: list[dict]) -> None:
    if not top:
        return
    r = top[0]
    mbid = r.get("mbid")
    if not mbid:
        return
    from sqlmodel import Session, select
    from database import engine
    from models import MBLookupCache
    top_ids = [str(x.get("mbid")) for x in top if x.get("mbid")]
    top_json = json.dumps(top_ids) if top_ids else None
    related_ids = [str(x.get("mbid")) for x in related if x.get("mbid")]
    related_json = json.dumps(related_ids) if related_ids else None
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
                top_mb_ids=top_json,
                related_mb_ids=related_json,
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
            row.top_mb_ids = top_json
            row.related_mb_ids = related_json
            session.add(row)
        _upsert_recordings(session, list(top) + list(related))
        session.commit()


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _score_row(query: str, r: dict) -> float:
    qm = _query_match_row(query, r.get("artist", ""), r.get("title", ""))
    mb = r.get("mb_score", 50) / 100.0
    return qm * 0.55 + mb * 0.45


def _parse_raw_recording_row(rec: dict) -> dict | None:
    """Turn one MB API recording dict into the same row shape as ``_parse_recordings``."""
    if not rec or not isinstance(rec, dict):
        return None
    for official in (True, False):
        rows = musicbrainz._parse_recordings(
            {"recordings": [rec]},
            min_score=1,
            require_official_release=official,
        )
        if rows:
            return rows[0]
    return None


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class HybridSearchService:
    def _response(self, *, top: list[dict], related: list[dict]) -> dict:
        return {
            "intent": "track",
            "sections": [
                {"type": "top_results", "label": "Top results", "tracks": top},
                {"type": "related", "label": "Related tracks", "tracks": related},
            ],
        }

    async def _search_live(self, query: str, query_normalized: str, *, is_cancelled=None) -> dict:
        async def _check() -> None:
            if is_cancelled and await is_cancelled():
                raise asyncio.CancelledError("client disconnected")

        # 1) Last.fm: search by user query directly (pool → dedupe by title+album → keep top 3)
        top_pool = await lastfm.track_search(query=query, limit=_LASTFM_SEARCH_POOL)
        await _check()
        top_hits = dedupe_lastfm_tracks_by_title_album(top_pool)[:3]
        if not top_hits:
            return {"intent": "track", "sections": []}

        # 2) Last.fm: related tracks based on the first hit (non-blocking for UI; but we include in response)
        seed = top_hits[0]
        seed_title = (seed.get("name") or "").strip()
        seed_artist = (seed.get("artist") or "").strip()
        related_pool = await lastfm.track_similar(
            track=seed_title or None, artist=seed_artist or None, limit=_LASTFM_SIMILAR_POOL
        )
        await _check()
        related_hits = dedupe_lastfm_tracks_by_title_album(related_pool or [])

        # Cap total to 10 (3 top + 7 related); keep Last.fm artist / album / title as returned.
        seen_key: set[str] = set()
        top_in: list[tuple[str, str, str | None]] = []
        for t in top_hits[:3]:
            a = (t.get("artist") or "").strip()
            ti = (t.get("name") or "").strip()
            alb = (t.get("album") or "").strip() or None
            if not a or not ti:
                continue
            k = f"{a.lower()}::{_normalize(ti)}"
            if k in seen_key:
                continue
            seen_key.add(k)
            top_in.append((a, ti, alb))

        related_in: list[tuple[str, str, str | None]] = []
        for t in related_hits or []:
            a = (t.get("artist") or "").strip()
            ti = (t.get("name") or "").strip()
            alb = (t.get("album") or "").strip() or None
            if not a or not ti:
                continue
            k = f"{a.lower()}::{_normalize(ti)}"
            if k in seen_key:
                continue
            seen_key.add(k)
            related_in.append((a, ti, alb))
            if len(related_in) >= 7:
                break

        raw_credits = list(
            dict.fromkeys(
                [a for a, _, _ in top_in] + [a for a, _, _ in related_in],
            )
        )
        _logged_credit_trim: set[str] = set()
        for credit in raw_credits:
            primary = _primary_artist_from_lastfm(credit)
            if primary and primary != credit and credit not in _logged_credit_trim:
                _logged_credit_trim.add(credit)
                logger.info(
                    'Search: using first credited artist "%s" from Last.fm credit "%s"',
                    primary,
                    credit,
                )

        uniq_primaries = list(dict.fromkeys(_primary_artist_from_lastfm(c) for c in raw_credits))
        uniq_primaries = [p for p in uniq_primaries if p]

        cache_hits = map_cached_artists_to_canonical(uniq_primaries)
        resolved_primary: dict[str, str] = {}
        for u in uniq_primaries:
            await _check()
            if u in cache_hits:
                canon = cache_hits[u]
                resolved_primary[u] = canon
                if canon != u:
                    logger.info(
                        'Search: using saved artist name "%s" for "%s"',
                        canon,
                        u,
                    )
                continue
            logger.info(
                'Search: resolving artist "%s" with MusicBrainz (no local alias yet)',
                u,
            )
            await _mb_limiter.acquire()
            canon = await musicbrainz.resolve_artist_string_via_mb_search(u)
            resolved_primary[u] = canon
            if canon != u:
                logger.info(
                    'Search: MusicBrainz normalized "%s" to "%s"',
                    u,
                    canon,
                )

        # (resolved MB artist, title, album, last.fm primary) — Lucene ORs canonical + primary when they differ.
        wanted_quads: list[tuple[str, str, str | None, str]] = []
        for raw_a, ti, alb in [*top_in, *related_in]:
            lf_primary = _primary_artist_from_lastfm(raw_a)
            resolved = resolved_primary.get(lf_primary, lf_primary or (raw_a or "").strip())
            wanted_quads.append((resolved, ti, alb, lf_primary or (raw_a or "").strip()))

        if not wanted_quads:
            return {"intent": "track", "sections": []}

        # 3) MusicBrainz: same pass-1 as playlist import (artist + release + title Lucene), then
        #    greedy unique match. Lazy import avoids import cycle (playlist_import imports this module).
        from services.playlist_import import (
            ImportInputRow,
            _build_batch_recording_query,
            _pick_best_unique_matches,
        )

        # One MB batch row per (resolved artist, normalized title); reuse pick for duplicate triples.
        rep_qn_by_dedupe_key: dict[tuple[str, str], str] = {}
        unique_mb_rows: list[ImportInputRow] = []
        for i, (a, ti, alb, lf_primary) in enumerate(wanted_quads):
            album_s = (alb or "").strip()
            dk = _hybrid_mb_batch_dedupe_key(a, ti)
            if dk in rep_qn_by_dedupe_key:
                continue
            qn = f"h:{i}:{a.casefold()}|{ti.casefold()}|{album_s.casefold()}"
            rep_qn_by_dedupe_key[dk] = qn
            alt = lf_primary.strip() if lf_primary.strip().casefold() != a.strip().casefold() else None
            unique_mb_rows.append(
                ImportInputRow(
                    row_index=len(unique_mb_rows),
                    title=ti,
                    artist=a,
                    album=album_s,
                    duration_ms=0,
                    query_normalized=qn,
                    artist_lucene_alt=alt,
                )
            )

        rows_alb = [r for r in unique_mb_rows if r.album.strip()]
        rows_no = [r for r in unique_mb_rows if not r.album.strip()]
        picks: dict[str, tuple[dict | None, float]] = {}

        try:
            if rows_alb:
                lucene1 = _build_batch_recording_query(rows_alb, include_release=True)
                cand1 = await _hybrid_recording_candidates_paged(lucene1, is_cancelled=is_cancelled)
                picks.update(
                    _pick_best_unique_matches(
                        rows_alb, cand1, require_release=True, min_title=0.0
                    )
                )
            if rows_no:
                lucene2 = _build_batch_recording_query(rows_no, include_release=False)
                cand2 = await _hybrid_recording_candidates_paged(lucene2, is_cancelled=is_cancelled)
                picks.update(
                    _pick_best_unique_matches(
                        rows_no, cand2, require_release=False, min_title=0.0
                    )
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("MB hybrid pass-1 resolve failed: %s", exc)
            return {"intent": "track", "sections": []}

        resolved: list[dict] = []
        for a, ti, alb, _lf_primary in wanted_quads:
            album_s = (alb or "").strip()
            dk = _hybrid_mb_batch_dedupe_key(a, ti)
            qn = rep_qn_by_dedupe_key.get(dk)
            if not qn:
                continue
            best_raw, _score = picks.get(qn, (None, 0.0))
            if not best_raw or not isinstance(best_raw, dict):
                continue
            row = _parse_raw_recording_row(best_raw)
            if row:
                resolved.append(row)

        # Ensure we don't exceed 10 after resolution (MB can collapse duplicates)
        resolved_top = resolved[: len(top_in)]
        resolved_related = resolved[len(top_in) : len(top_in) + 7]

        # 4) Covers: playlist-style MBEntityCache attach runs in ``/search/hybrid`` router (same session as playlist GET).

        # Cache top + related (MBID lists; recordings deduped in mb_entity_cache).
        if resolved_top:
            _save_to_cache(query_normalized, resolved_top, resolved_related)

        return self._response(top=resolved_top, related=resolved_related)

    async def _background_refresh(self, query: str, query_normalized: str) -> None:
        try:
            async with musicbrainz.mb_prefetch_calls():
                await self._search_live(query, query_normalized)
        except Exception as e:
            logger.debug("background hybrid refresh failed: %s", e)
        finally:
            _hybrid_bg_inflight.discard(query_normalized)

    async def search(self, query: str, *, prefetch_prefs: dict[str, bool] | None = None, is_cancelled=None) -> dict:
        query = query.strip()
        if not query:
            return {"intent": "track", "sections": []}

        pf = prefetch_prefs or {}
        allow_stale_bg = bool(pf.get("enabled", True)) and bool(pf.get("hybrid_stale_refresh", True))

        query_normalized = query.lower()
        cached_top, cached_related, fetched_at = _get_cache_with_meta(query_normalized)
        if cached_top:
            now = datetime.utcnow()
            stale = (
                fetched_at is None
                or (now - fetched_at > _SOFT_TTL)
            )
            if stale and allow_stale_bg and query_normalized not in _hybrid_bg_inflight:
                _hybrid_bg_inflight.add(query_normalized)
                asyncio.create_task(self._background_refresh(query, query_normalized))
            return self._response(top=cached_top, related=cached_related)

        return await self._search_live(query, query_normalized, is_cancelled=is_cancelled)
