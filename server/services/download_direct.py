import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from sqlmodel import Session

from database import engine
from models import Track, TrackStatus
from services.covers import _extract_local_cover
from services.soulseek import (
    download_file,
    set_progress_callback,
    remove_progress_callback,
    set_inflight_filesize,
)


def _extract_metadata(local_file_path: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Extract title, artist, album from audio file metadata using mutagen."""
    if not local_file_path or not os.path.isfile(local_file_path):
        logger.warning("File does not exist for metadata extraction: %s", local_file_path)
        return None, None, None

    try:
        from mutagen import File as MutagenFile
    except ImportError:
        logger.warning("mutagen not installed; cannot extract metadata")
        return None, None, None

    try:
        audio = MutagenFile(local_file_path, easy=False)
        if audio is None:
            logger.warning("mutagen could not read file: %s", local_file_path)
            return None, None, None

        title = None
        artist = None
        album = None

        tags = None
        try:
            tags = audio.tags
        except ValueError:
            logger.debug("Cannot access audio.tags directly for %s", local_file_path)

        if tags:
            try:
                tag_keys = list(tags.keys())
                logger.debug("Available tag keys for %s: %s", local_file_path, tag_keys)
            except ValueError:
                tag_keys = []

            for key in ['\xa9nam', 'TIT2', 'title', 'TITLE', 'Title']:
                try:
                    if key in tags:
                        val = tags[key]
                        if val:
                            title = str(val[0]) if isinstance(val, list) else str(val)
                            break
                except ValueError:
                    continue

            for key in ['\xa9ART', 'TPE1', 'artist', 'ARTIST', 'Artist']:
                try:
                    if key in tags:
                        val = tags[key]
                        if val:
                            artist = str(val[0]) if isinstance(val, list) else str(val)
                            break
                except ValueError:
                    continue

            for key in ['\xa9alb', 'TALB', 'album', 'ALBUM', 'Album']:
                try:
                    if key in tags:
                        val = tags[key]
                        if val:
                            album = str(val[0]) if isinstance(val, list) else str(val)
                            break
                except ValueError:
                    continue

        if not title and hasattr(audio, 'info'):
            title = getattr(audio.info, 'title', None)
            if title:
                title = str(title)

        logger.info("Extracted metadata from %s: title=%r artist=%r album=%r", local_file_path, title, artist, album)
        return title, artist, album
    except Exception:
        logger.warning("Metadata extraction failed for %s", local_file_path, exc_info=True)
        return None, None, None


logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)

_active_downloads: dict[int, "DirectDownloadInfo"] = {}
_active_lock = asyncio.Lock()
_download_history: list[dict] = []
_MAX_HISTORY = 50


@dataclass
class DirectDownloadInfo:
    track_id: int
    title: str
    artist: str
    album: str
    status: str = "searching"
    percent: int = 0
    bytes_downloaded: int = 0
    speed: float = 0
    filesize: Optional[int] = None
    local_path: Optional[str] = None
    error: Optional[str] = None
    started_at: datetime = field(default_factory=datetime.utcnow)


async def search_soulseek_direct(
    query: str,
    timeout: float = 30.0,
    collect_for: float = 8.0,
) -> list[dict]:
    """Search Soulseek and return results as dicts for the frontend."""
    from services.soulseek import search_soulseek

    results = await search_soulseek(
        query,
        timeout=timeout,
        collect_for=collect_for,
    )
    return [
        {
            "username": username,
            "path": path,
            "size": size,
            "ext": os.path.splitext(path)[1].lower() if path else "",
        }
        for username, path, size in results
    ]


async def download_track_direct(
    track_id: int,
    username: str,
    remote_path: str,
    title: str,
    artist: str,
    album: str = "",
) -> dict:
    """Download a track directly from Soulseek without going through the library."""
    global _active_downloads, _download_history

    async with _active_lock:
        if track_id in _active_downloads:
            logger.info("Direct download already in flight for track_id=%s, skipping", track_id)
            return {"track_id": track_id, "status": "already_downloading"}
        _active_downloads[track_id] = DirectDownloadInfo(
            track_id=track_id,
            title=title,
            artist=artist,
            album=album,
            status="downloading",
        )

    from main import ws_manager

    info = _active_downloads[track_id]

    async def progress_callback(
        percent: int,
        bytes_downloaded: int,
        speed: float,
        filesize: Optional[int] = None,
    ):
        info.percent = percent
        info.bytes_downloaded = bytes_downloaded
        info.speed = speed
        info.filesize = filesize or info.filesize
        if filesize:
            await set_inflight_filesize(track_id, filesize)
        await ws_manager.broadcast({
            "type": "direct_download_progress",
            "track_id": track_id,
            "percent": percent,
            "bytes_downloaded": bytes_downloaded,
            "speed": speed,
            "filesize": filesize,
        })

    await set_progress_callback(track_id, progress_callback)

    await ws_manager.broadcast({
        "type": "direct_download_started",
        "track_id": track_id,
        "local_stream_url": f"/stream/{track_id}",
    })

    local_path: Optional[str] = None
    status = TrackStatus.ERROR

    try:
        logger.info(
            "Direct Soulseek download: user=%r path=%r track_id=%d title=%r",
            username, remote_path, track_id, title,
        )
        lower_path = (remote_path or "").lower()
        if lower_path.endswith((".png", ".jpg", ".jpeg")):
            raise ValueError("Skipping non-audio file")

        local_path = await download_file(
            username,
            remote_path,
            timeout=600.0,
            track_id=track_id,
            abort_on_no_progress=False,
        )

        if local_path:
            status = TrackStatus.READY
            info.status = "completed"
            info.local_path = local_path
            logger.info("Direct download complete: %s", local_path)
        else:
            info.status = "failed"
            info.error = "Download failed"
            logger.error("Direct download failed for track %d", track_id)

    except Exception as e:
        info.status = "failed"
        info.error = str(e)
        logger.error("Direct Soulseek download failed for track %d: %s", track_id, e)
        await ws_manager.broadcast({
            "type": "direct_download_error",
            "track_id": track_id,
            "error": str(e),
        })
    finally:
        await remove_progress_callback(track_id)

    album_cover: Optional[str] = None
    extracted_title: Optional[str] = None
    extracted_artist: Optional[str] = None
    extracted_album: Optional[str] = None
    with Session(engine) as session:
        if status == TrackStatus.READY:
            track = session.get(Track, track_id)
            if track:
                track.status = status
                track.local_file_path = local_path
                if local_path:
                    from services.audio_quality import extract_quality
                    track.quality = extract_quality(local_path)
                session.add(track)
                session.commit()

                if local_path:
                    extracted_title, extracted_artist, extracted_album = _extract_metadata(local_path)
                    if extracted_title:
                        track.title = extracted_title
                    if extracted_artist:
                        track.artist = extracted_artist
                        if not track.artist_credit:
                            track.artist_credit = extracted_artist
                    if extracted_album:
                        track.album = extracted_album
                    session.add(track)
                    session.commit()

                    cover_url = _extract_local_cover(local_path, track_id)
                    if cover_url:
                        track.album_cover = cover_url
                        album_cover = cover_url
                        session.add(track)
                        session.commit()
            else:
                logger.warning("Track %d not found after direct download", track_id)
        else:
            track = session.get(Track, track_id)
            if track:
                track.status = status
                session.add(track)
                session.commit()

    if status == TrackStatus.READY:
        quality = None
        with Session(engine) as session:
            track = session.get(Track, track_id)
            quality = track.quality if track else None
        payload = {
            "type": "direct_download_ready",
            "track_id": track_id,
            "local_stream_url": f"/stream/{track_id}",
            "album_cover": album_cover,
        }
        if quality:
            payload["quality"] = quality
        await ws_manager.broadcast(payload)

    async with _active_lock:
        del _active_downloads[track_id]

        final_title = extracted_title or title
        final_artist = extracted_artist or artist
        final_album = extracted_album or album

        history_entry = {
            "track_id": track_id,
            "title": final_title,
            "artist": final_artist,
            "album": final_album,
            "status": info.status,
            "local_path": local_path,
            "completed_at": datetime.utcnow().isoformat(),
        }
        _download_history.insert(0, history_entry)
        if len(_download_history) > _MAX_HISTORY:
            _download_history.pop()

    return {
        "track_id": track_id,
        "status": info.status,
        "local_path": local_path,
    }


def get_active_downloads() -> list[dict]:
    return [
        {
            "track_id": info.track_id,
            "title": info.title,
            "artist": info.artist,
            "album": info.album,
            "status": info.status,
            "percent": info.percent,
            "bytes_downloaded": info.bytes_downloaded,
            "speed": info.speed,
            "filesize": info.filesize,
        }
        for info in _active_downloads.values()
    ]


def get_download_history() -> list[dict]:
    return list(_download_history)