import asyncio
import csv
import io
import json
import logging
import random
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, AsyncIterator, Optional
from difflib import SequenceMatcher
import re

from fastapi import HTTPException, UploadFile
from sqlmodel import Session, select

from models import (
    MBLookupCache,
    PlaylistImportJob,
    PlaylistImportRow,
    PlaylistImportRowState,
    PlaylistImportStatus,
    PlaylistItem,
    User,
)
from services.providers import musicbrainz
from services.hybrid_search import _normalize as _hs_normalize

logger = logging.getLogger(__name__)


def _csv_field(row: dict[str, Any], *names: str) -> str:
    for n in names:
        for k, v in row.items():
            if (k or "").strip().lower() == n:
                return (str(v) if v is not None else "").strip()
    return ""


def _query_normalized(artist: str, title: str, album: str | None) -> str:
    a = _hs_normalize(artist or "")
    t = _hs_normalize(title or "")
    alb = _hs_normalize(album or "")
    return f"{a} | {t} | {alb}".strip().lower()


async def _retry_mb(fn, *, retries: int = 3) -> Any:
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return await fn()
        except Exception as ex:
            last = ex
            if attempt >= retries:
                raise
            # simple jittered backoff, MB can sporadically 5xx/429
            await asyncio.sleep((0.25 * (2**attempt)) + random.random() * 0.15)
    raise last or RuntimeError("unreachable")


async def _retry_mb_forever_503_429(fn) -> Any:  # noqa: ANN001
    """Retry forever on 503/429 with 1s delay (import-only)."""
    while True:
        try:
            return await fn()
        except HTTPException as ex:
            # Some provider helpers may raise HTTPException.
            if ex.status_code in (429, 503):
                await asyncio.sleep(1.0)
                continue
            raise
        except Exception as ex:
            # httpx raises HTTPStatusError; musicbrainz wraps via _mb_get which retries,
            # but import wants to keep going on persistent transient failures too.
            status = getattr(ex, "response", None)
            code = getattr(status, "status_code", None)
            if code in (429, 503):
                await asyncio.sleep(1.0)
                continue
            raise


@dataclass(frozen=True)
class ImportInputRow:
    row_index: int
    title: str
    artist: str
    album: str
    duration_ms: int
    query_normalized: str


@dataclass(frozen=True)
class ResolveOutcome:
    state: PlaylistImportRowState
    meta: dict[str, Any] | None
    mbid: str | None
    phase: str | None
    confidence: float | None
    error: str | None


def _confidence_from_meta(meta: dict[str, Any]) -> float | None:
    try:
        # MB recording search payloads sometimes include `score` (0..100)
        s = meta.get("score")
        if s is None:
            return None
        return float(s) / 100.0
    except Exception:
        return None


def _norm_text(s: str) -> str:
    return _hs_normalize((s or "").replace("\ufeff", "").strip())


def _verbatim_query(artist: str, title: str) -> str:
    a = (artist or "").strip()
    t = (title or "").strip()
    return f"{a} - {t}".strip(" -")


def _ratio(a: str, b: str) -> float:
    an = _norm_text(a)
    bn = _norm_text(b)
    if not an or not bn:
        return 0.0
    if an == bn:
        return 1.0
    return SequenceMatcher(None, an, bn).ratio()


def _title_score_len_fallback(wanted: str, candidate: str) -> tuple[float, bool]:
    """Prefer token overlap; if none, fall back to length similarity (cross-script/localized).

    Returns (score, used_length_fallback).
    """
    w = _norm_text(wanted)
    c = _norm_text(candidate)
    if not w or not c:
        return (0.0, False)
    wt = [t for t in re.split(r"[^0-9a-z\u0080-\uffff]+", w) if t]
    ct = [t for t in re.split(r"[^0-9a-z\u0080-\uffff]+", c) if t]
    wset, cset = set(wt), set(ct)
    overlap = len(wset & cset)
    if overlap > 0:
        return (
            max(
            SequenceMatcher(None, w, c).ratio(),
            overlap / max(1, min(len(wset), len(cset))),
            ),
            False,
        )
    w_lat = _is_latinish(wanted)
    c_lat = _is_latinish(candidate)

    # If both sides are latin-ish (English/romaji), do NOT use length similarity.
    # Length-only matching is a major source of false positives (random titles of similar length).
    if w_lat and c_lat:
        return (SequenceMatcher(None, w, c).ratio(), False)

    # If both sides are non-latin-ish (CJK↔CJK etc), also do NOT use length similarity.
    # This prevents cases like 不埒な喝采 ↔ ジェラシス being treated as "close" by length alone.
    if (not w_lat) and (not c_lat):
        return (SequenceMatcher(None, w, c).ratio(), False)

    # For cross-script/localized comparisons (latin/romaji ↔ kana/kanji), length similarity is a last-resort heuristic.
    mx = max(len(w), len(c))
    if mx == 0:
        return (0.0, False)
    return (max(0.0, 1.0 - (abs(len(w) - len(c)) / mx)), True)


def _lucene_escape_phrase(s: str) -> str:
    return musicbrainz._lucene_escape_phrase(s)  # type: ignore[attr-defined]


def _build_batch_recording_query(
    rows: list[ImportInputRow],
    *,
    include_release: bool,
) -> str:
    parts: list[str] = []
    for r in rows:
        a = _lucene_escape_phrase(r.artist)
        t = _lucene_escape_phrase(r.title)
        if include_release:
            alb = _lucene_escape_phrase(r.album)
            parts.append(f'(artist:"{a}" AND release:"{alb}" AND ({t}))')
        else:
            parts.append(f'(artist:"{a}" AND ({t}))')
    return " OR ".join(parts)


def _pick_best_unique_matches(
    rows: list[ImportInputRow],
    candidates: list[dict[str, Any]],
    *,
    require_release: bool,
    title_bypass_artist_threshold: float | None = None,
    min_title: float = 0.0,
    album_bypass_threshold: float | None = None,
) -> dict[str, tuple[dict[str, Any] | None, float]]:
    """Greedy unique assignment: one candidate recording per input row.

    IMPORTANT: candidates must be *raw* MusicBrainz recording dicts (with `artist-credit` and `releases`).
    """
    scored: list[tuple[float, int, int]] = []
    for ri, r in enumerate(rows):
        for ci, c in enumerate(candidates):
            ct = str(c.get("title") or "")
            # best artist match across all credits
            best_a = 0.0
            for cred in c.get("artist-credit") or []:
                if not isinstance(cred, dict):
                    continue
                n = (cred.get("name") or "").strip()
                if n:
                    best_a = max(best_a, _ratio(r.artist, n))
                node = cred.get("artist")
                if isinstance(node, dict):
                    n2 = (node.get("name") or "").strip()
                    if n2:
                        best_a = max(best_a, _ratio(r.artist, n2))

            # best release title match across all embedded releases
            best_r = 0.0
            for rel in c.get("releases") or []:
                if not isinstance(rel, dict):
                    continue
                rt = (rel.get("title") or "").strip()
                if rt:
                    best_r = max(best_r, _ratio(r.album, rt))
            if require_release and best_r < 0.72:
                continue

            t_s, used_len = _title_score_len_fallback(r.title, ct)
            if t_s < min_title:
                continue
            if best_a < 0.62:
                if title_bypass_artist_threshold is None or t_s < title_bypass_artist_threshold:
                    continue
                # Never allow bypass when the title score came from length-only heuristic.
                if used_len:
                    continue
                # Even in bypass mode, require *some* artist similarity OR a very strong album match.
                # This allows e.g. "Kafu" CSV rows to match recordings credited as "… feat. 可不"
                # when the album title matches strongly, while blocking unrelated matches.
                if best_a < 0.28:
                    if not album_bypass_threshold or best_r < album_bypass_threshold:
                        continue
            # Use duration when present to reduce false positives in loose pass.
            dur_bonus = 0.0
            if r.duration_ms and c.get("duration_ms"):
                try:
                    cd = int(c.get("duration_ms") or 0)
                except Exception:
                    cd = 0
                if cd:
                    diff = abs(r.duration_ms - cd)
                    if diff <= 2000:
                        dur_bonus = 0.15
                    elif diff <= 6000:
                        dur_bonus = 0.08
            score = (t_s * 0.84) + (best_a * 0.10) + (best_r * 0.06) + dur_bonus
            scored.append((score, ri, ci))

    scored.sort(key=lambda x: x[0], reverse=True)
    used_rows: set[int] = set()
    used_cands: set[int] = set()
    out: dict[str, tuple[dict[str, Any] | None, float]] = {r.query_normalized: (None, 0.0) for r in rows}
    for score, ri, ci in scored:
        if ri in used_rows or ci in used_cands:
            continue
        used_rows.add(ri)
        used_cands.add(ci)
        out[rows[ri].query_normalized] = (candidates[ci], score)
    return out


def _pick_best_title_album_duration(
    row: ImportInputRow,
    candidates: list[dict[str, Any]],
    *,
    min_title: float = 0.78,
    min_album: float = 0.72,
) -> tuple[dict[str, Any] | None, float]:
    """Pass4 picker: title-only search, then score by title+album (+duration tie-break)."""
    best: dict[str, Any] | None = None
    best_s = 0.0
    for c in candidates:
        if not isinstance(c, dict):
            continue
        ct = str(c.get("title") or "")
        t_s, _used_len = _title_score_len_fallback(row.title, ct)
        if t_s < min_title:
            continue

        best_r = 0.0
        for rel in c.get("releases") or []:
            if not isinstance(rel, dict):
                continue
            rt = (rel.get("title") or "").strip()
            if rt:
                best_r = max(best_r, _ratio(row.album, rt))
        if row.album and best_r < min_album:
            continue

        dur_bonus = 0.0
        if row.duration_ms:
            try:
                clen = int(c.get("length") or 0)
            except Exception:
                clen = 0
            if clen:
                diff = abs(row.duration_ms - clen)
                if diff <= 2000:
                    dur_bonus = 0.18
                elif diff <= 6000:
                    dur_bonus = 0.10
                elif diff <= 15000:
                    dur_bonus = 0.04
        score = (t_s * 0.62) + (best_r * 0.30) + dur_bonus
        if score > best_s:
            best_s = score
            best = c
    return best, best_s

def _is_latinish(s: str) -> bool:
    """Heuristic: returns False when the string contains mostly non-latin letters.

    Used to avoid penalizing romanized vs native-script mismatches (e.g. Marshmary vs マシュマリー).
    """
    s = (s or "").strip()
    if not s:
        return True
    letters = 0
    latin = 0
    for ch in s:
        if ch.isalpha():
            letters += 1
            # treat accented latin as latin too
            o = ord(ch)
            if (65 <= o <= 90) or (97 <= o <= 122) or (0x00C0 <= o <= 0x024F):
                latin += 1
    if letters == 0:
        return True
    return (latin / letters) >= 0.6


def _type_bonus(rg_primary_type: str | None) -> float:
    t = (rg_primary_type or "").strip().lower()
    if t == "album":
        return 1.0
    if t == "ep":
        return 0.85
    if t == "single":
        return 0.75
    return 0.4


def _score_optimistic_candidate(
    *,
    want_artist: str,
    want_title: str,
    want_album: str,
    want_duration_ms: int,
    cand: dict[str, Any],
) -> float:
    ct = str(cand.get("title") or "")
    ca = str(cand.get("artist_credit") or cand.get("artist") or "")
    calb = str(cand.get("album") or "")
    ctype = cand.get("_rg_primary_type")
    cdur = cand.get("duration_ms") or 0
    try:
        cdur_i = int(cdur) if cdur else 0
    except Exception:
        cdur_i = 0

    title_latin = _is_latinish(want_title) and _is_latinish(ct)
    artist_latin = _is_latinish(want_artist) and _is_latinish(ca)
    album_latin = want_album and calb and _is_latinish(want_album) and _is_latinish(calb)

    title_ok = _ratio(want_title, ct) if title_latin else 0.55
    artist_ok = _artist_score(want_artist, ca) if artist_latin else 0.55
    album_ok = _ratio(want_album, calb) if album_latin else (0.62 if want_album else 0.45)

    # Hard gates when we can compare apples-to-apples (latin-ish on both sides).
    if title_latin and title_ok < 0.78:
        return 0.0
    if artist_latin and artist_ok < 0.62:
        return 0.0

    dur_ok = 0.0
    if want_duration_ms and cdur_i:
        diff = abs(want_duration_ms - cdur_i)
        # within 2s => great, within 6s => ok
        if diff <= 2000:
            dur_ok = 1.0
        elif diff <= 6000:
            dur_ok = 0.75
        elif diff <= 15000:
            dur_ok = 0.4
        else:
            dur_ok = 0.0

    mb = float(cand.get("mb_score") or 50.0) / 100.0
    bonus = _type_bonus(str(ctype) if ctype is not None else None)

    # Title dominates; artist helps; album/type refine.
    alb_w = 0.18 if want_album else 0.06
    score = (
        title_ok * 0.44
        + artist_ok * 0.28
        + album_ok * alb_w
        + mb * 0.06
        + bonus * 0.04
        + dur_ok * (0.10 if want_duration_ms else 0.0)
    )
    return score


_ART_SPLIT_RE = re.compile(r"\s*(?:;|,|&|/|\+| and )\s*", re.IGNORECASE)
_FEAT_SPLIT_RE = re.compile(r"\s*(?:feat\.?|ft\.?|featuring|with)\s*", re.IGNORECASE)


def _artist_tokens(raw: str) -> list[str]:
    """Split playlist artist strings like `a;b` and strip feat/join tokens."""
    s = (raw or "").strip()
    if not s:
        return []
    # split off any feat portion first, then split on common separators
    s = _FEAT_SPLIT_RE.split(s, maxsplit=1)[0].strip()
    parts = [p.strip() for p in _ART_SPLIT_RE.split(s) if p and p.strip()]
    # also handle "Artist1 - Artist2" style (rare)
    out = [p for p in parts if p]
    return out or [s]


def _artist_score(want_artist: str, cand_artist_credit: str) -> float:
    want = _artist_tokens(want_artist)
    cand = _artist_tokens(cand_artist_credit)
    if not want or not cand:
        return 0.0
    # score each wanted token by best match among candidate tokens, average.
    per: list[float] = []
    for w in want:
        per.append(max(_ratio(w, c) for c in cand))
    return sum(per) / len(per) if per else 0.0


async def _alias_artist_string(raw: str, *, token_cache: dict[str, str]) -> str:
    """Resolve MB artist aliases per token (e.g. Ye -> Kanye West).

    CSV imports often store multiple artists like `artist1;artist2`. Resolve each token
    separately (cached), then join back with `; ` so the next MB search is cleaner.
    """
    toks = _artist_tokens(raw)
    if not toks:
        return raw
    out: list[str] = []
    for t in toks:
        key = t.strip()
        if not key:
            continue
        if key in token_cache:
            out.append(token_cache[key])
            continue
        canon = (await musicbrainz.fix_artist_alias(key)).strip()
        token_cache[key] = canon or key
        out.append(token_cache[key])
    return "; ".join(out) if out else raw


def _pick_best_from_candidates(
    *,
    artist: str,
    title: str,
    candidates: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, float]:
    """Score candidates and pick best match for this (artist,title)."""
    want = _verbatim_query(artist, title)
    best: dict[str, Any] | None = None
    best_score = 0.0
    for c in candidates:
        ca = str(c.get("artist_credit") or c.get("artist") or "")
        ct = str(c.get("title") or "")
        cand = _verbatim_query(ca, ct)
        sr = _ratio(want, cand)
        ar = _artist_score(artist, ca)
        tr = _ratio(title, ct)
        # tolerate extra credited artists and feat differences, but require decent title match
        if tr < 0.72 or ar < 0.55:
            continue
        mb = float(c.get("mb_score") or 50.0) / 100.0
        score = sr * 0.66 + tr * 0.22 + ar * 0.12
        score = score * 0.82 + mb * 0.18
        if score > best_score:
            best_score = score
            best = c
    return best, best_score


async def _resolve_batch_verbatim(
    session: Session,
    rows: list[ImportInputRow],
    *,
    memo: dict[str, ResolveOutcome],
    stats: dict[str, int],
) -> None:
    """Resolve up to 5 input rows using the 4-pass batch recording query method.

    Pass 1: (artist:"A" AND release:"R" AND (Title)) OR ...
    Pass 2: canonicalize artist via MB artist endpoint (cached), same query as pass 1.
    Pass 3: drop release clause: (artist:"A" AND (Title)) OR ... with higher limit and relaxed artist gating.
    Pass 4: title-only single-track search (limit 40), then score by title+album+duration.
    """
    # cache-first + memo short-circuit
    pending: list[ImportInputRow] = []
    for r in rows:
        if r.query_normalized in memo:
            stats["memo_hit"] += 1
            continue
        cached = session.exec(
            select(MBLookupCache).where(MBLookupCache.query_normalized == r.query_normalized)
        ).first()
        if cached and cached.mb_id:
            stats["db_cache_hit"] += 1
            memo[r.query_normalized] = ResolveOutcome(
                state=PlaylistImportRowState.MATCHED,
                meta={
                    "mbid": cached.mb_id,
                    "title": cached.title,
                    "artist": cached.artist,
                    "artist_credit": cached.artist_credit or cached.artist,
                    "album": cached.album,
                    "mb_artist_id": cached.mb_artist_id,
                    "mb_release_id": cached.mb_release_id,
                    "mb_release_group_id": cached.mb_release_group_id,
                    "_resolve_phase": "MBLookupCache",
                },
                mbid=cached.mb_id,
                phase="MBLookupCache",
                confidence=None,
                error=None,
            )
            continue
        pending.append(r)

    if not pending:
        return

    # Pass 1
    stats["live_lookup"] += 1
    lucene1 = _build_batch_recording_query(pending, include_release=True)
    cand1 = await _retry_mb_forever_503_429(lambda: musicbrainz.recording_query_raw(lucene1, limit=20))
    picks1 = _pick_best_unique_matches(pending, cand1, require_release=True, min_title=0.0)

    misses1: list[ImportInputRow] = []
    for r in pending:
        best, score = picks1.get(r.query_normalized, (None, 0.0))
        if best and best.get("id"):
            stats["matched"] += 1
            meta = musicbrainz.recording_to_playlist_meta(best, album_hint=r.album)
            if not meta or not meta.get("mbid"):
                misses1.append(r)
                continue
            meta["_resolve_phase"] = "MB: batch (artist+release+title)"
            memo[r.query_normalized] = ResolveOutcome(
                state=PlaylistImportRowState.MATCHED,
                meta=meta,
                mbid=str(meta["mbid"]),
                phase=meta["_resolve_phase"],
                confidence=max(0.01, min(0.99, float(score))),
                error=None,
            )
        else:
            misses1.append(r)

    if not misses1:
        return

    # Pass 2: canonical artist (cached)
    canon_cache: dict[str, str] = {}
    canon_rows: list[ImportInputRow] = []
    for r in misses1:
        key = (r.artist or "").strip()
        if key in canon_cache:
            canon = canon_cache[key]
        else:
            canon = await _retry_mb_forever_503_429(lambda: musicbrainz.canonical_artist_name(key))
            canon_cache[key] = canon or key
        canon_rows.append(
            ImportInputRow(
                row_index=r.row_index,
                title=r.title,
                artist=canon_cache[key],
                album=r.album,
                duration_ms=r.duration_ms,
                query_normalized=r.query_normalized,
            )
        )

    stats["live_lookup"] += 1
    lucene2 = _build_batch_recording_query(canon_rows, include_release=True)
    cand2 = await _retry_mb_forever_503_429(lambda: musicbrainz.recording_query_raw(lucene2, limit=20))
    picks2 = _pick_best_unique_matches(canon_rows, cand2, require_release=True, min_title=0.0)

    misses2: list[ImportInputRow] = []
    for r in canon_rows:
        best, score = picks2.get(r.query_normalized, (None, 0.0))
        if best and best.get("id"):
            stats["matched"] += 1
            meta = musicbrainz.recording_to_playlist_meta(best, album_hint=r.album)
            if not meta or not meta.get("mbid"):
                misses2.append(r)
                continue
            meta["_resolve_phase"] = "MB: batch + canonical artist"
            memo[r.query_normalized] = ResolveOutcome(
                state=PlaylistImportRowState.MATCHED,
                meta=meta,
                mbid=str(meta["mbid"]),
                phase=meta["_resolve_phase"],
                confidence=max(0.01, min(0.99, float(score))),
                error=None,
            )
        else:
            misses2.append(r)

    if not misses2:
        return

    # Pass 3: drop release, larger limit, relax artist gate when title is extremely strong.
    stats["live_lookup"] += 1
    lucene3 = _build_batch_recording_query(misses2, include_release=False)
    cand3 = await _retry_mb_forever_503_429(lambda: musicbrainz.recording_query_raw(lucene3, limit=100))
    picks3 = _pick_best_unique_matches(
        misses2,
        cand3,
        require_release=False,
        title_bypass_artist_threshold=0.92,
        # In loose mode (no release), always require a meaningful title similarity.
        # Prevents wrong-track picks when only the artist matches.
        min_title=0.72,
        # Allow bypass for album-perfect compilation rows (e.g. 可不 credited but CSV says Kafu).
        album_bypass_threshold=0.86,
    )
    misses3: list[ImportInputRow] = []
    for r in misses2:
        best, score = picks3.get(r.query_normalized, (None, 0.0))
        if best and best.get("id"):
            stats["matched"] += 1
            meta = musicbrainz.recording_to_playlist_meta(best, album_hint=r.album)
            if not meta or not meta.get("mbid"):
                misses3.append(r)
                continue
            meta["_resolve_phase"] = "MB: batch (artist+title, no release)"
            memo[r.query_normalized] = ResolveOutcome(
                state=PlaylistImportRowState.MATCHED,
                meta=meta,
                mbid=str(meta["mbid"]),
                phase=meta["_resolve_phase"],
                confidence=max(0.01, min(0.99, float(score))),
                error=None,
            )
        else:
            misses3.append(r)

    if not misses3:
        return

    # Pass 4: single-track title-only queries (limit 40)
    for r in misses3:
        stats["live_lookup"] += 1
        title_only = _lucene_escape_phrase(r.title)
        lucene4 = f"({title_only})"
        try:
            cand4 = await _retry_mb_forever_503_429(
                lambda: musicbrainz.recording_query_raw(lucene4, limit=40)
            )
        except Exception as ex:
            stats["unmatched"] += 1
            memo[r.query_normalized] = ResolveOutcome(
                state=PlaylistImportRowState.UNMATCHED,
                meta=None,
                mbid=None,
                phase="MB: title-only",
                confidence=None,
                error=str(ex),
            )
            continue

        pick4, score4 = _pick_best_title_album_duration(r, cand4)
        if pick4 and pick4.get("id"):
            meta = musicbrainz.recording_to_playlist_meta(pick4, album_hint=r.album)
            if meta and meta.get("mbid"):
                stats["matched"] += 1
                meta["_resolve_phase"] = "MB: title-only + album"
                memo[r.query_normalized] = ResolveOutcome(
                    state=PlaylistImportRowState.MATCHED,
                    meta=meta,
                    mbid=str(meta["mbid"]),
                    phase=meta["_resolve_phase"],
                    confidence=max(0.01, min(0.99, float(score4))),
                    error=None,
                )
                continue

        stats["unmatched"] += 1
        memo[r.query_normalized] = ResolveOutcome(
            state=PlaylistImportRowState.UNMATCHED,
            meta=None,
            mbid=None,
            phase="MB: title-only",
            confidence=None,
            error=None,
        )


async def _resolve_one(
    session: Session,
    row: ImportInputRow,
    *,
    sem: asyncio.Semaphore,
    memo: dict[str, ResolveOutcome],
    stats: dict[str, int],
) -> ResolveOutcome:
    # Kept for compatibility with older call sites; resolve as a 1-sized batch.
    await _resolve_batch_verbatim(session, [row], memo=memo, stats=stats)
    return memo.get(row.query_normalized) or ResolveOutcome(
        state=PlaylistImportRowState.ERROR,
        meta=None,
        mbid=None,
        phase=None,
        confidence=None,
        error="Internal: missing memo outcome",
    )


async def parse_csv_upload(file: UploadFile) -> list[ImportInputRow]:
    raw = await file.read()
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="Empty CSV")
    out: list[ImportInputRow] = []
    for idx, row in enumerate(reader):
        title = _csv_field(row, "track name", "title", "track", "track title")
        artist_raw = _csv_field(row, "artist name(s)", "artist", "artists", "artist name")
        # Keep only the primary artist (first token) to avoid "A;B" false negatives.
        toks = _artist_tokens(artist_raw)
        artist = toks[0] if toks else artist_raw
        album = _csv_field(row, "album name", "album")
        dur_s = _csv_field(row, "duration (ms)", "duration_ms", "duration")
        try:
            duration_ms = int(float(dur_s)) if dur_s else 0
        except Exception:
            duration_ms = 0
        qn = _query_normalized(artist, title, album)
        out.append(
            ImportInputRow(
                row_index=idx,
                title=title.strip(),
                artist=artist.strip(),
                album=(album or "").strip(),
                duration_ms=duration_ms,
                query_normalized=qn,
            )
        )
    return out


def _chunks[T](items: list[T], size: int) -> list[list[T]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


async def run_csv_import_job(
    *,
    playlist_id: int,
    user: User,
    session: Session,
    file: UploadFile,
    base_position: int,
    concurrency: int = 3,
    insert_chunk_size: int = 300,
) -> tuple[int, int, list[str], int]:
    """Run a persisted import job. Returns (added, skipped, errors, job_id)."""
    t0 = time.monotonic()
    rows = await parse_csv_upload(file)
    total = len(rows)

    job = PlaylistImportJob(
        user_id=user.id,
        playlist_id=playlist_id,
        base_position=base_position,
        created_at=datetime.utcnow(),
        status=PlaylistImportStatus.RUNNING,
        total=total,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    errors: list[str] = []
    stats: dict[str, int] = {
        "memo_hit": 0,
        "db_cache_hit": 0,
        "live_lookup": 0,
        "live_error": 0,
        "matched": 0,
        "unmatched": 0,
    }

    memo: dict[str, ResolveOutcome] = {}

    # Resolve in strict batches of 5 (verbatim OR-search), alias retry only for misses.
    for i in range(0, len(rows), 5):
        batch = [r for r in rows[i : i + 5] if r.title and r.artist]
        if not batch:
            continue
        try:
            async with musicbrainz.mb_prefetch_calls():
                await _resolve_batch_verbatim(session, batch, memo=memo, stats=stats)
        except Exception as ex:
            stats["live_error"] += 1
            for r in batch:
                if r.query_normalized not in memo:
                    memo[r.query_normalized] = ResolveOutcome(
                        state=PlaylistImportRowState.ERROR,
                        meta=None,
                        mbid=None,
                        phase=None,
                        confidence=None,
                        error=str(ex),
                    )

    # materialize row records + playlist items
    import_rows: list[PlaylistImportRow] = []
    playlist_items: list[PlaylistItem] = []
    added = 0
    skipped = 0

    for r in rows:
        if not r.title or not r.artist:
            skipped += 1
            import_rows.append(
                PlaylistImportRow(
                    job_id=job.id,
                    row_index=r.row_index,
                    title=r.title,
                    artist=r.artist,
                    album=r.album,
                    query_normalized=r.query_normalized,
                    state=PlaylistImportRowState.ERROR,
                    error="Missing title or artist",
                )
            )
            continue

        outcome = memo.get(r.query_normalized) or ResolveOutcome(
            state=PlaylistImportRowState.ERROR,
            meta=None,
            mbid=None,
            phase=None,
            confidence=None,
            error="Internal: missing memo outcome",
        )

        details = None
        if outcome.meta is not None:
            try:
                details = json.dumps(outcome.meta)[:20000]
            except Exception:
                details = None

        if outcome.state == PlaylistImportRowState.MATCHED and outcome.mbid:
            meta = outcome.meta or {}
            desired_pos = base_position + r.row_index
            playlist_items.append(
                PlaylistItem(
                    playlist_id=playlist_id,
                    position=desired_pos,
                    title=(meta.get("title") or r.title)[:255],
                    artist=(meta.get("artist_credit") or meta.get("artist") or r.artist)[:255],
                    album=(meta.get("album") or r.album or "")[:255],
                    mb_recording_id=str(outcome.mbid),
                    mb_artist_id=meta.get("mb_artist_id"),
                    mb_release_id=meta.get("mb_release_id"),
                    mb_release_group_id=meta.get("mb_release_group_id"),
                    album_cover=None,
                    track_id=None,
                )
            )
            import_rows.append(
                PlaylistImportRow(
                    job_id=job.id,
                    row_index=r.row_index,
                    desired_position=desired_pos,
                    title=r.title,
                    artist=r.artist,
                    album=r.album,
                    query_normalized=r.query_normalized,
                    state=PlaylistImportRowState.MATCHED,
                    mb_recording_id=str(outcome.mbid),
                    confidence=outcome.confidence,
                    phase=outcome.phase,
                    details_json=details,
                )
            )
            added += 1
        elif outcome.state == PlaylistImportRowState.ERROR:
            skipped += 1
            if outcome.error:
                errors.append(f"row {r.row_index + 2}: {outcome.error}")
            import_rows.append(
                PlaylistImportRow(
                    job_id=job.id,
                    row_index=r.row_index,
                    desired_position=base_position + r.row_index,
                    title=r.title,
                    artist=r.artist,
                    album=r.album,
                    query_normalized=r.query_normalized,
                    state=PlaylistImportRowState.ERROR,
                    phase=outcome.phase,
                    details_json=details,
                    error=outcome.error,
                )
            )
        else:
            skipped += 1
            import_rows.append(
                PlaylistImportRow(
                    job_id=job.id,
                    row_index=r.row_index,
                    desired_position=base_position + r.row_index,
                    title=r.title,
                    artist=r.artist,
                    album=r.album,
                    query_normalized=r.query_normalized,
                    state=PlaylistImportRowState.UNMATCHED,
                    mb_recording_id=str(outcome.mbid) if outcome.mbid else None,
                    confidence=outcome.confidence,
                    phase=outcome.phase,
                    details_json=details,
                    error=outcome.error,
                )
            )

    # batch insert rows/items
    for chunk in _chunks(import_rows, insert_chunk_size):
        session.add_all(chunk)
        session.commit()
    for chunk in _chunks(playlist_items, insert_chunk_size):
        session.add_all(chunk)
        session.commit()

    # finalize job
    job.matched = added
    job.unmatched = sum(1 for r in import_rows if r.state == PlaylistImportRowState.UNMATCHED)
    job.errored = sum(1 for r in import_rows if r.state == PlaylistImportRowState.ERROR)
    job.status = PlaylistImportStatus.DONE
    # store a small summary (not too large)
    summary = {
        "memo_hit": stats["memo_hit"],
        "db_cache_hit": stats["db_cache_hit"],
        "live_lookup": stats["live_lookup"],
        "live_error": stats["live_error"],
        "elapsed_s": round(time.monotonic() - t0, 3),
    }
    job.error_summary = json.dumps(summary)[:4000]
    session.add(job)
    session.commit()

    logger.info(
        "[playlist_import] job=%s total=%s added=%s skipped=%s stats=%s",
        job.id,
        total,
        added,
        skipped,
        summary,
    )
    return (added, skipped, errors[:50], int(job.id))


async def stream_csv_import(
    *,
    playlist_id: int,
    user: User,
    session: Session,
    file: UploadFile,
    base_position: int,
    concurrency: int = 3,
) -> AsyncIterator[dict[str, Any]]:
    """NDJSON-friendly event stream while running a persisted job.\n\n    Current implementation runs the import in one shot but streams coarse progress.\n    """
    rows = await parse_csv_upload(file)
    total = len(rows)

    # create job
    job = PlaylistImportJob(
        user_id=user.id,
        playlist_id=playlist_id,
        base_position=base_position,
        created_at=datetime.utcnow(),
        status=PlaylistImportStatus.RUNNING,
        total=total,
    )
    session.add(job)
    session.commit()
    session.refresh(job)

    yield {"type": "start", "total": total, "job_id": job.id}

    memo: dict[str, ResolveOutcome] = {}
    stats: dict[str, int] = {
        "memo_hit": 0,
        "db_cache_hit": 0,
        "live_lookup": 0,
        "live_error": 0,
        "matched": 0,
        "unmatched": 0,
    }

    added = 0
    skipped = 0
    errors: list[str] = []
    import_rows: list[PlaylistImportRow] = []
    playlist_items: list[PlaylistItem] = []

    row_counter = 0
    for i in range(0, len(rows), 5):
        batch_all = rows[i : i + 5]
        # emit progress for each row immediately (batch-level resolver runs internally)
        for r in batch_all:
            row_counter += 1
            yield {
                "type": "progress",
                "current": row_counter,
                "total": total,
                "title": r.title or "—",
                "artist": r.artist or "—",
                "phase": "Queued for resolve (batch of 5)…",
                "job_id": job.id,
            }

        batch = [r for r in batch_all if r.title and r.artist]
        if batch:
            try:
                async with musicbrainz.mb_prefetch_calls():
                    await _resolve_batch_verbatim(session, batch, memo=memo, stats=stats)
            except Exception as ex:
                stats["live_error"] += 1
                for r in batch:
                    if r.query_normalized not in memo:
                        memo[r.query_normalized] = ResolveOutcome(
                            state=PlaylistImportRowState.ERROR,
                            meta=None,
                            mbid=None,
                            phase=None,
                            confidence=None,
                            error=str(ex),
                        )

        # materialize outcomes for this batch in CSV order
        for r in batch_all:
            if not r.title or not r.artist:
                skipped += 1
                err = "Missing title or artist"
                errors.append(f"row {r.row_index + 2}: {err}")
                import_rows.append(
                    PlaylistImportRow(
                        job_id=job.id,
                        row_index=r.row_index,
                        desired_position=base_position + r.row_index,
                        title=r.title,
                        artist=r.artist,
                        album=r.album,
                        query_normalized=r.query_normalized,
                        state=PlaylistImportRowState.ERROR,
                        error=err,
                    )
                )
                continue

            outcome = memo.get(r.query_normalized)
            if outcome is None:
                skipped += 1
                err = "Internal: missing memo outcome"
                errors.append(f"row {r.row_index + 2}: {err}")
                import_rows.append(
                    PlaylistImportRow(
                        job_id=job.id,
                        row_index=r.row_index,
                        desired_position=base_position + r.row_index,
                        title=r.title,
                        artist=r.artist,
                        album=r.album,
                        query_normalized=r.query_normalized,
                        state=PlaylistImportRowState.ERROR,
                        error=err,
                    )
                )
                continue
            details = None
            if outcome.meta is not None:
                try:
                    details = json.dumps(outcome.meta)[:20000]
                except Exception:
                    details = None

            if outcome.state == PlaylistImportRowState.MATCHED and outcome.mbid:
                meta = outcome.meta or {}
                desired_pos = base_position + r.row_index
                playlist_items.append(
                    PlaylistItem(
                        playlist_id=playlist_id,
                        position=desired_pos,
                        title=(meta.get("title") or r.title)[:255],
                        artist=(meta.get("artist_credit") or meta.get("artist") or r.artist)[:255],
                        album=(meta.get("album") or r.album or "")[:255],
                        mb_recording_id=str(outcome.mbid),
                        mb_artist_id=meta.get("mb_artist_id"),
                        mb_release_id=meta.get("mb_release_id"),
                        mb_release_group_id=meta.get("mb_release_group_id"),
                        album_cover=None,
                        track_id=None,
                    )
                )
                import_rows.append(
                    PlaylistImportRow(
                        job_id=job.id,
                        row_index=r.row_index,
                        desired_position=desired_pos,
                        title=r.title,
                        artist=r.artist,
                        album=r.album,
                        query_normalized=r.query_normalized,
                        state=PlaylistImportRowState.MATCHED,
                        mb_recording_id=str(outcome.mbid),
                        confidence=outcome.confidence,
                        phase=outcome.phase,
                        details_json=details,
                    )
                )
                added += 1
                yield {
                    "type": "added",
                    "title": (meta.get("title") or r.title),
                    "artist": (meta.get("artist_credit") or meta.get("artist") or r.artist),
                    "mbid": str(outcome.mbid),
                    "phase": outcome.phase or "MusicBrainz",
                    "job_id": job.id,
                }
                yield {
                    "type": "row",
                    "row_index": r.row_index,
                    "state": "matched",
                    "mb_recording_id": str(outcome.mbid),
                    "confidence": outcome.confidence,
                    "phase": outcome.phase,
                    "details_json": details,
                    "error": None,
                    "job_id": job.id,
                }
            elif outcome.state == PlaylistImportRowState.ERROR:
                skipped += 1
                if outcome.error:
                    errors.append(f"row {r.row_index + 2}: {outcome.error}")
                import_rows.append(
                    PlaylistImportRow(
                        job_id=job.id,
                        row_index=r.row_index,
                        desired_position=base_position + r.row_index,
                        title=r.title,
                        artist=r.artist,
                        album=r.album,
                        query_normalized=r.query_normalized,
                        state=PlaylistImportRowState.ERROR,
                        confidence=outcome.confidence,
                        phase=outcome.phase,
                        details_json=details,
                        error=outcome.error,
                    )
                )
                yield {
                    "type": "row",
                    "row_index": r.row_index,
                    "state": "error",
                    "mb_recording_id": None,
                    "confidence": outcome.confidence,
                    "phase": outcome.phase,
                    "details_json": details,
                    "error": outcome.error,
                    "job_id": job.id,
                }
            else:
                skipped += 1
                import_rows.append(
                    PlaylistImportRow(
                        job_id=job.id,
                        row_index=r.row_index,
                        desired_position=base_position + r.row_index,
                        title=r.title,
                        artist=r.artist,
                        album=r.album,
                        query_normalized=r.query_normalized,
                        state=PlaylistImportRowState.UNMATCHED,
                        mb_recording_id=str(outcome.mbid) if outcome.mbid else None,
                        confidence=outcome.confidence,
                        phase=outcome.phase,
                        details_json=details,
                        error=outcome.error,
                    )
                )
                yield {
                    "type": "row",
                    "row_index": r.row_index,
                    "state": "unmatched",
                    "mb_recording_id": str(outcome.mbid) if outcome.mbid else None,
                    "confidence": outcome.confidence,
                    "phase": outcome.phase,
                    "details_json": details,
                    "error": outcome.error,
                    "job_id": job.id,
                }

    # batch persist
    if import_rows:
        session.add_all(import_rows)
        session.commit()
    if playlist_items:
        session.add_all(playlist_items)
        session.commit()

    job.matched = added
    job.unmatched = sum(1 for r in import_rows if r.state == PlaylistImportRowState.UNMATCHED)
    job.errored = sum(1 for r in import_rows if r.state == PlaylistImportRowState.ERROR)
    job.status = PlaylistImportStatus.DONE
    session.add(job)
    session.commit()

    yield {
        "type": "done",
        "total": total,
        "added": added,
        "skipped": skipped,
        "errors": errors[:50],
        "job_id": job.id,
    }

