from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

from sqlmodel import Session, select

from database import engine
from models import MbArtist, MbArtistAlias

logger = logging.getLogger(__name__)

_MAX_PHRASE_TOKENS = 3
_MAX_ALIASES_INGEST = 400


def norm_alias(s: str) -> str:
    return " ".join((s or "").lower().strip().split())


def map_cached_artists_to_canonical(artists: list[str]) -> dict[str, str]:
    """Map stripped Last.fm (or other) artist strings to ``MbArtist.canonical_name`` when ``alias_norm`` matches.

    Keys are the original stripped strings passed in; only strings with a cache hit appear in the dict.
    """
    seen: list[str] = []
    for raw in artists:
        u = (raw or "").strip()
        if not u or u in seen:
            continue
        seen.append(u)
    if not seen:
        return {}
    norms_set: set[str] = set()
    for u in seen:
        n = norm_alias(u)
        if n:
            norms_set.add(n)
    norms = list(norms_set)
    if not norms:
        return {}
    try:
        with Session(engine) as session:
            rows = session.exec(
                select(MbArtistAlias.alias_norm, MbArtist.canonical_name)
                .join(MbArtist, MbArtistAlias.artist_mbid == MbArtist.artist_mbid)
                .where(MbArtistAlias.alias_norm.in_(norms))
            ).all()
    except Exception:
        logger.debug("map_cached_artists_to_canonical failed (ignored)", exc_info=True)
        return {}
    norm_to_canon: dict[str, str] = {}
    for an, cn in rows:
        if not an:
            continue
        c = (cn or "").strip()
        if c:
            norm_to_canon[an] = c
    out: dict[str, str] = {}
    for u in seen:
        c = norm_to_canon.get(norm_alias(u))
        if c:
            out[u] = c
    return out


def rewrite_query_with_cached_aliases(query: str) -> str:
    """Replace known cached alias phrases in a free-text query (1..3 token spans)."""
    q = (query or "").strip()
    if not q:
        return q

    words = q.split()
    if not words:
        return q

    # Preload replacements for all contiguous spans up to N tokens (bounded small).
    spans: list[tuple[int, int, str]] = []  # (i, j_exclusive, phrase_norm)
    for i in range(len(words)):
        for w in range(1, min(_MAX_PHRASE_TOKENS, len(words) - i) + 1):
            j = i + w
            phrase = " ".join(words[i:j])
            spans.append((i, j, norm_alias(phrase)))

    if not spans:
        return q

    norms = list({s for _, _, s in spans if s})
    hits: dict[str, tuple[str, str]] = {}
    if norms:
        try:
            with Session(engine) as session:
                rows = session.exec(
                    select(MbArtistAlias, MbArtist)
                    .join(MbArtist, MbArtistAlias.artist_mbid == MbArtist.artist_mbid)
                    .where(MbArtistAlias.alias_norm.in_(norms))
                ).all()
                for arow, mrow in rows:
                    hits[arow.alias_norm] = (mrow.artist_mbid, mrow.canonical_name)
        except Exception:
            logger.debug("alias cache rewrite lookup failed (ignored)", exc_info=True)
            return q

    if not hits:
        return q

    out_words = words[:]
    i = 0
    while i < len(out_words):
        best = None  # (j_exclusive, canonical)
        for w in range(min(_MAX_PHRASE_TOKENS, len(out_words) - i), 0, -1):
            j = i + w
            key = norm_alias(" ".join(out_words[i:j]))
            hit = hits.get(key)
            if hit:
                best = (j, hit[1])
                break
        if not best:
            i += 1
            continue
        j, canonical = best
        # Replace span [i:j) with canonical tokens split on whitespace.
        canon_tokens = canonical.split()
        out_words = out_words[:i] + canon_tokens + out_words[j:]
        i += len(canon_tokens)

    return " ".join(out_words).strip()


def upsert_from_mb_artist_json(data: dict[str, Any], *, source: str = "musicbrainz_artist") -> None:
    """Persist canonical artist + aliases from a raw MusicBrainz /artist JSON object."""
    mbid = (data.get("id") or "").strip()
    name = (data.get("name") or "").strip()
    if not mbid or not name:
        return

    sort_name = (data.get("sort-name") or "").strip() or None
    now = datetime.utcnow()

    aliases: list[str] = []
    aliases.append(name)
    if sort_name:
        aliases.append(sort_name)

    for al in data.get("aliases") or []:
        if not isinstance(al, dict):
            continue
        an = (al.get("name") or "").strip()
        if an:
            aliases.append(an)

    # Dedup while keeping stable order
    seen: set[str] = set()
    deduped: list[str] = []
    for a in aliases:
        k = norm_alias(a)
        if not k or k in seen:
            continue
        seen.add(k)
        deduped.append(a)
        if len(deduped) >= _MAX_ALIASES_INGEST:
            break

    try:
        with Session(engine) as session:
            artist = session.get(MbArtist, mbid)
            if artist is None:
                session.add(
                    MbArtist(
                        artist_mbid=mbid,
                        canonical_name=name,
                        sort_name=sort_name,
                        source=source,
                        is_manual=False,
                        created_at=now,
                        updated_at=now,
                        last_fetched_at=now,
                    )
                )
            else:
                if not artist.is_manual:
                    artist.canonical_name = name
                    if sort_name:
                        artist.sort_name = sort_name
                    artist.updated_at = now
                    artist.last_fetched_at = now
                    session.add(artist)

            for raw in deduped:
                key = norm_alias(raw)
                if not key:
                    continue
                row = session.exec(select(MbArtistAlias).where(MbArtistAlias.alias_norm == key)).first()
                if row is None:
                    session.add(
                        MbArtistAlias(
                            alias_norm=key,
                            alias_raw=raw,
                            artist_mbid=mbid,
                            source=source,
                            is_manual=False,
                            created_at=now,
                            last_seen_at=now,
                        )
                    )
                else:
                    if row.is_manual:
                        continue
                    # Prefer authoritative MB ingestion over older heuristic rows.
                    row.artist_mbid = mbid
                    row.alias_raw = raw or row.alias_raw
                    row.source = source
                    row.last_seen_at = now
                    session.add(row)

            session.commit()
    except Exception:
        logger.debug("artist alias upsert failed (ignored)", exc_info=True)


def upsert_from_fix_artist_alias(*, alias_raw: str, artist_mbid: str, canonical_name: str) -> None:
    """Persist a single alias→artist mapping learned from ``fix_artist_alias``."""
    alias_raw = (alias_raw or "").strip()
    canonical_name = (canonical_name or "").strip()
    artist_mbid = (artist_mbid or "").strip()
    if not alias_raw or not artist_mbid or not canonical_name:
        return
    key = norm_alias(alias_raw)
    if not key:
        return
    now = datetime.utcnow()
    source = "fix_artist_alias"
    try:
        with Session(engine) as session:
            artist = session.get(MbArtist, artist_mbid)
            if artist is None:
                session.add(
                    MbArtist(
                        artist_mbid=artist_mbid,
                        canonical_name=canonical_name,
                        sort_name=None,
                        source=source,
                        is_manual=False,
                        created_at=now,
                        updated_at=now,
                        last_fetched_at=now,
                    )
                )
            else:
                if not artist.is_manual and artist.canonical_name != canonical_name:
                    artist.canonical_name = canonical_name
                    artist.updated_at = now
                    artist.last_fetched_at = now
                    session.add(artist)

            row = session.exec(select(MbArtistAlias).where(MbArtistAlias.alias_norm == key)).first()
            if row is None:
                session.add(
                    MbArtistAlias(
                        alias_norm=key,
                        alias_raw=alias_raw,
                        artist_mbid=artist_mbid,
                        source=source,
                        is_manual=False,
                        created_at=now,
                        last_seen_at=now,
                    )
                )
            else:
                if row.is_manual:
                    session.commit()
                    return
                row.artist_mbid = artist_mbid
                row.alias_raw = alias_raw
                row.source = source
                row.last_seen_at = now
                session.add(row)

            session.commit()
    except Exception:
        logger.debug("fix_artist_alias upsert failed (ignored)", exc_info=True)
