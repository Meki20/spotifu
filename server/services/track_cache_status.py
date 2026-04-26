"""Annotate track dicts from metadata APIs with is_cached (local library READY)."""

import os

from sqlalchemy import func
from sqlmodel import Session, select

from models import Track, TrackStatus


def annotate_tracks_is_cached(
    session: Session,
    tracks: list[dict],
    *,
    artist_fallback: str | None = None,
) -> None:
    """Set ``is_cached`` on each dict/model in ``tracks``. Mutates in place."""
    if not tracks:
        return

    def _get(obj, key, default=None):
        return getattr(obj, key, default) if not isinstance(obj, dict) else obj.get(key, default)

    all_mb_ids = [str(_get(t, "mbid")) for t in tracks if _get(t, "mbid")]
    cached_mb: set[str] = set()

    if all_mb_ids:
        stmt = select(Track.mb_id).where(
            Track.mb_id.in_(all_mb_ids), Track.status == TrackStatus.READY
        )
        cached_mb = {row for row in session.exec(stmt) if row}

    titles_to_check = list({
        _get(t, "title", "").lower()
        for t in tracks
        if _get(t, "title")
    })
    ready_by_title_artist: set[tuple[str, str]] = set()
    # (title_lower, artist_lower) → local_file_path for tracks not matched above
    path_by_title_artist: dict[tuple[str, str], str] = {}
    if titles_to_check:
        title_matches = session.exec(
            select(Track.title, Track.artist, Track.local_file_path).where(
                Track.status == TrackStatus.READY,
                func.lower(Track.title).in_(titles_to_check),
            )
        ).all()
        for t_title, t_artist, t_path in title_matches:
            if t_title and t_artist:
                key = (t_title.lower(), t_artist.lower())
                ready_by_title_artist.add(key)
                if t_path:
                    path_by_title_artist[key] = t_path

    # Pre-fetch local_file_path for all remaining unmatched mb_ids in one shot
    unmatched_mb_ids = [
        str(_get(t, "mbid"))
        for t in tracks
        if not (
            (str(_get(t, "mbid") or "") in cached_mb)
            or ((_get(t, "album") or "").lower(), _get(t, "title", "").lower()) in ready_by_title_artist
            or (_get(t, "title", "").lower(), (_get(t, "artist") or "").lower() or (artist_fallback or "").lower()) in ready_by_title_artist
        )
        and str(_get(t, "mbid"))
    ]
    mb_path_by_id: dict[str, str] = {}
    if unmatched_mb_ids:
        path_rows = session.exec(
            select(Track.mb_id, Track.local_file_path).where(
                Track.mb_id.in_(unmatched_mb_ids),
                Track.status == TrackStatus.READY,
                Track.local_file_path != None,  # noqa: E711
            )
        ).all()
        for row_mb_id, row_path in path_rows:
            if row_mb_id and row_path:
                mb_path_by_id[row_mb_id] = row_path

    for t in tracks:
        mbid = str(_get(t, "mbid") or "")
        album_lower = (_get(t, "album") or "").lower()
        title_lower = _get(t, "title", "").lower()
        artist_lower = _get(t, "artist", "").lower() or (artist_fallback or "").lower()
        is_cached = (
            (bool(mbid) and mbid in cached_mb)
            or (album_lower, title_lower) in ready_by_title_artist
            or (title_lower, artist_lower) in ready_by_title_artist
        )
        if not is_cached and mbid:
            path = path_by_title_artist.get((title_lower, artist_lower)) or mb_path_by_id.get(mbid)
            if path and os.path.isfile(path):
                is_cached = True
        if isinstance(t, dict):
            t["is_cached"] = is_cached
        else:
            t.is_cached = is_cached