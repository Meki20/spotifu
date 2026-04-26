from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlmodel import Session, select
from database import get_session
from deps import get_current_user
from models import Track, TrackStatus, User
from services.providers import musicbrainz as mb_provider
from services.download import download_track_background
from datetime import datetime

router = APIRouter(prefix="/play", tags=["play"])


class DownloadResponse(BaseModel):
    track_id: int
    status: str
    local_stream_url: str | None = None


class PlayResponse(BaseModel):
    track_id: int | None
    local_stream_url: str | None
    preview_url: str | None
    title: str | None = None
    artist: str | None = None
    artist_credit: str | None = None
    status: str
    mb_artist_id: str | None = None
    mb_release_id: str | None = None
    mb_release_group_id: str | None = None
    release_date: str | None = None
    genre: str | None = None


def _get_or_create_track_by_mb(session: Session, mbid: str, meta: dict | None) -> tuple[Track, bool]:
    """Lookup or create track by mb_id. Reuses any row for this mb_id."""
    track = session.query(Track).filter(Track.mb_id == mbid).first()

    if track is None and meta:
        title = meta.get("title", "")
        artist = meta.get("artist", "")
        if title and artist:
            track = (
                session.query(Track)
                .filter(
                    Track.status == TrackStatus.READY,
                    Track.title.ilike(title),
                    Track.artist.ilike(artist),
                )
                .first()
            )
            if track:
                if not track.mb_id:
                    track.mb_id = mbid
                    session.add(track)
                    session.commit()
                return track, False

    if track is None:
        if meta is None:
            raise HTTPException(status_code=404, detail="Track not found on MusicBrainz")
        track = Track(
            title=meta.get("title", ""),
            artist=meta.get("artist", ""),
            artist_credit=meta.get("artist_credit") or meta.get("artist", ""),
            album=meta.get("album", ""),
            album_cover=meta.get("album_cover"),
            mb_id=mbid,
            mb_artist_id=meta.get("mb_artist_id"),
            mb_release_id=meta.get("mb_release_id"),
            mb_release_group_id=meta.get("mb_release_group_id"),
            preview_url=meta.get("preview_url"),
            release_date=meta.get("release_date"),
            genre=meta.get("genre"),
            status=TrackStatus.FETCHING,
            local_file_path=None,
        )
        session.add(track)
        session.commit()
        session.refresh(track)
        return track, True

    if track.status == TrackStatus.READY and track.local_file_path:
        return track, False

    if track.status == TrackStatus.ERROR:
        track.status = TrackStatus.FETCHING
        track.local_file_path = None
        if meta:
            track.artist_credit = meta.get("artist_credit") or track.artist_credit or track.artist
        session.commit()
        session.refresh(track)
        return track, True

    if track.local_file_path and __import__('os').path.isfile(track.local_file_path):
        track.status = TrackStatus.READY
        session.add(track)
        session.commit()
        return track, False

    return track, False


@router.get("/{provider}/{id}", response_model=PlayResponse)
async def play(
    provider: str,
    id: str,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Play a track. provider is 'local' or 'musicbrainz'. id is the provider-specific ID."""
    if provider == "local":
        try:
            numeric_id = int(id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid local track id")
        track = session.get(Track, numeric_id)
        if track is None:
            raise HTTPException(status_code=404, detail="Track not found")
        is_ready = track.status == TrackStatus.READY and track.local_file_path
        if is_ready:
            track.last_played_at = datetime.utcnow()
            session.add(track)
            session.commit()
        return PlayResponse(
            track_id=track.id,
            local_stream_url=f"/stream/{track.id}" if is_ready else None,
            preview_url=None,
            title=track.title,
            artist=track.artist,
            artist_credit=track.artist_credit,
            status=track.status.value,
            mb_artist_id=track.mb_artist_id,
            mb_release_id=track.mb_release_id,
            mb_release_group_id=track.mb_release_group_id,
            release_date=track.release_date,
            genre=track.genre,
        )

    elif provider == "musicbrainz":
        mbid = id
        meta = await mb_provider.get_track(mbid, include_cover=False)
        caa_release_mbids: list[str] = []
        if meta:
            caa_release_mbids = list(meta.pop("_caa_release_mbids", []) or [])
        track, needs_download = _get_or_create_track_by_mb(session, mbid, meta)
        if caa_release_mbids and not track.album_cover:
            background_tasks.add_task(
                mb_provider.hydrate_track_album_cover_from_releases,
                track.id,
                caa_release_mbids,
            )

        if needs_download:
            background_tasks.add_task(
                download_track_background,
                track.id,
                track.title,
                track.artist_credit or track.artist,
                track.album,
                track.mb_id,
                track.duration,
            )

        is_ready = track.status == TrackStatus.READY and track.local_file_path
        if is_ready:
            track.last_played_at = datetime.utcnow()
            session.add(track)
            session.commit()
        return PlayResponse(
            track_id=track.id,
            local_stream_url=f"/stream/{track.id}" if is_ready else None,
            preview_url=(meta or {}).get("preview_url"),
            title=track.title,
            artist=track.artist,
            artist_credit=track.artist_credit or (meta or {}).get("artist_credit"),
            status=track.status.value,
            mb_artist_id=track.mb_artist_id,
            mb_release_id=track.mb_release_id,
            mb_release_group_id=track.mb_release_group_id,
            release_date=track.release_date,
            genre=track.genre,
        )

    else:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")


@router.post("/download/{provider}/{id}", response_model=DownloadResponse)
async def download_track(
    provider: str,
    id: str,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Explicit download trigger for any provider."""
    if provider == "local":
        track_id = int(id)
        track = session.get(Track, track_id)
        if not track:
            raise HTTPException(status_code=404, detail="Track not found")
        if track.status == TrackStatus.READY and track.local_file_path:
            return DownloadResponse(
                track_id=track.id,
                status="already_downloaded",
                local_stream_url=f"/stream/{track.id}",
            )
        background_tasks.add_task(
            download_track_background,
            track.id,
            track.title,
            track.artist_credit or track.artist,
            track.album,
            track.mb_id,
            track.duration,
        )
        return DownloadResponse(track_id=track.id, status="downloading")

    elif provider == "musicbrainz":
        mbid = id
        meta = await mb_provider.get_track(mbid, include_cover=False)
        caa_release_mbids: list[str] = []
        if meta:
            caa_release_mbids = list(meta.pop("_caa_release_mbids", []) or [])
        track, _ = _get_or_create_track_by_mb(session, mbid, meta)
        if caa_release_mbids and not track.album_cover:
            background_tasks.add_task(
                mb_provider.hydrate_track_album_cover_from_releases,
                track.id,
                caa_release_mbids,
            )

        if track.status == TrackStatus.READY and track.local_file_path:
            return DownloadResponse(
                track_id=track.id,
                status="already_downloaded",
                local_stream_url=f"/stream/{track.id}",
            )

        background_tasks.add_task(
            download_track_background,
            track.id,
            track.title,
            track.artist_credit or track.artist,
            track.album,
            track.mb_id,
            track.duration,
        )
        return DownloadResponse(track_id=track.id, status="downloading")

    else:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {provider}")