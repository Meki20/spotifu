import asyncio
import csv
import io
import json
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select, func, delete, or_, and_
from database import get_session
from database import engine
from deps import get_current_user
from models import (
    Playlist,
    PlaylistItem,
    PlaylistImportJob,
    PlaylistImportRow,
    PlaylistImportRowState,
    User,
    Track,
    TrackStatus,
    LibraryAlbumOrder,
)
from services.playlist_import import run_csv_import_job, stream_csv_import
from services.providers import MetadataService
from services.providers import musicbrainz
from services.track_cache_status import annotate_tracks_is_cached
from schemas import TrackOut

router = APIRouter(prefix="/playlists", tags=["library"])


class PlaylistCreate(BaseModel):
    title: str
    description: str | None = None
    cover_image_url: str | None = None


class PlaylistUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    cover_image_url: str | None = None


class PlaylistResponse(BaseModel):
    id: int
    title: str
    description: str | None = None
    cover_image_url: str | None = None


class PlaylistItemOut(BaseModel):
    id: int
    position: int
    title: str
    artist: str
    album: str
    mb_recording_id: str
    mb_artist_id: str | None
    mb_release_id: str | None
    mb_release_group_id: str | None
    album_cover: str | None
    track_id: int | None
    is_cached: bool = False


class PlaylistDetailResponse(BaseModel):
    id: int
    title: str
    description: str | None
    cover_image_url: str | None
    items: list[PlaylistItemOut]


class PlaylistItemCreate(BaseModel):
    title: str
    artist: str
    album: str = ""
    mb_recording_id: str
    mb_artist_id: str | None = None
    mb_release_id: str | None = None
    mb_release_group_id: str | None = None
    album_cover: str | None = None
    position: int | None = None


class ItemReorderEntry(BaseModel):
    item_id: int
    position: int


class CsvImportResult(BaseModel):
    added: int
    skipped: int
    errors: list[str]
    job_id: int | None = None


class PlaylistImportJobOut(BaseModel):
    id: int
    playlist_id: int
    status: str
    created_at: str
    total: int
    matched: int
    unmatched: int
    errored: int
    base_position: int
    error_summary: str | None = None


class PlaylistImportRowOut(BaseModel):
    id: int
    row_index: int
    desired_position: int
    title: str
    artist: str
    album: str
    query_normalized: str
    state: str
    mb_recording_id: str | None
    confidence: float | None
    phase: str | None
    details_json: str | None = None
    error: str | None


class ResolveImportRowBody(BaseModel):
    mb_recording_id: str


@router.get("", response_model=list[PlaylistResponse])
def list_playlists(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    playlists = session.exec(
        select(Playlist)
        .where(Playlist.user_id == user.id)
        .order_by(Playlist.id.desc())
        .limit(limit)
        .offset(offset)
    ).all()
    return [
        PlaylistResponse(
            id=p.id,
            title=p.title,
            description=p.description,
            cover_image_url=p.cover_image_url,
        )
        for p in playlists
    ]


@router.post("", response_model=PlaylistResponse)
def create_playlist(
    body: PlaylistCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    pl = Playlist(
        title=body.title,
        user_id=user.id,
        description=body.description,
        cover_image_url=body.cover_image_url,
    )
    session.add(pl)
    session.commit()
    session.refresh(pl)
    return PlaylistResponse(
        id=pl.id,
        title=pl.title,
        description=pl.description,
        cover_image_url=pl.cover_image_url,
    )


def _get_playlist_for_user(session: Session, playlist_id: int, user_id: int) -> Playlist:
    pl = session.get(Playlist, playlist_id)
    if pl is None or pl.user_id != user_id:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return pl


def _max_item_position(session: Session, playlist_id: int) -> int:
    m = session.exec(
        select(func.max(PlaylistItem.position)).where(PlaylistItem.playlist_id == playlist_id)
    ).first()
    return int(m) if m is not None else -1


def _find_local_track_id(session: Session, mb_recording_id: str) -> int | None:
    ready = session.exec(
        select(Track.id)
        .where(Track.mb_id == mb_recording_id, Track.status == TrackStatus.READY)
        .limit(1)
    ).first()
    if ready is not None:
        return ready
    return session.exec(
        select(Track.id).where(Track.mb_id == mb_recording_id).limit(1)
    ).first()


def _effective_playlist_item_cached(session: Session, row: PlaylistItem, annotated: bool) -> bool:
    """Bright cache only when the linked library row is READY, or annotate matched without a link."""
    if row.track_id is not None:
        tr = session.get(Track, row.track_id)
        if tr is None or tr.status != TrackStatus.READY:
            return False
        return True
    return bool(annotated)


def _playlist_item_to_out(row: PlaylistItem, *, is_cached: bool = False) -> PlaylistItemOut:
    return PlaylistItemOut(
        id=row.id,
        position=row.position,
        title=row.title,
        artist=row.artist,
        album=row.album,
        mb_recording_id=row.mb_recording_id,
        mb_artist_id=row.mb_artist_id,
        mb_release_id=row.mb_release_id,
        mb_release_group_id=row.mb_release_group_id,
        album_cover=row.album_cover,
        track_id=row.track_id,
        is_cached=is_cached,
    )


def _csv_field(row: dict[str, str], *candidates: str) -> str:
    lower = {
        k.lower().strip(): (str(v).strip() if v is not None else "")
        for k, v in row.items()
        if k
    }
    for c in candidates:
        if c.lower() in lower and lower[c.lower()]:
            return lower[c.lower()]
    return ""


class LibraryTrackResponse(BaseModel):
    mb_id: str | None = None
    mb_artist_id: str | None = None
    title: str
    artist: str
    duration: int
    is_cached: bool


class LibraryAlbumResponse(BaseModel):
    id: str
    title: str
    artist: str
    cover: str | None
    track_count: int
    cached_count: int
    tracks: list[LibraryTrackResponse]
    position: int = 0
    album_key: str = ""


class AlbumOrderUpdate(BaseModel):
    album_key: str
    position: int


@router.get("/albums", response_model=list[LibraryAlbumResponse])
async def list_library_albums(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Return albums that have at least one READY (cached) track."""
    ready = session.exec(
        select(Track.album, Track.artist, func.count(Track.id).label("tc"))
        .where(Track.status == TrackStatus.READY)
        .group_by(Track.album, Track.artist)
    ).all()

    # Load custom ordering for user
    custom_order: dict[str, int] = {}
    order_rows = session.exec(
        select(LibraryAlbumOrder).where(LibraryAlbumOrder.user_id == user.id)
    ).all()
    for row in order_rows:
        custom_order[row.album_key] = row.position

    # Batch-fetch one mb_id per (album, artist) to eliminate N queries
    album_artist_pairs = [(album, artist) for album, artist, _ in ready]
    mb_id_by_pair: dict[tuple[str, str], str] = {}
    if album_artist_pairs:
        mb_id_rows = session.exec(
            select(Track.album, Track.artist, Track.mb_id)
            .where(
                Track.status == TrackStatus.READY,
                Track.mb_id != None,  # noqa: E711
            )
            .where(
                or_(
                    *[
                        and_(Track.album == a, Track.artist == ar)
                        for a, ar in album_artist_pairs
                    ]
                )
            )
        ).all()
        for row_album, row_artist, row_mb_id in mb_id_rows:
            key = (row_album, row_artist)
            if row_mb_id and "-" in row_mb_id and key not in mb_id_by_pair:
                mb_id_by_pair[key] = row_mb_id

    svc = MetadataService(session)
    sem = asyncio.Semaphore(6)

    async def _build_one(
        album_name: str, artist_name: str, _tc: int, mb_id: str, sort_idx: int
    ) -> LibraryAlbumResponse | None:
        async with sem:
            try:
                data = await svc.get_album(mb_id)
            except Exception:
                return None
        if not data:
            return None

        cover = data.get("cover") or data.get("album_cover")
        tracks_raw = data.get("tracks", [])
        if isinstance(tracks_raw, list):
            annotate_tracks_is_cached(session, tracks_raw, artist_fallback=artist_name)

        cached_count = sum(1 for t in tracks_raw if t.get("is_cached"))
        album_key = f"{artist_name}|{album_name}"
        position = custom_order.get(album_key, sort_idx)

        return LibraryAlbumResponse(
            id=mb_id,
            title=data.get("title", album_name),
            artist=data.get("artist", artist_name),
            cover=cover,
            track_count=len(tracks_raw),
            cached_count=cached_count,
            tracks=[
                LibraryTrackResponse(
                    mb_id=t.get("mbid") or t.get("mb_release_id"),
                    mb_artist_id=t.get("mb_artist_id"),
                    title=t.get("title", ""),
                    artist=t.get("artist", artist_name),
                    duration=t.get("duration", 0),
                    is_cached=bool(t.get("is_cached")),
                )
                for t in tracks_raw
            ],
            position=position,
            album_key=f"{artist_name}|{album_name}",
        )

    to_fetch = []
    for sort_idx, (album_name, artist_name, _tc) in enumerate(ready):
        mb_id = mb_id_by_pair.get((album_name, artist_name))
        if not mb_id:
            continue
        to_fetch.append(_build_one(album_name, artist_name, _tc, mb_id, sort_idx))

    parts = await asyncio.gather(*to_fetch) if to_fetch else []
    albums = [a for a in parts if a is not None]
    albums.sort(key=lambda a: a.position)
    return albums


@router.put("/albums/order")
def update_album_order(
    body: list[AlbumOrderUpdate],
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Replace all custom album positions for the user."""
    # Delete existing order entries
    existing = session.exec(
        select(LibraryAlbumOrder).where(LibraryAlbumOrder.user_id == user.id)
    ).all()
    for row in existing:
        session.delete(row)

    # Insert new positions
    for item in body:
        session.add(LibraryAlbumOrder(
            user_id=user.id,
            album_key=item.album_key,
            position=item.position,
        ))

    session.commit()
    return {"ok": True}


@router.get("/recently-added", response_model=list[TrackOut])
def list_recently_added(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tracks = session.exec(
        select(Track)
        .where(Track.status == TrackStatus.READY)
        .order_by(Track.id.desc())
        .limit(20)
    ).all()
    return [
        TrackOut(
            mb_id=t.mb_id or "",
            track_id=t.id,
            title=t.title,
            artist=t.artist,
            artist_credit=t.artist_credit,
            album=t.album,
            album_cover=t.album_cover,
            duration=t.duration,
            is_cached=True,
            local_stream_url=f"/stream/{t.id}" if t.local_file_path else None,
            mb_artist_id=t.mb_artist_id,
            mb_release_id=t.mb_release_id,
            mb_release_group_id=t.mb_release_group_id,
            release_date=t.release_date,
            genre=t.genre,
        )
        for t in tracks
    ]


@router.get("/recently-played", response_model=list[TrackOut])
def list_recently_played(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tracks = session.exec(
        select(Track)
        .where(Track.status == TrackStatus.READY)
        .where(Track.last_played_at.isnot(None))
        .order_by(Track.last_played_at.desc())
        .limit(20)
    ).all()
    return [
        TrackOut(
            mb_id=t.mb_id or "",
            track_id=t.id,
            title=t.title,
            artist=t.artist,
            artist_credit=t.artist_credit,
            album=t.album,
            album_cover=t.album_cover,
            duration=t.duration,
            is_cached=True,
            local_stream_url=f"/stream/{t.id}" if t.local_file_path else None,
            mb_artist_id=t.mb_artist_id,
            mb_release_id=t.mb_release_id,
            mb_release_group_id=t.mb_release_group_id,
            release_date=t.release_date,
            genre=t.genre,
        )
        for t in tracks
    ]


# --- Playlist detail & items ({playlist_id} routes must stay below static paths) ---


class RecordingCoverResponse(BaseModel):
    url: str | None = None


@router.get("/releases/{release_mbid}/cover", response_model=RecordingCoverResponse)
async def get_release_cover_url(
    release_mbid: str,
    user: User = Depends(get_current_user),
):
    url = await musicbrainz.cover_url_for_release_or_rg(
        mb_release_id=release_mbid,
        mb_release_group_id=None,
    )
    return RecordingCoverResponse(url=url if isinstance(url, str) else None)


@router.get("/release-groups/{rg_mbid}/cover", response_model=RecordingCoverResponse)
async def get_release_group_cover_url(
    rg_mbid: str,
    user: User = Depends(get_current_user),
):
    url = await musicbrainz.cover_url_for_release_or_rg(
        mb_release_id=None,
        mb_release_group_id=rg_mbid,
    )
    return RecordingCoverResponse(url=url if isinstance(url, str) else None)


@router.get("/recordings/{recording_mbid}/cover", response_model=RecordingCoverResponse)
async def get_recording_cover_url(
    recording_mbid: str,
    user: User = Depends(get_current_user),
):
    meta = await musicbrainz.get_track(recording_mbid)
    url = (meta or {}).get("album_cover")
    return RecordingCoverResponse(url=url if isinstance(url, str) else None)


@router.get("/{playlist_id}", response_model=PlaylistDetailResponse)
def get_playlist(
    playlist_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    pl = _get_playlist_for_user(session, playlist_id, user.id)
    items = session.exec(
        select(PlaylistItem)
        .where(PlaylistItem.playlist_id == pl.id)
        .order_by(PlaylistItem.position, PlaylistItem.id)
        .limit(limit)
        .offset(offset)
    ).all()
    shadow = [
        {
            "mbid": i.mb_recording_id,
            "title": i.title,
            "artist": i.artist,
            "album": i.album,
        }
        for i in items
    ]
    annotate_tracks_is_cached(session, shadow)
    # Fill playlist item covers from DB-backed cover cache when possible (no network),
    # but do it in a single batched DB read to avoid N+1 queries that slow the endpoint.
    try:
        from models import MBEntityCache
        from sqlmodel import select as _select
        import json as _json

        want_release: dict[str, list[PlaylistItem]] = {}
        want_rg: dict[str, list[PlaylistItem]] = {}
        for it in items:
            if it.album_cover:
                continue
            if it.mb_release_id:
                want_release.setdefault(it.mb_release_id, []).append(it)
            elif it.mb_release_group_id:
                want_rg.setdefault(it.mb_release_group_id, []).append(it)

        keys: list[str] = []
        keys.extend([f"cover_release:{rid}" for rid in want_release.keys()])
        keys.extend([f"cover_rg:{rgid}" for rgid in want_rg.keys()])
        if keys:
            rows = session.exec(_select(MBEntityCache).where(MBEntityCache.key.in_(keys))).all()
            payload_by_key: dict[str, dict] = {}
            for r in rows:
                try:
                    payload_by_key[r.key] = _json.loads(r.payload)
                except Exception:
                    continue

            for rid, its in want_release.items():
                p = payload_by_key.get(f"cover_release:{rid}") or {}
                if p.get("found") is True and p.get("url"):
                    for it in its:
                        it.album_cover = str(p["url"])

            for rgid, its in want_rg.items():
                p = payload_by_key.get(f"cover_rg:{rgid}") or {}
                if p.get("found") is True and p.get("url"):
                    for it in its:
                        it.album_cover = str(p["url"])
    except Exception:
        pass
    item_outs = [
        _playlist_item_to_out(
            row,
            is_cached=_effective_playlist_item_cached(session, row, bool(d.get("is_cached"))),
        )
        for row, d in zip(items, shadow, strict=True)
    ]
    return PlaylistDetailResponse(
        id=pl.id,
        title=pl.title,
        description=pl.description,
        cover_image_url=pl.cover_image_url,
        items=item_outs,
    )


@router.patch("/{playlist_id}", response_model=PlaylistResponse)
def update_playlist(
    playlist_id: int,
    body: PlaylistUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    pl = _get_playlist_for_user(session, playlist_id, user.id)
    data = body.model_dump(exclude_unset=True)
    if "title" in data:
        pl.title = data["title"]
    if "description" in data:
        pl.description = data["description"]
    if "cover_image_url" in data:
        pl.cover_image_url = data["cover_image_url"]
    session.add(pl)
    session.commit()
    session.refresh(pl)
    return PlaylistResponse(
        id=pl.id,
        title=pl.title,
        description=pl.description,
        cover_image_url=pl.cover_image_url,
    )


@router.delete("/{playlist_id}")
def delete_playlist(
    playlist_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    pl = _get_playlist_for_user(session, playlist_id, user.id)
    # DB-level ON DELETE CASCADE might not be present on existing installs.
    # Delete items first to avoid FK violations.
    session.exec(
        delete(PlaylistItem).where(PlaylistItem.playlist_id == playlist_id)
    )
    session.delete(pl)
    session.commit()
    return {"ok": True}


@router.post("/{playlist_id}/items", response_model=PlaylistItemOut)
def add_playlist_item(
    playlist_id: int,
    body: PlaylistItemCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    if body.position is not None:
        pos = body.position
    else:
        pos = _max_item_position(session, playlist_id) + 1
    track_id = _find_local_track_id(session, body.mb_recording_id)
    row = PlaylistItem(
        playlist_id=playlist_id,
        position=pos,
        title=body.title,
        artist=body.artist,
        album=body.album,
        mb_recording_id=body.mb_recording_id,
        mb_artist_id=body.mb_artist_id,
        mb_release_id=body.mb_release_id,
        mb_release_group_id=body.mb_release_group_id,
        album_cover=body.album_cover,
        track_id=track_id,
    )
    # If cover wasn't provided, try DB-backed caches quickly (no network required).
    if not row.album_cover:
        try:
            from services.providers import get_cached_cover
            if row.mb_release_id:
                found, url = get_cached_cover("cover_release", row.mb_release_id)
                if found and url:
                    row.album_cover = url
            if not row.album_cover and row.mb_release_group_id:
                found, url = get_cached_cover("cover_rg", row.mb_release_group_id)
                if found and url:
                    row.album_cover = url
        except Exception:
            pass
    session.add(row)
    session.commit()
    session.refresh(row)
    one = [
        {
            "mbid": row.mb_recording_id,
            "title": row.title,
            "artist": row.artist,
            "album": row.album,
        }
    ]
    annotate_tracks_is_cached(session, one)
    return _playlist_item_to_out(
        row,
        is_cached=_effective_playlist_item_cached(session, row, bool(one[0].get("is_cached"))),
    )


@router.delete("/{playlist_id}/items/{item_id}")
def delete_playlist_item(
    playlist_id: int,
    item_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    row = session.get(PlaylistItem, item_id)
    if row is None or row.playlist_id != playlist_id:
        raise HTTPException(status_code=404, detail="Playlist item not found")
    session.delete(row)
    session.commit()
    return {"ok": True}


@router.put("/{playlist_id}/items/reorder")
def reorder_playlist_items(
    playlist_id: int,
    body: list[ItemReorderEntry],
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    if not body:
        return {"ok": True}
    ids = {e.item_id for e in body}
    rows = session.exec(
        select(PlaylistItem).where(
            PlaylistItem.playlist_id == playlist_id,
            PlaylistItem.id.in_(ids),
        )
    ).all()
    if len(rows) != len(ids):
        raise HTTPException(status_code=400, detail="Unknown item id for this playlist")
    pos_map = {e.item_id: e.position for e in body}
    for r in rows:
        r.position = pos_map[r.id]
        session.add(r)
    session.commit()
    return {"ok": True}


@router.post("/{playlist_id}/import/csv/stream")
async def import_playlist_csv_stream(
    playlist_id: int,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    raw = await file.read()

    async def ndjson():
        # Decouple long-running import from the request cancel scope.
        # If the client disconnects, the stream ends, but the job continues.
        q: asyncio.Queue[dict[str, object] | None] = asyncio.Queue(maxsize=200)

        class _BytesUpload:
            def __init__(self, data: bytes):
                self._data = data

            async def read(self) -> bytes:
                return self._data

        async def runner():
            from sqlmodel import Session as _Session
            try:
                # Use a fresh DB session so request cancellation/cleanup can't break the job.
                with _Session(engine) as job_session:
                    fresh_user = job_session.get(User, user.id)
                    if fresh_user is None:
                        raise RuntimeError("User not found")
                    base_pos = _max_item_position(job_session, playlist_id) + 1
                    async for ev in stream_csv_import(
                        playlist_id=playlist_id,
                        user=fresh_user,
                        session=job_session,
                        file=_BytesUpload(raw),  # type: ignore[arg-type]
                        base_position=base_pos,
                    ):
                        try:
                            q.put_nowait(ev)
                        except asyncio.QueueFull:
                            # Drop noisy progress events under backpressure.
                            if ev.get("type") in ("done", "start"):
                                await q.put(ev)
            except Exception as ex:
                try:
                    q.put_nowait({"type": "done", "total": 0, "added": 0, "skipped": 0, "errors": [str(ex)], "job_id": None})
                except asyncio.QueueFull:
                    pass
            finally:
                try:
                    q.put_nowait(None)
                except asyncio.QueueFull:
                    await q.put(None)

        asyncio.create_task(runner())

        try:
            while True:
                ev = await q.get()
                if ev is None:
                    break
                yield (json.dumps(ev) + "\n").encode("utf-8")
        except asyncio.CancelledError:
            # Client disconnected; stop streaming quietly. Job continues in runner().
            return

    return StreamingResponse(ndjson(), media_type="application/x-ndjson")


@router.post("/{playlist_id}/import/csv", response_model=CsvImportResult)
async def import_playlist_csv(
    playlist_id: int,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    base_pos = _max_item_position(session, playlist_id) + 1
    added, skipped, errors, job_id = await run_csv_import_job(
        playlist_id=playlist_id,
        user=user,
        session=session,
        file=file,
        base_position=base_pos,
    )
    return CsvImportResult(added=added, skipped=skipped, errors=errors[:50], job_id=job_id)


@router.get("/{playlist_id}/imports/{job_id}", response_model=PlaylistImportJobOut)
def get_playlist_import_job(
    playlist_id: int,
    job_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    job = session.get(PlaylistImportJob, job_id)
    if job is None or job.playlist_id != playlist_id or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="Import job not found")
    return PlaylistImportJobOut(
        id=job.id,
        playlist_id=job.playlist_id,
        status=str(job.status.value if hasattr(job.status, "value") else job.status),
        created_at=job.created_at.isoformat(),
        total=job.total,
        matched=job.matched,
        unmatched=job.unmatched,
        errored=job.errored,
        base_position=job.base_position,
        error_summary=job.error_summary,
    )


@router.get("/{playlist_id}/imports/{job_id}/rows", response_model=list[PlaylistImportRowOut])
def list_playlist_import_rows(
    playlist_id: int,
    job_id: int,
    state: str | None = Query(default=None),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    job = session.get(PlaylistImportJob, job_id)
    if job is None or job.playlist_id != playlist_id or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="Import job not found")
    q = select(PlaylistImportRow).where(PlaylistImportRow.job_id == job_id)
    if state:
        q = q.where(PlaylistImportRow.state == state)
    rows = session.exec(q.order_by(PlaylistImportRow.row_index.asc()).limit(limit).offset(offset)).all()
    return [
        PlaylistImportRowOut(
            id=r.id,
            row_index=r.row_index,
            desired_position=r.desired_position,
            title=r.title,
            artist=r.artist,
            album=r.album,
            query_normalized=r.query_normalized,
            state=str(r.state.value if hasattr(r.state, "value") else r.state),
            mb_recording_id=r.mb_recording_id,
            confidence=r.confidence,
            phase=r.phase,
            details_json=r.details_json,
            error=r.error,
        )
        for r in rows
    ]


@router.post("/{playlist_id}/imports/{job_id}/rows/{row_id}/resolve", response_model=PlaylistItemOut)
async def resolve_playlist_import_row(
    playlist_id: int,
    job_id: int,
    row_id: int,
    body: ResolveImportRowBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    job = session.get(PlaylistImportJob, job_id)
    if job is None or job.playlist_id != playlist_id or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="Import job not found")
    row = session.get(PlaylistImportRow, row_id)
    if row is None or row.job_id != job_id:
        raise HTTPException(status_code=404, detail="Import row not found")
    if row.state == PlaylistImportRowState.MATCHED:
        raise HTTPException(status_code=400, detail="Row already matched")
    mbid = (body.mb_recording_id or "").strip()
    if not mbid:
        raise HTTPException(status_code=400, detail="Missing mb_recording_id")

    # Resolve metadata to populate item fields (and validate MB actually returns the recording).
    meta = await musicbrainz.get_track(mbid, include_cover=False)
    if not meta or not meta.get("mbid"):
        raise HTTPException(status_code=400, detail="MusicBrainz recording not found")

    track_id = _find_local_track_id(session, mbid)
    item = PlaylistItem(
        playlist_id=playlist_id,
        position=row.desired_position or (job.base_position + row.row_index),
        title=(meta.get("title") or row.title)[:255],
        artist=(meta.get("artist_credit") or meta.get("artist") or row.artist)[:255],
        album=(meta.get("album") or row.album or "")[:255],
        mb_recording_id=mbid,
        mb_artist_id=meta.get("mb_artist_id"),
        mb_release_id=meta.get("mb_release_id"),
        mb_release_group_id=meta.get("mb_release_group_id"),
        album_cover=None,
        track_id=track_id,
    )
    session.add(item)
    session.commit()
    session.refresh(item)

    row.state = PlaylistImportRowState.MATCHED
    row.mb_recording_id = mbid
    row.phase = row.phase or "Manual resolve"
    row.error = None
    session.add(row)
    session.commit()

    return _playlist_item_to_out(item, is_cached=False)


@router.post("/{playlist_id}/imports/{job_id}/rows/{row_id}/reject")
def reject_playlist_import_row(
    playlist_id: int,
    job_id: int,
    row_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_playlist_for_user(session, playlist_id, user.id)
    job = session.get(PlaylistImportJob, job_id)
    if job is None or job.playlist_id != playlist_id or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="Import job not found")
    row = session.get(PlaylistImportRow, row_id)
    if row is None or row.job_id != job_id:
        raise HTTPException(status_code=404, detail="Import row not found")
    if row.state == PlaylistImportRowState.MATCHED:
        raise HTTPException(status_code=400, detail="Row already matched")
    row.mb_recording_id = None
    row.phase = "Manual reject"
    row.error = "Rejected suggestion"
    session.add(row)
    session.commit()
    return {"ok": True}