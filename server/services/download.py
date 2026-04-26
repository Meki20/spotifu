import asyncio
import logging
import time
from database import engine
from models import Track, TrackStatus
from sqlmodel import Session

logger = logging.getLogger(__name__)

_active_downloads: set[int] = set()
_active_lock = asyncio.Lock()


async def download_track_background(track_id: int, title: str, artist: str, album: str = "", mb_id: str | None = None, duration: int = 0):
    async with _active_lock:
        if track_id in _active_downloads:
            logger.info("Download already in flight for track_id=%s, skipping", track_id)
            return
        _active_downloads.add(track_id)
    try:
        await _run_download(track_id, title, artist, album, mb_id, duration)
    finally:
        _active_downloads.discard(track_id)


async def _run_download(track_id: int, title: str, artist: str, album: str = "", mb_id: str | None = None, duration: int = 0):
    from services.soulseek import search_track, download_file, set_progress_callback, remove_progress_callback, set_inflight_filesize
    from main import ws_manager

    query = f"{artist} - {title}"
    local_path = None
    status = TrackStatus.ERROR

    logger.debug("Progress callback registered for track_id=%s mb_id=%r", track_id, mb_id)

    _started_emitted = False

    async def progress_callback(percent: int, bytes_downloaded: int, speed: float, filesize: int | None = None):
        nonlocal _started_emitted
        msg: dict = {
            "type": "download_progress",
            "track_id": track_id,
            "percent": percent,
            "bytes_downloaded": bytes_downloaded,
            "speed": speed,
        }
        if filesize:
            msg["filesize"] = filesize
            await set_inflight_filesize(track_id, filesize)
        if mb_id:
            msg["mb_id"] = mb_id
        await ws_manager.broadcast(msg)
        if not _started_emitted and bytes_downloaded > 0:
            _started_emitted = True
            started: dict = {
                "type": "download_started",
                "track_id": track_id,
                "local_stream_url": f"/stream/{track_id}",
                "duration": duration,
            }
            if mb_id:
                started["mb_id"] = mb_id
            await ws_manager.broadcast(started)

    await set_progress_callback(track_id, progress_callback)

    await ws_manager.broadcast({
        "type": "download_searching",
        "track_id": track_id,
        "local_stream_url": f"/stream/{track_id}",
        **({"mb_id": mb_id} if mb_id else {}),
    })

    try:
        logger.debug("Searching: artist=%r title=%r album=%r query=%r", artist, title, album, query)
        results = await search_track(artist, title, album=album, timeout=30.0)

        if not results:
            logger.warning("No Soulseek results for: %s", query)
            await ws_manager.broadcast({
                "type": "download_error",
                "track_id": track_id,
                "error": "No results found on Soulseek",
            })
            with Session(engine) as session:
                track = session.get(Track, track_id)
                if track and track.status == TrackStatus.FETCHING:
                    track.status = TrackStatus.ERROR
                    session.add(track)
                    session.commit()
            return

        logger.debug("Got %d results. Top candidates:", len(results))
        for idx, (u, p, sz) in enumerate(results[:5]):
            logger.debug("  [%d] %s | %s | %d bytes", idx+1, u, p, sz)

        MAX_ATTEMPTS = 3
        local_path = None
        for i, (username, remote_path, file_size) in enumerate(results[:MAX_ATTEMPTS]):
            logger.debug("Attempting download %d/%d: user=%r path=%r size=%d", i+1, min(len(results), MAX_ATTEMPTS), username, remote_path, file_size)
            if i > 0:
                logger.info(f"Soulseek retry: {remote_path} from {username} ({file_size} bytes)")
            try:
                # If we observe repeated "0 bytes" polls, abort and try next peer—
                # except on the final attempt where we give the last candidate a full chance.
                abort_on_no_progress = i < (MAX_ATTEMPTS - 1)
                local_path = await download_file(
                    username,
                    remote_path,
                    timeout=600.0,
                    track_id=track_id,
                    abort_on_no_progress=abort_on_no_progress,
                )
                if local_path:
                    logger.info("Download succeeded: %s", local_path)
                    break
                else:
                    logger.debug("Download returned None for %s/%s, trying next", username, remote_path)
            except Exception as e:
                logger.warning("Download attempt failed for %s/%s: %s", username, remote_path, e)
                continue

        if local_path:
            status = TrackStatus.READY
            logger.info("Download complete: %s", local_path)
        else:
            logger.error("Download failed for track %d", track_id)
            await ws_manager.broadcast({
                "type": "download_error",
                "track_id": track_id,
                "error": "Download failed",
            })

    except Exception as e:
        logger.error("Soulseek download failed for track %d: %s", track_id, e)
        await ws_manager.broadcast({
            "type": "download_error",
            "track_id": track_id,
            "error": str(e),
        })
    finally:
        await remove_progress_callback(track_id)

    mb_id_for_ws: str | None = None
    with Session(engine) as session:
        track = session.get(Track, track_id)
        if track:
            track.status = status
            track.local_file_path = local_path
            mb_id_for_ws = track.mb_id
            if status == TrackStatus.READY and not track.mb_id:
                from services.providers import musicbrainz
                try:
                    mb_id_resolved = await musicbrainz.resolve_id(
                        track.title, track.artist, track.album
                    )
                    if mb_id_resolved:
                        track.mb_id = mb_id_resolved
                        mb_id_for_ws = mb_id_resolved
                except Exception:
                    logger.exception("mb resolve_id after download for track_id=%s", track_id)
            session.add(track)
            session.commit()

    if status == TrackStatus.READY:
        payload: dict = {
            "type": "track_ready",
            "track_id": track_id,
            "local_stream_url": f"/stream/{track_id}",
        }
        if mb_id_for_ws:
            payload["mb_id"] = mb_id_for_ws
        await ws_manager.broadcast(payload)